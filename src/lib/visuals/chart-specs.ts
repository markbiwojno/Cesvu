/**
 * src/lib/visuals/chart-specs.ts — deterministic Vega-Lite spec generator
 *
 * Pure functions. No LLM. No DOM. No side effects.
 *
 * Given a column profile + the chart data series precomputed from the row
 * buffer (see buildColumnAnalysis in analysis.ts), produce a Vega-Lite
 * TopLevelSpec describing how to draw it:
 *
 *   - text / categorical → horizontal bar chart (top 10 values by frequency)
 *   - numeric            → histogram (binned counts, ~20 bins)
 *   - datetime           → time-series bar chart (counts grouped by month)
 *
 * The actual binning / bucketing / frequency counting is done by the caller
 * (it owns the row buffer); this module only shapes the already-computed
 * series into a spec. Returns null when there is nothing plottable.
 *
 * Theme: dark, responsive width ("container"), fixed 300px height, no
 * animations, tooltips enabled.
 */

import type { TopLevelSpec } from 'vega-lite';
import type { ColumnProfile } from '$lib/types.js';

// ============================================================
// Chart data series — the parser-agnostic shape the caller hands us
// ============================================================

/** A single categorical / bar datum: a label and its frequency. */
export interface CategoryDatum {
	label: string;
	count: number;
}

/** A single histogram bin: half-open range [lo, hi) and its count. */
export interface HistogramBin {
	lo: number;
	hi: number;
	count: number;
}

/** A single month bucket: "YYYY-MM" and the number of records in it. */
export interface MonthBucket {
	month: string;
	count: number;
}

/**
 * Precomputed chart data, discriminated by `kind`. The caller computes exactly
 * one of these from the row buffer based on the column type and passes it in.
 * `null` (or an empty series) → buildChartSpec returns null (no chart).
 */
export type ChartData =
	| { kind: 'category'; values: CategoryDatum[] }
	| { kind: 'histogram'; bins: HistogramBin[] }
	| { kind: 'timeseries'; buckets: MonthBucket[] };

// ============================================================
// Dark theme constants
// ============================================================

const CHART_HEIGHT = 300;
const AXIS_LABEL = '#cbd5e1'; // slate-300
const AXIS_TITLE = '#94a3b8'; // slate-400
const GRID = '#334155'; // slate-700
const MARK = '#3b82f6'; // blue-500
const FONT =
	'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

/**
 * Shared Vega-Lite config block: transparent background (so the chart blends
 * into the message bubble), dark axis/legend styling, no view stroke.
 */
function darkConfig(): TopLevelSpec['config'] {
	return {
		background: 'transparent',
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
			titleColor: AXIS_TITLE
		}
	};
}

// ============================================================
// buildChartSpec — the single public entry point
// ============================================================

/**
 * Build a Vega-Lite spec for a column. Returns null when the column has no
 * plottable data (no precomputed series, or an empty series).
 *
 * @param col        The column profile (used for the axis title / column name).
 * @param columnType The resolved column type. text + categorical → bar;
 *                   numeric → histogram; datetime → monthly time series.
 * @param data       Precomputed chart series from the row buffer. Optional:
 *                   when omitted/null we fall back to the profile's topValues
 *                   (categorical/text only — numeric & datetime need the buffer).
 */
export function buildChartSpec(
	col: ColumnProfile,
	columnType: ColumnProfile['type'],
	data?: ChartData | null
): TopLevelSpec | null {
	switch (columnType) {
		case 'numeric':
			if (data?.kind === 'histogram') return histogramSpec(col, data.bins);
			return null;

		case 'datetime':
			if (data?.kind === 'timeseries') return timeSeriesSpec(col, data.buckets);
			return null;

		case 'categorical':
		case 'text': {
			// Prefer the precomputed full-distribution series; fall back to the
			// profile's truncated topValues/sampleValues when no buffer was given.
			let values: CategoryDatum[] | null = null;
			if (data?.kind === 'category') {
				values = data.values;
			} else {
				const src = col.topValues?.length ? col.topValues : col.sampleValues;
				if (src?.length) {
					values = src.map((v) => ({ label: v.value, count: v.count }));
				}
			}
			return barSpec(col, values);
		}

		default:
			return null;
	}
}

