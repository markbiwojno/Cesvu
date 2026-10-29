import { describe, it, expect } from 'vitest';
import {
	ROW_HEIGHT,
	MAX_WHEEL_ROWS_PER_EVENT,
	createWheelStepper,
	keyTargetRow
} from './spreadsheet-scroll.js';

/** Feed `count` equal wheel events spaced `gapMs` apart; return total rows moved. */
function swipe(count: number, deltaPx: number, gapMs: number, startMs = 0): number {
	const s = createWheelStepper();
	let total = 0;
	for (let i = 0; i < count; i++) total += s.step(deltaPx, startMs + i * gapMs);
	return total;
}

describe('createWheelStepper', () => {
	it('ignores the tiny momentum-tail events', () => {
		const s = createWheelStepper();
		for (let i = 0; i < 50; i++) expect(s.step(3, i * 8)).toBe(0);
	});

	it('moves by distance, not by number of events (the trackpad problem)', () => {
		// 380px of finger travel delivered as 38 small events or 19 larger
		// ones moves the SAME number of rows.
		const many = swipe(38, 10, 8);
		const few = swipe(19, 20, 16);
		expect(many).toBe(few);
		expect(many).toBe(Math.floor(380 / ROW_HEIGHT));
	});

	it('carries the sub-row remainder between events', () => {
		const s = createWheelStepper();
		expect(s.step(10, 0)).toBe(0);
		expect(s.step(10, 10)).toBe(0);
		expect(s.step(10, 20)).toBe(1); // 30px >= 28px
	});

	it('caps rows per event', () => {
		const s = createWheelStepper();
		expect(s.step(5_000, 0)).toBe(MAX_WHEEL_ROWS_PER_EVENT);
		expect(createWheelStepper().step(-5_000, 0)).toBe(-MAX_WHEEL_ROWS_PER_EVENT);
	});

	it('bounds one continuous gesture, however many events it fires', () => {
		// 1000 events at ~125Hz for 8 seconds: only the first 300ms count.
		const rows = swipe(1_000, 10, 8);
		expect(rows).toBeGreaterThan(0);
		expect(rows).toBeLessThanOrEqual(Math.ceil(300 / 8) * 10 / ROW_HEIGHT + 1);
	});

	it('a pause starts a new gesture with a fresh budget', () => {
		const s = createWheelStepper();
		let first = 0;
		for (let i = 0; i < 100; i++) first += s.step(10, i * 8); // runs past 300ms
		const mid = s.step(10, 800 + 500); // long pause, new gesture
		let second = mid;
		for (let i = 1; i < 30; i++) second += s.step(10, 1300 + i * 8);
		expect(first).toBeGreaterThan(0);
		expect(second).toBeGreaterThan(0);
	});

	it('reversing direction drops the carried remainder', () => {
		const s = createWheelStepper();
		expect(s.step(20, 0)).toBe(0);
		expect(s.step(-20, 10)).toBe(0); // remainder reset, then -20
		expect(s.step(-20, 20)).toBe(-1); // -40px
	});

	it('reset() clears all state', () => {
		const s = createWheelStepper();
		s.step(20, 0);
		s.reset();
		expect(s.step(20, 5)).toBe(0); // would be 1 if the 20px had been kept
	});
});

describe('keyTargetRow', () => {
	const N = 48_000;

	it('moves one row with the arrow keys', () => {
		expect(keyTargetRow('ArrowDown', 87, N, 20)).toBe(88);
		expect(keyTargetRow('ArrowUp', 87, N, 20)).toBe(86);
	});

	it('moves a page (minus one row of context) with Page keys', () => {
		expect(keyTargetRow('PageDown', 100, N, 20)).toBe(119);
		expect(keyTargetRow('PageUp', 100, N, 20)).toBe(81);
	});

	it('goes to the first / last row with Home / End', () => {
		expect(keyTargetRow('Home', 5_000, N, 20)).toBe(0);
		expect(keyTargetRow('End', 5_000, N, 20)).toBe(N - 1);
	});

	it('clamps at both ends', () => {
		expect(keyTargetRow('ArrowUp', 0, N, 20)).toBe(0);
		expect(keyTargetRow('PageUp', 3, N, 20)).toBe(0);
		expect(keyTargetRow('ArrowDown', N - 1, N, 20)).toBe(N - 1);
		expect(keyTargetRow('PageDown', N - 5, N, 20)).toBe(N - 1);
	});

	it('moves at least one row per Page key even in a tiny viewport', () => {
		expect(keyTargetRow('PageDown', 10, N, 1)).toBe(11);
	});

	it('ignores other keys and empty tables', () => {
		expect(keyTargetRow('a', 10, N, 20)).toBeNull();
		expect(keyTargetRow('Enter', 10, N, 20)).toBeNull();
		expect(keyTargetRow('ArrowDown', 0, 0, 20)).toBeNull();
	});
});
