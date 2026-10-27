/**
 * src/lib/crypto/vault-io.ts — streaming encrypt-to-disk / decrypt-to-disk
 * for the "vault" flows:
 *
 *   - exportRawFileToVault(): a dropped file whose type the in-app viewer
 *     doesn't support (see vault-constants.ts's isVaultCandidate) is
 *     encrypted with a freshly generated diceware/emoji passphrase and
 *     written straight to a location the user picks, WITHOUT ever loading
 *     the whole file into memory (Chromium fast path). This is the
 *     "unlimited filesize" streaming save described in the DICOM-era
 *     README (see /dicom/DICOM_STREAMING_INFO.txt §9).
 *
 *   - importVaultFileToDisk(): a dropped `.cesvu` file over
 *     VAULT_IMPORT_STREAM_THRESHOLD_BYTES is decrypted straight to a
 *     location the user picks (or, lacking that browser API, a normal
 *     download), instead of being loaded into memory and parsed by the
 *     in-app viewer.
 *
 * Both functions have four tiers, in preference order:
 *   1. `showSaveFilePicker` (Chromium): true zero-buffer streaming straight
 *      to a user-chosen location on disk.
 *   2. Service-worker streaming download (Firefox/Safari, and any secure
 *      context with service workers): bytes are streamed through
 *      `static/vault-download-sw.js` directly to the browser's download
 *      manager. O(one chunk) memory, NOTHING staged on disk, and the
 *      response carries a real `Content-Disposition: attachment` header.
 *      No "choose folder" dialog (the file lands in the downloads folder).
 *   3. OPFS scratch file + `<a download>` (any browser with OPFS, no
 *      service worker): still O(chunk) JS-heap memory — the browser reads
 *      the finished OPFS file lazily off disk during the download — but it
 *      must stage the full output on disk first, and has an inherent race
 *      between deleting that scratch file and the browser finishing its
 *      lazy read (there is no download-completion event to synchronize
 *      with). That race is why this tier now sits BELOW the streaming one:
 *      on a large file it could yank the scratch file out from under an
 *      in-progress download, which Firefox reported as
 *      "can't find the file at blob:…".
 *   4. Full in-memory one-shot (only reached if OPFS itself is also
 *      unavailable, e.g. some older mobile browsers): bounded only by
 *      available memory. Last resort, not the common case.
 */


import {
	encryptCesvuStream,
	decryptCesvuStream,
	encryptCesvu,
	decryptCesvu,
	generateDicewarePassphrase,
	generateEmojiPassphrase,
	type CesvuMetadata,
	type PassphraseType
} from './cesvu-crypto.js';

import {
	opfsAvailable,
	openVaultScratchWritable,
	downloadOpfsFile
} from '$lib/stores/vault-opfs-scratch.js';

import {
	beginStreamingDownload,
	DownloadCancelledError
} from '$lib/stores/vault-download-stream.js';


import { buildCesvuDownloadName } from '$lib/utils/cesvu-filename.js';


/** Thrown when the user dismisses the native save-location picker without
 *  choosing a file. Callers should treat this as a silent cancel, not an
 *  error to display. */
export class VaultCancelledError extends Error {
	constructor() {
		super('The save dialog was cancelled.');
		this.name = 'VaultCancelledError';
	}
}

export interface VaultProgress {
	bytesProcessed: number;
	totalBytes: number;
}

/** True when this browser exposes the File System Access API's
 *  `showSaveFilePicker` (Chromium-family only, as of writing). */
export function saveFilePickerAvailable(): boolean {
	return typeof window !== 'undefined' && typeof (window as unknown as {
		showSaveFilePicker?: unknown;
	}).showSaveFilePicker === 'function';
}

type SaveFilePickerFn = (options?: {
	suggestedName?: string;
	types?: { description?: string; accept: Record<string, string[]> }[];
}) => Promise<FileSystemFileHandle>;

function getSaveFilePicker(): SaveFilePickerFn {
	return (window as unknown as { showSaveFilePicker: SaveFilePickerFn }).showSaveFilePicker;
}

/** Turn a `File` into an async iterable of raw byte chunks via its native
 *  stream reader — never materializing the whole file at once. Manual
 *  reader loop (not `for await...of file.stream()`) for broad browser
 *  support (older Safari didn't implement ReadableStream's async
 *  iterator protocol). */
