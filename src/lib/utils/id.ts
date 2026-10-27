/**
 * src/lib/utils/id.ts — safe unique-id generation.
 *
 * `crypto.randomUUID()` is ONLY defined in a Secure Context (HTTPS, or
 * `localhost`/`127.0.0.1` specifically — see
 * https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts).
 * The deployed app is always HTTPS, so this never matters there. But it DOES
 * matter for local development: `vite dev --host` binds to `0.0.0.0` so the
 * app can be reached from another device on the LAN, and loading it via that
 * LAN IP over plain HTTP is NOT a secure context — `crypto.randomUUID` is
 * simply `undefined` on `window.crypto` in that case. Any unguarded call
 * throws a `TypeError` the instant it's reached (e.g. adding a note, sending
 * a chat message), which looks like a broken feature but is really just a
 * missing feature-detect. `vite preview` (and prod) serve on `localhost` /
 * HTTPS, so the bug doesn't reproduce there — which is why it's easy to miss.
 *
 * IMPORTANT: none of the ids produced here are security-sensitive. They are
 * local storage keys (IndexedDB rows), Svelte `{#each ... (id)}` list keys,
 * or request/response correlation ids for postMessage round-trips with a
 * worker. Do NOT use this helper for anything that needs to be unguessable.
 */

/**
 * Generate a unique id. Prefers `crypto.randomUUID()`; falls back to a
 * timestamp + `Math.random()` id when `crypto.randomUUID` is unavailable
 * (non-secure-context dev/LAN serving, or a very old browser). The fallback
 * is NOT cryptographically strong — see the file header for why that's fine
 * here.
 *
 * @param prefix optional short tag prepended to fallback ids only (real
 *   UUIDs are returned as-is), to help distinguish id "families" in logs.
 */
export function newId(prefix = 'id'): string {
	if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
		return crypto.randomUUID();
	}
	return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
