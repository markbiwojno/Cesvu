/**
 * src/lib/report/report-chart-specs.ts — configurable Vega-Lite specs for the
 * "Column Visual Analysis" PDF report.
 *
 * Deliberately a SEPARATE module from src/lib/visuals/chart-specs.ts (the
 * dashboard's chart engine), not a modification of it:
 *   - The dashboard always uses ONE fixed chart type per column type, a dark
 *     theme (for the on-screen workbench), and hardcoded topN/binCount. This
 *     report lets the user override all of that per column (req: "more
 *     configuration than the dashboard"), including a pie/donut option the
 *     dashboard doesn't have.
 *   - The report is rendered to PDF on a WHITE page, so it needs a light
 *     theme — reusing the dashboard's dark-on-transparent config would be
 *     unreadable once rasterized onto a white background.
 *
 * Still pure / deterministic: given the same ChartData + config, always
 * produces the same spec. No DOM, no side effects.
 */

import type { TopLevelSpec } from 'vega-lite';
import type { ChartData, CategoryDatum, HistogramBin, MonthBucket } from '$lib/visuals/chart-specs.js';

/** Chart kinds available in the report's per-column config UI. */
export type ReportChartType = 'bar' | 'pie' | 'histogram' | 'timeseries' | 'bar-by-year';

/** Sort order for bar/pie category ordering (re-exported for the modal). */
export type ReportCategorySort = 'count-desc' | 'alpha-asc';

export interface ColumnChartConfig {
	column: string;
	columnType: 'numeric' | 'categorical' | 'datetime' | 'text';
	chartType: ReportChartType;
	/** Defaults to the column name when omitted. */
	title?: string;
	/** Hex color for the chart's mark(s). Defaults to CHART_DEFAULT_COLOR. */
	color?: string;
	/** categorical/text only. Default 10 (matches the dashboard). */
	topN?: number;
	/** categorical/text only. Default 'count-desc' (matches the dashboard). */
	sort?: ReportCategorySort;
	/** numeric only. Default 20 (matches the dashboard). */
	binCount?: number;
}

/** The chart type a column type defaults to when the user hasn't overridden it. */
export function defaultChartType(columnType: ColumnChartConfig['columnType']): ReportChartType {
	switch (columnType) {
		case 'numeric':
			return 'histogram';
		case 'datetime':
			return 'timeseries';
		case 'categorical':
		case 'text':
			return 'bar';
	}
}

/** Which chart types are valid choices for a given column type (for the config UI). */
export function availableChartTypes(columnType: ColumnChartConfig['columnType']): ReportChartType[] {
	switch (columnType) {
		case 'numeric':
			return ['histogram'];
		case 'datetime':
			return ['timeseries', 'bar-by-year'];
		case 'categorical':
		case 'text':
			return ['bar', 'pie'];
	}
}

export const CHART_DEFAULT_COLOR = '#2563eb'; // blue-600 — reads well on white print
const CHART_HEIGHT = 240; // smaller than the dashboard's 300 — 3-per-page needs to be compact
const AXIS_LABEL = '#334155'; // slate-700 (dark text on white)
const AXIS_TITLE = '#475569'; // slate-600
const GRID = '#e2e8f0'; // slate-200
const FONT = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

function lightConfig(): TopLevelSpec['config'] {
	return {
		background: 'white',
		font: FONT,
		view: { stroke: 'transparent' },
		axis: {
			labelColor: AXIS_LABEL,
			titleColor: AXIS_TITLE,
			gridColor: GRID,
			domainColor: GRID,
			tickColor: GRID,
			labelFontSize: 10,
			titleFontSize: 11
		},
		legend: {
			labelColor: AXIS_LABEL,
			titleColor: AXIS_TITLE,
			labelFontSize: 10,
			titleFontSize: 11
		}
	};
}

/**
 * Build a Vega-Lite spec for one report column, per its {@link ColumnChartConfig}.
 * Returns null when there's nothing plottable (mirrors chart-specs.ts).
 */
export function buildReportChartSpec(
	config: ColumnChartConfig,
	data: ChartData | null
): TopLevelSpec | null {
	const color = config.color ?? CHART_DEFAULT_COLOR;
	const title = config.title ?? config.column;

	switch (config.chartType) {
		case 'histogram':
			if (data?.kind !== 'histogram') return null;
			return histogramSpec(data.bins, title, color);
		case 'timeseries':
			if (data?.kind !== 'timeseries') return null;
			return timeSeriesSpec(data.buckets, title, color);
		case 'bar-by-year':
			if (data?.kind !== 'timeseries') return null;
			return barByYearSpec(data.buckets, title, color);
		case 'pie':
			if (data?.kind !== 'category') return null;
			return pieSpec(data.values, title, color, config.sort ?? 'count-desc', config.topN ?? 10);
		case 'bar':
		default:
			if (data?.kind !== 'category') return null;
			return barSpec(data.values, title, color, config.sort ?? 'count-desc', config.topN ?? 10);
	}
}

function sortedTop(
	values: CategoryDatum[],
	sort: ReportCategorySort,
	topN: number
): { label: string; count: number }[] {
	const mapped = values.map((d) => ({ label: String(d.label), count: d.count }));
	const sorted =
		sort === 'alpha-asc'
			? mapped.sort((a, b) => a.label.localeCompare(b.label))
			: mapped.sort((a, b) => b.count - a.count);
	return sorted.slice(0, topN);
}

