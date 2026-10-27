// SPDX-License-Identifier: Apache-2.0

/**
 * output-names.ts — deciding an output filename from UNTRUSTED metadata.
 *
 * Node port of `CLI/cesvu/src/cesvu/output_names.py`. Same rationale:
 * `CesvuMetadata.filename` is authenticated: it lives inside the
 * AEAD-protected metadata, so it cannot be tampered with in transit. That is
 * NOT the same as trustworthy. Authentication proves only that whoever
 * produced the file held the passphrase, and the producer is exactly the
 * party we are defending against when a `.cesvu` arrives from someone
 * else. So the embedded name may INFORM the output path; it may never
 * DECIDE it.
 *
 * ── Why rejection happens BEFORE the rename, not after ─────────────────
 * An earlier design verified the result after the rename and fell back if
 * the filesystem had done something unexpected. That is not a control,
 * because the damage is already done. Measured on Windows 11:
 *
 *     requested        result                 on disk
 *     'trailing.'      "ok", 4 bytes          'trailing'   (extension gone)
 *     'trailing...'    "ok", 4 bytes          'trailing'   (COLLAPSED onto
 *                                                           the same entry,
 *                                                           destroying the
 *                                                           previous file)
 *     'NUL'            "ok", 0 bytes          nothing at all — data discarded
 *
 * Noticing afterwards that `trailing...` landed on `trailing` does not
 * bring back the file it overwrote. Verification is therefore diagnostics
 * only (see {@link describeWriteDiscrepancies}), and everything that can
 * refuse must refuse before the destructive step.
 *
 * ── Why a rejection list, not a sanitizer ───────────────────────────────
 * "Strip anything unusual" was considered and rejected: it destroys the
 * extension dot, mangles every non-ASCII name, and still would not stop
 * `NUL`. Instead the policy rejects a narrow set of names with PLATFORM
 * SEMANTICS and preserves everything else byte-for-byte. Measured, these
 * all save correctly and are deliberately allowed through untouched:
 *
 *     '..pdf'  '...pdf'  '.pdf'  'report .txt'  '契約書.pdf'  'Übersicht.docx'
 *
 * The rules are applied UNCONDITIONALLY, including the Windows-specific
 * ones on POSIX hosts. A file decrypted on Linux and copied to Windows
 * meets Win32 semantics there, so guarding only on Windows would happily
 * produce names that are hostile somewhere else.
 *
 * ── Threat model (declared, not aspirational) ───────────────────────────
 * This is sized for a local, non-privileged, single-user tool. Collision
 * detection is inherently racy: another process may create the entry
 * between the check and the rename. That is accepted here and is NOT safe
 * in a directory writable by hostile users or processes, nor under
 * privileged execution.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

// The Win32 reserved character set, adopted wholesale rather than by
// case-by-case judgement. Note ':' earns its place twice over: it blocks
// NTFS alternate data streams (`report.txt:hidden` writes an invisible
// stream) AND the drive-relative form `C:evil.txt`, which has no separator
// at all and so survives naive basename logic while resolving against the
// current directory of another drive.
const WINDOWS_FORBIDDEN_CHARS = new Set('<>:"/\\|?*'.split(''));

// NUL plus the C0 control range, kept as its own rule rather than folded
// into the set above. Windows rejects these outright (measured: 'a\tb.txt'
// fails with EINVAL); POSIX permits most of them, which is precisely why
// they need refusing here — a newline or ESC in a filename is a
// terminal-injection primitive, and '\x00' truncates the name in any C API.
function isControlChar(ch: string): boolean {
	const code = ch.codePointAt(0)!;
	return (code >= 0x00 && code <= 0x1f) || code === 0x7f;
}

// Win32 device names. These resolve to devices rather than files
// REGARDLESS of extension, so `NUL.txt` is as dangerous as `NUL` and must
// be matched on the stem. Superscript digit forms are included because
// Win32 folds ¹²³ onto 1/2/3 during device-name resolution: `COM¹.txt`
// reaches the device while looking like an ordinary text file, which is
// the exact "succeeds wrongly" shape this module exists to stop.
const SUPERSCRIPT_DIGITS: Record<string, string> = {
	'\u00b9': '1',
	'\u00b2': '2',
	'\u00b3': '3'
};

const RESERVED_DEVICE_STEMS = new Set<string>([
	'CON',
	'PRN',
	'AUX',
	'NUL',
	...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
	...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`)
]);

// Conservative single-component byte budget. Most filesystems allow 255
// bytes per component; NTFS counts UTF-16 units instead, so this is a
// floor rather than an exact match for any one filesystem.
export const MAX_COMPONENT_BYTES = 255;

// How many `name (n).ext` variants to try before giving up. Exhaustion is
// a real answer, not a state to engineer around with timestamps or UUIDs:
// after this many collisions, guessing again is more likely to hit yet
// another existing file than to find a free slot, and the whole point of
// this module is to not overwrite files the user never named.
export const MAX_CANDIDATE_ATTEMPTS = 100;

/**
 * A candidate path escaped the intended directory.
 *
 * A dedicated type rather than a generic Error subclass check: callers
 * catch this around a block that also runs decryption and metadata
 * parsing, which throw for their own reasons (malformed JSON, bad
 * lengths). Catching those as a containment violation would report an
 * unrelated bug as a security event and hide the real error.
 */
