// SPDX-License-Identifier: Apache-2.0

/**
 * document.ts — CFP1 document framing for the Node/NPM package.
 *
 * Port of the Python CLI's `document.py` (see CLI/cesvu/src/cesvu/document.py)
 * and mirrors the same "document" export path in
 * src/lib/stores/contract-store.svelte.ts (exportAsCesvu / CFP1 framing), so
 * files produced by {@link encryptCesvuFile} for a recognized type
 * (.txt / .md / .csv) open directly in the cesvu.com web app's viewer —
 * with the SAME `text`/`rawContent` shape the browser itself would have
 * produced for the identical file — instead of falling into the "raw
 * vault" download-only path (see RawVaultPayloadError in
 * contract-store.svelte.ts).
 *
 * Wire format (identical to the web app / Python CLI — CFP1 framing):
 *     [0..3]           magic 'CFP1'
 *     [4..7]           uint32 BE  docJson length
 *     [8 .. 8+len)     docJson (UTF-8; the CesvuDocument WITHOUT rawContent)
 *     [8+len .. end)   raw source bytes (implicit length = remainder)
 *
 * Per-type parity with the browser's own parsers (src/lib/parsers/*.ts) and
 * Workspace.svelte's export prep (fileText / fileSourceType / rawContentBytes):
 *   - 'txt': `text` = UTF-8 decoded file, BOM stripped, then trimmed — matches
 *     parseTXT()'s `.trim()`. No raw section (rawContent is null for txt, same
 *     as the browser).
 *   - 'md': `text` = markdown STRIPPED to plain text (see {@link stripMarkdown},
 *     a direct port of md.ts's stripMarkdown(), which is the canonical source)
 *     — matches fileText()'s md branch, which sends parseMD()'s stripped
 *     `parsedData`, NOT the raw markdown. No raw section.
 *   - 'csv': `text` = "" (matches fileText()'s csv/excel branch — "csv/excel
 *     have no plain-text body"). The RAW CSV BYTES are appended as the CFP1
 *     raw section (no UTF-8 decoding/validation at all — matches the browser,
 *     which just carries an ArrayBuffer via rawContentBytes()), so the web
 *     app's importer reconstructs the SAME `rawContent` it would have gotten
 *     from an in-browser upload and re-parses it into a workbook — CLI/NPM-
 *     encrypted CSVs open as full, interactive tables, not a blank/broken
 *     viewer.
 */

import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

// Keep in lockstep with CESVU_SCHEMA_VERSION in src/lib/schema.ts and
// CLI/cesvu/src/cesvu/document.py's CESVU_SCHEMA_VERSION.
export const CESVU_SCHEMA_VERSION = 4;

// CFP1 payload framing constants — MUST match PAYLOAD_MAGIC /
// PAYLOAD_HEADER_LEN in src/lib/stores/contract-store.svelte.ts (and
// CLI/cesvu/src/cesvu/document.py) exactly.
export const PAYLOAD_MAGIC = new Uint8Array([0x43, 0x46, 0x50, 0x31]); // 'CFP1'
export const PAYLOAD_HEADER_LEN = 8; // magic(4) + uint32 docJsonLen(4)

/** The SourceType values this module can auto-frame as a document. */
export type DocumentSourceType = 'txt' | 'md' | 'csv';

/**
 * All 6 real SourceTypes (see src/lib/schema.ts) — recognized on the
 * decrypt/unwrap side, even though {@link buildCfp1DocumentPlaintext} only
 * ever PRODUCES txt/md/csv. Decrypt must still correctly unwrap a
 * pdf/docx/xlsx file that was encrypted by the web app, not just files this
 * package itself made.
 */
const VALID_SOURCE_TYPES = new Set(['txt', 'md', 'csv', 'pdf', 'docx', 'excel']);

/**
 * SourceTypes for which `text` IS the designed, complete representation of
 * the content (no raw section ever accompanies it). Used only to decide
 * whether falling back to `text` (because the raw section is empty) counts
 * as an unexpected "fallback" worth warning about, or is simply normal.
 */
const TEXT_IS_NATIVE_CONTENT = new Set(['txt', 'md']);

// Extension -> SourceType for the types this module can auto-frame as a
// document. Anything not in this map is left to the caller's raw/vault
// fallback.
const SUPPORTED_EXTENSIONS: Record<string, DocumentSourceType> = {
	'.txt': 'txt',
	'.md': 'md',
	'.csv': 'csv'
};

/**
 * Return the SourceType ('txt' | 'md' | 'csv') for `filenameOrPath`'s
 * extension, or `null` if this module doesn't support auto-framing that
 * type (the caller should fall back to raw/vault encryption unchanged).
 */
export function detectDocumentSourceType(filenameOrPath: string): DocumentSourceType | null {
	const ext = path.extname(filenameOrPath).toLowerCase();
	return SUPPORTED_EXTENSIONS[ext] ?? null;
}

