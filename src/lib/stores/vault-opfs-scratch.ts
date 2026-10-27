// SPDX-License-Identifier: Apache-2.0

/**
 * src/lib/stores/vault-opfs-scratch.ts — a tiny OPFS-backed scratch file
 * wrapper used by the streaming "vault" encrypt/decrypt fallback paths
 * (src/lib/crypto/vault-io.ts) on browsers without the File System Access
 * API (`showSaveFilePicker`) — i.e. Firefox and Safari.
 *
 * Why OPFS at all: both `encryptCesvuStream` and `decryptCesvuStream`
 * yield chunks incrementally (≈1 MiB apiece), and a vault file can be
 * arbitrarily large. Holding the whole output in one JS-side Uint8Array
 * would defeat the entire point of streaming (and can crash the tab on a
 * large enough file). Instead we stream straight to a scratch file in the
 * Origin Private File System (a per-origin, sandboxed disk area every
 * modern browser exposes via `navigator.storage.getDirectory()`), then
 * trigger a normal `<a download>` from the finished OPFS `File` handle —
 * browsers read `Blob`/`File` downloads lazily off disk, so this stays
 * memory-bounded end to end even though it can't offer an upfront
 * "choose folder" dialog the way `showSaveFilePicker` can.
 *
 * This is the same pattern `/dicom/dicom-opfs-scratch.ts` used for the
 * (now-removed) DICOM streaming import path — copied here (not imported
 * from `/dicom`, which is a reference-only archive, not part of the build)
 * and generalized for both directions (import AND export).
 *
 * Every scratch file lives under a dedicated `cesvu-vault-scratch/`
 * directory so cleanup can't accidentally touch anything else the origin
 * might store in OPFS.
 */

const SCRATCH_DIR = 'cesvu-vault-scratch';

/** True when this browser exposes the OPFS + createWritable() APIs we need. */
export function opfsAvailable(): boolean {
	return (
		typeof navigator !== 'undefined' &&
		'storage' in navigator &&
		typeof navigator.storage.getDirectory === 'function'
	);
}

async function getScratchDir(): Promise<FileSystemDirectoryHandle> {
	const root = await navigator.storage.getDirectory();
	return root.getDirectoryHandle(SCRATCH_DIR, { create: true });
}

/** A handle to one in-progress or completed OPFS scratch file. */
export interface VaultScratchHandle {
	name: string;
	/** Delete this scratch file. Safe to call multiple times (no-op after the first). */
	cleanup: () => Promise<void>;
	/** Read back the finished file as a real `File` (OPFS-backed, not re-buffered). */
	getFile: () => Promise<File>;
}

/**
 * User-facing message for a QuotaExceededError (or any OPFS write failure)
 * during a vault encrypt/decrypt fallback. Exported so callers can present
 * the same wording as other quota-related errors in the app.
 */
export const VAULT_OPFS_QUOTA_ERROR_MESSAGE =
	'Not enough local storage space to complete this — free up space and try again.';

/**
 * Open a fresh OPFS scratch file and return a `WritableStream` to it plus a
 * handle for cleanup/read-back. Every `write()` (and the initial
 * `createWritable()`) is guarded — on `QuotaExceededError` or any other
 * write failure, the partial file is deleted immediately and a clear,
 * user-facing `Error(VAULT_OPFS_QUOTA_ERROR_MESSAGE)` is thrown (for quota)
 * or the original error is rethrown (for anything else, after cleanup).
 */
export async function openVaultScratchWritable(): Promise<{
	writable: WritableStream<Uint8Array>;
	handle: VaultScratchHandle;
}> {
	const dir = await getScratchDir();
	const name = `vault-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.bin`;

	let fileHandle: FileSystemFileHandle;
	let cleaned = false;
	const cleanup = async (): Promise<void> => {
		if (cleaned) return;
		cleaned = true;
		try {
			await dir.removeEntry(name);
		} catch {
			/* already gone, or never fully created — fine */
		}
	};

	fileHandle = await dir.getFileHandle(name, { create: true });

	let underlying: FileSystemWritableFileStream;
	try {
		underlying = await fileHandle.createWritable();
	} catch (err) {
		await cleanup();
		if (err instanceof DOMException && err.name === 'QuotaExceededError') {
			throw new Error(VAULT_OPFS_QUOTA_ERROR_MESSAGE);
		}
		throw err;
	}

	// Wrap the raw FileSystemWritableFileStream's write()/close() so a
	// mid-stream QuotaExceededError (or any other write failure) triggers
	// the same cleanup-then-surface behavior as the initial createWritable().
	const writable = new WritableStream<Uint8Array>({
		async write(chunk) {
			try {
				await underlying.write(chunk as FileSystemWriteChunkType);
			} catch (err) {
				try {
					await underlying.close();
				} catch {
					/* best-effort */
				}
				await cleanup();
				if (err instanceof DOMException && err.name === 'QuotaExceededError') {
					throw new Error(VAULT_OPFS_QUOTA_ERROR_MESSAGE);
				}
				throw err;
			}
		},
		async close() {
			await underlying.close();
		},
		async abort(reason) {
			try {
				await underlying.close();
			} catch {
				/* best-effort */
			}
			await cleanup();
			throw reason;
		}
	});

	const handle: VaultScratchHandle = {
		name,
		cleanup,
		getFile: () => fileHandle.getFile()
	};

	return { writable, handle };
}

/**
 * Trigger a normal browser download of an OPFS-backed `File` under
 * `filename`, via a Blob URL + synthetic `<a download>` click. Because
 * `File` extends `Blob`, the browser reads it lazily off disk as the
 * download proceeds — this does NOT re-buffer the whole file into JS
 * memory first, no matter how large it is.
 */
export function downloadOpfsFile(file: File, filename: string, mimeType?: string): void {
	// Re-wrap in a typed Blob when a real MIME type is known — the OPFS
	// `File`'s own `.type` is often empty/generic, and giving the
	// downloaded Blob a specific type helps some browsers/OSes associate
	// the saved file with its correct type (in addition to the `download`
	// filename, which is what actually determines the saved name).
	const blob = mimeType ? new Blob([file], { type: mimeType }) : file;
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	a.remove();
	// Revoke on a delay — some browsers need the URL to remain valid for the
	// duration of the download handoff to the OS, not just the click().
	setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
