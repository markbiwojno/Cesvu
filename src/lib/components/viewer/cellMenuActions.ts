/**
 * cellMenuActions.ts — Shared action helpers for the spreadsheet right-click
 * context menu (CellContextMenu.svelte), used by BOTH grid viewers:
 *   - DocumentPane.svelte   (streaming CSV table)
 *   - SpreadsheetViewer.svelte (non-streaming workbook / .xlsx table)
 *
 * Keeping the logic here (not inline in each viewer) means the two grids share
 * identical behavior and there's a single place to evolve it. Each helper wires
 * into the existing workspace store contract — no new evaluation paths:
 *   - filter/exclude  → workspace.setActiveFilter({ filterTree }) (the same
 *                       filterTree path both viewers already evaluate, and the
 *                       editable filter bar in DocumentPane re-seeds from)
 *   - add to context  → workspace.setSelection({...}) (the existing blue chip)
 *   - analyze column  → workspace.setChatPrefill(prompt) (PULL pattern; ChatPane
 *                       consumes it in its own handler)
 *   - copy            → copyText() (single source of truth, see below)
 */

import { workspace } from '$lib/stores/workspace.svelte.js';
import { notesStore } from '$lib/stores/notesStore.svelte.js';
import type { Filter } from '$lib/pipeline/filter.js';

/**
 * What the user right-clicked. `kind` drives which menu items are enabled.
 *   - 'cell'   : a data cell — has column + value + rowData + rowIndex
 *   - 'column' : a column header — has column only
 *   - 'row'    : a row header (#) — has rowData + rowIndex only
 * `sheet` is the active sheet name for multi-sheet workbooks (used to prefix
 * the AI-context label so the LLM knows which sheet); omit for CSV.
 */
export interface MenuTarget {
	kind: 'cell' | 'column' | 'row';
	column?: string;
	value?: unknown;
	rowIndex?: number;
	rowData?: Record<string, unknown>;
	/** Column order — needed to serialize a row as TSV in header order. */
	columns: string[];
	sheet?: string;
}

/**
 * SINGLE SOURCE OF TRUTH for programmatic copy. Future keyboard shortcuts
 * (Ctrl/Cmd+C on a selected cell) MUST call this same helper rather than
 * touching the clipboard directly, so copy behavior stays consistent.
 *
 * Uses the async Clipboard API when available, with a legacy
 * execCommand('copy') fallback for older / insecure-context browsers. Shows a
 * toast on success. Returns true on success.
 */
export async function copyText(text: string, toastMessage = 'Copied'): Promise<boolean> {
	let ok = false;
	try {
		if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
			await navigator.clipboard.writeText(text);
			ok = true;
		}
	} catch {
		ok = false;
	}

	// Fallback for browsers without the async Clipboard API (or when it threw,
	// e.g. non-secure context). Uses a transient off-screen textarea.
	if (!ok && typeof document !== 'undefined') {
		try {
			const ta = document.createElement('textarea');
			ta.value = text;
			ta.style.position = 'fixed';
			ta.style.opacity = '0';
			ta.style.pointerEvents = 'none';
			document.body.appendChild(ta);
			ta.focus();
			ta.select();
			ok = document.execCommand('copy');
			document.body.removeChild(ta);
		} catch {
			ok = false;
		}
	}

	if (ok) workspace.showToast(toastMessage);
	return ok;
}

/** Stringify a cell value for copy/filter (null/undefined → empty string). */
function cellToString(v: unknown): string {
	return v === null || v === undefined ? '' : String(v);
}

/** Serialize a row as a tab-separated line in header (column) order. */
function rowToTSV(row: Record<string, unknown>, columns: string[]): string {
	return columns.map((c) => cellToString(row[c])).join('\t');
}

// ── Group 1: Copy ───────────────────────────────────────────────────────────

/** "Copy" — copies the primary text for the target (value / column / row). */
export function copyPrimary(t: MenuTarget): void {
	if (t.kind === 'cell') {
		void copyText(cellToString(t.value));
	} else if (t.kind === 'column') {
		void copyText(t.column ?? '');
	} else {
		// row header → copy the whole row (TSV)
		void copyText(t.rowData ? rowToTSV(t.rowData, t.columns) : '', 'Copied row');
	}
}

/** "Copy row" — always the tab-separated row. Disabled for column headers. */
export function copyRow(t: MenuTarget): void {
	if (!t.rowData) return;
	void copyText(rowToTSV(t.rowData, t.columns), 'Copied row');
}

// ── Group 2: Act ──────────────────────────────────────────────────────────────

/** "Filter by this value" — column equals value. */
export function filterByValue(t: MenuTarget): void {
	if (t.kind !== 'cell' || !t.column) return;
	const value = cellToString(t.value);
	const tree: Filter = { column: t.column, op: 'eq', value };
	workspace.setActiveFilter({
		pattern: value,
		column: t.column,
		matchCount: 0, // recomputed by the viewer's reactive filter
		valueOp: 'eq',
		filterTree: tree
	});
}

/** "Exclude this value" — column NOT equals value. */
export function excludeValue(t: MenuTarget): void {
	if (t.kind !== 'cell' || !t.column) return;
	const value = cellToString(t.value);
	const tree: Filter = { not: { column: t.column, op: 'eq', value } };
	workspace.setActiveFilter({
		pattern: value,
		column: t.column,
		matchCount: 0,
		valueOp: 'neq',
		filterTree: tree
	});
}

