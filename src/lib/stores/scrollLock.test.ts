import { describe, it, expect, beforeEach } from 'vitest';
import { scrollLock } from './scrollLock.svelte.js';

describe('scrollLock', () => {
	// The module is loaded once per test file, so before any test touches it
	// the value is still the module's initial state: the OFF-by-default contract.
	it('is OFF by default', () => {
		expect(scrollLock.locked).toBe(false);
	});

	describe('mutations', () => {
		beforeEach(() => scrollLock.set(false));

		it('toggle flips the state', () => {
			scrollLock.toggle();
			expect(scrollLock.locked).toBe(true);
			scrollLock.toggle();
			expect(scrollLock.locked).toBe(false);
		});

		it('set writes the state directly', () => {
			scrollLock.set(false);
			expect(scrollLock.locked).toBe(false);
			scrollLock.set(true);
			expect(scrollLock.locked).toBe(true);
		});
	});
});