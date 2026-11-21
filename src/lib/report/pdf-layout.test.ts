import { describe, it, expect } from 'vitest';
import { wrapText, computeColumnWidths, shrinkColumnsToFit } from './pdf-layout.js';

/** 1 unit of width per character — makes wrap-point math exact in tests. */
const MONO = { widthOfTextAtSize: (text: string) => text.length };

describe('wrapText', () => {
	it('returns a single line when the text fits', () => {
		expect(wrapText('hello world', MONO, 1, 20)).toEqual(['hello world']);
	});

	it('wraps on word boundaries', () => {
		expect(wrapText('one two three four', MONO, 1, 9)).toEqual(['one two', 'three', 'four']);
	});

	it('hard-splits a single word wider than maxWidth', () => {
		expect(wrapText('abcdefghij', MONO, 1, 4)).toEqual(['abcd', 'efgh', 'ij']);
	});

	it('splits on \\n into separate paragraphs, each wrapped independently', () => {
		expect(wrapText('ab cd\nef gh', MONO, 1, 5)).toEqual(['ab cd', 'ef gh']);
	});

	it('returns [""] for empty input', () => {
		expect(wrapText('', MONO, 1, 10)).toEqual(['']);
	});

	it('preserves an empty line between two \\n characters', () => {
		expect(wrapText('a\n\nb', MONO, 1, 10)).toEqual(['a', '', 'b']);
	});
});

describe('computeColumnWidths', () => {
	it('sizes a column to its widest header/value, clamped to [min,max]', () => {
		const widths = computeColumnWidths(
			[
				{ header: 'ID', sampleValues: ['1', '2'] },
				{ header: 'Customer Name', sampleValues: ['Jane Doe', 'A Much Longer Company Name LLC'] }
			],
			{ minWidth: 10, maxWidth: 100, headerFont: MONO, headerSize: 1, cellFont: MONO, cellSize: 1, padding: 2 }
		);
		// 'ID' header is only 2 chars -> clamped up to minWidth (10).
		expect(widths[0]).toBe(10);
		// Longest value ('A Much Longer Company Name LLC' = 30 chars) + padding*2 = 34, under maxWidth.
		expect(widths[1]).toBe(34);
	});

	it('clamps at maxWidth for very wide content', () => {
		const widths = computeColumnWidths(
			[{ header: 'H', sampleValues: ['x'.repeat(500)] }],
			{ minWidth: 5, maxWidth: 50, headerFont: MONO, headerSize: 1, cellFont: MONO, cellSize: 1, padding: 0 }
		);
		expect(widths[0]).toBe(50);
	});
});

describe('shrinkColumnsToFit', () => {
	it('leaves widths unchanged when they already fit', () => {
		expect(shrinkColumnsToFit([10, 20, 30], 100, 5)).toEqual([10, 20, 30]);
	});

	it('shrinks proportionally above the floor when over budget', () => {
		const result = shrinkColumnsToFit([20, 80], 70, 5);
		const total = result.reduce((a, b) => a + b, 0);
		expect(total).toBeCloseTo(70, 5);
		// The wider column (80) should still end up wider than the narrower one (20).
		expect(result[1]).toBeGreaterThan(result[0]);
		expect(result[0]).toBeGreaterThanOrEqual(5);
	});

	it('never shrinks a column below minWidth even in a degenerate case', () => {
		const result = shrinkColumnsToFit([50, 50, 50, 50], 40, 10);
		for (const w of result) expect(w).toBeGreaterThanOrEqual(10 - 1e-9);
	});
});
