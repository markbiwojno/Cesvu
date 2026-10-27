/**
 * Barrel for the crypto module.
 *
 * Consumers import from `$lib/crypto` (resolved to this file) rather than
 * reaching into `$lib/crypto/cesvu-crypto.js` directly. This keeps the
 * concrete filename an implementation detail and gives the build a single
 * stable entry point. `cesvu-crypto.ts` remains the single source of truth
 * for the .cesvu v2 binary format, the libsodium Argon2id13 KDF, and the
 * XChaCha20-Poly1305 secretstream cipher — do NOT add format logic here.
 */
export * from './cesvu-crypto.js';
