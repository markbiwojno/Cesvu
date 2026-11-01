/**
 * spreadsheet-scroll.ts — scroll constants and keyboard navigation shared by
 * the Excel viewer (SpreadsheetViewer.svelte) and the CSV viewer
 * (DocumentPane.svelte). Pure (no DOM) so it can be unit-tested.
 *
 * EXACT PIXEL MODE
 *   MAX_SCROLL_PX is derived from the app's row cap (MAX_DISPLAY_ROWS), so
 *   every sheet the app can show keeps one row == ROW_HEIGHT px. The old fixed
 *   50,000px cap switched sheets above ~1,785 rows into a "proportional" mode
 *   whose jump and scroll mappings disagreed: after jumping to row 88 of a
 *   48,000-row sheet the next native scroll event decoded the position as
 *   ~row 2,000 and the view leapt there. At the 250,000-row cap the scroll
 *   area is 7,000,000px, under current browser limits (Chrome/Safari ~33M px,
 *   Firefox ~17.9M px).
 *
 * KEYBOARD
 *   keyScrollTarget moves RELATIVE to the current scrollTop. A jump centers
 *   the target row, so the top visible row is not the row you jumped to;
 *   deriving a row from scrollTop and stepping from it shifted the view by
 *   about half a page on the first key press.
 */

import { MAX_DISPLAY_ROWS } from '$lib/config.js';

export const ROW_HEIGHT = 28; // px — must match the table's CSS row height

/** Largest virtual scroll height before the (legacy) proportional mode. */
export const MAX_SCROLL_PX = MAX_DISPLAY_ROWS * ROW_HEIGHT;

/**
 * New scrollTop for a navigation key, or null if the key isn't handled.
 *   ArrowUp / ArrowDown  one row
 *   PageUp / PageDown    one viewport minus one row (at least one row)
 *   Home / End           top / bottom
 * The result is clamped to [0, maxScrollTop].
 */
export function keyScrollTarget(
	key: string,
	scrollTop: number,
	clientHeight: number,
	maxScrollTop: number
): number | null {
	const page = Math.max(ROW_HEIGHT, Math.floor(clientHeight / ROW_HEIGHT) * ROW_HEIGHT - ROW_HEIGHT);
	let target: number;
	switch (key) {
		case 'ArrowDown':
			target = scrollTop + ROW_HEIGHT;
			break;
		case 'ArrowUp':
			target = scrollTop - ROW_HEIGHT;
			break;
		case 'PageDown':
			target = scrollTop + page;
			break;
		case 'PageUp':
			target = scrollTop - page;
			break;
		case 'Home':
			target = 0;
			break;
		case 'End':
			target = maxScrollTop;
			break;
		default:
			return null;
	}
	return Math.max(0, Math.min(target, Math.max(0, maxScrollTop)));
}

/** What a wheel / trackpad event should do. */
export type WheelAction =
	| 'pass' // leave it to the browser (pinch-zoom, or sideways scroll with the lock off)
	| 'block' // swallow it (vertical input while the scroll lock is on)
	| 'scroll-horizontal' // scroll sideways ourselves, applying ONLY the horizontal part
	| 'step-vertical'; // throttled vertical row stepping (lock off)

/**
 * Decide what to do with a wheel event.
 *
 * A mostly-horizontal trackpad swipe still carries a small vertical
 * component. Letting those events pass to the browser while the lock is on
 * applied that vertical part natively, so the table drifted (and then jumped a
 * few rows) during sideways swiping. With the lock on, horizontal-dominant
 * events are therefore handled here: only deltaX is applied.
 *
 * ctrlKey marks trackpad pinch-zoom; never interfere with it.
 * With the lock OFF, horizontal-dominant events pass through unchanged.
 */
export function wheelAction(
	deltaX: number,
	deltaY: number,
	ctrlKey: boolean,
	locked: boolean
): WheelAction {
	if (ctrlKey) return 'pass';
	const horizontal = Math.abs(deltaX) > Math.abs(deltaY);
	if (horizontal) return locked ? 'scroll-horizontal' : 'pass';
	return locked ? 'block' : 'step-vertical';
}

/** deltaX in pixels, honouring WheelEvent.deltaMode (0 px, 1 lines, 2 pages). */
export function horizontalDeltaPx(deltaX: number, deltaMode: number, clientWidth: number): number {
	if (deltaMode === 1) return deltaX * ROW_HEIGHT;
	if (deltaMode === 2) return deltaX * clientWidth;
	return deltaX;
}