async function* fileToAsyncChunks(file: File): AsyncGenerator<Uint8Array, void, undefined> {
	const reader = file.stream().getReader();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return;
			if (value && value.length > 0) yield value;
		}
	} finally {
		try {
			reader.releaseLock();
		} catch {
			/* best-effort */
		}
	}
}

/** Trigger a normal browser download of an in-memory Blob. Used only by the
 *  last-resort (no File System Access API, no OPFS) fallback tier. */
function triggerBlobDownload(blob: Blob, filename: string): void {
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	a.remove();
	URL.revokeObjectURL(url);
}

/** Was the user-cancel signal — the native picker throws a DOMException
 *  named 'AbortError' when the user dismisses it without choosing. */
function isPickerAbort(err: unknown): boolean {
	return err instanceof DOMException && err.name === 'AbortError';
}

/**
 * True for Chromium's transient `FileSystemWritableFileStream` failure:
 * "An operation that depends on state cached in an interface object was
 * made but the state had changed since it was read from disk."
 *
 * This is a `NotReadableError` DOMException thrown by `write()`/`close()`
 * on the hidden swap-file rename Chromium performs under the hood for
 * `showSaveFilePicker` writes. It fires when something else touches the
 * destination path mid-write (AV real-time scanning, Windows Search
 * Indexer, a backup tool, etc.) — NOT a bug in our encrypt/decrypt logic.
 * It is transient: retrying the whole write (fresh `createWritable()` on
 * the same handle, re-running the source stream from the start) very
 * often succeeds once the interfering process has moved on. Matched by
 * both `.name` (when Chromium sets it) and message text (observed cases
 * where `.name` is generic but the message is this specific string), so
 * we don't silently swallow unrelated NotReadableErrors under a vague
 * name check alone.
 */
function isTransientWriteStateError(err: unknown): boolean {
	if (!(err instanceof DOMException)) return false;
	if (err.name === 'NotReadableError') return true;
	return /state had changed since it was read from disk/i.test(err.message);
}

