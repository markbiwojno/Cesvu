/**
 * src/lib/report/report-pdf-input.ts — converts a {@link SummaryReport}
 * (pure grouping/aggregation math) into the {@link ReportPdfInput} shape
 * pdf-writer.ts actually draws.
 *
 * Kept separate so this formatting-and-section-building step is
 * unit-testable without touching pdf-lib, fonts, or a Worker.
 */

import type {
	SummaryReport,
	ReportDetail,
	ColumnAggSpec,
	ReportGroup,
	ParsedRow,
	AggregationChoice
} from './summary-report.js';
import type { ReportTableSection, ReportLine } from './pdf-writer.js';

export type FormatTotalFn = (column: string, value: number, aggregation: AggregationChoice) => string;

function describeAggregations(specs: ColumnAggSpec[]): string {
	const active = specs.filter((s) => s.aggregation !== 'none');
	if (active.length === 0) return 'None';
	return active.map((s) => `${s.column} (${s.aggregation === 'sum' ? 'Sum' : 'Average'})`).join(', ');
}

/** Build the compact "Settings" block printed on page 1. */
export function buildSettingsLines(opts: {
	sheetName?: string;
	groupByColumn: string | null;
	columnAggregations: ColumnAggSpec[];
	sortDescription: string;
	detail: ReportDetail;
	pageSize: 'Letter' | 'A4';
	groupCount: number;
	sha256Full: string;
}): string[] {
	const lines: string[] = [];
	if (opts.sheetName) lines.push(`Sheet: ${opts.sheetName}`);
	lines.push(`Group by: ${opts.groupByColumn ?? 'None (all rows in one group)'}`);
	lines.push(`Aggregations: ${describeAggregations(opts.columnAggregations)}`);
	lines.push(`Sort: ${opts.sortDescription}`);
	lines.push(`Detail: ${opts.detail === 'summary' ? 'Summary only' : 'Summary + detail rows'}`);
	lines.push(`Page size: ${opts.pageSize}`);
	lines.push(`Groups: ${opts.groupCount.toLocaleString()}`);
	lines.push(`SHA-256: ${opts.sha256Full}`);
	return lines;
}

/** Build the KPI header block: grand totals, group count, date ranges. */
export function buildKpiLines(
	report: SummaryReport,
	formatTotal: FormatTotalFn,
	dateFormatter: (ms: number) => string
): string[] {
	const lines: string[] = [];
	lines.push(`Total rows: ${report.totalRowCount.toLocaleString()}`);
	lines.push(`Groups: ${report.groupCount.toLocaleString()}`);
	for (const t of report.grandTotals) {
		lines.push(
			`Grand total ${t.column} (${t.aggregation === 'sum' ? 'Sum' : 'Average'}): ${formatTotal(t.column, t.value, t.aggregation)}`
		);
	}
	for (const r of report.dateRanges) {
		lines.push(`${r.column} range: ${dateFormatter(r.minMs)} – ${dateFormatter(r.maxMs)}`);
	}
	return lines;
}

/**
 * Build the "Group summary" table: one row per group with its row count and
 * per-aggregated-column subtotal, plus a grand-total row (req. #7/#8).
 * This table is what "Summary only" mode shows ON ITS OWN — report-worker.ts
 * omits the detail section entirely in that mode.
 */
export function buildGroupSummarySection(
	report: SummaryReport,
	aggregatedColumns: string[],
	formatTotal: FormatTotalFn
): ReportTableSection {
	const columns = ['Group', 'Row count', ...aggregatedColumns];
	const totalFor = (g: ReportGroup, col: string) => g.totals.find((t) => t.column === col);

	const lines: ReportLine[] = report.groups.map((g) => ({
		kind: 'data',
		cells: [
			g.key,
			g.rowCount.toLocaleString(),
			...aggregatedColumns.map((col) => {
				const t = totalFor(g, col);
				return t ? formatTotal(col, t.value, t.aggregation) : '';
			})
		]
	}));

	lines.push({
		kind: 'grand-total',
		cells: [
			'Grand total',
			report.totalRowCount.toLocaleString(),
			...aggregatedColumns.map((col) => {
				const t = report.grandTotals.find((gt) => gt.column === col);
				return t ? formatTotal(col, t.value, t.aggregation) : '';
			})
		]
	});

	const columnSamples = columns.map((_, i) =>
		lines.slice(0, 20).map((l) => (l.kind === 'group-header' ? l.label : l.cells[i] ?? ''))
	);

	return { heading: 'Group summary', columns, columnSamples, lines };
}

/**
 * Build the "Detail" table: every row, grouped with a header + per-group
 * subtotal row, ending in a grand-total row. Omitted entirely in
 * "summary only" mode — report-worker.ts simply doesn't call this then.
 */
export function buildDetailSection(
	report: SummaryReport,
	headers: string[],
	aggregatedColumns: string[],
	formatTotal: FormatTotalFn,
	cellsForRow: (row: ParsedRow) => string[],
	showGroupHeaders: boolean
): ReportTableSection {
	const lines: ReportLine[] = [];
	for (const g of report.groups) {
		if (showGroupHeaders) lines.push({ kind: 'group-header', label: g.key });
		for (const row of g.rows) lines.push({ kind: 'data', cells: cellsForRow(row) });
		if (showGroupHeaders && g.totals.length > 0) {
			lines.push({
				kind: 'subtotal',
				cells: headers.map((h) => {
					const t = g.totals.find((gt) => gt.column === h);
					return t ? `Subtotal: ${formatTotal(h, t.value, t.aggregation)}` : '';
				})
			});
		}
	}
	if (report.grandTotals.length > 0) {
		lines.push({
			kind: 'grand-total',
			cells: headers.map((h) => {
				const t = report.grandTotals.find((gt) => gt.column === h);
				return t ? `Grand total: ${formatTotal(h, t.value, t.aggregation)}` : '';
			})
		});
	}

	const sampleRows = report.groups.flatMap((g) => g.rows).slice(0, 50);
	const columnSamples = headers.map((h) => sampleRows.map((r) => r[h]?.display ?? ''));

	return { heading: 'Detail', columns: headers, columnSamples, lines };
}
