import { describe, it, expect } from 'vitest';
import {
	buildSummaryReport,
	defaultColumnAggregations,
	BLANK_GROUP_LABEL,
	NO_GROUPING_LABEL,
	MANY_GROUPS_WARNING_THRESHOLD,
	type ParsedRow,
	type ParsedCell
} from './summary-report.js';

function cell(numeric: number | null, display: string, opts: Partial<ParsedCell> = {}): ParsedCell {
	return { numeric, display, isBlank: false, isError: false, ...opts };
}

function blankCell(): ParsedCell {
	return { numeric: null, display: '', isBlank: true, isError: false };
}

function errorCell(display = '#DIV/0!'): ParsedCell {
	return { numeric: null, display, isBlank: false, isError: true };
}

function row(obj: Record<string, ParsedCell>): ParsedRow {
	return obj;
}

describe('buildSummaryReport — grouping', () => {
	it('groups rows by the chosen column', () => {
		const rows = [
			row({ Region: cell(null, 'East'), Amount: cell(100, '100') }),
			row({ Region: cell(null, 'West'), Amount: cell(200, '200') }),
			row({ Region: cell(null, 'East'), Amount: cell(50, '50') })
		];
		const report = buildSummaryReport({
			headers: ['Region', 'Amount'],
			rows,
			groupByColumn: 'Region',
			columnAggregations: [{ column: 'Amount', aggregation: 'sum' }],
			dateColumns: [],
			sort: null,
			detail: 'summary-and-detail'
		});
		expect(report.groupCount).toBe(2);
		const east = report.groups.find((g) => g.key === 'East')!;
		expect(east.rowCount).toBe(2);
		expect(east.totals[0].value).toBe(150);
	});

	it('uses the implicit "All rows" group when groupByColumn is null', () => {
		const rows = [row({ Amount: cell(10, '10') }), row({ Amount: cell(20, '20') })];
		const report = buildSummaryReport({
			headers: ['Amount'],
			rows,
			groupByColumn: null,
			columnAggregations: [{ column: 'Amount', aggregation: 'sum' }],
			dateColumns: [],
			sort: null,
			detail: 'summary-and-detail'
		});
		expect(report.groupCount).toBe(1);
		expect(report.groups[0].key).toBe(NO_GROUPING_LABEL);
		expect(report.groups[0].totals[0].value).toBe(30);
	});

	it('buckets blank/missing group cells into "(blank)"', () => {
		const rows = [
			row({ Region: blankCell(), Amount: cell(5, '5') }),
			row({ Region: cell(null, '  '), Amount: cell(5, '5') }),
			row({ Region: cell(null, 'East'), Amount: cell(5, '5') })
		];
		const report = buildSummaryReport({
			headers: ['Region', 'Amount'],
			rows,
			groupByColumn: 'Region',
			columnAggregations: [],
			dateColumns: [],
			sort: null,
			detail: 'summary-and-detail'
		});
		expect(report.groups.find((g) => g.key === BLANK_GROUP_LABEL)?.rowCount).toBe(2);
	});
});

describe('buildSummaryReport — aggregation', () => {
	it('computes sum and average independently per column', () => {
		const rows = [
			row({ A: cell(10, '10'), B: cell(2, '2') }),
			row({ A: cell(20, '20'), B: cell(4, '4') })
		];
		const report = buildSummaryReport({
			headers: ['A', 'B'],
			rows,
			groupByColumn: null,
			columnAggregations: [
				{ column: 'A', aggregation: 'sum' },
				{ column: 'B', aggregation: 'average' }
			],
			dateColumns: [],
			sort: null,
			detail: 'summary-and-detail'
		});
		const totals = report.grandTotals;
		expect(totals.find((t) => t.column === 'A')!.value).toBe(30);
		expect(totals.find((t) => t.column === 'B')!.value).toBe(3);
	});

	it('excludes error cells from sum/average and counts them', () => {
		const rows = [row({ A: cell(10, '10') }), row({ A: errorCell() }), row({ A: cell(20, '20') })];
		const report = buildSummaryReport({
			headers: ['A'],
			rows,
			groupByColumn: null,
			columnAggregations: [{ column: 'A', aggregation: 'sum' }],
			dateColumns: [],
			sort: null,
			detail: 'summary-and-detail'
		});
		const total = report.grandTotals[0];
		expect(total.value).toBe(30);
		expect(total.skippedErrorCount).toBe(1);
		expect(report.warnings.some((w) => w.includes('error or unresolved-formula'))).toBe(true);
	});

	it('excludes blanks from averages (does not count them toward the denominator)', () => {
		const rows = [row({ A: cell(10, '10') }), row({ A: blankCell() }), row({ A: cell(30, '30') })];
		const report = buildSummaryReport({
			headers: ['A'],
			rows,
			groupByColumn: null,
			columnAggregations: [{ column: 'A', aggregation: 'average' }],
			dateColumns: [],
			sort: null,
			detail: 'summary-and-detail'
		});
		expect(report.grandTotals[0].value).toBe(20);
		expect(report.grandTotals[0].skippedBlankCount).toBe(1);
	});

	it('produces no ColumnTotal for a column aggregated as "none"', () => {
		const rows = [row({ A: cell(10, '10') })];
		const report = buildSummaryReport({
			headers: ['A'],
			rows,
			groupByColumn: null,
			columnAggregations: [{ column: 'A', aggregation: 'none' }],
			dateColumns: [],
			sort: null,
			detail: 'summary-and-detail'
		});
		expect(report.grandTotals).toHaveLength(0);
	});
});

