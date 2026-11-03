import { describe, it, expect } from 'vitest';
import {
	ROW_HEIGHT,
	MAX_SCROLL_PX,
	HORIZONTAL_KEY_STEP,
	keyScrollTarget,
	keyScrollLeftTarget
} from './spreadsheet-scroll.js';
import { MAX_DISPLAY_ROWS } from '$lib/config.js';

const VIEWPORT = 600; // 21 rows
const MAX_TOP = 48_000 * ROW_HEIGHT - VIEWPORT;

describe('exact pixel mode', () => {
	it('the scroll cap covers every displayable sheet', () => {
		expect(MAX_SCROLL_PX).toBe(MAX_DISPLAY_ROWS * ROW_HEIGHT);
		// 48,000 rows (the reported sheet) is far below the cap...
		expect(48_000 * ROW_HEIGHT).toBeLessThanOrEqual(MAX_SCROLL_PX);
		// ...and the largest sheet stays under Firefox's ~17.9M px limit.
		expect(MAX_SCROLL_PX).toBeLessThan(17_000_000);
	});
});

describe('keyScrollTarget', () => {
	it('moves exactly one row with the arrow keys, from wherever the view is', () => {
		// A jump centers the row, so scrollTop need not sit on a row boundary of
		// the jumped-to row; the key must still move by one row.
		const top = 989 * ROW_HEIGHT - 300; // centered landing on row 999
		expect(keyScrollTarget('ArrowDown', top, VIEWPORT, MAX_TOP)).toBe(top + ROW_HEIGHT);
		expect(keyScrollTarget('ArrowUp', top, VIEWPORT, MAX_TOP)).toBe(top - ROW_HEIGHT);
	});

	it('moves a page minus one row with the Page keys', () => {
		expect(keyScrollTarget('PageDown', 5_000, VIEWPORT, MAX_TOP)).toBe(5_000 + 20 * ROW_HEIGHT);
		expect(keyScrollTarget('PageUp', 5_000, VIEWPORT, MAX_TOP)).toBe(5_000 - 20 * ROW_HEIGHT);
	});

	it('moves at least one row per Page key in a tiny viewport', () => {
		expect(keyScrollTarget('PageDown', 100, 20, MAX_TOP)).toBe(100 + ROW_HEIGHT);
	});

	it('goes to the top / bottom with Home / End', () => {
		expect(keyScrollTarget('Home', 5_000, VIEWPORT, MAX_TOP)).toBe(0);
		expect(keyScrollTarget('End', 5_000, VIEWPORT, MAX_TOP)).toBe(MAX_TOP);
	});

	it('clamps at both ends', () => {
		expect(keyScrollTarget('ArrowUp', 0, VIEWPORT, MAX_TOP)).toBe(0);
		expect(keyScrollTarget('PageUp', 10, VIEWPORT, MAX_TOP)).toBe(0);
		expect(keyScrollTarget('ArrowDown', MAX_TOP, VIEWPORT, MAX_TOP)).toBe(MAX_TOP);
		expect(keyScrollTarget('PageDown', MAX_TOP - 5, VIEWPORT, MAX_TOP)).toBe(MAX_TOP);
	});

	it('handles a sheet shorter than the viewport', () => {
		expect(keyScrollTarget('ArrowDown', 0, VIEWPORT, 0)).toBe(0);
		expect(keyScrollTarget('End', 0, VIEWPORT, -50)).toBe(0);
	});

	it('ignores other keys', () => {
		expect(keyScrollTarget('a', 100, VIEWPORT, MAX_TOP)).toBeNull();
		expect(keyScrollTarget('Enter', 100, VIEWPORT, MAX_TOP)).toBeNull();
		expect(keyScrollTarget('ArrowLeft', 100, VIEWPORT, MAX_TOP)).toBeNull();
	});
});

describe('keyScrollLeftTarget', () => {
	const MAX_LEFT = 2_000;

	it('moves right/left by the default step', () => {
		expect(keyScrollLeftTarget('ArrowRight', 100, MAX_LEFT)).toBe(100 + HORIZONTAL_KEY_STEP);
		expect(keyScrollLeftTarget('ArrowLeft', 100, MAX_LEFT)).toBe(100 - HORIZONTAL_KEY_STEP);
	});

	it('accepts a custom step', () => {
		expect(keyScrollLeftTarget('ArrowRight', 100, MAX_LEFT, 150)).toBe(250);
	});

	it('clamps at both ends', () => {
		expect(keyScrollLeftTarget('ArrowLeft', 10, MAX_LEFT)).toBe(0);
		expect(keyScrollLeftTarget('ArrowRight', MAX_LEFT - 5, MAX_LEFT)).toBe(MAX_LEFT);
	});

	it('handles content narrower than the viewport', () => {
		expect(keyScrollLeftTarget('ArrowRight', 0, 0)).toBe(0);
		expect(keyScrollLeftTarget('ArrowLeft', 0, -20)).toBe(0);
	});

	it('ignores other keys', () => {
		expect(keyScrollLeftTarget('ArrowUp', 100, MAX_LEFT)).toBeNull();
		expect(keyScrollLeftTarget('ArrowDown', 100, MAX_LEFT)).toBeNull();
		expect(keyScrollLeftTarget('a', 100, MAX_LEFT)).toBeNull();
	});
});