export class UnsafeOutputPath extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'UnsafeOutputPath';
	}
}

/**
 * No acceptable, non-colliding output name was found.
 *
 * Raised BEFORE anything is written, so nothing has been created or
 * overwritten. Recovery is trivial and lossless: the `.cesvu` and the
 * passphrase are both still in hand, so writing to an explicit path
 * reproduces the file immediately. This is why aborting here is
 * preferable to falling back to a fixed constant — after a bounded search
 * has already failed, a constant is the candidate MOST likely to collide,
 * which would turn the "safe fallback" into the thing that destroys a
 * file.
 */
export class OutputNameExhausted extends Error {
	constructor(
		public readonly directory: string,
		public readonly attempts: number
	) {
		super(
			`could not find an unused output name in ${directory} after ${attempts} attempts; ` +
				'choose an explicit destination path instead'
		);
		this.name = 'OutputNameExhausted';
	}
}

/** The portion Win32 uses for device-name resolution: everything before
 * the first dot, with trailing spaces/dots ignored, superscript digits
 * folded, upper-cased. */
function deviceStem(name: string): string {
	const idx = name.indexOf('.');
	let stem = idx === -1 ? name : name.slice(0, idx);
	stem = stem.replace(/[. ]+$/, '');
	stem = Array.from(stem)
		.map((ch) => SUPERSCRIPT_DIGITS[ch] ?? ch)
		.join('');
	return stem.toUpperCase();
}

/**
 * Return a human-readable reason `name` is unusable as a single output
 * component, or `null` if it is acceptable.
 *
 * A returned reason means "fall back to a derived name", not "fail the
 * decrypt". Refusing to write a file that already decrypted successfully
 * would be a far worse outcome than writing it under a different name.
 */
export function rejectionReason(name: string): string | null {
	if (!name) return 'empty';
	if (name === '.' || name === '..') return `reserved name ${JSON.stringify(name)}`;

	// Separators and drive/root syntax. Checked against BOTH platforms'
	// semantics rather than just the host's, so a Windows-shaped name is
	// caught on POSIX and vice versa.
	if (name.includes('/') || name.includes('\\')) return 'contains a path separator';

	// Windows absolute/rooted/drive-qualified forms: `C:\x`, `C:evil.txt`
	// (drive-relative, no separator at all), `\\server\share\x` (UNC).
	if (/^[a-zA-Z]:/.test(name)) return 'is absolute, rooted or drive-qualified';
	if (path.win32.isAbsolute(name) || path.posix.isAbsolute(name)) {
		return 'is absolute, rooted or drive-qualified';
	}

	const bad = Array.from(new Set(Array.from(name).filter((ch) => WINDOWS_FORBIDDEN_CHARS.has(ch)))).sort();
	if (bad.length > 0) {
		return 'contains reserved character(s) ' + bad.map((c) => JSON.stringify(c)).join(' ');
	}
	if (Array.from(name).some(isControlChar)) return 'contains control characters';

	// Trailing dots/spaces are silently DROPPED by Win32, which is how
	// 'trailing.' becomes 'trailing' and how two distinct names collapse
	// onto one entry and overwrite each other.
	const lastChar = name[name.length - 1];
	if (lastChar === '.' || lastChar === ' ') return 'ends with a dot or space';

	if (RESERVED_DEVICE_STEMS.has(deviceStem(name))) return 'is a reserved Windows device name';

	// Must be encodable as strict UTF-8. This is what catches lone
	// surrogates (a real hazard for emoji mangled by a Windows console),
	// which cannot be encoded at all and would otherwise raise deep inside
	// the write.
	let utf8: Uint8Array;
	try {
		utf8 = new TextEncoder().encode(name);
		// TextEncoder is lenient by spec (substitutes U+FFFD rather than
		// throwing), so explicitly check for lone surrogates ourselves.
		for (let i = 0; i < name.length; i++) {
			const code = name.charCodeAt(i);
			if (code >= 0xd800 && code <= 0xdfff) {
				const isHighSurrogate = code <= 0xdbff;
				const pairOk = isHighSurrogate
					? i + 1 < name.length &&
						name.charCodeAt(i + 1) >= 0xdc00 &&
						name.charCodeAt(i + 1) <= 0xdfff
					: i > 0 && name.charCodeAt(i - 1) >= 0xd800 && name.charCodeAt(i - 1) <= 0xdbff;
				if (!pairOk) {
					return 'cannot be encoded as UTF-8 (contains unpaired surrogates)';
				}
			}
		}
	} catch {
		return 'cannot be encoded as UTF-8 (contains unpaired surrogates)';
	}

	if (utf8.length > MAX_COMPONENT_BYTES) return `is longer than ${MAX_COMPONENT_BYTES} bytes`;

	return null;
}