/**
 * "Show duplicates of this value" — CELL-LEVEL filter. Functionally identical
 * to filterByValue() (column == value, same filterTree the engine already
 * evaluates), but tagged with `duplicatesOf` so DocumentPane shows a different
 * banner: "Showing X rows where [Column] = [Value]". This surfaces every other
 * row that shares the right-clicked cell's value — i.e. its duplicates — using
 * the proven column=value path rather than any new frequency machinery.
 */
export function showDuplicates(t: MenuTarget): void {
	if (t.kind !== 'cell' || !t.column) return;
	const value = cellToString(t.value);
	const tree: Filter = { column: t.column, op: 'eq', value };
	workspace.setActiveFilter({
		pattern: value,
		column: t.column,
		matchCount: 0, // recomputed by the viewer's reactive filter
		valueOp: 'eq',
		filterTree: tree,
		duplicatesOf: { column: t.column, value }
	});
}


// ── Group 3: Notes ──────────────────────────────────────────────────────────

/**
 * "Add note" — pin a free-text note to the right-clicked cell. The note
 * is created empty; the user types the body in the Notes pane that opens.
 * Same UX as the contract view's prose notes: small amber pin in the
 * cell's top-right, numbered bubble in the right sidebar, click-to-jump
 * from the bubble back to the cell.
 *
 * Side effects:
 *  - turns workspace.notesMode on (so the pin is visible)
 *  - sets workspace.focusNoteId to the new note (so the bubble is in
 *    edit-ready state immediately)
 */
export function addCellNote(t: MenuTarget): void {
	// For 'column' target, this is a column-level note (rowIndex = -1).
	// For 'cell' target, the specific (sheet, column, rowIndex) tuple.
	// For 'row' target, we skip — the user can right-click an individual
	// cell in the row if they want a per-cell note. (Per-row notes are
	// a future feature; the current data model is single-cell.)
	if (t.kind === 'cell' && t.column && t.rowIndex !== undefined) {
		const sheet = t.sheet ?? '';
		// Use the row's stable original file index (__rowIdx__, stamped at parse
		// time) rather than the DISPLAY array index (rowIndex).  The display index
		// drifts when filter/sort is active, so notes created on a sorted or
		// filtered table would anchor to the WRONG row.  __rowIdx__ is invariant
		// across any sort/filter/streaming-chunk reorder.
		// Falls back to the display index for Excel rows and legacy notes created
		// before the stamp was introduced.
		const stableRowIdx =
			typeof (t.rowData as Record<string, unknown>)?.__rowIdx__ === 'number'
				? ((t.rowData as Record<string, unknown>).__rowIdx__ as number)
				: t.rowIndex;
		const note = notesStore.addNoteForCell(sheet, t.column, stableRowIdx);

		workspace.setNotesMode(true);
		// Note: we intentionally do NOT call openNotesPane() here. The
		// popover is now a "collapse" affordance, not an "always-on editor".
		// Auto-opening every time the user right-clicks "Add note" would
		// pop a 320px strip over the table — blocking scroll in the
		// region the user is looking at. Instead, the note is created
		// silently (the pin appears), the pin becomes focus-ready, and
		// the user opens the popover when they actually want to type
		// (by clicking the pin, the sheet info bar's Notes button, or
		// — when the popover is already open — by clicking another
		// pin from inside it). requestFocusNote still runs so if the
		// popover IS already open, the new bubble focuses immediately.
		workspace.requestFocusNote(note.id);
	} else if (t.kind === 'column' && t.column) {
		const sheet = t.sheet ?? '';
		const note = notesStore.addNoteForCell(sheet, t.column, -1);
		workspace.setNotesMode(true);
		// Same intentional non-open — see cell branch above. The pin
		// appears in the column header; the user opens the popover when
		// ready. (See cell branch for the full rationale.)
		workspace.requestFocusNote(note.id);
	}
}

/**
 * "Analyze this column" — inject a column-analysis prompt into the ChatPane
 * input (PULL pattern), then let the user press Send. On send, runChatInference
 * takes the deterministic `detectColumnAnalysis` → `buildColumnAnalysis` path
 * (no LLM) and returns header stats + a Vega-Lite chart spec, which ChatPane
 * renders inline (header → chart → body).
 *
 * The prompt phrasing — "Analyze the <Column> column: describe its
 * distribution." — is chosen deliberately: it matches the COLUMN_ANALYSIS_
 * PATTERNS in analysis.ts AND the analyze/summarize guard in query.ts, so it
 * routes to the deterministic chart path and is never misread as a row filter.
 * `skipQueryEngine: true` is belt-and-suspenders so the prompt always reaches
 * that path rather than the filter/intent engine.
 *
 * A cell-level right-click analyzes that cell's column.
 */
export function analyzeColumn(t: MenuTarget): void {
	const column = t.column;
	if (!column || (t.kind !== 'column' && t.kind !== 'cell')) return;

	// If the Notes pane is currently showing (it fully REPLACES ChatPane in
	// the same right-pane slot — see Workspace.svelte's isTabularFile branch),
	// switch back to Chat first. Otherwise the prefill below would be queued
	// into an unmounted ChatPane and the user would see no visible change.
	workspace.closeOpenPane();

	const prompt = `Analyze the ${column} column: describe its distribution.`;
	workspace.setChatPrefill(prompt, { skipQueryEngine: true });

	// Nudge an already-mounted ChatPane to pull the prefill immediately
	// (onMount + onfocus also pull it; this covers the live-pane case).
	if (typeof window !== 'undefined') {
		window.dispatchEvent(new CustomEvent('cesvu:chat-prefill'));
	}
}
