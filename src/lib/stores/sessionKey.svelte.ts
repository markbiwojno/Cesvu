/**
 * src/lib/stores/sessionKey.svelte.ts — the in-memory "Send Back" passphrase.
 *
 * When a recipient unlocks a .cesvu file IN-BROWSER (the small-file, in-memory
 * ImportModal path — never the oversized "decrypt straight to disk"
 * SecureOpenModal path, and never the raw-vault-payload download path, neither
 * of which ever materializes a document in the workspace), the passphrase they
 * typed is what re-encrypts a "Send Back" reply to the SAME sender using the
 * SAME passphrase — see contract-store.svelte.ts's `sendBackAsCesvu`. Every
 * encrypt call still draws a brand-new random salt (see cesvu-crypto.ts's
 * encryptCesvuStream), so reusing the passphrase never lets an observer link
 * two files together by their ciphertext/salt alone.
 *
 * This store is the ONLY place that passphrase is allowed to live after the
 * unlock modal closes. It is intentionally NOT part of contract-store's
 * CesvuDocument record (which is plaintext-in-memory by design, see
 * schema.ts) — the passphrase is far more sensitive than the document body
 * and gets its own, much more paranoid, lifecycle:
 *
 *   ── Storage ──────────────────────────────────────────────────────────
 *   The passphrase is kept as UTF-8 bytes (`Uint8Array`), never as a
 *   lingering JS string — strings are immutable in JS/V8, so there is no way
 *   to force their backing memory to zero; a `Uint8Array` is the one thing we
 *   CAN actually wipe (see `secureZero` in cesvu-crypto.ts, same idea here).
 *   The string is decoded back only transiently, at the single call site that
 *   needs it right before an encrypt (`getPassphrase()`), and the caller must
 *   not retain it any longer than that one call.
 *
 *   ── Clearing (either of these fires clear()) ────────────────────────────
 *     A) 15 minutes of user inactivity (no mousemove/keydown/click/scroll/
 *        touchstart anywhere in the window) — a fresh timer is armed on every
 *        setKey() and reset on every detected activity tick.
 *     B) The document is closed (the ✕ button / any reset path) — wired via
 *        workspace.svelte.ts's `perDocumentTeardowns`, the same mechanism
 *        that already unbinds clauseStore/notesStore on close.
 *
 *   A `visibilitychange`-based clear (drop the key the instant the tab goes
 *   to background) was deliberately considered and REMOVED: the
 *   `visibilitychange` API cannot distinguish "user switched to another tab"
 *   from "user minimized the whole browser window" — both fire
 *   `document.visibilityState === 'hidden'` identically. That made the
 *   "Send Back" button grey out on a routine window minimize/restore, which
 *   is far too disruptive for how the feature is actually used (see
 *   SECURITY.md's "Send Back session key" section for the full writeup).
 *
 *   clear() does exactly three things, in order:
 *     1. `passphraseBytes.fill(0)` — zeroize the actual key bytes.
 *     2. Drop every reference (documentId / passphraseBytes / passphraseType
 *        all set to null) so nothing else can reach the (now-zeroed) buffer.
 *     3. `clearTimeout(inactivityTimer)`.
 *
 * Effect on the UI: `Workspace.svelte`'s "Send Back" button stays VISIBLE for
 * as long as the session was opened from a .cesvu (see workspace.openedFromCesvu),
 * but only turns green/enabled while `hasKeyFor(activeContractId)` is true. Once
 * the key clears (inactivity or close), the button greys back out live — it
 * does not disappear — and the user must re-open/re-unlock the .cesvu to
 * regain a live key.
 */

import type { PassphraseType } from '$lib/crypto/index.js';

/** 15 minutes. Exported so tests can assert against the same constant rather
 *  than duplicating the magic number (and so a future tuning pass only needs
 *  one edit). */
export const INACTIVITY_TIMEOUT_MS = 15 * 60 * 1000;

/** Window activity events that count as "the user is still here" and
 *  therefore reset the inactivity timer. Passive listeners only — this
 *  must never affect scroll/touch performance. */
const ACTIVITY_EVENTS = ['mousemove', 'keydown', 'click', 'scroll', 'touchstart'] as const;

let documentId = $state<string | null>(null);
let passphraseBytes = $state<Uint8Array | null>(null);
let passphraseType = $state<PassphraseType | null>(null);

let inactivityTimer: ReturnType<typeof setTimeout> | null = null;
let listenersInstalled = false;

/** (Re)arm the 15-minute inactivity timer. No-op when no key is held. */
function resetInactivityTimer(): void {
	if (inactivityTimer) {
		clearTimeout(inactivityTimer);
		inactivityTimer = null;
	}
	if (documentId === null) return;
	inactivityTimer = setTimeout(() => clear(), INACTIVITY_TIMEOUT_MS);
}

/** Trigger A: any detected user activity resets the clock (only matters
 *  while a key is actually held — cheap no-op otherwise). */
function handleActivity(): void {
	if (documentId !== null) resetInactivityTimer();
}

/** Install the window listeners exactly once per page life. Safe to call
 *  repeatedly; safe under SSR (no-ops when window is absent). */
function installListeners(): void {
	if (listenersInstalled) return;
	if (typeof window === 'undefined') return;
	listenersInstalled = true;
	for (const evt of ACTIVITY_EVENTS) {
		window.addEventListener(evt, handleActivity, { passive: true });
	}
}

/**
 * Record the passphrase used to unlock `docId`, replacing (and zeroizing)
 * any previously-held key first. Called once, by ImportModal, immediately
 * after a successful IN-MEMORY unlock (never for the oversized decrypt-to-
 * disk path or the raw-vault-payload download path — neither ever opens a
 * document in the workspace, so neither has any use for a "Send Back" key).
 */
function setKey(docId: string, passphrase: string, type: PassphraseType): void {
	installListeners();
	// Zeroize/drop whatever key (if any) was held before this one.
	clear();
	documentId = docId;
	passphraseBytes = new TextEncoder().encode(passphrase);
	passphraseType = type;
	resetInactivityTimer();
}

/** True iff a live key is currently held for `docId`. Used by Workspace.svelte
 *  to decide whether the "Send Back" button is green/enabled. */
function hasKeyFor(docId: string | null): boolean {
	return docId !== null && documentId === docId && passphraseBytes !== null;
}

/**
 * Decode the held passphrase back to a string for ONE immediate use (handing
 * it to `sendBackAsCesvu`). Returns null if no key is held. The caller MUST
 * use the result immediately and must not retain it — this store keeps no
 * decoded copy, but a JS string, once created, cannot be forcibly zeroed, so
 * minimizing its lifetime at the call site is the only mitigation available.
 */
function getPassphrase(): string | null {
	if (!passphraseBytes) return null;
	return new TextDecoder().decode(passphraseBytes);
}

/**
 * Clear the held key. Idempotent — safe to call when nothing is held (e.g.
 * closeDocument() runs this unconditionally via perDocumentTeardowns).
 *
 *   1. Zeroize the actual key bytes.
 *   2. Drop every reference.
 *   3. Cancel the inactivity timer.
 */
function clear(): void {
	if (passphraseBytes) {
		passphraseBytes.fill(0);
	}
	passphraseBytes = null;
	documentId = null;
	passphraseType = null;
	if (inactivityTimer) {
		clearTimeout(inactivityTimer);
		inactivityTimer = null;
	}
}

export const sessionKeyStore = {
	get documentId() {
		return documentId;
	},
	get passphraseType() {
		return passphraseType;
	},
	hasKeyFor,
	setKey,
	getPassphrase,
	clear
};
