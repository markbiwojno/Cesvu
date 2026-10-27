/**
 * src/lib/data/workbook.ts — Workbook data model for multi-sheet documents
 *
 * This module defines the canonical data model for tabular documents that may
 * contain multiple sheets (e.g. Excel .xlsx workbooks). It unifies the way the
 * application reasons about spreadsheet-style data regardless of source format.
 *
 * ── CSV as a single-sheet workbook ──────────────────────────────────────────
 * A CSV/TSV file has no concept of multiple tabs. To keep the rest of the
 * pipeline parser-agnostic, a CSV is modeled as a `Workbook` containing exactly
 * ONE `Sheet`. The sheet name defaults to the file name (or "Sheet1"), and
 * `activeSheet` points at that single sheet. This means downstream code —
 * profiling, signal extraction, sampling, compression, rendering — can treat
 * every tabular input uniformly as a `Workbook`, whether it originated from a
 * single-sheet CSV or a multi-tab .xlsx file.
 *
 * Import {@link ColumnProfile} from `../types.ts` for per-column statistics.
 */

import type { ColumnProfile } from '../types.js';

/**
 * A single sheet (tab) of tabular data.
 *
 * For CSV files there is exactly one `Sheet` per `Workbook`. For Excel files
 * there is one `Sheet` per worksheet tab in the workbook.
 */
export interface Sheet {
	/** The sheet/tab name. For CSV, defaults to the file name or "Sheet1". */
	name: string;
	/** Ordered list of column header names. */
	headers: string[];
	/**
	 * Row objects keyed by header name. Values are normalized to strings.
	 * NOTE: this array is the DISPLAY/query buffer and may be CAPPED at
	 * MAX_DISPLAY_ROWS for very large sheets. `rowCount` always reflects the
	 * true number of data rows; `isSampled` flags when capping occurred.
	 */
	rows: Record<string, string>[];
	/** True number of data rows in the source sheet (excludes the header row). */
	rowCount: number;
	/**
	 * True when `rows` was capped to MAX_DISPLAY_ROWS (rowCount > rows.length).
	 * Column statistics in the SheetProfile still reflect ALL rows.
	 */
	isSampled?: boolean;
	/**
	 * Pre-computed per-column profiles over the FULL (uncapped) row set,
	 * produced in the Excel worker before the display buffer was capped. When
	 * present, profileWorkbook() uses these instead of re-profiling the (capped)
	 * `rows` array, so stats reflect every row. Absent for CSV-derived sheets.
	 */
	fullProfile?: ColumnProfile[];
	/**
	 * Optional per-row formula map keyed by header name, present only when the
	 * source format preserves formulas (e.g. .xlsx). CSV sheets never have this.
	 */
	formulas?: Record<string, string>[];

}

/**
 * A workbook containing one or more sheets.
 *
 * CSV files are represented as a single-sheet workbook (see module docs).
 * Excel files map each worksheet tab onto a `Sheet`.
 */
export interface Workbook {
	/** Original file name (e.g. "q3_sales.xlsx" or "data.csv"). */
	fileName: string;
	/** All sheets in the workbook, in their original tab order. */
	sheets: Sheet[];
	/** Name of the currently active/selected sheet. */
	activeSheet: string;
}

/**
 * Profiling summary for a single sheet.
 *
 * Produced during the PROFILE stage of the pipeline. Each `ColumnProfile`
 * (imported from `../types.ts`) describes the type and statistics of one column.
 */
export interface SheetProfile {
	/** The sheet/tab name this profile describes. */
	name: string;
	/** Number of data rows in the sheet. */
	rowCount: number;
	/** Per-column type classification and statistics. */
	columns: ColumnProfile[];
	/** Whether any cell in this sheet contains a formula. */
	hasFormulas: boolean;
}

/**
 * Profiling summary for an entire workbook.
 *
 * Aggregates per-sheet profiles plus workbook-wide totals. For a CSV
 * (single-sheet workbook) `sheets` contains exactly one `SheetProfile`.
 */
export interface WorkbookProfile {
	/** Original file name. */
	fileName: string;
	/** Sum of `rowCount` across all sheets. */
	totalRows: number;
	/** Sum of column counts across all sheets. */
	totalColumns: number;
	/** Per-sheet profiles, in tab order. */
	sheets: SheetProfile[];
}