describe('buildSummaryReport — sort', () => {
	const rows = [
		row({ Region: cell(null, 'West'), Amount: cell(5, '5') }),
		row({ Region: cell(null, 'East'), Amount: cell(5, '5') }),
		row({ Region: cell(null, 'East'), Amount: cell(5, '5') })
	];
	const base = {
		headers: ['Region', 'Amount'],
		rows,
		groupByColumn: 'Region',
		columnAggregations: [{ column: 'Amount', aggregation: 'sum' as const }],
		dateColumns: [],
		detail: 'summary-and-detail' as const
	};

	it('sorts by group key', () => {
		const report = buildSummaryReport({ ...base, sort: { by: 'group-key', direction: 'asc' } });
		expect(report.groups.map((g) => g.key)).toEqual(['East', 'West']);
	});

	it('sorts by row count descending', () => {
		const report = buildSummaryReport({ ...base, sort: { by: 'row-count', direction: 'desc' } });
		expect(report.groups[0].key).toBe('East');
	});

	it('sorts by a column subtotal', () => {
		const report = buildSummaryReport({
			...base,
			sort: { by: 'column-subtotal', column: 'Amount', direction: 'desc' }
		});
		expect(report.groups[0].key).toBe('East');
	});
});

describe('buildSummaryReport — warnings', () => {
	it('warns when the group count exceeds the threshold', () => {
		const rows = Array.from({ length: MANY_GROUPS_WARNING_THRESHOLD + 1 }, (_, i) =>
			row({ Key: cell(null, `g${i}`) })
		);
		const report = buildSummaryReport({
			headers: ['Key'],
			rows,
			groupByColumn: 'Key',
			columnAggregations: [],
			dateColumns: [],
			sort: null,
			detail: 'summary-and-detail'
		});
		expect(report.warnings.some((w) => w.includes('a lot'))).toBe(true);
	});

	it('warns with "Showing N of M rows" when the row set is capped', () => {
		const rows = [row({ A: cell(1, '1') })];
		const report = buildSummaryReport({
			headers: ['A'],
			rows,
			groupByColumn: null,
			columnAggregations: [],
			dateColumns: [],
			sort: null,
			detail: 'summary-and-detail',
			isRowSetCapped: true,
			trueRowCount: 500
		});
		expect(report.warnings.some((w) => w.includes('Showing 1 of 500 rows'))).toBe(true);
	});
});

describe('buildSummaryReport — date ranges', () => {
	it('computes min/max for date-flagged columns, excluding blanks/errors', () => {
		const rows = [
			row({ D: cell(1000, '1/1/2024') }),
			row({ D: blankCell() }),
			row({ D: cell(5000, '2/1/2024') }),
			row({ D: errorCell() })
		];
		const report = buildSummaryReport({
			headers: ['D'],
			rows,
			groupByColumn: null,
			columnAggregations: [],
			dateColumns: ['D'],
			sort: null,
			detail: 'summary-and-detail'
		});
		expect(report.dateRanges).toEqual([{ column: 'D', minMs: 1000, maxMs: 5000 }]);
	});
});

describe('defaultColumnAggregations', () => {
	it('pre-fills sum for ordinary columns and none for identifier-like ones', () => {
		const specs = defaultColumnAggregations(['Amount Paid', 'Invoice #', 'Revenue']);
		expect(specs).toEqual([
			{ column: 'Amount Paid', aggregation: 'sum' },
			{ column: 'Invoice #', aggregation: 'none' },
			{ column: 'Revenue', aggregation: 'sum' }
		]);
	});
});
