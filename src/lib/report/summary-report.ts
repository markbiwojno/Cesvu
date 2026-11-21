/**
 * src/lib/report/summary-report.ts — pure grouping/aggregation math for the
 * "Summary report" Generate Report option.
 *
 * Deliberately format/source-agnostic: callers (report-worker.ts) adapt
 * SheetJS cell objects (Excel, with `.z`/`.w`/`.v`) or plain CSV strings into
 * the neutral {@link ParsedCell} shape before calling {@link buildSummaryReport}.
 * This keeps the grouping/subtotal/sort logic unit-testable without pulling
 * in the `xlsx` package or a Worker.
 */

import { suggestAggregation, type AggregationChoice } from './column-heuristics.js';
export type { AggregationChoice };

/** Group label used for rows whose group-by cell is blank/missing. */
export const BLANK_GROUP_LABEL = '(blank)';

/** Group key for the single implicit group when no group-by column is chosen. */
export const NO_GROUPING_LABEL = 'All rows';

/**
 * A single cell, adapted to a format the report math can reason about
 * regardless of source (Excel cell object vs. plain CSV string).
 */
export interface ParsedCell {
	/**
	 * Numeric value to use for aggregation (sum/average) or, for a column
	 * flagged as a date column, the cell's timestamp in epoch milliseconds.
	 * `null` when the cell has no usable numeric value (text, blank, error).
	 */
	numeric: number | null;
	/** Display text exactly as the source showed it (never reformatted). */
	display: string;
	/** True for an empty/missing cell. Excluded from sums AND averages. */
	isBlank: boolean;
	/**
	 * True for a formula error (#DIV/0!, #N/A, …) or a formula cell with no
	 * cached value. Excluded from sums and averages; counted in warnings.
	 */
	isError: boolean;
}

export type ParsedRow = Record<string, ParsedCell>;

export type SortOption =
	| { by: 'group-key'; direction: 'asc' | 'desc' }
	| { by: 'row-count'; direction: 'asc' | 'desc' }
	| { by: 'column-subtotal'; column: string; direction: 'asc' | 'desc' };

export interface ColumnAggSpec {
	column: string;
	aggregation: AggregationChoice;
}

export type ReportDetail = 'summary' | 'summary-and-detail';

export interface BuildSummaryReportOptions {
	headers: string[];
	rows: ParsedRow[];
	/** null = no grouping (every row falls into one implicit group). */
	groupByColumn: string | null;
	/** Only entries with aggregation !== 'none' produce a ColumnTotal. */
	columnAggregations: ColumnAggSpec[];
	/** Headers flagged as date-formatted — excluded from aggregation, used for dateRanges. */
	dateColumns: string[];
	sort: SortOption | null;
	detail: ReportDetail;
	/**
	 * True when `rows` was capped below the sheet's true row count. The
	 * worker always re-parses the full file so this should normally be
	 * false — kept so a "Showing N of M rows" warning can still surface if a
	 * caller ever has to fall back to a capped buffer.
	 */
	isRowSetCapped?: boolean;
	/** True row count of the source sheet, for the "Showing N of M" message. */
	trueRowCount?: number;
}

export interface ColumnTotal {
	column: string;
	aggregation: AggregationChoice;
	/** Raw numeric sum or average. Formatting (currency/%/date) happens elsewhere. */
	value: number;
	/** Cells skipped because they were errors/unresolved formulas. */
	skippedErrorCount: number;
	/** Cells skipped because they were blank (relevant mainly for averages). */
	skippedBlankCount: number;
}

export interface ReportGroup {
	key: string;
	rowCount: number;
	rows: ParsedRow[];
	totals: ColumnTotal[];
}

export interface DateRange {
	column: string;
	minMs: number;
	maxMs: number;
}

export interface SummaryReport {
	groups: ReportGroup[];
	grandTotals: ColumnTotal[];
	totalRowCount: number;
	groupCount: number;
	warnings: string[];
	dateRanges: DateRange[];
}

/** Threshold above which a "lots of groups" warning is raised. */
export const MANY_GROUPS_WARNING_THRESHOLD = 500;

function groupKeyFor(row: ParsedRow, groupByColumn: string | null): string {
	if (!groupByColumn) return NO_GROUPING_LABEL;
	const cell = row[groupByColumn];
	if (!cell || cell.isBlank) return BLANK_GROUP_LABEL;
	const trimmed = cell.display.trim();
	return trimmed === '' ? BLANK_GROUP_LABEL : trimmed;
}