export function isAcceptableComponent(name: string): boolean {
	return rejectionReason(name) === null;
}

/**
 * Render a name safely for a terminal/log.
 *
 * Escaping, not stripping — the reader needs to see that something odd is
 * present, and the escaped form is still recognisable. This is the ONLY
 * defence against the bidi/homoglyph class: `a\u202Eb.txt` is stored
 * faithfully by the filesystem and passes every post-write check, because
 * the target of that attack is the human reading the output, not the
 * disk. Also neutralises ANSI escape sequences, which would otherwise let
 * a filename repaint the terminal.
 */
export function escapeForDisplay(name: string): string {
	let out = '';
	for (const ch of name) {
		const code = ch.codePointAt(0)!;
		// Control (C0/C1 + DEL), private-use, and surrogate-range code
		// points are escaped. (JS strings can't hold lone-surrogate-free
		// astral private-use ranges distinctly from BMP ones here, but the
		// control/format/PUA ranges below cover the attack classes this
		// function exists for: bidi overrides, ANSI escapes, raw controls.)
		const isControl = (code >= 0x00 && code <= 0x1f) || code === 0x7f || (code >= 0x80 && code <= 0x9f);
		const isBidiOrFormat =
			(code >= 0x200b && code <= 0x200f) ||
			(code >= 0x202a && code <= 0x202e) ||
			(code >= 0x2060 && code <= 0x2069) ||
			code === 0xfeff;
		const isPrivateUse = (code >= 0xe000 && code <= 0xf8ff) || (code >= 0xf0000 && code <= 0xffffd) || (code >= 0x100000 && code <= 0x10fffd);
		const isSurrogate = code >= 0xd800 && code <= 0xdfff;
		if (isControl || isBidiOrFormat || isPrivateUse || isSurrogate) {
			out += `\\u${code.toString(16).padStart(4, '0')}`;
		} else {
			out += ch;
		}
	}
	return out;
}

/**
 * Verify `candidatePath` resolves inside `directory`.
 *
 * This is the one check that CANNOT be deferred to post-write
 * verification: discovering afterwards that attacker-named bytes landed
 * outside the intended directory is not a control, it is a post-mortem.
 * Should be called again immediately before the rename so the window
 * between validation and the destructive step is as small as the platform
 * allows.
 */
export async function assertContained(directory: string, candidatePath: string): Promise<void> {
	const parent = await fs.realpath(directory);
	let resolved: string;
	try {
		resolved = await fs.realpath(candidatePath);
	} catch {
		// Target doesn't exist yet (the common case — we haven't written
		// it). Resolve its parent directory instead and re-attach the
		// basename, mirroring what realpath would report once created.
		const resolvedParent = await fs.realpath(path.dirname(candidatePath));
		resolved = path.join(resolvedParent, path.basename(candidatePath));
	}
	if (path.dirname(resolved) !== parent) {
		throw new UnsafeOutputPath(
			`refusing to write outside ${directory}: ${escapeForDisplay(candidatePath)}`
		);
	}
}