/**
 * Thrown by {@link buildCfp1DocumentPlaintext} when a 'txt'/'md' file isn't
 * valid UTF-8 text despite its extension. Callers should catch this
 * specifically and fall back to raw/vault encryption instead of failing the
 * whole encrypt call — a non-UTF-8 ".txt"/".md" is still a perfectly valid
 * file to hand off via the vault path. ('csv' never throws this — its bytes
 * are carried raw with no decoding.)
 */
export class Cfp1TextDecodeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'Cfp1TextDecodeError';
	}
}

const _encoder = new TextEncoder();
// fatal: true so invalid UTF-8 throws instead of silently substituting
// U+FFFD — matching Python's `bytes.decode('utf-8')`, which raises
// UnicodeDecodeError on the same input.
const _fatalDecoder = new TextDecoder('utf-8', { fatal: true });

/**
 * Strip common markdown formatting to produce plain text. Direct port of
 * src/lib/parsers/md.ts's `stripMarkdown()` (the canonical source — the
 * Python CLI's `_strip_markdown` is itself a line-for-line port of this).
 * Handles: headings, bold, italic, code blocks, inline code, links, images,
 * blockquotes, horizontal rules, lists.
 */
export function stripMarkdown(md: string): string {
	return md
		// Fenced code blocks → keep content, remove fences
		.replace(/```[\w]*\n([\s\S]*?)```/g, '$1')
		// Inline code
		.replace(/`([^`]+)`/g, '$1')
		// ATX headings (# ## ### etc.)
		.replace(/^#{1,6}\s+(.+)$/gm, '$1')
		// Bold + italic ***text***
		.replace(/\*{3}(.+?)\*{3}/g, '$1')
		// Bold **text** or __text__
		.replace(/(\*{2}|_{2})(.+?)\1/g, '$2')
		// Italic *text* or _text_
		.replace(/(\*|_)(.+?)\1/g, '$2')
		// Strikethrough ~~text~~
		.replace(/~~(.+?)~~/g, '$1')
		// Images ![alt](url) → alt text
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
		// Links [text](url) → text
		.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
		// Reference links [text][ref] → text
		.replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
		// Blockquotes
		.replace(/^>\s?/gm, '')
		// Horizontal rules
		.replace(/^[-*_]{3,}\s*$/gm, '')
		// Unordered list markers
		.replace(/^[\s]*[-*+]\s+/gm, '')
		// Ordered list markers
		.replace(/^[\s]*\d+\.\s+/gm, '')
		// HTML tags
		.replace(/<[^>]+>/g, '')
		// Multiple blank lines → single blank line
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

/**
 * Decode `bytes` as UTF-8 text, stripping a leading BOM if present.
 *
 * Throws {@link Cfp1TextDecodeError} if the bytes aren't valid UTF-8 —
 * callers should catch this and fall back to raw/vault encryption instead
 * of failing the whole encrypt call.
 */
function readTextStrippingBom(bytes: Uint8Array): string {
	let b = bytes;
	if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) {
		b = b.subarray(3);
	}
	try {
		return _fatalDecoder.decode(b);
	} catch {
		throw new Cfp1TextDecodeError('file is not valid UTF-8 text');
	}
}

/** A CesvuDocument-shaped object, loosely typed (mirrors src/lib/schema.ts). */
export interface Cfp1DocJson {
	id: string;
	version: number;
	name: string;
	sourceType: string;
	createdAt: number;
	updatedAt: number;
	text: string;
	paragraphs: unknown[];
	rawContent: null;
	splits: { manual: unknown[]; auto: unknown[]; mode: string };
	profile: null;
	clauses: unknown[];
	annotations: unknown[];
	messages: unknown[];
}

function buildDocJson(name: string, sourceType: DocumentSourceType, text: string): Uint8Array {
	const nowMs = Date.now();
	const doc: Cfp1DocJson = {
		id: randomUUID(),
		version: CESVU_SCHEMA_VERSION,
		name,
		sourceType,
		createdAt: nowMs,
		updatedAt: nowMs,
		text,
		paragraphs: [],
		rawContent: null,
		splits: { manual: [], auto: [], mode: 'manual' },
		profile: null,
		clauses: [],
		annotations: [],
		messages: []
	};
	// JSON.stringify never escapes non-ASCII by default, matching the
	// browser's own JSON.stringify() output and giving byte-for-byte
	// consistency with what exportAsCesvu() would write for identical
	// content (unlike Python's default ensure_ascii=True, which the CLI
	// must explicitly disable).
	return _encoder.encode(JSON.stringify(doc));
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
	const total = parts.reduce((n, p) => n + p.length, 0);
	const out = new Uint8Array(total);
	let off = 0;
	for (const p of parts) {
		out.set(p, off);
		off += p.length;
	}
	return out;
}

function u32be(n: number): Uint8Array {
	const out = new Uint8Array(4);
	new DataView(out.buffer).setUint32(0, n, false);
	return out;
}

/**
 * Build the CFP1-framed plaintext buffer that should be handed to
 * `encryptCesvu`/`encryptCesvuStream` in place of the raw file bytes, for
 * `fileBytes` (named `name`) detected as `sourceType` ('txt' | 'md' | 'csv').
 *
 * Throws {@link Cfp1TextDecodeError} for 'txt'/'md' if the file isn't valid
 * UTF-8 text; 'csv' never throws this, since its bytes are carried raw with
 * no decoding, matching the browser's own ArrayBuffer-based handling of CSV
 * files.
 */
export function buildCfp1DocumentPlaintext(
	name: string,
	sourceType: DocumentSourceType,
	fileBytes: Uint8Array
): Uint8Array {
	if (sourceType === 'csv') {
		// Matches Workspace.svelte's fileText() ("csv/excel have no
		// plain-text body") and rawContentBytes() (raw ArrayBuffer, carried
		// as the CFP1 raw section) — the CSV's raw bytes are the ONLY
		// payload the viewer needs.
		const docJson = buildDocJson(name, sourceType, '');
		return concatBytes(PAYLOAD_MAGIC, u32be(docJson.length), docJson, fileBytes);
	}

	let text = readTextStrippingBom(fileBytes);
	if (sourceType === 'txt') {
		// Matches parseTXT()'s `.trim()`.
		text = text.trim();
	} else if (sourceType === 'md') {
		// Matches fileText()'s md branch, which sends parseMD()'s
		// markdown-STRIPPED parsedData as `text`, not the raw markdown.
		text = stripMarkdown(text);
	}

	const docJson = buildDocJson(name, sourceType, text);
	return concatBytes(PAYLOAD_MAGIC, u32be(docJson.length), docJson);
}

// ── decrypt-side: unwrapping CFP1 framing back to plain content ─────────

/**
 * How much USER-AUTHORED structured data a CFP1 document carries that this
 * package's decrypt path cannot represent as a plain output file.
 *
 * Counts, not booleans, so a caller can tell the user exactly what is in
 * the file ("3 notes and 1 marked clause") instead of a vague "may contain
 * notes". DERIVED data (`profile`, `splits.auto`) is deliberately NOT
 * counted — see {@link countUnrestorableExtras}.
 */
export class UnrestorableExtras {
	readonly notes: number;
	readonly marks: number;
	readonly messages: number;
	readonly manualSplits: number;

	constructor(init: { notes?: number; marks?: number; messages?: number; manualSplits?: number } = {}) {
		this.notes = init.notes ?? 0;
		this.marks = init.marks ?? 0;
		this.messages = init.messages ?? 0;
		this.manualSplits = init.manualSplits ?? 0;
	}

	get total(): number {
		return this.notes + this.marks + this.messages + this.manualSplits;
	}

	/**
	 * Human phrase naming ONLY the non-zero categories, correctly
	 * pluralized: "3 notes", "1 marked clause and 2 chat messages", etc.
	 * Returns "" when nothing is present (callers should check `total`).
	 */
	describe(): string {
		const parts: string[] = [];
		const entries: Array<[number, string, string]> = [
			[this.notes, 'note', 'notes'],
			[this.marks, 'marked clause', 'marked clauses'],
			[this.messages, 'chat message', 'chat messages'],
			[this.manualSplits, 'manual clause split', 'manual clause splits']
		];
		for (const [count, singular, plural] of entries) {
			if (count) parts.push(`${count} ${count === 1 ? singular : plural}`);
		}
		if (parts.length === 0) return '';
		if (parts.length === 1) return parts[0];
		return parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1];
	}
}

function countList(value: unknown): number {
	return Array.isArray(value) ? value.length : 0;
}

/**
 * Count the user-authored structured data in `doc` that this package has no
 * viewer for and cannot write into a plain output file.
 *
 * Counted (only ever non-empty through deliberate user action):
 *   - `annotations` — notes the user typed
 *   - `clauses`     — clause highlights the user marked
 *   - `messages`    — the user's chat history
 *   - `splits.manual` — clause boundaries the user placed by hand
 *
 * NOT counted, because it is DERIVED rather than authored: `profile` (the
 * built contract analysis, recomputed automatically on open) and
 * `splits.auto` (likewise recomputed by the clause splitter on open).
 */
export function countUnrestorableExtras(doc: Record<string, unknown>): UnrestorableExtras {
	const splits = doc.splits;
	const manualSplits =
		splits && typeof splits === 'object' && !Array.isArray(splits)
			? countList((splits as Record<string, unknown>).manual)
			: 0;
	return new UnrestorableExtras({
		notes: countList(doc.annotations),
		marks: countList(doc.clauses),
		messages: countList(doc.messages),
		manualSplits
	});
}

const NO_EXTRAS = new UnrestorableExtras();

function looksLikeValidCfp1Doc(doc: unknown): doc is Record<string, unknown> {
	if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return false;
	const d = doc as Record<string, unknown>;
	return (
		typeof d.sourceType === 'string' &&
		VALID_SOURCE_TYPES.has(d.sourceType) &&
		typeof d.text === 'string' &&
		typeof d.id === 'string' &&
		typeof d.version === 'number'
	);
}

/** Result of {@link unwrapCfp1Plaintext}. */
export interface UnwrapResult {
	/** True if `plaintext` was recognized as genuine CFP1 document framing. */
	isDocument: boolean;
	/**
	 * True only when `content` came from `doc.text` for a type that
	 * normally carries the original file as a raw section
	 * ('csv'/'excel'/'pdf'/'docx') and that section was empty — i.e. the
	 * sender excluded the original file at export time. Always false for
	 * 'txt'/'md' (using `text` there is expected, not a fallback) and
	 * always false when `isDocument` is false.
	 */
	isTextFallback: boolean;
	/**
	 * Counts of user-authored structured data (notes / marked clauses /
	 * chat / manual splits) this package has no viewer for and cannot
	 * write into a plain output file. All-zero when `isDocument` is false.
	 */
	extras: UnrestorableExtras;
	/**
	 * The unwrapped content: raw section bytes (full fidelity) if present,
	 * else `doc.text` UTF-8 encoded. If `isDocument` is false, this is
	 * `plaintext` itself, completely unchanged.
	 */
	content: Uint8Array;
	/** The parsed CFP1 document JSON, or `null` if `isDocument` is false. */
	doc: Record<string, unknown> | null;
}

/**
 * Given `plaintext` (the decrypted plaintext of a .cesvu file), detect
 * whether it's CFP1 document framing and, if so, return just the
 * underlying content instead — the symmetric counterpart to
 * {@link buildCfp1DocumentPlaintext} / the web app's `exportAsCesvu()`.
 *
 * Works for ANY CFP1-framed file — whether produced by this package
 * (txt/md/csv only), the Python CLI (txt/md/csv only), or the web app's own
 * Export button (all six SourceTypes: txt/md/csv/pdf/docx/excel).
 *
 * Structural validation happens BEFORE any unwrapping, so a raw/vault
 * plaintext that merely happens to start with the 4 bytes 'CFP1' (or has a
 * corrupted/truncated length) is never misinterpreted as a document —
 * `isDocument` is `false` and `content` is `plaintext`, byte-for-byte
 * unchanged.
 */
export function unwrapCfp1Plaintext(plaintext: Uint8Array): UnwrapResult {
	const passthrough = (): UnwrapResult => ({
		isDocument: false,
		isTextFallback: false,
		extras: NO_EXTRAS,
		content: plaintext,
		doc: null
	});

	if (
		plaintext.length < PAYLOAD_HEADER_LEN ||
		plaintext[0] !== PAYLOAD_MAGIC[0] ||
		plaintext[1] !== PAYLOAD_MAGIC[1] ||
		plaintext[2] !== PAYLOAD_MAGIC[2] ||
		plaintext[3] !== PAYLOAD_MAGIC[3]
	) {
		return passthrough();
	}

	const dv = new DataView(plaintext.buffer, plaintext.byteOffset, plaintext.byteLength);
	const docLen = dv.getUint32(4, false);
	const need = PAYLOAD_HEADER_LEN + docLen;
	if (need > plaintext.length) {
		// Declared length exceeds the actual plaintext — not a genuine
		// CFP1 file (or it's truncated/corrupted). Fail safe: passthrough.
		return passthrough();
	}

	const docJsonBytes = plaintext.subarray(PAYLOAD_HEADER_LEN, need);
	let doc: unknown;
	try {
		doc = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(docJsonBytes));
	} catch {
		return passthrough();
	}

	if (!looksLikeValidCfp1Doc(doc)) {
		return passthrough();
	}

	const sourceType = doc.sourceType as string;
	const extras = countUnrestorableExtras(doc);
	const rawSection = plaintext.subarray(need);

	if (rawSection.length > 0) {
		// Raw section present: the ORIGINAL file bytes are the content,
		// regardless of sourceType.
		return { isDocument: true, isTextFallback: false, extras, content: rawSection, doc };
	}

	// Raw section empty: fall back to `text`. Expected/native for txt/md;
	// a fallback (worth warning about) for every other type.
	const isFallback = !TEXT_IS_NATIVE_CONTENT.has(sourceType);
	return {
		isDocument: true,
		isTextFallback: isFallback,
		extras,
		content: _encoder.encode(doc.text as string),
		doc
	};
}
