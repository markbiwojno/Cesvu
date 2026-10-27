/**
 * TypeScript 5.8 tightened ArrayBuffer generics, making Uint8Array<ArrayBufferLike>
 * incompatible with BufferSource (which requires ArrayBufferView<ArrayBuffer>).
 *
 * crypto.ts is an audited file and cannot be modified. This declaration widens
 * the SubtleCrypto interface to accept Uint8Array<ArrayBufferLike> where
 * BufferSource is expected, restoring pre-5.8 compatibility.
 *
 * This only affects type-checking — the runtime behavior is identical.
 */

// Augment the global BufferSource to accept ArrayBufferLike-backed views
declare global {
  type BufferSource = ArrayBufferView | ArrayBuffer | ArrayBufferLike;
}

export {};