function barSpec(
	values: CategoryDatum[],
	title: string,
	color: string,
	sort: ReportCategorySort,
	topN: number
): TopLevelSpec | null {
	const top = sortedTop(values, sort, topN);
	if (top.length === 0) return null;
	return {
		$schema: 'https://vega.github.io/schema/vega-lite/v6.json',
		width: 'container',
		height: CHART_HEIGHT,
		title,
		data: { values: top },
		mark: { type: 'bar', color, tooltip: true },
		encoding: {
			y: {
				field: 'label',
				type: 'nominal',
				sort: sort === 'alpha-asc' ? 'ascending' : '-x',
				title: null,
				axis: { labelLimit: 120 }
			},
			x: { field: 'count', type: 'quantitative', title: 'Count' },
			tooltip: [
				{ field: 'label', type: 'nominal', title },
				{ field: 'count', type: 'quantitative', title: 'Count', format: ',' }
			]
		},
		config: lightConfig()
	} as TopLevelSpec;
}

function pieSpec(
	values: CategoryDatum[],
	title: string,
	color: string,
	sort: ReportCategorySort,
	topN: number
): TopLevelSpec | null {
	const top = sortedTop(values, sort, topN);
	if (top.length === 0) return null;
	return {
		$schema: 'https://vega.github.io/schema/vega-lite/v6.json',
		width: 'container',
		height: CHART_HEIGHT,
		title,
		data: { values: top },
		mark: { type: 'arc', tooltip: true },
		encoding: {
			theta: { field: 'count', type: 'quantitative' },
			color: {
				field: 'label',
				type: 'nominal',
				title: null,
				legend: { columns: 1, symbolLimit: topN }
			},
			tooltip: [
				{ field: 'label', type: 'nominal', title },
				{ field: 'count', type: 'quantitative', title: 'Count', format: ',' }
			]
		},
		// `color` (the per-column accent) isn't directly usable on an arc mark
		// with a categorical color encoding — it drives the `blues` scheme's
		// endpoint instead via config, keeping the user's choice visible.
		config: { ...lightConfig(), range: { category: { scheme: 'blues' } } }
	} as unknown as TopLevelSpec;
}

function histogramSpec(bins: HistogramBin[], title: string, color: string): TopLevelSpec | null {
	if (!bins || bins.length === 0) return null;
	if (bins.every((b) => b.count === 0)) return null;
	const values = bins.map((b) => ({ lo: b.lo, hi: b.hi, count: b.count }));
	return {
		$schema: 'https://vega.github.io/schema/vega-lite/v6.json',
		width: 'container',
		height: CHART_HEIGHT,
		title,
		data: { values },
		mark: { type: 'bar', color, tooltip: true },
		encoding: {
			x: { field: 'lo', type: 'quantitative', bin: { binned: true }, title: null },
			x2: { field: 'hi' },
			y: { field: 'count', type: 'quantitative', title: 'Count' },
			tooltip: [
				{ field: 'lo', type: 'quantitative', title: 'From', format: ',' },
				{ field: 'hi', type: 'quantitative', title: 'To', format: ',' },
				{ field: 'count', type: 'quantitative', title: 'Count', format: ',' }
			]
		},
		config: lightConfig()
	} as TopLevelSpec;
}

function timeSeriesSpec(buckets: MonthBucket[], title: string, color: string): TopLevelSpec | null {
	if (!buckets || buckets.length === 0) return null;
	if (buckets.every((b) => b.count === 0)) return null;
	const values = buckets.map((b) => ({ month: `${b.month}-01`, count: b.count }));
	return {
		$schema: 'https://vega.github.io/schema/vega-lite/v6.json',
		width: 'container',
		height: CHART_HEIGHT,
		title,
		data: { values },
		mark: { type: 'bar', color, tooltip: true },
		encoding: {
			x: { field: 'month', type: 'temporal', timeUnit: 'yearmonth', title: null },
			y: { field: 'count', type: 'quantitative', title: 'Records' },
			tooltip: [
				{ field: 'month', type: 'temporal', timeUnit: 'yearmonth', title: 'Month' },
				{ field: 'count', type: 'quantitative', title: 'Records', format: ',' }
			]
		},
		config: lightConfig()
	} as TopLevelSpec;
}

/** Datetime "by year" rollup — coarser than the monthly timeseries, useful
 *  for a long date range where month-level bars would be unreadably dense. */
function barByYearSpec(buckets: MonthBucket[], title: string, color: string): TopLevelSpec | null {
	if (!buckets || buckets.length === 0) return null;
	const yearCounts = new Map<string, number>();
	for (const b of buckets) {
		const year = b.month.slice(0, 4);
		yearCounts.set(year, (yearCounts.get(year) ?? 0) + b.count);
	}
	const values = [...yearCounts.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([year, count]) => ({ year, count }));
	if (values.length === 0 || values.every((v) => v.count === 0)) return null;
	return {
		$schema: 'https://vega.github.io/schema/vega-lite/v6.json',
		width: 'container',
		height: CHART_HEIGHT,
		title,
		data: { values },
		mark: { type: 'bar', color, tooltip: true },
		encoding: {
			x: { field: 'year', type: 'nominal', title: null },
			y: { field: 'count', type: 'quantitative', title: 'Records' },
			tooltip: [
				{ field: 'year', type: 'nominal', title: 'Year' },
				{ field: 'count', type: 'quantitative', title: 'Records', format: ',' }
			]
		},
		config: lightConfig()
	} as TopLevelSpec;
}