/** Sum/average a set of columns over an arbitrary row slice. */
function aggregateColumns(rows: ParsedRow[], specs: ColumnAggSpec[]): ColumnTotal[] {
	const totals: ColumnTotal[] = [];
	for (const spec of specs) {
		if (spec.aggregation === 'none') continue;
		let sum = 0;
		let count = 0;
		let skippedErrorCount = 0;
		let skippedBlankCount = 0;
		for (const row of rows) {
			const cell = row[spec.column];
			if (!cell || cell.isError) {
				if (cell?.isError) skippedErrorCount++;
				continue;
			}
			if (cell.isBlank || cell.numeric === null) {
				skippedBlankCount++;
				continue;
			}
			sum += cell.numeric;
			count++;
		}
		const value = spec.aggregation === 'average' ? (count > 0 ? sum / count : 0) : sum;
		totals.push({ column: spec.column, aggregation: spec.aggregation, value, skippedErrorCount, skippedBlankCount });
	}
	return totals;
}

function computeDateRanges(rows: ParsedRow[], dateColumns: string[]): DateRange[] {
	const ranges: DateRange[] = [];
	for (const column of dateColumns) {
		let min = Infinity;
		let max = -Infinity;
		for (const row of rows) {
			const cell = row[column];
			if (!cell || cell.isBlank || cell.isError || cell.numeric === null) continue;
			if (cell.numeric < min) min = cell.numeric;
			if (cell.numeric > max) max = cell.numeric;
		}
		if (min !== Infinity) ranges.push({ column, minMs: min, maxMs: max });
	}
	return ranges;
}

function sortGroups(groups: ReportGroup[], sort: SortOption | null): ReportGroup[] {
	if (!sort) return groups;
	const dir = sort.direction === 'asc' ? 1 : -1;
	const sorted = [...groups];
	if (sort.by === 'group-key') {
		sorted.sort((a, b) => dir * a.key.localeCompare(b.key));
	} else if (sort.by === 'row-count') {
		sorted.sort((a, b) => dir * (a.rowCount - b.rowCount));
	} else {
		const col = sort.column;
		sorted.sort((a, b) => {
			const av = a.totals.find((t) => t.column === col)?.value ?? 0;
			const bv = b.totals.find((t) => t.column === col)?.value ?? 0;
			return dir * (av - bv);
		});
	}
	return sorted;
}

/**
 * Build the grouped summary report from already-parsed rows. Pure function —
 * no I/O, no PDF, no xlsx — so it's cheap to exercise exhaustively in tests.
 */
export function buildSummaryReport(opts: BuildSummaryReportOptions): SummaryReport {
	const aggSpecs = opts.columnAggregations.filter((s) => s.aggregation !== 'none');

	const byKey = new Map<string, ParsedRow[]>();
	for (const row of opts.rows) {
		const key = groupKeyFor(row, opts.groupByColumn);
		const bucket = byKey.get(key);
		if (bucket) bucket.push(row);
		else byKey.set(key, [row]);
	}

	let groups: ReportGroup[] = [...byKey.entries()].map(([key, rows]) => ({
		key,
		rowCount: rows.length,
		rows,
		totals: aggregateColumns(rows, aggSpecs)
	}));

	groups = sortGroups(groups, opts.sort);

	const grandTotals = aggregateColumns(opts.rows, aggSpecs);

	const warnings: string[] = [];
	if (groups.length > MANY_GROUPS_WARNING_THRESHOLD) {
		warnings.push(
			`This report has ${groups.length.toLocaleString()} groups, which is a lot — ` +
				`consider choosing a different "Group by" column or narrowing the data first.`
		);
	}
	const totalSkippedErrors = grandTotals.reduce((sum, t) => sum + t.skippedErrorCount, 0);
	if (totalSkippedErrors > 0) {
		warnings.push(
			`${totalSkippedErrors.toLocaleString()} error or unresolved-formula cell(s) were ` +
				`excluded from totals and averages.`
		);
	}
	if (opts.isRowSetCapped && opts.trueRowCount) {
		warnings.push(
			`Showing ${opts.rows.length.toLocaleString()} of ${opts.trueRowCount.toLocaleString()} rows.`
		);
	}

	return {
		groups,
		grandTotals,
		totalRowCount: opts.rows.length,
		groupCount: groups.length,
		warnings,
		dateRanges: computeDateRanges(opts.rows, opts.dateColumns)
	};
}

/**
 * Convenience: build the default per-column aggregation list for a set of
 * numeric (non-date) headers, using {@link suggestAggregation}'s heuristic.
 * The report modal calls this once to pre-fill its per-column controls;
 * users can change any entry before generating.
 */
export function defaultColumnAggregations(numericHeaders: string[]): ColumnAggSpec[] {
	return numericHeaders.map((column) => ({
		column,
		aggregation: suggestAggregation(column)
	}));
}
