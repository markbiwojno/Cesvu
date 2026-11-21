import { describe, it, expect } from 'vitest';
import { buildCoverageSet, sanitizeForFont } from './font-coverage.js';

const LATIN_FONT = {
	characterSet: [..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!?., #0123456789\n\r"].map(
		(c) => c.codePointAt(0)!
	)
};

describe('buildCoverageSet', () => {
	it('builds a Set from characterSet', () => {
		const set = buildCoverageSet(LATIN_FONT);
		expect(set.has('H'.codePointAt(0)!)).toBe(true);
		expect(set.has('日'.codePointAt(0)!)).toBe(false);
	});
});

describe('sanitizeForFont', () => {
	const coverage = buildCoverageSet(LATIN_FONT);

	it('leaves fully-covered text unchanged', () => {
		const r = sanitizeForFont('Hello World', coverage);
		expect(r.text).toBe('Hello World');
		expect(r.replacedCount).toBe(0);
	});

	it('replaces unsupported code points with the placeholder', () => {
		const r = sanitizeForFont('Hello 日本語', coverage);
		expect(r.text).toBe('Hello ???');
		expect(r.replacedCount).toBe(3);
	});

	it('supports a custom placeholder', () => {
		const r = sanitizeForFont('A日B', coverage, '#');
		expect(r.text).toBe('A#B');
		expect(r.replacedCount).toBe(1);
	});

	it('preserves \\n and \\r even if not explicitly in characterSet', () => {
		const noNewlineFont = { characterSet: [...'AB'].map((c) => c.codePointAt(0)!) };
		const cov = buildCoverageSet(noNewlineFont);
		const r = sanitizeForFont('A\nB\r', cov);
		expect(r.text).toBe('A\nB\r');
		expect(r.replacedCount).toBe(0);
	});

	it('replaces astral code points (e.g. emoji) as a single unit, not two mangled halves', () => {
		const r = sanitizeForFont('A😀B', coverage);
		// '😀' is one code point (U+1F600) spanning two UTF-16 code units.
		expect(r.text).toBe('A?B');
		expect(r.replacedCount).toBe(1);
	});
});
