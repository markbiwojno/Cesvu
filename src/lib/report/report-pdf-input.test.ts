import { describe, it, expect } from 'vitest';
import {
	buildSettingsLines,
	buildKpiLines,
	buildGroupSummarySection,
	buildDetailSection
} from './report-pdf-input.js';
import { buildSummaryReport, type ParsedRow, type ParsedCell } from './summary-report.js';

function cell(numeric: number | null, display: string): ParsedCell {
	return { numeric, display, isBlank: false, isError: false };
}
function row(obj: Record<string, ParsedCell>): ParsedRow {
	return obj;
}

const formatTotal = (_col: string, value: number) => value.toLocaleString();

describe('buildSettingsLines', () => {
	it('includes every setting and the full SHA-256', () => {
		const lines = buildSettingsLines({
			sheetName: 'Sheet1',
			groupByColumn: 'Region',
			columnAggregations: [{ column: 'Amount', aggregation: 'sum' }],
			sortDescription: 'Group key (asc)',
			detail: 'summary-and-detail',
			pageSize: 'Letter',
			groupCount: 3,
			sha256Full: 'a'.repeat(64)
		});
		const joined = lines.join('\n');
		expect(joined).toContain('Sheet: Sheet1');
		expect(joined).toContain('Group by: Region');
		expect(joined).toContain('Amount (Sum)');
		expect(joined).toContain('Group key (asc)');
		expect(joined).toContain('Summary + detail rows');
		expect(joined).toContain('Letter');
		expect(joined).toContain('Groups: 3');
		expect(joined).toContain('a'.repeat(64));
	});

	it('describes "no grouping" and "summary only" distinctly', () => {
		const lines = buildSettingsLines({
			groupByColumn: null,
			columnAggregations: [],
			sortDescription: 'None',
			detail: 'summary',
			pageSize: 'A4',
			groupCount: 1,
			sha256Full: 'b'.repeat(64)
		});
		const joined = lines.join('\n');
		expect(joined).toContain('None (all rows in one group)');
		expect(joined).toContain('Summary only');
	});
});

describe('buildKpiLines', () => {
	it('includes total rows, group count, grand totals, and date ranges', () => {
		const rows = [
			row({ Region: cell(null, 'East'), Amount: cell(100, '100'), Date: cell(1000, '1/1/2024') }),
			row({ Region: cell(null, 'West'), Amount: cell(200, '200'), Date: cell(5000, '2/1/2024') })
		];
		const report = buildSummaryReport({
			headers: ['Region', 'Amount', 'Date'],
			rows,
			groupByColumn: 'Region',
			columnAggregations: [{ column: 'Amount', aggregation: 'sum' }],
			dateColumns: ['Date'],
			sort: null,
			detail: 'summary-and-detail'
		});
		const lines = buildKpiLines(report, formatTotal, (ms) => new Date(ms).toISOString());
		const joined = lines.join('\n');
		expect(joined).toContain('Total rows: 2');
		expect(joined).toContain('Groups: 2');
		expect(joined).toContain('Grand total Amount (Sum): 300');
		expect(joined).toContain('Date range');
	});
});

describe('buildGroupSummarySection', () => {
	it('produces one row per group with row count + subtotal, plus a grand total', () => {
		const rows = [
			row({ Region: cell(null, 'East'), Amount: cell(100, '100') }),
			row({ Region: cell(null, 'East'), Amount: cell(50, '50') }),
			row({ Region: cell(null, 'West'), Amount: cell(200, '200') })
		];
		const report = buildSummaryReport({
			headers: ['Region', 'Amount'],
			rows,
			groupByColumn: 'Region',
			columnAggregations: [{ column: 'Amount', aggregation: 'sum' }],
			dateColumns: [],
			sort: { by: 'group-key', direction: 'asc' },
			detail: 'summary-and-detail'
		});
		const section = buildGroupSummarySection(report, ['Amount'], formatTotal);
		expect(section.heading).toBe('Group summary');
		expect(section.columns).toEqual(['Group', 'Row count', 'Amount']);
		expect(section.lines).toHaveLength(3); // East, West, grand-total
		expect(section.lines[0]).toEqual({ kind: 'data', cells: ['East', '2', '150'] });
		expect(section.lines[1]).toEqual({ kind: 'data', cells: ['West', '1', '200'] });
		expect(section.lines[2]).toEqual({ kind: 'grand-total', cells: ['Grand total', '3', '350'] });
	});
});

describe('buildDetailSection', () => {
	it('emits group headers, data rows, and a subtotal row per group, then a grand total', () => {
		const rows = [
			row({ Region: cell(null, 'East'), Amount: cell(100, '100') }),
			row({ Region: cell(null, 'West'), Amount: cell(200, '200') })
		];
		const report = buildSummaryReport({
			headers: ['Region', 'Amount'],
			rows,
			groupByColumn: 'Region',
			columnAggregations: [{ column: 'Amount', aggregation: 'sum' }],
			dateColumns: [],
			sort: { by: 'group-key', direction: 'asc' },
			detail: 'summary-and-detail'
		});
		const cellsForRow = (r: ParsedRow) => ['Region', 'Amount'].map((h) => r[h].display);
		const section = buildDetailSection(report, ['Region', 'Amount'], ['Amount'], formatTotal, cellsForRow, true);

		expect(section.heading).toBe('Detail');
		expect(section.lines[0]).toEqual({ kind: 'group-header', label: 'East' });
		expect(section.lines[1]).toEqual({ kind: 'data', cells: ['East', '100'] });
		expect(section.lines[2].kind).toBe('subtotal');
		expect(section.lines[3]).toEqual({ kind: 'group-header', label: 'West' });
		expect(section.lines.at(-1)?.kind).toBe('grand-total');
	});

	it('omits group headers/subtotals when showGroupHeaders is false', () => {
		const rows = [row({ Region: cell(null, 'East'), Amount: cell(100, '100') })];
		const report = buildSummaryReport({
			headers: ['Region', 'Amount'],
			rows,
			groupByColumn: null,
			columnAggregations: [],
			dateColumns: [],
			sort: null,
			detail: 'summary-and-detail'
		});
		const cellsForRow = (r: ParsedRow) => ['Region', 'Amount'].map((h) => r[h].display);
		const section = buildDetailSection(report, ['Region', 'Amount'], [], formatTotal, cellsForRow, false);
		expect(section.lines.every((l) => l.kind === 'data')).toBe(true);
	});
});
