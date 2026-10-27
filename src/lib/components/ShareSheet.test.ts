import { describe, it, expect } from 'vitest';
import {
	buildEmailBody,
	detectIOS,
	exceedsShareSizeLimit,
	SHARE_SIZE_LIMIT_BYTES
} from './ShareSheet.svelte';

describe('exceedsShareSizeLimit', () => {
	it('is false below the 15MB cutoff', () => {
		expect(exceedsShareSizeLimit(SHARE_SIZE_LIMIT_BYTES - 1)).toBe(false);
	});

	it('is true AT the 15MB cutoff (>=, not >)', () => {
		expect(exceedsShareSizeLimit(SHARE_SIZE_LIMIT_BYTES)).toBe(true);
	});

	it('is true above the cutoff', () => {
		expect(exceedsShareSizeLimit(SHARE_SIZE_LIMIT_BYTES + 1)).toBe(true);
	});

	it('is false for a tiny file', () => {
		expect(exceedsShareSizeLimit(1024)).toBe(false);
	});
});

describe('detectIOS', () => {
	it('detects iPhone via user agent', () => {
		expect(
			detectIOS(
				'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
				'iPhone',
				5
			)
		).toBe(true);
	});

	it('detects iPad via user agent', () => {
		expect(
			detectIOS('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)', 'iPad', 5)
		).toBe(true);
	});

	it('detects iPod via user agent', () => {
		expect(
			detectIOS('Mozilla/5.0 (iPod touch; CPU iPhone OS 17_0)', 'iPod', 5)
		).toBe(true);
	});

	it('detects iPadOS 13+ reporting as MacIntel with touch points', () => {
		// iPadOS 13+'s desktop-class UA masking reports platform=MacIntel,
		// matching real macOS Safari — maxTouchPoints is what actually
		// distinguishes the two.
		expect(
			detectIOS(
				'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_6)',
				'MacIntel',
				5
			)
		).toBe(true);
	});

	it('does NOT flag real desktop macOS Safari (MacIntel, no touch points)', () => {
		expect(
			detectIOS(
				'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_6)',
				'MacIntel',
				0
			)
		).toBe(false);
	});

	it('does NOT flag Android/Windows', () => {
		expect(
			detectIOS('Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Win32', 0)
		).toBe(false);
		expect(
			detectIOS('Mozilla/5.0 (Linux; Android 14)', 'Linux armv8l', 5)
		).toBe(false);
	});
});

describe('buildEmailBody', () => {
	it('never contains a passphrase-shaped hint — this build has no passcode', () => {
		const body = buildEmailBody();
		expect(body).not.toMatch(/passphrase:|passcode:/i);
	});

	it('includes the visit/upload instructions and the cesvu.com link', () => {
		const body = buildEmailBody();
		expect(body).toContain('https://cesvu.com');
		expect(body).toContain('Upload this attachment');
	});

	it('is stable/deterministic across calls', () => {
		expect(buildEmailBody()).toBe(buildEmailBody());
	});
});