// ============================================================
// Bar chart (categorical / text) — top 10 values by frequency
// ============================================================

function barSpec(
	col: ColumnProfile,
	values: CategoryDatum[] | null
): TopLevelSpec | null {
	if (!values || values.length === 0) return null;

	// Top 10 by count, descending. Coerce labels to strings (defensive — the
	// caller may hand us numeric-looking categories).
	const top = [...values]
		.sort((a, b) => b.count - a.count)
		.slice(0, 10)
		.map((d) => ({ label: String(d.label), count: d.count }));

	if (top.length === 0) return null;

	return {
		$schema: 'https://vega.github.io/schema/vega-lite/v6.json',
		width: 'container',
		height: CHART_HEIGHT,
		data: { values: top },
		mark: { type: 'bar', color: MARK, tooltip: true },
		encoding: {
			y: {
				field: 'label',
				type: 'nominal',
				sort: '-x',
				title: col.name,
				axis: { labelLimit: 140 }
			},
			x: {
				field: 'count',
				type: 'quantitative',
				title: 'Count'
			},
			tooltip: [
				{ field: 'label', type: 'nominal', title: col.name },
				{ field: 'count', type: 'quantitative', title: 'Count', format: ',' }
			]
		},
		config: darkConfig()
	} as TopLevelSpec;
}

// ============================================================
// Histogram (numeric) — precomputed bins
// ============================================================

function histogramSpec(
	col: ColumnProfile,
	bins: HistogramBin[]
): TopLevelSpec | null {
	if (!bins || bins.length === 0) return null;
	// Nothing to plot if every bin is empty.
	if (bins.every((b) => b.count === 0)) return null;

	const values = bins.map((b) => ({ lo: b.lo, hi: b.hi, count: b.count }));

	return {
		$schema: 'https://vega.github.io/schema/vega-lite/v6.json',
		width: 'container',
		height: CHART_HEIGHT,
		data: { values },
		mark: { type: 'bar', color: MARK, tooltip: true },
		encoding: {
			x: {
				field: 'lo',
				type: 'quantitative',
				bin: { binned: true },
				title: col.name
			},
			x2: { field: 'hi' },
			y: {
				field: 'count',
				type: 'quantitative',
				title: 'Count'
			},
			tooltip: [
				{ field: 'lo', type: 'quantitative', title: 'From', format: ',' },
				{ field: 'hi', type: 'quantitative', title: 'To', format: ',' },
				{ field: 'count', type: 'quantitative', title: 'Count', format: ',' }
			]
		},
		config: darkConfig()
	} as TopLevelSpec;
}

// ============================================================
// Time series (datetime) — counts grouped by month
// ============================================================

function timeSeriesSpec(
	col: ColumnProfile,
	buckets: MonthBucket[]
): TopLevelSpec | null {
	if (!buckets || buckets.length === 0) return null;
	if (buckets.every((b) => b.count === 0)) return null;

	// Append "-01" so each "YYYY-MM" parses as the first of the month (temporal).
	const values = buckets.map((b) => ({
		month: `${b.month}-01`,
		count: b.count
	}));

	return {
		$schema: 'https://vega.github.io/schema/vega-lite/v6.json',
		width: 'container',
		height: CHART_HEIGHT,
		data: { values },
		mark: { type: 'bar', color: MARK, tooltip: true },
		encoding: {
			x: {
				field: 'month',
				type: 'temporal',
				timeUnit: 'yearmonth',
				title: col.name
			},
			y: {
				field: 'count',
				type: 'quantitative',
				title: 'Records'
			},
			tooltip: [
				{
					field: 'month',
					type: 'temporal',
					timeUnit: 'yearmonth',
					title: 'Month'
				},
				{ field: 'count', type: 'quantitative', title: 'Records', format: ',' }
			]
		},
		config: darkConfig()
	} as TopLevelSpec;
}
