/**
 * src/lib/visuals/chart-data.ts — pure row → {@link ChartData} series builders
 *
 * Extracted out of dashboard.worker.ts so the exact same binning / top-N /
 * month-bucketing math can be reused outside a Worker — specifically by
 * src/lib/report/column-chart-renderer.ts (the "Column Visual Analysis"
 * report), which runs on the main thread because vega-embed needs a DOM.
 *
 * dashboard.worker.ts keeps its own thin wrappers around these (still
 * imported from here) so its existing behavior/tests are unaffected.
 *
 * All parameters beyond `rows`/`col` are optional and default to the
 * dashboard's original hardcoded values (topN=10, binCount=20) — the new
 * report's per-column config UI is what actually varies them.
 */

import type { ChartData } from './chart-specs.js';

/** Sort order for `categoryData`'s top-N selection. */
export type CategorySort = 'count-desc' | 'alpha-asc';

/**
 * Top-N categorical/text frequency series. `sort`:
 *   - 'count-desc' (default): most frequent first — matches the dashboard.
 *   - 'alpha-asc': alphabetical by label, THEN truncated to topN. Useful
 *     when the user wants e.g. "Jan, Feb, Mar…" in natural order rather
 *     than frequency order.
 */
export function categoryData(
	rows: Record<string, unknown>[],
	col: string,
	topN = 10,
	sort: CategorySort = 'count-desc'
): ChartData {
	const counts = new Map<string, number>();
	for (const r of rows) {
		const v = r[col];
		if (v === null || v === undefined || v === '') continue;
		const s = String(v);
		counts.set(s, (counts.get(s) ?? 0) + 1);
	}
	const entries = [...counts.entries()];
	const sorted =
		sort === 'alpha-asc'
			? entries.sort(([a], [b]) => a.localeCompare(b))
			: entries.sort((a, b) => b[1] - a[1]);
	const top = sorted.slice(0, topN).map(([label, count]) => ({ label, count }));
	return { kind: 'category', values: top };
}

/** Fixed-width-bin histogram over a numeric column. `binCount` default: 20. */
export function histogramData(
	rows: Record<string, unknown>[],
	col: string,
	binCount = 20,
	toNumber: (v: unknown) => number | null = defaultToNumber
): ChartData {
	const nums: number[] = [];
	for (const r of rows) {
		const n = toNumber(r[col]);
		if (n !== null) nums.push(n);
	}
	if (nums.length < 2) return { kind: 'histogram', bins: [] };
	// Linear min/max — see columnStats.ts for why.
	let min = nums[0];
	let max = nums[0];
	for (let i = 1; i < nums.length; i++) {
		if (nums[i] < min) min = nums[i];
		if (nums[i] > max) max = nums[i];
	}
	if (min === max) {
		return { kind: 'histogram', bins: [{ lo: min, hi: max, count: nums.length }] };
	}
	const width = (max - min) / binCount;
	const bins = Array.from({ length: binCount }, (_, i) => ({
		lo: min + i * width,
		hi: min + (i + 1) * width,
		count: 0
	}));
	for (const n of nums) {
		let i = Math.floor((n - min) / width);
		if (i >= binCount) i = binCount - 1;
		bins[i].count++;
	}
	return { kind: 'histogram', bins };
}

/** Monthly-bucket time series over a datetime column. */
export function timeseriesData(
	rows: Record<string, unknown>[],
	col: string,
	toDate: (v: unknown) => Date | null = defaultToDate
): ChartData {
	const monthCounts = new Map<string, number>();
	for (const r of rows) {
		const d = toDate(r[col]);
		if (!d) continue;
		const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
		monthCounts.set(key, (monthCounts.get(key) ?? 0) + 1);
	}
	const buckets = [...monthCounts.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([month, count]) => ({ month, count }));
	return { kind: 'timeseries', buckets };
}

// Minimal local fallbacks so this module has no hard dependency on
// columnStats.ts's toNumber/toDate (callers in a Worker already have their
// own imports; the report renderer passes columnStats.ts's real versions).
function defaultToNumber(v: unknown): number | null {
	if (v === null || v === undefined || v === '') return null;
	if (typeof v === 'number') return Number.isFinite(v) ? v : null;
	const n = parseFloat(String(v).replace(/[, $]/g, ''));
	return Number.isFinite(n) ? n : null;
}

function defaultToDate(v: unknown): Date | null {
	if (v === null || v === undefined || v === '') return null;
	if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
	if (typeof v === 'number' && v > 1 && v < 100000) {
		const ms = (v - 25569) * 86400 * 1000;
		const d = new Date(ms);
		return Number.isNaN(d.getTime()) ? null : d;
	}
	const d = new Date(String(v));
	return Number.isNaN(d.getTime()) ? null : d;
}
