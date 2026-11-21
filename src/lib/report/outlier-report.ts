/**
 * src/lib/report/outlier-report.ts — pure numeric-outlier detection math for
 * the "Data Outlier Analysis" Generate Report option.
 *
 * Deliberately format/source-agnostic, same pattern as duplication-report.ts:
 * operates on the neutral {@link ParsedRow} shape (built by report-cells.ts's
 * adaptExcelCell/adaptCsvCell), so it's unit-testable without pulling in the
 * `xlsx` package or a Worker, and report-worker.ts can feed it the exact same
 * re-parsed rows it already builds for the Summary/Duplication reports.
 *
 * Detection method: the IQR fence — the SAME statistic
 * src/lib/pipeline/columnStats.ts already computes for the Data Workbench
 * dashboard's "Show outliers" callout (ColumnTile.svelte), via the
 * `simple-statistics` quantile() function, so a value flagged here agrees
 * with what the dashboard would flag for the same column. A value is an
 * outlier when it falls outside [Q1 - k·IQR, Q3 + k·IQR], where k is 1.5
 * ("standard" sensitivity, the conventional Tukey fence) or 3 ("extreme" —
 * only the most severe outliers).
 *
 * Row-count safety: unlike the Duplication Report's compact mode (which
 * joined row numbers into one cell and could overflow a page for a large
 * cluster — see the fix in duplication-report.ts), this report's natural
 * unit is ONE ROW PER FLAGGED VALUE, so an outlier-heavy column just means a
 * longer (but still correctly paginating) detail table — no cell can grow
 * unboundedly. {@link MAX_OUTLIER_DETAIL_ROWS} is a coarse total-row cap
 * purely as a performance/file-size backstop for pathological inputs (e.g.
 * a column that's mostly outliers on a very large sheet); the column-summary
 * table's counts are NEVER truncated.
 */

import { quantile } from 'simple-statistics';
import type { ParsedRow } from './summary-report.js';
import type { ReportTableSection, ReportLine } from './pdf-writer.js';

/** 'standard' = classic Tukey fence (1.5× IQR). 'extreme' = only the most
 *  severe outliers (3× IQR) — fewer, more clearly actionable flags. */
export type OutlierSensitivity = 'standard' | 'extreme';

const SENSITIVITY_MULTIPLIER: Record<OutlierSensitivity, number> = {
	standard: 1.5,
	extreme: 3
};

/** Coarse cap on the detail table's TOTAL row count across all columns —
 *  a performance/file-size backstop, not a correctness fix (see module doc
 *  comment). The column-summary table's counts are always complete. */
export const MAX_OUTLIER_DETAIL_ROWS = 20_000;

export interface OutlierColumnSummary {
	column: string;
	nonNullCount: number;
	outlierCount: number;
	/** 0–1 share of non-null values flagged, for display as a percentage. */
	pctOfRows: number;
	q1: number;
	q3: number;
	iqr: number;
	/** Lower/upper fence — values outside this range are flagged. */
	loFence: number;
	hiFence: number;
}

export interface OutlierDetailRow {
	column: string;
	/** 1-based row number in the source sheet. */
	rowNumber: number;
	value: number;
	/** Display text exactly as the source showed it (never reformatted). */
	display: string;
	/** e.g. "+2.3× IQR above fence" or "-1.1× IQR below fence". */
	deviation: string;
}

export interface OutlierAnalysis {
	columnSummaries: OutlierColumnSummary[];
	/** Detail rows, capped at {@link MAX_OUTLIER_DETAIL_ROWS} total. */
	details: OutlierDetailRow[];
	/** TRUE total across all columns, before any cap is applied. */
	totalOutlierCount: number;
}

function formatDeviation(value: number, loFence: number, hiFence: number, iqr: number): string {
	if (iqr <= 0) return value > hiFence ? 'above fence' : 'below fence';
	if (value > hiFence) {
		const mult = (value - hiFence) / iqr;
		return `+${mult.toFixed(1)}× IQR above fence`;
	}
	const mult = (loFence - value) / iqr;
	return `-${mult.toFixed(1)}× IQR below fence`;
}

/**
 * Find numeric outliers (IQR-fence method) across `columns`, over already
 * re-parsed rows. Pure function — no I/O, no PDF, no xlsx — cheap to
 * exercise exhaustively in tests.
 */
