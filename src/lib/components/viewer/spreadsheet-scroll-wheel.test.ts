import { describe, it, expect } from 'vitest';
import { ROW_HEIGHT, wheelAction, horizontalDeltaPx } from './spreadsheet-scroll.js';

describe('wheelAction — scroll lock ON', () => {
	it('blocks vertical swipes', () => {
		expect(wheelAction(0, 40, false, true)).toBe('block');
		expect(wheelAction(0, -40, false, true)).toBe('block');
	});

	it('handles horizontal swipes itself instead of passing them to the browser', () => {
		expect(wheelAction(40, 0, false, true)).toBe('scroll-horizontal');
		expect(wheelAction(-40, 0, false, true)).toBe('scroll-horizontal');
	});

	it('regression: a diagonal swipe that is mostly sideways never leaks its vertical part', () => {
		// Used to 'pass' (browser scrolled both axes) -> table drifted vertically.
		expect(wheelAction(30, 8, false, true)).toBe('scroll-horizontal');
		expect(wheelAction(-30, -8, false, true)).toBe('scroll-horizontal');
		expect(wheelAction(30, -8, false, true)).toBe('scroll-horizontal');
	});

	it('treats a mostly-vertical diagonal as vertical, so it is blocked', () => {
		expect(wheelAction(8, 30, false, true)).toBe('block');
	});

	it('treats an exact tie as vertical (matches the old handler)', () => {
		expect(wheelAction(20, 20, false, true)).toBe('block');
	});

	it('never interferes with pinch-zoom (ctrlKey)', () => {
		expect(wheelAction(0, 40, true, true)).toBe('pass');
		expect(wheelAction(40, 0, true, true)).toBe('pass');
	});
});

describe('wheelAction — scroll lock OFF', () => {
	it('steps vertical swipes as before', () => {
		expect(wheelAction(0, 40, false, false)).toBe('step-vertical');
		expect(wheelAction(8, 30, false, false)).toBe('step-vertical');
	});

	it('leaves horizontal swipes to the browser, unchanged', () => {
		expect(wheelAction(40, 0, false, false)).toBe('pass');
		expect(wheelAction(30, 8, false, false)).toBe('pass');
	});

	it('never interferes with pinch-zoom (ctrlKey)', () => {
		expect(wheelAction(0, 40, true, false)).toBe('pass');
	});
});

describe('horizontalDeltaPx', () => {
	it('returns pixels unchanged in pixel mode', () => {
		expect(horizontalDeltaPx(37, 0, 800)).toBe(37);
		expect(horizontalDeltaPx(-12, 0, 800)).toBe(-12);
	});

	it('scales line mode by the row height', () => {
		expect(horizontalDeltaPx(3, 1, 800)).toBe(3 * ROW_HEIGHT);
	});

	it('scales page mode by the viewport width', () => {
		expect(horizontalDeltaPx(1, 2, 800)).toBe(800);
		expect(horizontalDeltaPx(-2, 2, 500)).toBe(-1000);
	});
});
