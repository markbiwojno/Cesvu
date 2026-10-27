// SPDX-License-Identifier: Apache-2.0

/**
 * file-io.ts — filesystem convenience wrappers around cesvu-crypto's
 * in-memory encrypt/decrypt API, using {@link withAtomicWriter} so a
 * killed process never leaves a corrupted-but-plausible output file.
 *
 * These are thin conveniences, not a required entry point — anyone doing
 * their own I/O (streaming from S3, etc.) should call
 * `encryptCesvuStream`/`decryptCesvuStream` from `./cesvu-crypto`
 * directly and write with `withAtomicWriter` themselves.
 *
 * ── Document (CFP1) vs. raw/vault framing ───────────────────────────────
 * By default, a recognized plain-text extension (.txt/.md/.csv) is wrapped
 * in the same CFP1 document framing the web app's own Export button
 * produces (see `./document.js`), so the file opens directly in
 * cesvu.com's viewer on import instead of falling into the "raw vault"
 * download-only path — matching the Python CLI's default `cesvu encrypt`
 * behavior (see CLI/cesvu/src/cesvu/cli.py, CLI/cesvu/src/cesvu/document.py).
 * Pass `rawOnly: true` to force the old raw/vault behavior (recipient
 * always gets a plain download) even for a recognized type — the
 * equivalent of the CLI's `--download` flag. Unsupported types
 * (pdf/docx/xlsx/images/zips/etc.) always use raw/vault framing; `rawOnly`
 * is a no-op for them since there is nothing to opt out of.
 *
 * Symmetrically, `decryptCesvuFile`/`decryptCesvuFileToDirectory` default
 * to unwrapping CFP1 framing (from either this package, the Python CLI, or
 * the web app itself) back to plain content, so the decrypted output file
 * contains just the human content — not the raw CFP1 envelope (magic bytes
 * + JSON metadata + payload). Pass `rawOnly: true` to skip unwrapping and
 * write the decrypted plaintext verbatim.
 */

import * as path from 'node:path';
import { withAtomicWriter, readFileBytes } from './atomic-io.js';
import {
	chooseOutputName,
	forceTextExtension,
	type ChooseOutputNameOptions
} from './output-names.js';

import {
	encryptCesvu,
	decryptCesvu,
	type EncryptOptions,
	type DecryptedCesvu,
	type PassphraseType
} from './cesvu-crypto.js';
import {
	detectDocumentSourceType,
	buildCfp1DocumentPlaintext,
	unwrapCfp1Plaintext,
	Cfp1TextDecodeError,
	UnrestorableExtras
} from './document.js';


export interface EncryptFileOptions extends Omit<EncryptOptions, 'metadata'> {
	/**
	 * Metadata to embed. If omitted, `filename`/`mimeType` are inferred
	 * from `sourcePath` (basename) and default to `text/plain`, and
	 * `createdAt` defaults to `Date.now()`.
	 */
	metadata?: EncryptOptions['metadata'];
	/**
	 * `true` to skip CFP1 document auto-framing entirely and always
	 * encrypt the raw file bytes verbatim, even for a recognized
	 * .txt/.md/.csv extension — the equivalent of the Python CLI's
	 * `--download` flag. Default `false` (auto-frame when recognized).
	 */
	rawOnly?: boolean;
}

/**
 * Read `sourcePath`, encrypt it into a .cesvu v1 file, and atomically
 * write the result to `destPath`.
 *
 * By default, a recognized `.txt`/`.md`/`.csv` extension is auto-framed as
 * a CFP1 document (see module docs above) so it opens in the cesvu.com
 * viewer on import; pass `rawOnly: true` to opt out.
 */