/** Split into [stem, suffix] preserving a leading-dot name intact, so
 * '.pdf' and '..pdf' keep their full name and only a real extension is
 * treated as one. */
function splitStemSuffix(name: string): [string, string] {
	const idx = name.lastIndexOf('.');
	if (idx > 0) return [name.slice(0, idx), name.slice(idx)];
	return [name, ''];
}

/**
 * Replace `name`'s extension (if any) with `.txt`.
 *
 * Used when the content actually being written is extracted plain text —
 * not the original binary file — even though the ORIGINAL file's name
 * (and therefore its real extension, e.g. '.pdf'/'.docx'/'.xlsx') is what
 * lives in the untrusted metadata. Writing that original name unchanged
 * would hand back a file whose extension lies about its own format: an
 * OS/associated app opens "contract-final.pdf" expecting real PDF bytes,
 * finds plain text instead, and reports it as corrupted — turning a
 * successful, honest decrypt into what looks like data loss.
 *
 * Applied only to AUTOMATICALLY chosen output names (see file-io.ts's
 * `decryptCesvuFileToDirectory`): a name the caller supplies directly via
 * an explicit `destPath` (in `decryptCesvuFile`) is their own literal
 * choice and is left alone — the caller can act on `isTextFallback` in the
 * returned result if they want to rename it themselves.
 *
 * Uses the same leading-dot-preserving split as {@link candidateNames}, so
 * a leading-dot name like '.pdf' (whose "suffix" is actually its whole
 * name) becomes '.pdf.txt' rather than losing its name entirely, and a
 * stem with no extension at all (e.g. 'README') becomes 'README.txt'.
 */
export function forceTextExtension(name: string): string {
	const [stem] = splitStemSuffix(name);
	return `${stem}.txt`;
}

/** `name`, then `name (1)`, `name (2)`, … keeping any extension last so
 * 'report.pdf' yields 'report (1).pdf' rather than 'report.pdf (1)'. */
export function* candidateNames(name: string): Generator<string, void, undefined> {

	yield name;
	const [stem, suffix] = splitStemSuffix(name);
	for (let n = 1; n < MAX_CANDIDATE_ATTEMPTS; n++) {
		yield `${stem} (${n})${suffix}`;
	}
}

/**
 * The directory entry `name` would collide with, as it ACTUALLY appears
 * on disk, or `null`.
 *
 * Comparison folds case and NFC-normalizes so we approximate the
 * filesystem's own folding (case-insensitivity on NTFS/APFS, NFD
 * normalization on HFS+) without having to reimplement it exactly.
 * Enumeration is used only to recover the real spelling for display,
 * which a plain existence check cannot tell us. Best-effort and racy by
 * nature: it informs the decision, it does not authorize the write.
 */
export async function findExistingEntry(directory: string, name: string): Promise<string | null> {
	const candidatePath = path.join(directory, name);
	try {
		await fs.lstat(candidatePath);
	} catch {
		return null;
	}
	try {
		const folded = name.toLowerCase().normalize('NFC');
		const entries = await fs.readdir(directory);
		for (const entry of entries) {
			if (entry === name) return entry;
			const entryFolded = entry.toLowerCase().normalize('NFC');
			if (entryFolded === folded) return entry;
		}
	} catch {
		/* best-effort */
	}
	// lstat said it exists but enumeration could not confirm which entry
	// (or failed). The collision is still real; report the requested
	// spelling.
	return name;
}

export interface ChooseOutputNameOptions {
	/** Callback invoked with human-readable warnings (fallback used, name
	 * substituted due to collision, etc.). Optional; no-op if omitted. */
	warn?: (message: string) => void;
	/**
	 * `true` (default) — metadata-derived name: the user has never seen
	 * this name, so consent to overwrite cannot be inferred. Colliding
	 * names advance to `name (1)`, `name (2)`, … and the substitution is
	 * reported. Throws {@link OutputNameExhausted} if the search runs out.
	 *
	 * `false` — name derived from something the caller typed/chose
	 * themselves: return the validated name as-is and let the caller apply
	 * its own overwrite policy. Collision is the CALLER's decision here,
	 * so silently advancing to `report (1)` would be wrong — it would
	 * break idempotent re-decrypts, and break them quietly.
	 */
	neverOverwrite?: boolean;
}

