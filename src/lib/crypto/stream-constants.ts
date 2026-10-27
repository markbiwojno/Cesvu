// SPDX-License-Identifier: Apache-2.0

/**
 * src/lib/crypto/stream-constants.ts — Shared thresholds for the
 * chunked-streaming import/export path (large DICOM studies, etc.).
 *
 * Single source of truth so the export routing decision (contract-store),
 * the import routing decision, and any UI messaging stay in lockstep.
 */

/**
 * Above this size (bytes), export/import route through the streaming
 * (`encryptCesvuStream` / `decryptCesvuStream`) path instead of the
 * one-shot (`encryptCesvu` / `decryptCesvu`) path. 128 MiB.
 */
export const LARGE_FILE_THRESHOLD_BYTES = 128 * 1024 * 1024;

/**
 * Plaintext bytes read per chunk when streaming a `File`/`Blob` through
 * `encryptCesvuStream`. 1 MiB — matches the crypto layer's own default
 * `CHUNK_SHIFT_DEFAULT` chunk size, so chunk boundaries stay aligned with
 * secretstream's own framing (not required for correctness — the crypto
 * layer re-accumulates to its own chunk size internally — but avoids
 * needless re-buffering).
 */
export const STREAM_CHUNK_BYTES = 1 * 1024 * 1024;

/**
 * Hard cap on how many decrypted bytes the streaming IMPORT path will
 * buffer in memory while looking for the end of the CFP1 header + the
 * embedded CesvuDocument JSON. Once this many bytes have been
 * accumulated without finding a complete, parseable JSON envelope, the
 * import is aborted as corrupt rather than continuing to buffer toward
 * the 1.5 GB decrypt cap. 64 KiB — the JSON envelope (document metadata,
 * NOT the DICOM study bytes themselves) is always tiny.
 */
export const META_PREFIX_CAP_BYTES = 64 * 1024;
