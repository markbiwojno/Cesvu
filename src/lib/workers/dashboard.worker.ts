/**
 * src/lib/workers/dashboard.worker.ts — Off-main-thread dashboard compute
 *
 * Runs the same data transforms that used to block the main thread for
 * 1-3 seconds after a 200k-row CSV finishes streaming:
 *   - per-column stats (numeric / categorical / datetime / text)
 *   - per-column chart data series (histogram / timeseries / top-N)
 *   - interestingness sort
 *   - workbook-level KPIs
 *
 * The main thread ships us the row buffer + column metadata + an
 * optional filter tree + an optional list of "loaded" columns. We
 * apply the filter, run the engine, and post back the four result
 * objects. While we're chewing, the main thread is free — the user
 * can scroll, click chat, etc.
 *
 * ── Two-tier compute (the lazy-load architecture) ────────────────────────
 *
 * `loadedColumns` decides which columns get the full treatment vs
 * the cheap "lite" treatment:
 *
 *   - Loaded columns: full stats (with outlier walks, top-N lists,
 *     month buckets, length percentiles) + chart data series. The
 *     ColumnTile renders a Vega chart and click-to-filter on top of
 *     these.
 *
 *   - Unloaded columns: lite stats (mean/median/σ/p5/p95 + IQR width
 *     + unique count, but no outlier list, no top-N, no month buckets,
 *     no length percentiles) + null chart data. The ColumnCard
 *     placeholder renders these as plain text.
 *
 * This is what keeps the dashboard's memory footprint reasonable on
 * a 200-column sheet: only the columns the user has clicked get the
 * expensive stats. The others are ~5KB of text on screen.
 */

import { computeColumnStats, computeKpis, toNumber, toDate } from '$lib/pipeline/columnStats.js';
import type { ColumnStats } from '$lib/pipeline/columnStats.js';
import type { ColumnProfile } from '$lib/types.js';
import type { ChartData } from '$lib/visuals/chart-specs.js';
import type { Filter } from '$lib/pipeline/filter.js';
import { evaluate as evalFilter } from '$lib/pipeline/filter.js';

// ── Wire protocol ─────────────────────────────────────────────────────────

/** What the main thread sends us. */
export interface ComputeRequest {
	columns: ColumnProfile[];
	rows: Record<string, unknown>[];
	/** Optional filter tree. When set, the worker subsets the rows
	 *  before computing — keeps the main thread idle for filter clicks. */
	filter: Filter | null;
	/** Names of columns the user has opted in to render with a chart.
	 *  When present (even as an empty array), only these columns get
	 *  full stats + chart series. All other columns get lite stats.
	 *  An EMPTY array = "every column gets lite" — i.e. NO chart
	 *  data, NO outlier walks, NO top-N categoricals. This is the
	 *  default on a fresh file load.
	 *
	 *  The legacy "undefined = full" interpretation was the
	 *  pre-lazy-load default; it's been removed because it was the
	 *  OOM root cause for 200-column sheets (worker still shipped
	 *  full stats + chart data for all 200 even though only 0 were
	 *  displayed). The DashboardPane now always sends an array. */
	loadedColumns: string[];
}

/** What we send back. */
export interface ComputeResult {
	statsByColumn: Record<string, ColumnStats>;
	chartDataByColumn: Record<string, ChartData | null>;
	sortedColumns: ColumnProfile[];
	kpis: import('$lib/pipeline/columnStats.js').WorkbookKpis;
	/** Wall time inside the worker, in ms — surfaced for diagnostics. */
	elapsedMs: number;
}

// ── Chart-data helpers ────────────────────────────────────────────────────

function categoryData(rows: Record<string, unknown>[], col: string, topN = 10): ChartData {
	const counts = new Map<string, number>();
	for (const r of rows) {
		const v = r[col];
		if (v === null || v === undefined || v === '') continue;
		const s = String(v);
		counts.set(s, (counts.get(s) ?? 0) + 1);
	}
	const top = [...counts.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, topN)
		.map(([label, count]) => ({ label, count }));
	return { kind: 'category', values: top };
}

