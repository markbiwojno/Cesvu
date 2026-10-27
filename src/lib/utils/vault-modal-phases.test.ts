import { describe, it, expect } from 'vitest';
import { isDismissiblePhase } from './vault-modal-phases.js';

describe('isDismissiblePhase', () => {
	// Every phase currently used across the three vault-encrypt modals
	// (SecureSaveModal.svelte, ExportModal.svelte, SendBackModal.svelte).
	// If any of these modals adds/renames a phase in the future, add it
	// here too so the intent ("dismissible or not?") stays reviewed and
	// tested rather than silently inherited from whatever the default
	// happens to be.

	it('blocks dismissal during "generating" — an encrypt is in flight in all three modals', () => {
		expect(isDismissiblePhase('generating')).toBe(false);
	});

	it('blocks dismissal during "saving" — SecureSaveModal.svelte\'s actual streaming encrypt + disk write', () => {
		// Regression guard: SecureSaveModal.svelte originally guarded only
		// 'generating' after splitting its flow into a cheap 'generating'
		// (passphrase only) phase and a 'saving' (real encrypt + write)
		// phase, leaving 'saving' dismissible and allowing a user to abandon
		// an in-progress encrypt via backdrop click / Escape / the ✕ button.
		expect(isDismissiblePhase('saving')).toBe(false);
	});

	it('blocks dismissal during "sharing" — ExportModal.svelte\'s Web Share API flow (ShareSheet.svelte)', () => {
		expect(isDismissiblePhase('sharing')).toBe(false);
	});

	it('allows dismissal for every other known phase', () => {
		const dismissiblePhases = [
			'choose-type', // SecureSaveModal, ExportModal
			'confirm-preset', // SecureSaveModal only: "send file back" confirm screen
			'show-words', // SecureSaveModal, ExportModal
			'options', // ExportModal, SendBackModal
			'done', // all three
			'error' // all three
		];

		for (const phase of dismissiblePhases) {
			expect(isDismissiblePhase(phase)).toBe(true);
		}
	});

	it('defaults to dismissible for an unrecognized phase', () => {
		expect(isDismissiblePhase('some-future-phase')).toBe(true);
	});
});