export async function encryptCesvuFile(
	sourcePath: string,
	destPath: string,
	passphrase: string,
	options: EncryptFileOptions = {}
): Promise<void> {
	const fileBytes = await readFileBytes(sourcePath);

	let plaintext: Uint8Array = fileBytes;
	let isDocument = false;

	if (!options.rawOnly) {
		const sourceType = detectDocumentSourceType(sourcePath);
		if (sourceType !== null) {
			try {
				plaintext = buildCfp1DocumentPlaintext(path.basename(sourcePath), sourceType, fileBytes);
				isDocument = true;
			} catch (err) {
				if (err instanceof Cfp1TextDecodeError) {
					// Not valid UTF-8 text despite the extension — fall back
					// to raw/vault framing rather than failing the whole
					// encrypt call.
					plaintext = fileBytes;
				} else {
					throw err;
				}
			}
		}
	}

	const metadata =
		options.metadata ??
		({
			filename: path.basename(sourcePath),
			// Matches the Python CLI: a document gets 'application/json'
			// (the CFP1 envelope's real content type); everything else
			// gets 'application/octet-stream'.
			mimeType: isDocument ? 'application/json' : 'application/octet-stream',
			// Milliseconds since Unix epoch — MUST match the web app
			// (`Date.now()` in vault-io.ts) and the CLI
			// (`int(time.time() * 1000)` in cli.py). Do not divide by 1000;
			// `createdAt` is defined format-wide as epoch millis, not seconds.
			createdAt: Date.now()
		} satisfies EncryptOptions['metadata']);


	const ciphertext = await encryptCesvu(plaintext, passphrase, {
		...options,
		metadata
	});

	await withAtomicWriter(destPath, async (write) => {
		await write(ciphertext);
	});
}

export interface DecryptFileResult extends Omit<DecryptedCesvu, 'plaintext'> {
	/** Path the decrypted plaintext was written to. */
	destPath: string;
	/**
	 * `true` if the decrypted plaintext was recognized as CFP1 document
	 * framing (produced by this package, the Python CLI, or the web app's
	 * Export button) and unwrapped to just its human content before being
	 * written to `destPath`. Always `false` if `rawOnly` was passed.
	 */
	isDocument: boolean;
	/**
	 * `true` only when the written content came from the document's
	 * `text` field for a type that normally carries the original file as
	 * a raw section (csv/excel/pdf/docx) and that section was empty — i.e.
	 * the sender excluded the original file at export time. Always
	 * `false` for txt/md and always `false` when `isDocument` is `false`.
	 */
	isTextFallback: boolean;
	/**
	 * Counts of user-authored structured data (notes / marked clauses /
	 * chat / manual splits) carried by the document that has no
	 * representation in the plain output file at `destPath`. Purely
	 * informational — `extras.total === 0` means there is nothing to warn
	 * about. All-zero when `isDocument` is `false`.
	 */
	extras: UnrestorableExtras;
}

export interface DecryptFileOptions {
	/**
	 * `true` to skip CFP1 document unwrapping and write the decrypted
	 * plaintext verbatim, even if it's CFP1-framed. Default `false`
	 * (unwrap automatically when framing is detected).
	 */
	rawOnly?: boolean;
}

/**
 * Read `sourcePath` (a .cesvu v1 file), decrypt it, and atomically write
 * the recovered plaintext to `destPath`. Returns the recovered metadata
 * (original filename, mime type, etc.) without the plaintext bytes
 * (already on disk at `destPath`).
 *
 * By default, CFP1 document framing (from this package, the Python CLI, or
 * the web app) is unwrapped so `destPath` contains just the human content;
 * pass `options.rawOnly: true` to write the plaintext verbatim instead.
 */
export async function decryptCesvuFile(
	sourcePath: string,
	destPath: string,
	passphrase: string,
	preferredType?: PassphraseType,
	options: DecryptFileOptions = {}
): Promise<DecryptFileResult> {
	const bytes = await readFileBytes(sourcePath);
	const result = await decryptCesvu(bytes, passphrase, preferredType);

	let content = result.plaintext;
	let isDocument = false;
	let isTextFallback = false;
	let extras = new UnrestorableExtras();

	if (!options.rawOnly) {
		const unwrapped = unwrapCfp1Plaintext(result.plaintext);
		isDocument = unwrapped.isDocument;
		isTextFallback = unwrapped.isTextFallback;
		extras = unwrapped.extras;
		content = unwrapped.content;
	}

	await withAtomicWriter(destPath, async (write) => {
		await write(content);
	});

	const { plaintext: _plaintext, ...rest } = result;
	return { ...rest, destPath, isDocument, isTextFallback, extras };
}

