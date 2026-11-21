/**
 * src/lib/report/cell-commentary-report.ts — pure data prep for "Your Cell
 * Commentary Report".
 *
 * Takes the user's cell-anchored notes (notesStore.ts) + the workbook's row
 * buffer (workspace.workbook) and produces plain table rows: Note content,
 * Cell content, Row number — ready to hand to pdf-writer.ts's existing
 * ReportTableSection machinery (no new PDF layout code needed; this report
 * reuses buildReportPdf()'s single-section table renderer).
 *
 * No DOM, no Worker dependency — this is cheap enough (N notes, each a
 * single row lookup) to run entirely synchronously on the main thread
 * before handing off to the Worker purely for the PDF draw/save step.
 */

import type { Note, CellAnchor } from '$lib/stores/notesStore.svelte.js';
import type { Sheet } from '$lib/data/workbook.js';
import type { ReportTableSection, ReportLine } from './pdf-writer.js';

export interface CellCommentaryRow {
	sheet: string;
	column: string;
	/** -1 = column-level note (no specific row). */
	rowIndex: number;
	/** 1-based row number for display, or null for column-level notes. */
	rowNumber: number | null;
	/** The actual cell value, or null for column-level notes / unresolved rows. */
	cellContent: string | null;
	noteBody: string;
	author: string;
	createdAt: number;
}

/**
 * Build one {@link CellCommentaryRow} per cell-anchored note, optionally
 * restricted to a single sheet, sorted NEWEST FIRST (createdAt descending)
 * per the product requirement — independent of notesStore's internal
 * position-based ordering (which sorts by anchor, not creation time).
 *
 * Column-level notes (anchor.rowIndex === -1) are INCLUDED, with
 * `rowNumber: null` and `cellContent: null` — the PDF renders these as
 * "(whole column)" / "—" rather than being dropped.
 */
export function buildCellCommentaryRows(
	notes: Note[],
	sheets: Sheet[],
	sheetFilter: string | null
): CellCommentaryRow[] {
	const sheetByName = new Map(sheets.map((s) => [s.name, s]));

	const cellNotes = notes.filter(
		(n): n is Note & { anchor: CellAnchor } =>
			n.anchor.kind === 'cell' && (sheetFilter === null || n.anchor.sheet === sheetFilter)
	);

	const rows: CellCommentaryRow[] = cellNotes.map((n) => {
		const { sheet, column, rowIndex } = n.anchor;
		const isColumnLevel = rowIndex === -1;
		const sourceSheet = sheetByName.get(sheet);
		const cellContent = isColumnLevel
			? null
			: (sourceSheet?.rows[rowIndex]?.[column] ?? null);
		return {
			sheet,
			column,
			rowIndex,
			rowNumber: isColumnLevel ? null : rowIndex + 1,
			cellContent,
			noteBody: n.body,
			author: n.author,
			createdAt: n.createdAt
		};
	});

	// Newest first.
	rows.sort((a, b) => b.createdAt - a.createdAt);
	return rows;
}

/** Distinct sheet names that have at least one cell-anchored note — drives
 *  the report's sheet picker (only sheets worth offering). */
export function sheetsWithCellNotes(notes: Note[]): string[] {
	const names = new Set<string>();
	for (const n of notes) {
		if (n.anchor.kind === 'cell') names.add(n.anchor.sheet);
	}
	return [...names];
}

/** Format one row's cell content for display — "(whole column)" for
 *  column-level notes, "(blank)" for an empty/missing cell value. */
export function formatCellContent(row: CellCommentaryRow): string {
	if (row.rowNumber === null) return '(whole column)';
	if (row.cellContent === null || row.cellContent === '') return '(blank)';
	return row.cellContent;
}

/** Format one row's row-number column — blank for column-level notes. */
export function formatRowNumber(row: CellCommentaryRow): string {
	return row.rowNumber === null ? '—' : String(row.rowNumber);
}

/**
 * Build the single table section pdf-writer.ts draws for this report:
 * Sheet · Column · Row · Cell content · Note, newest-first (rows are
 * already sorted that way by buildCellCommentaryRows()).
 */
export function buildCellCommentarySection(rows: CellCommentaryRow[]): ReportTableSection {
	const columns = ['Sheet', 'Column', 'Row', 'Cell Content', 'Note'];
	const lines: ReportLine[] = rows.map((r) => ({
		kind: 'data',
		cells: [r.sheet, r.column, formatRowNumber(r), formatCellContent(r), r.noteBody || '(empty note)']
	}));
	const columnSamples = columns.map((_, i) =>
		lines.slice(0, 20).map((l) => (l.kind === 'group-header' ? l.label : (l.cells[i] ?? '')))
	);
	return { heading: 'Cell Commentary', columns, columnSamples, lines };
}
