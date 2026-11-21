import { describe, it, expect } from 'vitest';
import { categoryData, histogramData, timeseriesData } from './chart-data.js';

describe('categoryData', () => {
	const rows = [
		{ col: 'A' }, { col: 'A' }, { col: 'A' },
		{ col: 'B' }, { col: 'B' },
		{ col: 'C' },
		{ col: null }, { col: '' }
	];

	it('counts frequencies and sorts by count descending by default', () => {
		const result = categoryData(rows, 'col');
		expect(result).toEqual({
			kind: 'category',
			values: [
				{ label: 'A', count: 3 },
				{ label: 'B', count: 2 },
				{ label: 'C', count: 1 }
			]
		});
	});

	it('respects a smaller topN', () => {
		const result = categoryData(rows, 'col', 2);
		expect(result.kind).toBe('category');
		expect(result.kind === 'category' && result.values).toEqual([
			{ label: 'A', count: 3 },
			{ label: 'B', count: 2 }
		]);
	});

	it('sorts alphabetically when sort="alpha-asc"', () => {
		const result = categoryData(rows, 'col', 10, 'alpha-asc');
		expect(result.kind === 'category' && result.values).toEqual([
			{ label: 'A', count: 3 },
			{ label: 'B', count: 2 },
			{ label: 'C', count: 1 }
		]);
	});

	it('ignores null/undefined/empty-string values', () => {
		const result = categoryData(rows, 'col');
		const total = result.kind === 'category' ? result.values.reduce((s, v) => s + v.count, 0) : 0;
		expect(total).toBe(6); // 8 rows - 2 blank
	});
});

describe('histogramData', () => {
	it('bins numeric values into the requested bin count', () => {
		const rows = Array.from({ length: 100 }, (_, i) => ({ n: i }));
		const result = histogramData(rows, 'n', 10);
		expect(result.kind).toBe('histogram');
		if (result.kind === 'histogram') {
			expect(result.bins).toHaveLength(10);
			const total = result.bins.reduce((s, b) => s + b.count, 0);
			expect(total).toBe(100);
		}
	});

	it('returns a single bin when all values are equal', () => {
		const rows = [{ n: 5 }, { n: 5 }, { n: 5 }];
		const result = histogramData(rows, 'n', 20);
		expect(result).toEqual({ kind: 'histogram', bins: [{ lo: 5, hi: 5, count: 3 }] });
	});

	it('returns empty bins with fewer than 2 numeric values', () => {
		const result = histogramData([{ n: 5 }], 'n');
		expect(result).toEqual({ kind: 'histogram', bins: [] });
	});
});

describe('timeseriesData', () => {
	it('buckets dates by YYYY-MM, sorted ascending', () => {
		const toDate = (v: unknown) => (v ? new Date(String(v)) : null);
		const rows = [
			{ d: '2024-03-01' },
			{ d: '2024-01-15' },
			{ d: '2024-01-20' },
			{ d: null }
		];
		const result = timeseriesData(rows, 'd', toDate);
		expect(result).toEqual({
			kind: 'timeseries',
			buckets: [
				{ month: '2024-01', count: 2 },
				{ month: '2024-03', count: 1 }
			]
		});
	});
});