/** Small delay helper for the retry backoff below. */
function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Extract a `.ext` suffix (lowercase, dot included) from a filename, or
 * `''` if there isn't one. Used to build the `showSaveFilePicker` `types`
 * entry so the native save dialog associates and preserves the ORIGINAL
 * file's extension (e.g. `.zip`) instead of falling back to an
 * extension-less "All Files" filter, which on Windows (with "Hide
 * extensions for known file types" enabled) can result in the actual
 * saved file silently losing its extension even though the in-app
 * success message still shows the correct original name.
 */
function extensionOf(filename: string): string {
	const idx = filename.lastIndexOf('.');
	// No dot, or a dot with nothing after it, or a leading dot with no
	// name before it (e.g. ".gitignore" — treat as no extension since
	// there's no meaningful "base name" to pair it with here).
	if (idx <= 0 || idx === filename.length - 1) return '';
	return filename.slice(idx).toLowerCase();
}

/**
 * Build a human-readable `types[].description` for the save picker from an
 * extension, e.g. `.zip` → "ZIP file", `.mp4` → "MP4 file". This is a pure
 * mechanical transform (uppercase the extension, no lookup table), so it
 * works identically for common AND rare/unknown extensions alike — there's
 * nothing to "fall out of" a dictionary for.
 *
 * Falls back to the generic "Original file type" only when `ext` doesn't
 * look like a plausible extension: empty, longer than a real-world
 * extension ever reasonably is (e.g. a dot-separated version string like
 * "final version (2)" mistaken for an extension), or containing characters
 * an extension wouldn't (spaces, parens, etc.). Real-world extensions are
 * alphanumeric and short (the longest common ones — "jpeg", "docx",
 * "sqlite3" — top out around 7-8 chars; 12 gives comfortable headroom
 * without accepting garbage).
 */
function describeExtension(ext: string): string {
	const bare = ext.replace(/^\./, '');
	if (bare.length === 0 || bare.length > 12 || !/^[a-z0-9]+$/i.test(bare)) {
		return 'Original file type';
	}
	return `${bare.toUpperCase()} file`;
}

/**
 * Lowercased extension (with leading dot, e.g. ".zip") → registered MIME
 * type. Used so the `showSaveFilePicker` `accept` dictionary and the
 * downloaded Blob's `type` never fall back to the generic
 * `application/octet-stream`, which Windows Explorer's save dialog can
 * treat as "no real file type" and silently strip the extension from the
 * saved file even though the suggested/download filename showed it
 * correctly. Pure lookup; `null` for unknown extensions so callers can
 * fall back to whatever type info they already have.
 */
const EXT_TO_MIME: Readonly<Record<string, string>> = {
	'.zip': 'application/zip',
	'.pdf': 'application/pdf',
	'.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
	'.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
	'.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
	'.odt': 'application/vnd.oasis.opendocument.text',
	'.ods': 'application/vnd.oasis.opendocument.spreadsheet',
	'.csv': 'text/csv',
	'.tsv': 'text/tab-separated-values',
	'.txt': 'text/plain',
	'.md': 'text/markdown',
	'.json': 'application/json',
	'.xml': 'application/xml',
	'.html': 'text/html',
	'.htm': 'text/html',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.webp': 'image/webp',
	'.svg': 'image/svg+xml',
	'.bmp': 'image/bmp',
	'.ico': 'image/x-icon',
	'.tif': 'image/tiff',
	'.tiff': 'image/tiff',
	'.mp4': 'video/mp4',
	'.mov': 'video/quicktime',
	'.avi': 'video/x-msvideo',
	'.mkv': 'video/x-matroska',
	'.webm': 'video/webm',
	'.mp3': 'audio/mpeg',
	'.wav': 'audio/wav',
	'.ogg': 'audio/ogg',
	'.flac': 'audio/flac',
	'.m4a': 'audio/mp4',
	'.7z': 'application/x-7z-compressed',
	'.tar': 'application/x-tar',
	'.gz': 'application/gzip',
	'.tgz': 'application/gzip',
	'.bz2': 'application/x-bzip2',
	'.xz': 'application/x-xz',
	'.rar': 'application/vnd.rar',
	'.iso': 'application/x-iso9660-image',
	'.dmg': 'application/x-apple-diskimage',
	'.exe': 'application/x-msdownload',
	'.msi': 'application/x-msdownload',
	'.apk': 'application/vnd.android.package-archive',
	'.wasm': 'application/wasm'
};

/** Look up a registered MIME type for a file extension (lowercased, with
 *  leading dot). Returns `null` for unknown / missing extensions. */
function mimeForExt(ext: string): string | null {
	if (!ext) return null;
	return EXT_TO_MIME[ext.toLowerCase()] ?? null;
}




// ============================================================
// Export: encrypt an unsupported file into a .cesvu vault
// ============================================================

/**
 * Generate a fresh vault passphrase for `passphraseType`, WITHOUT doing any
 * encryption or I/O. Split out from the old `exportRawFileToVault` so
 * callers (see `SecureSaveModal.svelte`) can show the words to the user
 * FIRST and only start the actual (potentially disruptive — see
 * `writeVaultFile`'s doc comment) encrypt+save/download once the user has
 * confirmed they've stored the passphrase.
 *
 * Returns both the display `words` (for the UI grid) and the flattened
 * `passphrase` string `writeVaultFile` expects.
 */
export function generateVaultPassphrase(
	passphraseType: PassphraseType,
	/** Required when `passphraseType === 'raw'` — the user-chosen password. */
	rawPassphrase?: string
): Promise<{ words: string[]; passphrase: string }> {
	return (async () => {
		let words: string[];
		if (passphraseType === 'emoji') {
			words = await generateEmojiPassphrase(8);
		} else if (passphraseType === 'raw') {
			if (!rawPassphrase) {
				throw new Error(
					'generateVaultPassphrase: rawPassphrase is required when passphraseType is "raw"'
				);
			}
			words = [rawPassphrase];
		} else {
			words = await generateDicewarePassphrase(6);
		}
		const passphrase =
			passphraseType === 'emoji'
				? words.join('')
				: passphraseType === 'raw'
					? words[0]
					: words.join(' ');
		return { words, passphrase };
	})();
}

/**
 * Encrypt `file` (any type — this is for files the in-app viewer can't
 * open) with an ALREADY-GENERATED `passphrase` (see
 * {@link generateVaultPassphrase}) and write the result to a location the
 * user chooses.
 *
 * IMPORTANT (mobile Safari/Chrome): on the Tier 2/3/4 fallback paths below,
 * triggering a save-file-picker or browser download can fire a native,
 * disruptive "Do you want to download…" interstitial. On iOS this can race
 * and abort other in-flight work on the page (e.g. concurrent `<img>`
 * fetches), so callers MUST NOT invoke this until the user has already seen
 * and confirmed the passphrase — never call this eagerly during a
 * "generating" spinner phase. See `SecureSaveModal.svelte`'s `finish()` for
 * the correct call site.
 *
 * Throws {@link VaultCancelledError} if the user dismisses the native save
 * dialog (Chromium path only — there is no dialog to cancel on the OPFS/
 * in-memory fallback tiers, since those trigger a normal download instead).
 */
export async function writeVaultFile(
	file: File,
	passphrase: string,
	passphraseType: PassphraseType,
	onProgress?: (p: VaultProgress) => void
): Promise<void> {
	// Prefer a MIME type derived from the file's extension over the

	// browser-reported `file.type`, which is frequently empty or wrong.
	// The extension is the more reliable signal of what the user actually
	// expects this file to be (see EXT_TO_MIME's doc comment above).
	const metadata: CesvuMetadata = {
		filename: file.name,
		mimeType: mimeForExt(extensionOf(file.name)) || file.type || 'application/octet-stream',
		createdAt: Date.now()
	};

	const totalBytes = file.size;
	let bytesProcessed = 0;
	async function* trackedSource(): AsyncGenerator<Uint8Array, void, undefined> {
		for await (const chunk of fileToAsyncChunks(file)) {
			bytesProcessed += chunk.length;
			onProgress?.({ bytesProcessed, totalBytes });
			yield chunk;
		}
	}

	// Strip the original extension before appending .cesvu — the outer
	// filename is unencrypted and unauthenticated (anyone who merely sees
	// it sitting in a downloads folder or inbox can read it), so leaking
	// the original file's type via a doubled extension (e.g.
	// "passport-scan.jpg.cesvu") undercuts the zero-knowledge posture of
	// this app. See cesvu-filename.ts's doc comment for the full
	// rationale; this mirrors ExportModal.svelte's exportFileName().
	const suggestedName = buildCesvuDownloadName(file.name);


	// ── Tier 1: showSaveFilePicker (Chromium) — true streaming to disk ──
	if (saveFilePickerAvailable()) {
		let fileHandle: FileSystemFileHandle;
		try {
			fileHandle = await getSaveFilePicker()({
				suggestedName,
				types: [
					{
						description: 'CESVU file',
						accept: { 'application/octet-stream': ['.cesvu'] }
					}
				]
			});

		} catch (err) {
			if (isPickerAbort(err)) throw new VaultCancelledError();
			throw err;
		}

		// Chromium's showSaveFilePicker writes through a hidden swap file
		// and only atomically renames it over the real destination on
		// `.close()`. If anything else touches that destination path
		// mid-write (AV real-time scanning, Windows Search Indexer, a
		// backup tool, etc.), that final rename's state-validation can
		// fail with a transient NotReadableError — see
		// `isTransientWriteStateError`'s doc comment. This is NOT a bug
		// in our encrypt logic; retrying the ENTIRE write (fresh
		// `createWritable()` on the SAME handle, re-running the encrypt
		// stream from the start of `file`, which is always safely
		// re-readable) very often succeeds once whatever interfered has
		// moved on. We retry a bounded number of times with backoff
		// before giving up and falling through to Tier 2.
		const MAX_WRITE_ATTEMPTS = 3;
		const RETRY_DELAYS_MS = [300, 800];
		let lastErr: unknown = null;
		for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
			const writable = await fileHandle.createWritable();
			try {
				for await (const chunk of encryptCesvuStream(trackedSource(), passphrase, {
					metadata,
					passphraseType
				})) {
					await writable.write(chunk as FileSystemWriteChunkType);
				}
				await writable.close();
				return;
			} catch (err) {
				try {
					await writable.abort();
				} catch {
					/* best-effort */
				}
				if (isTransientWriteStateError(err) && attempt < MAX_WRITE_ATTEMPTS - 1) {
					lastErr = err;
					await delay(RETRY_DELAYS_MS[attempt] ?? 800);
					continue;
				}
				if (isTransientWriteStateError(err)) {
					// Retries exhausted — fall through to Tier 2 (OPFS +
					// download) below instead of surfacing this Chromium
					// quirk as a hard failure to the user.
					lastErr = err;
					break;
				}
				throw err;
			}
		}
		// Only reach here after exhausting retries on a transient error.
		// Fall through to Tier 2/3 below rather than returning — do NOT
		// `return` here, so this is intentionally a fallthrough, with
		// `lastErr` kept only for potential future logging.
		void lastErr;
	}


	// ── Tier 2: service-worker streaming download ──
	//
	// Streams ciphertext straight to the browser's download manager with no
	// staging file at all (see static/vault-download-sw.js). Preferred over
	// the OPFS tier below because that tier has an inherent race: it must
	// delete its scratch file at some point, but there is no
	// download-completion event to tell it when the browser has finished
	// lazily reading that file, so a large download can have the file
	// yanked out from under it.
	const dl = await beginStreamingDownload(suggestedName);
	if (dl) {
		try {
			for await (const chunk of encryptCesvuStream(trackedSource(), passphrase, {
				metadata,
				passphraseType
			})) {
				// `write()` resolves only when the worker asks for the next
				// chunk, so this loop is paced by the download itself and
				// never buffers more than one chunk.
				await dl.write(chunk);
			}
			await dl.close();
			return;
		} catch (err) {
			dl.abort(err instanceof Error ? err.message : String(err));
			// A browser-side cancel is the user declining the download —
			// surface it as the same silent-cancel signal the native save
			// dialog produces, so callers already handling that don't need
			// to learn a second error type.
			if (err instanceof DownloadCancelledError) throw new VaultCancelledError();
			throw err;
		}
	}

	// ── Tier 3: OPFS scratch file + <a download> ──
	if (opfsAvailable()) {
		const { writable, handle } = await openVaultScratchWritable();
		try {
			const writer = writable.getWriter();

			try {
				for await (const chunk of encryptCesvuStream(trackedSource(), passphrase, {
					metadata,
					passphraseType
				})) {
					await writer.write(chunk);
				}
				await writer.close();
			} catch (err) {
				try {
					await writer.abort(err);
				} catch {
					/* best-effort */
				}
				throw err;
			}
			const finished = await handle.getFile();
			downloadOpfsFile(finished, suggestedName);
		} finally {
			await handle.cleanup();
		}
		return;
	}

	// ── Tier 4: last resort — full in-memory (bounded only by available RAM) ──
	const bytes = new Uint8Array(await file.arrayBuffer());
	const encrypted = await encryptCesvu(bytes, passphrase, { metadata, passphraseType });

	const blob = new Blob([encrypted as BlobPart], { type: 'application/octet-stream' });
	triggerBlobDownload(blob, suggestedName);
	return;
}

