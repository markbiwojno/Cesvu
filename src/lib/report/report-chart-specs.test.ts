import { describe, it, expect } from 'vitest';
import {
	buildReportChartSpec,
	defaultChartType,
	availableChartTypes,
	type ColumnChartConfig
} from './report-chart-specs.js';
import type { ChartData } from '$lib/visuals/chart-specs.js';

describe('defaultChartType / availableChartTypes', () => {
	it('defaults numeric to histogram, datetime to timeseries, categorical/text to bar', () => {
		expect(defaultChartType('numeric')).toBe('histogram');
		expect(defaultChartType('datetime')).toBe('timeseries');
		expect(defaultChartType('categorical')).toBe('bar');
		expect(defaultChartType('text')).toBe('bar');
	});

	it('offers pie as an alternative for categorical/text, bar-by-year for datetime', () => {
		expect(availableChartTypes('categorical')).toEqual(['bar', 'pie']);
		expect(availableChartTypes('text')).toEqual(['bar', 'pie']);
		expect(availableChartTypes('datetime')).toEqual(['timeseries', 'bar-by-year']);
		expect(availableChartTypes('numeric')).toEqual(['histogram']);
	});
});

function baseConfig(overrides: Partial<ColumnChartConfig> = {}): ColumnChartConfig {
	return {
		column: 'Region',
		columnType: 'categorical',
		chartType: 'bar',
		...overrides
	};
}

describe('buildReportChartSpec', () => {
	it('builds a bar spec from category data, respecting topN and sort', () => {
		const data: ChartData = {
			kind: 'category',
			values: [
				{ label: 'West', count: 5 },
				{ label: 'East', count: 10 },
				{ label: 'North', count: 1 }
			]
		};
		const spec = buildReportChartSpec(baseConfig({ topN: 2 }), data);
		expect(spec).not.toBeNull();
		expect(spec?.title).toBe('Region');
		const values = (spec?.data as { values: { label: string; count: number }[] }).values;
		expect(values).toHaveLength(2);
		expect(values[0]).toEqual({ label: 'East', count: 10 });
	});

	it('builds a pie spec with an arc mark', () => {
		const data: ChartData = { kind: 'category', values: [{ label: 'A', count: 3 }] };
		const spec = buildReportChartSpec(baseConfig({ chartType: 'pie' }), data) as unknown as {
			mark: { type: string };
		};
		expect(spec).not.toBeNull();
		expect(spec.mark.type).toBe('arc');
	});

	it('builds a histogram spec from histogram data', () => {
		const data: ChartData = { kind: 'histogram', bins: [{ lo: 0, hi: 1, count: 5 }] };
		const spec = buildReportChartSpec(
			baseConfig({ column: 'Amount', columnType: 'numeric', chartType: 'histogram' }),
			data
		);
		expect(spec).not.toBeNull();
		expect(spec?.title).toBe('Amount');
	});

	it('builds a timeseries spec and a bar-by-year rollup from the same bucket data', () => {
		const data: ChartData = {
			kind: 'timeseries',
			buckets: [
				{ month: '2023-01', count: 2 },
				{ month: '2023-06', count: 3 },
				{ month: '2024-01', count: 1 }
			]
		};
		const tsSpec = buildReportChartSpec(
			baseConfig({ column: 'Date', columnType: 'datetime', chartType: 'timeseries' }),
			data
		);
		expect(tsSpec).not.toBeNull();

		const yearSpec = buildReportChartSpec(
			baseConfig({ column: 'Date', columnType: 'datetime', chartType: 'bar-by-year' }),
			data
		);
		expect(yearSpec).not.toBeNull();
		const values = (yearSpec?.data as { values: { year: string; count: number }[] }).values;
		expect(values).toEqual([
			{ year: '2023', count: 5 },
			{ year: '2024', count: 1 }
		]);
	});

	it('applies a custom color and title override', () => {
		const data: ChartData = { kind: 'category', values: [{ label: 'A', count: 1 }] };
		const spec = buildReportChartSpec(
			baseConfig({ color: '#ff0000', title: 'Custom Title' }),
			data
		) as unknown as { title: string; mark: { color: string } };
		expect(spec.title).toBe('Custom Title');
		expect(spec.mark.color).toBe('#ff0000');
	});

	it('returns null when the data kind does not match the chart type', () => {
		const data: ChartData = { kind: 'histogram', bins: [] };
		const spec = buildReportChartSpec(baseConfig({ chartType: 'bar' }), data);
		expect(spec).toBeNull();
	});

	it('returns null for empty/all-zero series', () => {
		expect(buildReportChartSpec(baseConfig(), { kind: 'category', values: [] })).toBeNull();
		expect(
			buildReportChartSpec(
				baseConfig({ columnType: 'numeric', chartType: 'histogram' }),
				{ kind: 'histogram', bins: [{ lo: 0, hi: 1, count: 0 }] }
			)
		).toBeNull();
	});
});
