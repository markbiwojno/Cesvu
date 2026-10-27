/**
 * Barrel for the crypto module.
 *
 * Consumers import from `$lib/crypto` (resolved to this file) rather than
 * reaching into `$lib/crypto/cesvu-crypto.js` directly. This keeps the
 * concrete filename an implementation detail and gives the build a single
 * stable entry point. `cesvu-crypto.ts` remains the single source of truth
 * for the plain (unencrypted, SHA-256-checksummed) `.cesvu` v2 container —
 * do NOT add format logic here.
 *
 * NOTE: this web app's `.cesvu` export is no longer encrypted (see
 * cesvu-crypto.ts's top doc comment). The Python CLI (`CLI/cesvu/`) and
 * the Node.js package (`NPM/`) are untouched and still implement the
 * original encrypted v1 envelope — the two formats are not interchangeable.
 */
export * from './cesvu-crypto.js';
