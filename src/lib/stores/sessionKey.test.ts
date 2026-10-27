/**
 * src/lib/stores/sessionKey.test.ts
 *
 * Regression guard for the "Send Back" passphrase's clearing lifecycle (see
 * sessionKey.svelte.ts's doc comment). Locks in that BOTH triggers actually
 * clear the key, and that clearing is real (not just a "looks cleared"
 * illusion): the underlying bytes are zeroized, every reference is dropped,
 * and the inactivity timer is cancelled so it can't fire late and clobber a
 * subsequently-set key.
 *
 * NOTE: a visibilitychange-based clear (tab hidden → drop key) was
 * deliberately removed — see sessionKey.svelte.ts's doc comment and
 * SECURITY.md's "Send Back session key" section for why. There is
 * intentionally no test for it here.
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from 'vitest';
import { sessionKeyStore, INACTIVITY_TIMEOUT_MS } from './sessionKey.svelte.js';
import { workspace } from './workspace.svelte.js';

/**
 * This project's vitest environment is plain Node (no jsdom/happy-dom
 * dependency — see vite.config.ts's `test` block), so `window` doesn't
 * exist by default. sessionKey.svelte.ts only needs a minimal
 * EventTarget-like surface (addEventListener/dispatchEvent) — Node's own
 * built-in, Web-compatible `EventTarget` class (global since Node 15)
 * covers that without adding a new dependency. Stubbed once at module scope
 * so sessionKeyStore's one-time `installListeners()` binds to this same
 * object for every test below.
 */
const fakeWindow = new EventTarget();

beforeAll(() => {
	vi.stubGlobal('window', fakeWindow);
});

describe('sessionKeyStore', () => {
	beforeEach(() => {
		sessionKeyStore.clear();
		vi.useFakeTimers();
	});

	afterEach(() => {
		sessionKeyStore.clear();
		vi.useRealTimers();
	});

	it('setKey() records the key and hasKeyFor() reports it live', () => {
		sessionKeyStore.setKey('doc-1', 'correct horse battery staple winter forest', 'diceware');

		expect(sessionKeyStore.hasKeyFor('doc-1')).toBe(true);
		expect(sessionKeyStore.hasKeyFor('doc-2')).toBe(false);
		expect(sessionKeyStore.hasKeyFor(null)).toBe(false);
		expect(sessionKeyStore.documentId).toBe('doc-1');
		expect(sessionKeyStore.passphraseType).toBe('diceware');
	});

	it('getPassphrase() round-trips the exact passphrase string', () => {
		const passphrase = 'correct horse battery staple winter forest';
		sessionKeyStore.setKey('doc-1', passphrase, 'diceware');
		expect(sessionKeyStore.getPassphrase()).toBe(passphrase);
	});

	it('getPassphrase() returns null when no key is held', () => {
		expect(sessionKeyStore.getPassphrase()).toBeNull();
	});

	it('setKey() zeroizes/replaces any previously-held key (no leak across two setKey calls)', () => {
		sessionKeyStore.setKey('doc-1', 'first passphrase words here', 'diceware');
		sessionKeyStore.setKey('doc-2', 'second different passphrase', 'diceware');

		// The old key must be gone — not merely shadowed.
		expect(sessionKeyStore.hasKeyFor('doc-1')).toBe(false);
		expect(sessionKeyStore.hasKeyFor('doc-2')).toBe(true);
		expect(sessionKeyStore.getPassphrase()).toBe('second different passphrase');
	});

	// ── Trigger B: explicit clear() (the ✕ / closeDocument path) ────────────
	it('clear() drops the key: documentId/passphraseType null, hasKeyFor false, getPassphrase null', () => {
		sessionKeyStore.setKey('doc-1', 'some passphrase words', 'diceware');
		sessionKeyStore.clear();

		expect(sessionKeyStore.documentId).toBeNull();
		expect(sessionKeyStore.passphraseType).toBeNull();
		expect(sessionKeyStore.hasKeyFor('doc-1')).toBe(false);
		expect(sessionKeyStore.getPassphrase()).toBeNull();
	});

	it('clear() is idempotent (safe to call with nothing held)', () => {
		expect(() => sessionKeyStore.clear()).not.toThrow();
		expect(() => sessionKeyStore.clear()).not.toThrow();
	});

	it('workspace.closeDocument() clears the session key via perDocumentTeardowns', () => {
		workspace.closeDocument();
		sessionKeyStore.setKey('doc-1', 'some passphrase words', 'diceware');
		expect(sessionKeyStore.hasKeyFor('doc-1')).toBe(true);

		// ✕ / start over.
		workspace.closeDocument();

		expect(sessionKeyStore.hasKeyFor('doc-1')).toBe(false);
		expect(sessionKeyStore.getPassphrase()).toBeNull();
	});

	it('a freshly opened document does NOT inherit a previous document’s key', () => {
		workspace.closeDocument();
		sessionKeyStore.setKey('doc-A', 'passphrase for document A here', 'diceware');
		workspace.closeDocument();

		sessionKeyStore.setKey('doc-B', 'passphrase for document B here', 'emoji');

		expect(sessionKeyStore.hasKeyFor('doc-A')).toBe(false);
		expect(sessionKeyStore.hasKeyFor('doc-B')).toBe(true);
		expect(sessionKeyStore.getPassphrase()).toBe('passphrase for document B here');
	});

	// ── Trigger A: 15-minute inactivity timer ───────────────────────────────
	it('clears itself after INACTIVITY_TIMEOUT_MS with no activity', () => {
		sessionKeyStore.setKey('doc-1', 'some passphrase words', 'diceware');
		expect(sessionKeyStore.hasKeyFor('doc-1')).toBe(true);

		vi.advanceTimersByTime(INACTIVITY_TIMEOUT_MS - 1);
		expect(sessionKeyStore.hasKeyFor('doc-1')).toBe(true);

		vi.advanceTimersByTime(1);
		expect(sessionKeyStore.hasKeyFor('doc-1')).toBe(false);
	});

	it('window activity resets the inactivity timer so the key survives past the original deadline', () => {
		sessionKeyStore.setKey('doc-1', 'some passphrase words', 'diceware');

		// Just short of the deadline, simulate real user activity.
		vi.advanceTimersByTime(INACTIVITY_TIMEOUT_MS - 1000);
		window.dispatchEvent(new Event('mousemove'));

		// Advance past what WOULD have been the original deadline — the key
		// should still be alive because activity reset the clock.
		vi.advanceTimersByTime(1500);
		expect(sessionKeyStore.hasKeyFor('doc-1')).toBe(true);

		// But it still expires INACTIVITY_TIMEOUT_MS after the LAST activity.
		vi.advanceTimersByTime(INACTIVITY_TIMEOUT_MS);
		expect(sessionKeyStore.hasKeyFor('doc-1')).toBe(false);
	});
});
