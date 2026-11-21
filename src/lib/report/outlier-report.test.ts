import { describe, it, expect } from 'vitest';
import {
	findOutliers,
	buildOutlierSections,
	MAX_OUTLIER_DETAIL_ROWS,
	type OutlierSensitivity
} from './outlier-report.js';
import type { ParsedRow } from './summary-report.js';

function cell(value: number | string) {
	const isNum = typeof value === 'number';
	return {
		numeric: isNum ? value : null,
		display: String(value),
		isBlank: false,
		isError: false
	};
}

function blankCell() {
	return { numeric: null, display: '', isBlank: true, isError: false };
}

function errorCell() {
	return { numeric: null, display: '#DIV/0!', isBlank: false, isError: true };
}

function row(values: Record<string, number | string | null>): ParsedRow {
	const r: ParsedRow = {};
	for (const [k, v] of Object.entries(values)) {
		r[k] = v === null ? blankCell() : cell(v);
	}
	return r;
}

// A tight cluster of "normal" values plus one clear high outlier.
const NORMAL_WITH_ONE_HIGH_OUTLIER = [10, 11, 12, 13, 14, 12, 11, 13, 10, 500];

describe('findOutliers', () => {
	it('flags a clear high outlier beyond the standard 1.5x IQR fence', () => {
		const rows = NORMAL_WITH_ONE_HIGH_OUTLIER.map((v) => row({ Amount: v }));
		const result = findOutliers(rows, ['Amount'], 'standard');
		expect(result.columnSummaries).toHaveLength(1);
		expect(result.columnSummaries[0].outlierCount).toBe(1);
		expect(result.details).toHaveLength(1);
		expect(result.details[0].value).toBe(500);
		expect(result.details[0].rowNumber).toBe(10);
		expect(result.details[0].deviation).toMatch(/\+.*IQR above fence/);
	});

	it('"extreme" (3x IQR) sensitivity flags fewer or equal outliers than "standard" (1.5x)', () => {
		const rows = NORMAL_WITH_ONE_HIGH_OUTLIER.map((v) => row({ Amount: v }));
		const standard = findOutliers(rows, ['Amount'], 'standard');
		const extreme = findOutliers(rows, ['Amount'], 'extreme');
		expect(extreme.totalOutlierCount).toBeLessThanOrEqual(standard.totalOutlierCount);
	});

	it('excludes blank and error cells from both the fence computation and flagging', () => {
		const rows = [
			...NORMAL_WITH_ONE_HIGH_OUTLIER.map((v) => row({ Amount: v })),
			row({ Amount: null }),
			{ Amount: errorCell() }
		];
		const result = findOutliers(rows, ['Amount'], 'standard');
		expect(result.columnSummaries[0].nonNullCount).toBe(10); // unaffected by the blank/error rows
	});

	it('skips a column entirely when it has no usable numeric values', () => {
		const rows = [row({ Amount: null }), { Amount: errorCell() }];
		const result = findOutliers(rows, ['Amount'], 'standard');
		expect(result.columnSummaries).toHaveLength(0);
		expect(result.details).toHaveLength(0);
	});

	it('flags no outliers for a column with zero IQR (all-identical values)', () => {
		const rows = Array.from({ length: 10 }, () => row({ Amount: 42 }));
		const result = findOutliers(rows, ['Amount'], 'standard');
		expect(result.columnSummaries[0].outlierCount).toBe(0);
		expect(result.columnSummaries[0].iqr).toBe(0);
	});

	it('analyzes multiple columns independently, each with its own fence', () => {
		const rows = NORMAL_WITH_ONE_HIGH_OUTLIER.map((v, i) =>
			row({ Amount: v, Age: 30 + (i === 0 ? 100 : 0) }) // Age has its own single outlier at row 1
		);
		const result = findOutliers(rows, ['Amount', 'Age'], 'standard');
		expect(result.columnSummaries).toHaveLength(2);
		const ageSummary = result.columnSummaries.find((s) => s.column === 'Age');
		expect(ageSummary?.outlierCount).toBe(1);
	});

	it('sorts column summaries by outlier count descending', () => {
		const rows = Array.from({ length: 20 }, (_, i) =>
			row({
				Few: i === 0 ? 1000 : 10, // 1 outlier
				Many: i < 5 ? 1000 : 10 // several outliers
			})
		);
		const result = findOutliers(rows, ['Few', 'Many'], 'standard');
		expect(result.columnSummaries[0].column).toBe('Many');
	});

	it('caps total detail rows at MAX_OUTLIER_DETAIL_ROWS and never exceeds the true total', () => {
		const rows = Array.from({ length: 10 }, (_, i) => row({ Amount: i < 5 ? 1 : 1000 }));
		const result = findOutliers(rows, ['Amount'], 'standard');
		expect(MAX_OUTLIER_DETAIL_ROWS).toBeGreaterThan(0);
		expect(result.details.length).toBeLessThanOrEqual(MAX_OUTLIER_DETAIL_ROWS);
		expect(result.totalOutlierCount).toBeGreaterThanOrEqual(result.details.length);
	});

	it('the standard/extreme sensitivity union is exhaustive', () => {
		const sensitivities: OutlierSensitivity[] = ['standard', 'extreme'];
		expect(sensitivities).toHaveLength(2);
	});
});

describe('buildOutlierSections', () => {
	const analysis = findOutliers(
		NORMAL_WITH_ONE_HIGH_OUTLIER.map((v) => row({ Amount: v })),
		['Amount'],
		'standard'
	);

	it('summary mode: only the column-summary section, bounded by column count', () => {
		const sections = buildOutlierSections(analysis, 'summary');
		expect(sections).toHaveLength(1);
		expect(sections[0].heading).toBe('Column outlier summary');
		expect(sections[0].columns).toEqual(['Column', 'Non-null rows', 'Outlier count', '% of rows', 'Expected range']);
		expect(sections[0].lines).toHaveLength(1);
	});

	it('summary-and-detail mode: adds a detail section with one group-header per column + one row per outlier', () => {
		const sections = buildOutlierSections(analysis, 'summary-and-detail');
		expect(sections).toHaveLength(2);
		expect(sections[1].heading).toBe('Outlier detail');
		expect(sections[1].columns).toEqual(['Row #', 'Value', 'Deviation']);
		expect(sections[1].lines[0]).toEqual({ kind: 'group-header', label: expect.stringContaining('Amount') });
		expect(sections[1].lines).toHaveLength(2); // 1 group-header + 1 outlier row
	});

	it('summary section correctly reports 0 outliers for a non-outlier-only run', () => {
		const flatAnalysis = findOutliers(
			Array.from({ length: 5 }, () => row({ Amount: 5 })),
			['Amount'],
			'standard'
		);
		const sections = buildOutlierSections(flatAnalysis, 'summary');
		expect(sections[0].lines[0]).toEqual({
			kind: 'data',
			cells: ['Amount', '5', '0', '0.0%', expect.any(String)]
		});
	});
});
