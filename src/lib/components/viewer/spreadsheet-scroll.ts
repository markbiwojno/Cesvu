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