/**
 * Pick a validated single path component inside `directory`.
 *
 * `preferred` is the untrusted metadata name; `fallback` is the name
 * derived from the input file, itself only as trustworthy as whoever
 * named the `.cesvu`, so it is validated by the SAME policy rather than
 * assumed safe.
 *
 * Either way, nothing is written or modified before this function
 * returns.
 */
export async function chooseOutputName(
	directory: string,
	preferred: string,
	fallback: string,
	options: ChooseOutputNameOptions = {}
): Promise<string> {
	const { warn, neverOverwrite = true } = options;

	let base = preferred;
	const reason = rejectionReason(preferred);
	if (reason !== null) {
		if (warn && preferred) {
			warn(`ignoring the filename stored in this file (${escapeForDisplay(preferred)}): ${reason}`);
		}
		base = fallback;
		// The fallback gets no free pass: it is derived from the on-disk
		// name, which is equally attacker-chosen.
		const fallbackReason = rejectionReason(base);
		if (fallbackReason !== null) {
			throw new OutputNameExhausted(directory, 0);
		}
	}

	// Validated, and that is all that was asked for. The caller owns the
	// collision decision (see the docstring), so return before the
	// candidate search rather than silently choosing a different file than
	// the one the caller is about to prompt the user about.
	if (!neverOverwrite) {
		return base;
	}

	let attempts = 0;
	for (const candidate of candidateNames(base)) {
		attempts += 1;
		// Every generated candidate is re-validated, not just the first.
		// The " (n)" suffix cannot introduce a forbidden character, but it
		// CAN push a name past the byte limit, and a validator that only
		// ran once would miss that.
		if (rejectionReason(candidate) !== null) continue;
		const existing = await findExistingEntry(directory, candidate);
		if (existing === null) {
			if (candidate !== preferred && warn) {
				warn(`writing as ${escapeForDisplay(candidate)} (requested name was unavailable)`);
			}
			return candidate;
		}
		if (warn) {
			warn(`${escapeForDisplay(existing)} already exists; not overwriting a name that came from file metadata`);
		}
	}
	throw new OutputNameExhausted(directory, attempts);
}

/**
 * Compare what is on disk against what we believe we wrote.
 *
 * DIAGNOSTICS ONLY. This runs after a successful write and must never
 * delete, re-write or retry anything: at this point `filePath` most
 * likely holds the correctly decrypted file, and "cleaning up" on the
 * basis of a cosmetic mismatch would convert a warning into data loss. A
 * non-empty result means "report this" — not "repair it".
 */
export async function describeWriteDiscrepancies(
	filePath: string,
	expectedSize: number
): Promise<string[]> {
	const problems: string[] = [];
	let st: Awaited<ReturnType<typeof fs.lstat>>;
	try {
		st = await fs.lstat(filePath);
	} catch (err) {
		return [`expected output ${escapeForDisplay(filePath)} is not there: ${String(err)}`];
	}

	if (!st.isFile()) {
		problems.push(
			`${escapeForDisplay(filePath)} is not a regular file — the write may have gone to a device`
		);
	}
	if (st.size !== expectedSize) {
		problems.push(`${escapeForDisplay(filePath)} is ${st.size} bytes but ${expectedSize} were written`);
	}

	// Did the filesystem store the name we asked for? This is what
	// catches a trailing-dot rewrite after the fact.
	//
	// Compared under NFC, NOT byte-for-byte. A byte comparison would
	// report every accented filename on macOS as "rewritten", because
	// HFS+/APFS legitimately store `café.pdf` decomposed — turning a
	// completely correct decrypt into a non-zero exit. Normalization is a
	// documented, harmless property of the filesystem; a dropped trailing
	// dot is not, and still fails this check because it changes the
	// characters rather than their composition.
	try {
		const dir = path.dirname(filePath);
		const wanted = path.basename(filePath).normalize('NFC');
		const entries = await fs.readdir(dir);
		if (entries.length > 0 && !entries.some((entry) => entry.normalize('NFC') === wanted)) {
			problems.push(
				`requested ${escapeForDisplay(path.basename(filePath))} but the directory entry is not ` +
					'spelled that way — the filesystem rewrote the name'
			);
		}
	} catch {
		/* best-effort */
	}

	return problems;
}
