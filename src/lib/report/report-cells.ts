/**
 * src/lib/report/report-cells.ts — adapts raw source cells (SheetJS cell
 * objects for Excel, plain strings for CSV) into the neutral {@link ParsedCell}
 * shape that summary-report.ts's pure math operates on.
 *
 * Kept separate from report-worker.ts so this adaptation logic — the part
 * most worth covering with fixtures (error cells, blanks, dates, percents,
 * negatives) — is unit-testable without spinning up a Worker.
 */

import type { ParsedCell } from './summary-report.js';

/** The slice of a SheetJS cell object this module actually needs. */
export interface Xlsxish {
	/** Cell type: 'n' numeric, 's' string, 'b' boolean, 'e' error, etc. */
	t?: string;
	/** Raw value — number, string, boolean, or (with cellDates:true) a Date. */
	v?: unknown;
	/** Formatted display text, present when the workbook was read with cellNF/cellText. */
	w?: string;
	/** Number format code, present when read with cellNF:true. */
	z?: string;
}

/**
 * Adapt one SheetJS cell (read with `{ cellNF: true, cellDates: true }`)
 * into a ParsedCell.
 *
 * - Error cells (`t === 'e'`) AND formula cells with no cached value (`v`
 *   undefined) are flagged `isError` — excluded from sums/averages (req. #10).
 * - A `Date` value (from `cellDates: true`) becomes `numeric` = epoch ms, so
 *   date columns can feed {@link computeDateRanges} directly.
 * - `display` always prefers `.w` (the format-aware display text SheetJS
 *   computed); falls back to `String(v)` only when `.w` is missing (req. #10).
 */
export function adaptExcelCell(cell: Xlsxish | undefined): ParsedCell {
	if (!cell || cell.v === undefined || cell.v === null) {
		return { numeric: null, display: cell?.w ?? '', isBlank: true, isError: false };
	}
	if (cell.t === 'e') {
		return { numeric: null, display: cell.w ?? String(cell.v), isBlank: false, isError: true };
	}
	if (cell.v instanceof Date) {
		const ms = cell.v.getTime();
		return {
			numeric: Number.isNaN(ms) ? null : ms,
			display: cell.w ?? String(cell.v),
			isBlank: false,
			isError: false
		};
	}
	if (typeof cell.v === 'number') {
		return { numeric: cell.v, display: cell.w ?? String(cell.v), isBlank: false, isError: false };
	}
	// String/boolean cell — not numeric, but not blank (has real content).
	const display = cell.w ?? String(cell.v);
	return { numeric: null, display, isBlank: display.trim() === '', isError: false };
}

const NUMERIC_STRIP_RE = /[$,%\s]/g;

/**
 * Adapt a plain CSV string cell. CSV carries no per-cell format metadata, so
 * there is no `.w`/`.z` — `display` is the raw string, and numeric detection
 * is a best-effort parse (strips `$`, `,`, `%`, matching the heuristic
 * already used elsewhere in the app — see pipeline.ts/csv.ts).
 */
export function adaptCsvCell(raw: string | undefined | null): ParsedCell {
	if (raw === undefined || raw === null || raw.trim() === '') {
		return { numeric: null, display: raw ?? '', isBlank: true, isError: false };
	}
	const cleaned = raw.replace(NUMERIC_STRIP_RE, '');
	const n = cleaned !== '' && !Number.isNaN(Number(cleaned)) ? Number(cleaned) : null;
	return { numeric: n, display: raw, isBlank: false, isError: false };
}

/**
 * Decide whether a column (by its SheetJS cell objects, header row excluded)
 * is a DATE column: a majority of its non-blank cells carry a number format
 * recognized by `XLSX.SSF.is_date(z)`. Date columns are excluded from
 * sum/average aggregation and feed the KPI date range instead (req. #5).
 *
 * `isDateFormat` is injected (rather than importing `xlsx` here) so this
 * module — and its tests — never need the `xlsx` package, which is loaded
 * dynamically elsewhere to keep it out of non-Excel bundles.
 */
export function columnLooksLikeDate(
	cells: (Xlsxish | undefined)[],
	isDateFormat: (z: string) => boolean
): boolean {
	let dateCount = 0;
	let nonBlankCount = 0;
	for (const cell of cells) {
		if (!cell || cell.v === undefined || cell.v === null) continue;
		nonBlankCount++;
		if (cell.z && isDateFormat(cell.z)) dateCount++;
	}
	if (nonBlankCount === 0) return false;
	return dateCount / nonBlankCount > 0.5;
}
