// SPDX-License-Identifier: Apache-2.0

/**
 * atomic-io.ts — "write-and-rename" atomic file output for Node.js.
 *
 * Node port of `CLI/cesvu/src/cesvu/atomic_io.py`. Same rationale: write
 * to a temp file in the SAME directory as the final destination, fsync,
 * then rename (atomic on the same filesystem) so a killed process never
 * leaves a corrupted-but-plausible-looking output file behind.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export class InsufficientDiskSpaceError extends Error {
	constructor(
		public readonly required: number,
		public readonly available: number,
		public readonly destination: string
	) {
		super(
			`Not enough free disk space at ${path.dirname(destination)}: need ~${required.toLocaleString()} bytes, only ${available.toLocaleString()} available.`
		);
		this.name = 'InsufficientDiskSpaceError';
	}
}

/**
 * Best-effort disk-space check. Node has no portable, dependency-free
 * `statvfs` equivalent in core `fs`, so this shells out to `df`/`wmic`
 * style checks is avoided entirely: instead we attempt to write a
 * zero-length temp file and rely on ENOSPC surfacing naturally during the
 * real write in {@link atomicWriter}. This function exists as a narrow,
 * OPTIONAL pre-check for callers who already know the required byte count
 * and want to fail fast — it is NOT called automatically by
 * {@link atomicWriter}.
 *
 * Uses `fs.statfs` (Node >= 18.15). If unavailable on the platform/Node
 * build, this function no-ops (does not throw) — callers who need a hard
 * guarantee should still handle ENOSPC from the actual write.
 */
export async function checkDiskSpace(
	destination: string,
	requiredBytes: number,
	safetyMargin = 1.05
): Promise<void> {
	const dir = path.dirname(destination);
	await fs.mkdir(dir, { recursive: true });

	const statfs = (fs as unknown as { statfs?: (p: string) => Promise<{ bavail: number; bsize: number }> })
		.statfs;
	if (typeof statfs !== 'function') return; // best-effort only

	let free: number;
	try {
		const stats = await statfs(dir);
		free = stats.bavail * stats.bsize;
	} catch {
		return; // best-effort only
	}

	const needed = Math.ceil(requiredBytes * safetyMargin);
	if (free < needed) {
		throw new InsufficientDiskSpaceError(needed, free, destination);
	}
}

export interface AtomicWriterHandle {
	/** Append a chunk to the temp file. */
	write(chunk: Uint8Array): Promise<void>;
	/**
	 * Flush + fsync the temp file and atomically rename it onto the
	 * destination. MUST be called to commit the write; if never called
	 * (e.g. the caller throws first), call {@link AtomicWriterHandle.abort}
	 * or rely on `using`/try-finally to clean up the temp file.
	 */
	commit(): Promise<void>;
	/**
	 * Best-effort cleanup: close and unlink the temp file without touching
	 * the destination. Safe to call multiple times. Automatically invoked
	 * by {@link withAtomicWriter} on any thrown error.
	 */
	abort(): Promise<void>;
}

async function openTempFile(destination: string): Promise<{ tmpPath: string; fh: fs.FileHandle }> {
	const dir = path.dirname(destination);
	await fs.mkdir(dir, { recursive: true });
	// Emulate mkstemp: unique name in the destination directory.
	const rand = Math.random().toString(36).slice(2, 10) + process.pid.toString(36);
	const tmpPath = path.join(dir, `.cesvu-${rand}.tmp`);
	const fh = await fs.open(tmpPath, 'wx');
	return { tmpPath, fh };
}

/**
 * Low-level handle-based atomic writer. Prefer {@link withAtomicWriter}
 * for the common case (it guarantees cleanup on error via try/finally).
 */
export async function createAtomicWriter(destination: string): Promise<AtomicWriterHandle> {
	const { tmpPath, fh } = await openTempFile(destination);
	let closed = false;
	let committed = false;

	return {
		async write(chunk: Uint8Array): Promise<void> {
			if (closed) throw new Error('createAtomicWriter: write() called after commit/abort');
			await fh.write(chunk);
		},
		async commit(): Promise<void> {
			if (closed) return;
			closed = true;
			await fh.sync();
			await fh.close();
			await fs.rename(tmpPath, destination);
			committed = true;
		},
		async abort(): Promise<void> {
			if (closed) return;
			closed = true;
			try {
				await fh.close();
			} catch {
				/* best-effort */
			}
			try {
				await fs.unlink(tmpPath);
			} catch (err) {
				const code = (err as NodeJS.ErrnoException).code;
				if (code !== 'ENOENT') {
					// Mirror the Python module's stderr warning: cleanup
					// failed and sensitive plaintext/ciphertext may remain
					// on disk in an orphaned temp file.
					process.stderr.write(
						`cesvu: warning: could not remove temporary file "${tmpPath}": ${String(err)}. ` +
							'It may contain sensitive data; delete it manually.\n'
					);
				}
			}
			void committed; // committed is always false on this path
		}
	};
}

/**
 * Preferred entry point: stream output into `destination` via a callback,
 * with the temp-file cleanup / atomic rename handled automatically.
 *
 *   await withAtomicWriter(destPath, async (write) => {
 *     for (const chunk of chunks) await write(chunk);
 *   });
 *
 * On normal completion, the temp file is fsync'd, closed, and renamed onto
 * `destination` (atomic on the same filesystem — the same guarantee POSIX
 * `rename()` / Windows `MoveFileEx` with `MOVEFILE_REPLACE_EXISTING`
 * provides, which is what `fs.rename` uses under the hood).
 *
 * On a thrown error, the temp file is closed and unlinked (best-effort)
 * and `destination` is left untouched; the original error is re-thrown.
 */
export async function withAtomicWriter(
	destination: string,
	fn: (write: (chunk: Uint8Array) => Promise<void>) => Promise<void>
): Promise<void> {
	const handle = await createAtomicWriter(destination);
	try {
		await fn(handle.write);
		await handle.commit();
	} catch (err) {
		await handle.abort();
		throw err;
	}
}

/** Read an entire file into memory as a Uint8Array. Thin convenience wrapper. */
export async function readFileBytes(p: string): Promise<Uint8Array> {
	const buf = await fs.readFile(p);
	return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

/** Just re-exported for callers who want the platform temp dir without importing `node:os` directly. */
export const tmpdir = os.tmpdir;