export interface DecryptFileToDirectoryOptions {
	/** Receives human-readable warnings (metadata filename rejected and a
	 * fallback/substitute name used, collision avoided, etc.). */
	warn?: (message: string) => void;
	/** Passphrase profile hint forwarded to `decryptCesvu`. */
	preferredType?: PassphraseType;
	/**
	 * `true` to skip CFP1 document unwrapping and write the decrypted
	 * plaintext verbatim, even if it's CFP1-framed. Default `false`
	 * (unwrap automatically when framing is detected).
	 */
	rawOnly?: boolean;
}

/**
 * Read `sourcePath` (a .cesvu v1 file), decrypt it, and atomically write
 * the recovered plaintext to a SAFE, validated filename inside `destDir`
 * — chosen from the file's own (untrusted, authenticated-but-not-trusted)
 * `metadata.filename`, per the filename-safety policy in
 * `./output-names.js` (ported from the Python CLI's `output_names.py`;
 * see `.cesvu SPEC/README.md` § "metadata.filename is AUTHENTICATED, not
 * TRUSTED").
 *
 * Unlike {@link decryptCesvuFile} — where the caller supplies a complete
 * destination path they chose themselves, so nothing needs filtering —
 * this function is for the "just give me a directory" case, where the
 * actual filename necessarily comes from the untrusted file. The chosen
 * name:
 *   - is rejected (and a fallback derived from `sourcePath`'s basename
 *     used instead) if it contains path separators, is absolute/rooted/
 *     drive-qualified, uses reserved Windows characters/device names,
 *     ends in a dot/space, contains control characters, isn't valid
 *     UTF-8, or exceeds 255 bytes;
 *   - will NEVER overwrite an existing file — the caller never saw this
 *     name, so consent to overwrite cannot be inferred. Colliding names
 *     advance to `name (1)`, `name (2)`, … up to `MAX_CANDIDATE_ATTEMPTS`
 *     before throwing {@link OutputNameExhausted}.
 *
 * There is no option to disable this filtering — see the README section
 * "Safe decrypt-to-directory" for why.
 *
 * By default, CFP1 document framing is unwrapped (see
 * {@link decryptCesvuFile}'s docs); pass `options.rawOnly: true` to opt
 * out.
 */
export async function decryptCesvuFileToDirectory(
	sourcePath: string,
	destDir: string,
	passphrase: string,
	options: DecryptFileToDirectoryOptions = {}
): Promise<DecryptFileResult> {
	const bytes = await readFileBytes(sourcePath);
	const result = await decryptCesvu(bytes, passphrase, options.preferredType);

	let content = result.plaintext;
	let isDocument = false;
	let isTextFallback = false;
	let extras = new UnrestorableExtras();

	if (!options.rawOnly) {
		const unwrapped = unwrapCfp1Plaintext(result.plaintext);
		isDocument = unwrapped.isDocument;
		isTextFallback = unwrapped.isTextFallback;
		extras = unwrapped.extras;
		content = unwrapped.content;
	}

	const fallback = path.basename(sourcePath).replace(/\.cesvu$/i, '') || 'decrypted.out';

	// A text-fallback document (isTextFallback) writes EXTRACTED TEXT, not
	// the original binary file — even though `result.metadata.filename`
	// is still the ORIGINAL file's name (e.g. "contract-final.pdf").
	// Writing that name unchanged onto extracted plain text would hand
	// back a file whose extension lies about its own format: an
	// OS/associated app expects real PDF/DOCX/XLSX bytes, finds plain
	// text instead, and reports it as corrupted. Since this function
	// (unlike decryptCesvuFile) chooses the output name itself, correct
	// it before the candidate-collision search runs, so `name (1).txt`,
	// `name (2).txt`, … and the already-.txt fallback all operate on the
	// corrected name from the start.
	const preferredName =
		isTextFallback && result.metadata.filename
			? forceTextExtension(result.metadata.filename)
			: result.metadata.filename;
	const fallbackBasename = isTextFallback ? forceTextExtension(fallback) : fallback;

	const chosenOpts: ChooseOutputNameOptions = { neverOverwrite: true };
	if (options.warn) chosenOpts.warn = options.warn;

	const chosenName = await chooseOutputName(destDir, preferredName, fallbackBasename, chosenOpts);
	const destPath = path.join(destDir, chosenName);


	await withAtomicWriter(destPath, async (write) => {
		await write(content);
	});

	const { plaintext: _plaintext, ...rest } = result;
	return { ...rest, destPath, isDocument, isTextFallback, extras };
}