// ============================================================
// Import: decrypt an oversized .cesvu straight to disk
// ============================================================

/**
 * Decrypt `file` (a `.cesvu` too large to open in the in-app viewer) with
 * `passphrase` and write the plaintext to a location the user chooses,
 * never buffering the whole plaintext in memory (Chromium path) or only
 * doing so as a last resort (see tier ordering in the doc comment above).
 *
 * Throws {@link VaultCancelledError} if the user dismisses the native save
 * dialog (Chromium path only). Throws `CesvuError('DECRYPT_FAILED')` (from
 * the underlying `decryptCesvuStream`/`decryptCesvu`) on a wrong
 * passphrase — callers should catch and map that the same way
 * `ImportModal.svelte` does.
 */
export async function importVaultFileToDisk(
	file: File,
	passphrase: string,
	preferredType: PassphraseType | undefined,
	onProgress?: (p: VaultProgress) => void
): Promise<{ metadata: CesvuMetadata; savedName: string }> {


	const totalBytes = file.size;
	let bytesProcessed = 0;
	async function* trackedSource(): AsyncGenerator<Uint8Array, void, undefined> {
		for await (const chunk of fileToAsyncChunks(file)) {
			bytesProcessed += chunk.length;
			onProgress?.({ bytesProcessed, totalBytes });
			yield chunk;
		}
	}

	// We don't know the ORIGINAL filename (it's inside the encrypted
	// envelope's metadata) until decryption reaches the metadata prefix,
	// which happens almost immediately (on the very first decrypted
	// chunk) — well before the save dialog needs to open. Fall back to
	// stripping the .cesvu suffix only if metadata is somehow never
	// parsed (shouldn't happen; decryptCesvuStream always yields
	// metadata before its first plaintext chunk on success).
	const fallbackName = file.name.toLowerCase().endsWith('.cesvu')
		? file.name.slice(0, -'.cesvu'.length)
		: `${file.name}.decrypted`;

	// ── Tier 1: showSaveFilePicker (Chromium) — true streaming to disk ──
	if (saveFilePickerAvailable()) {
		// Drive the decrypt generator up through metadata parsing BEFORE
		// opening the save dialog, so we can suggest the REAL original
		// filename (with its real extension, e.g. "archive.zip") instead
		// of a guessed name with no extension. This costs nothing extra —
		// the KDF derivation + first-chunk decrypt (which is where
		// metadata lives) has to happen regardless; we're just moving the
		// (already-required) save dialog to after it instead of before.
		// Still fully streaming: no plaintext bytes beyond the metadata
		// prefix are buffered — `firstChunk` below holds at most one
		// segment's worth of plaintext, exactly like every other chunk in
		// the loop.
		//
		// IMPORTANT: metadata is captured via the `onMetadata` callback, NOT
		// from the generator's RETURN value. The return value only arrives
		// after the LAST chunk, so reading the filename from it worked only
		// for files small enough to decrypt in a single chunk — every
		// multi-chunk (i.e. large) file fell back to `fallbackName`, which
		// is the outer `.cesvu` name minus its suffix and therefore has NO
		// extension (export deliberately strips the original one so the
		// unencrypted outer filename can't leak the file type). That was the
		// real reason large files were being saved without their extension.
		// `onMetadata` fires synchronously the instant the metadata prefix is
		// parsed, always strictly before the first plaintext chunk.
		let metadata: CesvuMetadata | null = null;
		const gen = decryptCesvuStream(trackedSource(), passphrase, preferredType, (m) => {
			metadata = m;
		});
		let firstChunk: Uint8Array | null = null;
		let generatorDone = false;
		try {
			const first = await gen.next();
			if (first.done) {
				metadata = first.value.metadata;
				generatorDone = true;
			} else {
				firstChunk = first.value;
			}
		} catch (err) {

			try {
				await gen.return(undefined as never);
			} catch {
				/* best-effort */
			}
			throw err;
		}

		const suggestedName = metadata?.filename || fallbackName;
		const ext = extensionOf(suggestedName);
		// Prefer a MIME type derived from the extension over the
		// producer's stored `metadata.mimeType`, which may be a generic
		// `application/octet-stream` for older/CLI-produced vault files.
		// Anchoring the dialog's `accept` entry to a specific, registered
		// MIME type — instead of the octet-stream catch-all — is what
		// stops Windows Explorer's save dialog from stripping the
		// extension from the suggested filename.
		const realMime = mimeForExt(ext) || metadata?.mimeType || null;
		let fileHandle: FileSystemFileHandle;
		try {
			fileHandle = await getSaveFilePicker()({
				suggestedName,
				...(ext && realMime
					? {
							types: [
								{
									description: describeExtension(ext),
									accept: { [realMime]: [ext] }
								}
							]
						}
					: {})

			});
		} catch (err) {
			try {
				await gen.return(undefined as never);
			} catch {
				/* best-effort */
			}
			if (isPickerAbort(err)) throw new VaultCancelledError();
			throw err;
		}


		const writable = await fileHandle.createWritable();
		try {
			if (firstChunk) {
				await writable.write(firstChunk as FileSystemWriteChunkType);
			}
			if (!generatorDone) {
				for (;;) {
					const { value, done } = await gen.next();
					if (done) {
						metadata = value.metadata;
						break;
					}
					await writable.write(value as FileSystemWriteChunkType);
				}
			}
			await writable.close();
			if (!metadata) {
				// Unreachable: decryptCesvuStream always calls onMetadata
				// (or resolves its return value's metadata) before
				// completing on success — every code path above sets
				// `metadata` before this point is reached.
				throw new Error('importVaultFileToDisk: decrypt completed without metadata (unreachable)');
			}
			// Report the file handle's ACTUAL name — reflects whatever the
			// user may have edited in the save dialog — rather than blindly
			// trusting `metadata.filename`, so the success message can never
			// lie about what was really written to disk.
			return { metadata, savedName: fileHandle.name };
		} catch (err) {
			try {
				await writable.abort();
			} catch {
				/* best-effort */
			}
			throw err;
		}
	}



	// ── Tier 2: service-worker streaming download ──
	//
	// The preferred Firefox/Safari path: plaintext is streamed straight to
	// the browser's download manager and never staged on disk at all, which
	// removes the OPFS tier's unwinnable cleanup race entirely (see
	// static/vault-download-sw.js) AND, because the response carries
	// `Content-Disposition: attachment`, can't be reinterpreted by the
	// browser as something to preview inline.
	{
		// The download's filename must be known before the response headers
		// are sent, so pull the generator just far enough for `onMetadata` to
		// fire (it always does so before the first plaintext chunk). The
		// first chunk is held and written below — at most one chunk of
		// plaintext is buffered, exactly as in the loop that follows.
		let metadata: CesvuMetadata | null = null;
		const gen = decryptCesvuStream(trackedSource(), passphrase, preferredType, (m) => {
			metadata = m;
		});

		let firstChunk: Uint8Array | null = null;
		let generatorDone = false;
		try {
			const first = await gen.next();
			if (first.done) {
				metadata = first.value.metadata;
				generatorDone = true;
			} else {
				firstChunk = first.value;
			}
		} catch (err) {
			try {
				await gen.return(undefined as never);
			} catch {
				/* best-effort */
			}
			// A wrong passphrase surfaces here (before any download starts),
			// which is exactly where callers expect it.
			throw err;
		}

		const savedName = metadata?.filename || fallbackName;
		const dl = await beginStreamingDownload(savedName);

		if (dl) {
			// Tracks whether any plaintext actually reached the download
			// manager. Distinguishes "failed before anything was written"
			// (nothing to clean up) from "failed part-way through" (a
			// partial file may exist), so the error below only warns about
			// a stray download when one could genuinely have appeared.
			let wroteAnyPlaintext = false;
			try {
				if (firstChunk) {
					await dl.write(firstChunk);
					wroteAnyPlaintext = true;
				}
				if (!generatorDone) {
					for (;;) {
						const { value, done } = await gen.next();
						if (done) {
							metadata = value.metadata;
							break;
						}
						await dl.write(value);
						wroteAnyPlaintext = true;
					}
				}

				// Only reached once the generator ran to completion, which
				// means decryptCesvuStream observed TAG_FINAL. Closing the
				// stream is therefore the COMMIT point: the browser only
				// sees a cleanly-terminated body for a whole, fully
				// authenticated file.
				await dl.close();
				if (!metadata) {
					// Unreachable: decryptCesvuStream always calls
					// onMetadata (or resolves its return value's metadata)
					// before completing on success.
					throw new Error('importVaultFileToDisk: decrypt completed without metadata (unreachable)');
				}
				// No native save dialog on this path, so the name we asked
				// for IS the saved name (modulo the browser de-duplicating
				// against an existing file in the downloads folder).
				return { metadata, savedName };
			} catch (err) {
				// ── Truncation / tampering lands here ──
				//
				// Unlike every other tier, this one CANNOT retract what it
				// already emitted. Tier 1 discards its swap file via
				// writable.abort(), Tier 3 only publishes the OPFS scratch
				// file after the loop completes, and Tier 4 decrypts
				// one-shot — all three commit strictly after TAG_FINAL. Here
				// the bytes are handed to the browser's download manager as
				// they are produced, so by the time a missing TAG_FINAL is
				// detected some prefix may already be on disk.
				//
				// Those bytes are NOT forged — every secretstream segment
				// yielded was MAC-verified, so an attacker cannot choose
				// their contents. The risk is COMPLETENESS, not authenticity:
				// a truncated file whose prefix is genuine.
				//
				// dl.abort() errors the response body stream in the service
				// worker (controller.error(), see static/vault-download-sw.js),
				// which is the strongest signal available on this path — the
				// browser marks the transfer failed and normally discards its
				// partial file. "Normally" is not "always", so we also make
				// the failure explicit to the user below rather than letting
				// a generic decrypt error imply nothing was written.
				dl.abort(err instanceof Error ? err.message : String(err));
				if (err instanceof DownloadCancelledError) throw new VaultCancelledError();
				if (wroteAnyPlaintext) {
					throw new Error(
						`"${savedName}" failed to decrypt completely and was NOT saved in full. ` +
							`The file is truncated or corrupted. Your browser should have discarded ` +
							`the incomplete download — if a partial "${savedName}" did appear in your ` +
							`downloads folder, delete it: it is only part of the original file. ` +
							`(Cause: ${err instanceof Error ? err.message : String(err)})`,
						{ cause: err }
					);
				}
				throw err;
			}

		}

		// Streaming download unavailable — release the generator before
		// falling through, so the OPFS tier below can start a fresh decrypt
		// from the beginning of the file rather than inheriting a
		// half-consumed one.
		try {
			await gen.return(undefined as never);
		} catch {
			/* best-effort */
		}
	}

	// ── Tier 3: OPFS scratch file + <a download> ──
	//
	// Only reached when the service worker isn't available (non-secure
	// origin, or SW registration blocked). Retains the known cleanup race
	// described above, which is why it now sits BELOW the streaming tier.
	if (opfsAvailable()) {
		const { writable, handle } = await openVaultScratchWritable();
		const gen = decryptCesvuStream(trackedSource(), passphrase, preferredType);
		try {
			let metadata: CesvuMetadata | null = null;
			const writer = writable.getWriter();

			try {
				for (;;) {
					const { value, done } = await gen.next();
					if (done) {
						metadata = value.metadata;
						break;
					}
					await writer.write(value);
				}
				await writer.close();
			} catch (err) {
				try {
					await writer.abort(err);
				} catch {
					/* best-effort */
				}
				throw err;
			}
			if (!metadata) {
				// Unreachable: decryptCesvuStream always calls onMetadata
				// (or resolves its return value's metadata) before
				// completing on success.
				throw new Error('importVaultFileToDisk: decrypt completed without metadata (unreachable)');
			}
			const finished = await handle.getFile();
			const savedName = metadata.filename || fallbackName;
			// NOTE: deliberately NOT passing a real MIME type here (unlike
			// Tier 1's `accept` dict above). Firefox/Safari's `<a download>`
			// path treats a real, "viewable" MIME type (video/*, application/
			// pdf, image/*, etc.) on a blob: URL as an invitation to open an
			// inline preview tab instead of forcing a download. Keeping this
			// as the generic octet-stream type is the strongest nudge toward
			// a real download that this tier can offer. (The streaming tier
			// above doesn't need the nudge — it sends a real
			// `Content-Disposition: attachment` header instead.)
			downloadOpfsFile(finished, savedName);

			// This tier and the in-memory one below both go through an
			// anchor `<a download>`, which the browser honors exactly as
			// given (no native "Save As" dialog the user could edit), so
			// `savedName` here IS the real saved name — unlike Tier 1,
			// there's no fileHandle.name to reconcile against.
			return { metadata, savedName };


		} finally {
			await handle.cleanup();
		}
	}

	// ── Tier 4: last resort — full in-memory (bounded only by available RAM) ──
	const bytes = new Uint8Array(await file.arrayBuffer());
	const result = await decryptCesvu(bytes, passphrase, preferredType);
	const savedName = result.metadata.filename || fallbackName;
	// Same reasoning as Tier 3 above: a real, "viewable" MIME type on a

	// blob: URL invites Firefox/Safari to open an inline preview tab
	// instead of forcing a download, which can then fail to (re)load a
	// large blob with a spurious "File not found". Keep this generic.
	const blob = new Blob([result.plaintext as BlobPart], { type: 'application/octet-stream' });
	triggerBlobDownload(blob, savedName);

	return { metadata: result.metadata, savedName };
}