function histogramData(rows: Record<string, unknown>[], col: string, binCount = 20): ChartData {
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

function timeseriesData(rows: Record<string, unknown>[], col: string): ChartData {
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

function chartDataFor(col: ColumnProfile, rows: Record<string, unknown>[]): ChartData | null {
	if (col.type === 'numeric') return histogramData(rows, col.name);
	if (col.type === 'datetime') return timeseriesData(rows, col.name);
	if (col.type === 'categorical' || col.type === 'text') return categoryData(rows, col.name);
	return null;
}

// ── Lite-friendly sort ────────────────────────────────────────────────────

/**
 * Sort columns by interestingness when most of them only have lite
 * stats. The engine's `interestingnessScore` reads outlier lists
 * (always empty in lite) and p95 length (zero in lite), so a default
 * sort would put everything at score=0. We substitute lite-friendly
 * signals: IQR width for numeric, unique count for categorical,
 * date-range span for datetime, unique count for text.
 *
 * This puts "interesting" cards first in the placeholder view:
 * numeric-with-wide-spread → dense categoricals → dates → text.
 */
function sortColumnsOrLite(
	columns: ColumnProfile[],
	stats: Record<string, ColumnStats>,
	totalRows: number
): ColumnProfile[] {
	const score = (col: ColumnProfile): number => {
		const s = stats[col.name];
		if (!s) return 0;
		switch (col.type) {
			case 'numeric': {
				const ns = s as import('$lib/pipeline/columnStats.js').NumericStats;
				// IQR width relative to a "normal" 10-unit spread. Wide
				// spread = more variation = more interesting.
				const widthScore = Math.min(100, (ns.p95 - ns.p5) / 10);
				// Outliers are zero in lite mode; this is a flat bonus
				// for full-mode outliers.
				const outlierBonus = ns.iqrOutliers.length;
				return 500 + widthScore + outlierBonus * 10;
			}
			case 'categorical': {
				const cs = s as import('$lib/pipeline/columnStats.js').CategoricalStats;
				const u = cs.uniqueCount;
				if (u <= 1) return 100;
				if (u >= Math.max(50, totalRows * 0.5)) return 250;
				// Bell around 5–25 unique: peak at ~10
				return 200 + Math.max(0, 100 - Math.abs(10 - Math.log2(u)) * 20);
			}
			case 'datetime': {
				const ds = s as import('$lib/pipeline/columnStats.js').DatetimeStats;
				const spanMs = ds.max.getTime() - ds.min.getTime();
				// Span in years, capped at 100.
				const spanScore = Math.min(100, spanMs / (365 * 24 * 3600 * 1000));
				return 400 + spanScore;
			}
			case 'text': {
				const ts = s as import('$lib/pipeline/columnStats.js').TextStats;
				return 50 + Math.min(100, ts.uniqueCount / 10);
			}
		}
	};
	return [...columns].sort((a, b) => score(b) - score(a));
}

// ── Worker entry point ────────────────────────────────────────────────────

self.addEventListener('message', (ev: MessageEvent<ComputeRequest>) => {
	const req = ev.data;
	const t0 = performance.now();
	const { columns, rows, filter, loadedColumns } = req;

	// Apply filter up front (when present). The filtered subset is what
	// stats, charts, and KPIs all use. Doing it here keeps the main
	// thread idle for filter clicks.
	const filtered = filter
		? rows.filter((r) => evalFilter(filter, r))
		: rows;

	// Build a fast-lookup Set so the per-column loop is O(1) per check.
	// An empty allowlist is the common case (default on a fresh
	// file load) — every column gets lite, no chart data.
	const loadedSet = new Set(loadedColumns);

	// Per-column stats. Lite pass = cheap; full pass = expensive.
	const statsByColumn: Record<string, ColumnStats> = {};
	for (const col of columns) {
		statsByColumn[col.name] = computeColumnStats(
			col.name,
			filtered,
			col.type,
			loadedSet.has(col.name) ? 'full' : 'lite'
		);
	}

	// Per-column chart data. Only computed for loaded columns.
	const chartDataByColumn: Record<string, ChartData | null> = {};
	for (const col of columns) {
		chartDataByColumn[col.name] = loadedSet.has(col.name)
			? chartDataFor(col, filtered)
			: null;
	}

	// Interestingness sort (lite-friendly — see sortColumnsOrLite).
	const sortedColumns = sortColumnsOrLite(
		columns,
		statsByColumn,
		filtered.length
	);

	// Workbook KPIs (always over the full filtered set).
	const kpis = computeKpis(
		filtered,
		columns.map((c) => ({ name: c.name, type: c.type }))
	);

	const result: ComputeResult = {
		statsByColumn,
		chartDataByColumn,
		sortedColumns,
		kpis,
		elapsedMs: performance.now() - t0
	};

	(self as unknown as Worker).postMessage(result);
});