export function findOutliers(
	rows: ParsedRow[],
	columns: string[],
	sensitivity: OutlierSensitivity
): OutlierAnalysis {
	const multiplier = SENSITIVITY_MULTIPLIER[sensitivity];
	const columnSummaries: OutlierColumnSummary[] = [];
	const details: OutlierDetailRow[] = [];
	let totalOutlierCount = 0;

	for (const column of columns) {
		// Collect numeric values + their 1-based row numbers + display text,
		// skipping blank/error/non-numeric cells (mirrors summary-report.ts's
		// aggregateColumns() skip rules).
		const entries: { rowNumber: number; value: number; display: string }[] = [];
		rows.forEach((row, i) => {
			const cell = row[column];
			if (!cell || cell.isBlank || cell.isError || cell.numeric === null) return;
			entries.push({ rowNumber: i + 1, value: cell.numeric, display: cell.display });
		});
		if (entries.length === 0) continue;

		const values = entries.map((e) => e.value);
		const q1 = quantile(values, 0.25);
		const q3 = quantile(values, 0.75);
		const iqr = q3 - q1;
		const loFence = q1 - multiplier * iqr;
		const hiFence = q3 + multiplier * iqr;

		const flagged = entries.filter((e) => e.value < loFence || e.value > hiFence);
		totalOutlierCount += flagged.length;

		columnSummaries.push({
			column,
			nonNullCount: entries.length,
			outlierCount: flagged.length,
			pctOfRows: flagged.length / entries.length,
			q1,
			q3,
			iqr,
			loFence,
			hiFence
		});

		for (const e of flagged) {
			details.push({
				column,
				rowNumber: e.rowNumber,
				value: e.value,
				display: e.display,
				deviation: formatDeviation(e.value, loFence, hiFence, iqr)
			});
		}
	}

	columnSummaries.sort((a, b) => b.outlierCount - a.outlierCount);
	return {
		columnSummaries,
		details: details.slice(0, MAX_OUTLIER_DETAIL_ROWS),
		totalOutlierCount
	};
}

export type OutlierReportDetail = 'summary' | 'summary-and-detail';

function formatNum(n: number): string {
	return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

/**
 * Build the report sections pdf-writer.ts draws. Mirrors the Summary
 * Report's "Group summary" + optional "Detail" split:
 *
 *   Column outlier summary (always shown) — one row per analyzed column:
 *   non-null count, outlier count, % of rows, and the expected [lo, hi]
 *   range. Bounded by the number of analyzed columns, never by row count.
 *
 *   Outlier detail (shown in "summary-and-detail" mode) — one group-header
 *   per column + one data line per flagged value (row #, value, deviation).
 */
export function buildOutlierSections(
	analysis: OutlierAnalysis,
	detail: OutlierReportDetail
): ReportTableSection[] {
	const summaryColumns = ['Column', 'Non-null rows', 'Outlier count', '% of rows', 'Expected range'];
	const summaryLines: ReportLine[] = analysis.columnSummaries.map((s) => ({
		kind: 'data',
		cells: [
			s.column,
			s.nonNullCount.toLocaleString(),
			s.outlierCount.toLocaleString(),
			`${(s.pctOfRows * 100).toFixed(1)}%`,
			`${formatNum(s.loFence)} – ${formatNum(s.hiFence)}`
		]
	}));
	const summarySamples = summaryColumns.map((_, i) =>
		summaryLines.slice(0, 20).map((l) => (l.kind === 'group-header' ? l.label : (l.cells[i] ?? '')))
	);
	const sections: ReportTableSection[] = [
		{ heading: 'Column outlier summary', columns: summaryColumns, columnSamples: summarySamples, lines: summaryLines }
	];

	if (detail === 'summary-and-detail') {
		const detailColumns = ['Row #', 'Value', 'Deviation'];
		const detailLines: ReportLine[] = [];
		let currentColumn: string | null = null;
		for (const d of analysis.details) {
			if (d.column !== currentColumn) {
				const summary = analysis.columnSummaries.find((s) => s.column === d.column);
				const label = summary
					? `${d.column} — ${summary.outlierCount.toLocaleString()} outlier${summary.outlierCount === 1 ? '' : 's'} (expected range ${formatNum(summary.loFence)} – ${formatNum(summary.hiFence)})`
					: d.column;
				detailLines.push({ kind: 'group-header', label });
				currentColumn = d.column;
			}
			detailLines.push({ kind: 'data', cells: [String(d.rowNumber), d.display, d.deviation] });
		}
		const detailSamples = detailColumns.map((_, i) =>
			detailLines.slice(0, 50).map((l) => (l.kind === 'group-header' ? l.label : (l.cells[i] ?? '')))
		);
		sections.push({
			heading: 'Outlier detail',
			columns: detailColumns,
			columnSamples: detailSamples,
			lines: detailLines
		});
	}

	return sections;
}
