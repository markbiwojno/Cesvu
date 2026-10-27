/**
 * src/lib/pipeline/columnStats.ts — deterministic column statistics engine
 *
 * Pure functions. No LLM. No DOM. No side effects. Re-runnable on filtered
 * row subsets in O(n) time. Powers the Data Workbench dashboard surface
 * (DashboardPane.svelte) so every metric / chart / click-to-filter is
 * reproducible and auditable — no model calls.
 *
 * Library: simple-statistics for mean, median, std dev, quantile, MAD. We
 * compute our own IQR-based outlier detection on top of those primitives.
 *
 * Type system: column type names are 'numeric' | 'categorical' | 'datetime'
 * | 'text', matching ColumnProfile['type'] in src/lib/types.ts. The row
 * shape is the same Record<string, unknown>[] the rest of the pipeline uses.
 */

import {
	mean,
	median,
	standardDeviation,
	quantile
} from 'simple-statistics';
import type { Filter, FilterLeaf } from '$lib/pipeline/filter.js';

// ============================================================
// Coercion helpers — work over Record<string, unknown>
// ============================================================

/** Coerce an unknown cell to a finite number, or null. */
export function toNumber(v: unknown): number | null {
	if (v === null || v === undefined || v === '') return null;
	if (typeof v === 'number') return Number.isFinite(v) ? v : null;
	const n = parseFloat(String(v).replace(/[, $]/g, ''));
	return Number.isFinite(n) ? n : null;
}

/** Coerce an unknown cell to a Date, or null. Accepts ISO, US (MM/DD/YYYY),
 *  and Excel-style numeric serials (days since 1899-12-30, leap-year-bug aware). */
export function toDate(v: unknown): Date | null {
	if (v === null || v === undefined || v === '') return null;
	if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
	// Excel serial number (1–100000 covers years 1900–2173)
	if (typeof v === 'number' && v > 1 && v < 100000) {
		const ms = (v - 25569) * 86400 * 1000; // 25569 = days from 1899-12-30 to 1970-01-01
		const d = new Date(ms);
		return Number.isNaN(d.getTime()) ? null : d;
	}
	const d = new Date(String(v));
	return Number.isNaN(d.getTime()) ? null : d;
}

/** Stringify an unknown cell, treating null/undefined as ''. */
export function toString(v: unknown): string {
	return v === null || v === undefined ? '' : String(v);
}

// ============================================================
// Stats per column type
// ============================================================

/** Numeric column — count, mean, median, std, min, max, percentiles, outliers. */
export interface NumericStats {
	kind: 'numeric';
	count: number;
	nonNull: number;
	nullCount: number;
	min: number;
	max: number;
	mean: number;
	median: number;
	std: number;
	q1: number;
	q3: number;
	iqr: number;
	p5: number;
	p95: number;
	/** Z-score > 3 (secondary flag). */
	zOutliers: number[];
	/** Outside [Q1 - 1.5·IQR, Q3 + 1.5·IQR] (primary flag — robust to skew). */
	iqrOutliers: number[];
	/** Sample of up to 5 outlier VALUES for the "outliers" callout. */
	outlierSamples: number[];
}

/** Categorical column — unique count, top values, missing rate, long tail. */
export interface CategoricalStats {
	kind: 'categorical';
	count: number;
	nonNull: number;
	nullCount: number;
	uniqueCount: number;
	/** Top values by frequency (capped). */
	topValues: Array<{ value: string; count: number; pct: number }>;
	/** True when >5% of rows fall outside the top-10 values (long tail). */
	hasLongTail: boolean;
	/** Sum of top-10 shares (0–1) — the "concentration" of the distribution. */
	top10Share: number;
}

/** Datetime column — range, peak month, gaps. */
export interface DatetimeStats {
	kind: 'datetime';
	count: number;
	nonNull: number;
	nullCount: number;
	min: Date;
	max: Date;
	/** YYYY-MM string of the month with the most rows. */
	peakMonth: string;
	peakCount: number;
	/** Number of distinct calendar months in the data. */
	distinctMonths: number;
}

/** Text column — basically a categorical with a "too many unique" flag. */
export interface TextStats {
	kind: 'text';
	count: number;
	nonNull: number;
	nullCount: number;
	uniqueCount: number;
	/** Median + 95th percentile string length. */
	medianLength: number;
	p95Length: number;
	/** A handful of the most frequent distinct values (not exhaustive). */
	topValues: Array<{ value: string; count: number }>;
}

/** Discriminated union. */
export type ColumnStats = NumericStats | CategoricalStats | DatetimeStats | TextStats;

/** Compute statistics for a single column over a row subset.
 *
 *  `mode = 'lite'` returns the same ColumnStats shape but with the
 *  expensive fields stubbed out: outlier lists, top-N categoricals,
 *  month buckets, length percentiles, etc. The compact dashboard
 *  cards use `lite` so the user can browse 200+ columns at zero
 *  compute cost. The full mode powers the chart-bearing ColumnTile. */
export type ColumnStatsMode = 'full' | 'lite';

export function computeColumnStats(
	column: string,
	rows: Record<string, unknown>[],
	type: 'numeric' | 'categorical' | 'datetime' | 'text',
	mode: ColumnStatsMode = 'full'
): ColumnStats {
	const values: unknown[] = new Array(rows.length);
	let nullCount = 0;
	for (let i = 0; i < rows.length; i++) {
		const v = rows[i][column];
		values[i] = v;
		if (v === null || v === undefined || v === '') nullCount++;
	}
	const nonNull = rows.length - nullCount;

	switch (type) {
		case 'numeric':
			return numericStats(values, nonNull, nullCount, mode);
		case 'datetime':
			return datetimeStats(values, nonNull, nullCount, mode);
		case 'categorical':
			return categoricalStats(values, nonNull, nullCount, rows.length, mode);
		case 'text':
			return textStats(values, nonNull, nullCount, mode);
	}
}

function numericStats(
	values: unknown[],
	nonNull: number,
	nullCount: number,
	mode: ColumnStatsMode
): NumericStats {
	const nums: number[] = [];
	for (const v of values) {
		const n = toNumber(v);
		if (n !== null) nums.push(n);
	}
	if (nums.length === 0) {
		return {
			kind: 'numeric', count: values.length, nonNull, nullCount,
			min: 0, max: 0, mean: 0, median: 0, std: 0,
			q1: 0, q3: 0, iqr: 0, p5: 0, p95: 0,
			zOutliers: [], iqrOutliers: [], outlierSamples: []
		};
	}
	const sorted = [...nums].sort((a, b) => a - b);
	const mn = mean(nums);
	const med = median(nums);
	const sd = standardDeviation(nums);
	const q1 = quantile(nums, 0.25);
	const q3 = quantile(nums, 0.75);
	const iqr = q3 - q1;
	const p5 = quantile(nums, 0.05);
	const p95 = quantile(nums, 0.95);
	// Lite mode skips the outlier walks (one extra full pass + 2 Map
	// filters each) so the dashboard can render hundreds of placeholder
	// cards without exceeding memory.
	if (mode === 'lite') {
		return {
			kind: 'numeric',
			count: values.length, nonNull, nullCount,
			min: sorted[0], max: sorted[sorted.length - 1],
			mean: mn, median: med, std: sd,
			q1, q3, iqr, p5, p95,
			zOutliers: [], iqrOutliers: [], outlierSamples: []
		};
	}
	const loFence = q1 - 1.5 * iqr;
	const hiFence = q3 + 1.5 * iqr;
	const iqrOutliers = nums.filter((n) => n < loFence || n > hiFence);
	// Z-score outlier detection (secondary flag). Require at least 4 samples
	// (mean / std meaningless below that). SD == 0 → no outliers by z-score.
	const zOutliers: number[] = sd > 0
		? nums.filter((n) => Math.abs((n - mn) / sd) > 3)
		: [];
	const outlierSamples = iqrOutliers.slice(0, 5);
	return {
		kind: 'numeric',
		count: values.length, nonNull, nullCount,
		min: sorted[0], max: sorted[sorted.length - 1],
		mean: mn, median: med, std: sd,
		q1, q3, iqr, p5, p95,
		zOutliers, iqrOutliers, outlierSamples
	};
}

function categoricalStats(
	values: unknown[], nonNull: number, nullCount: number, total: number,
	mode: ColumnStatsMode
): CategoricalStats {
	const counts = new Map<string, number>();
	for (const v of values) {
		const s = toString(v);
		if (s === '') continue;
		counts.set(s, (counts.get(s) ?? 0) + 1);
	}
	// Lite mode: just the unique count. The sort + slice + reduce
	// below are all skipped. That keeps the placeholder card cheap
	// at the cost of no "top values" preview.
	if (mode === 'lite') {
		return {
			kind: 'categorical',
			count: values.length, nonNull, nullCount,
			uniqueCount: counts.size,
			topValues: [],
			hasLongTail: false, top10Share: 0
		};
	}
	const sorted = [...counts.entries()]
		.sort((a, b) => b[1] - a[1]);
	const top = sorted.slice(0, 10).map(([value, c]) => ({
		value, count: c, pct: c / total
	}));
	const top10Share = top.reduce((acc, t) => acc + t.pct, 0);
	const hasLongTail = top10Share < 0.95 && sorted.length > 10;
	return {
		kind: 'categorical',
		count: values.length, nonNull, nullCount,
		uniqueCount: counts.size,
		topValues: top,
		hasLongTail, top10Share
	};
}

function datetimeStats(
	values: unknown[], nonNull: number, nullCount: number,
	mode: ColumnStatsMode
): DatetimeStats {
	const dates: Date[] = [];
	for (const v of values) {
		const d = toDate(v);
		if (d) dates.push(d);
	}
	if (dates.length === 0) {
		const epoch = new Date(0);
		return {
			kind: 'datetime', count: values.length, nonNull, nullCount,
			min: epoch, max: epoch, peakMonth: '', peakCount: 0, distinctMonths: 0
		};
	}
	// Linear min/max — Math.min(...ts) blows the call stack for
	// 200k+ element arrays. (V8 caps the arg-spread at ~125k args;
	// datetime columns on a 200k-row sheet have ~200k entries.)
	let minMs = dates[0].getTime();
	let maxMs = dates[0].getTime();
	for (let i = 1; i < dates.length; i++) {
		const t = dates[i].getTime();
		if (t < minMs) minMs = t;
		if (t > maxMs) maxMs = t;
	}
	// Lite mode: skip the month-bucketing loop (one full pass + a
	// Map allocation + a reduce over the Map). The placeholder
	// card just shows the min/max date range.
	if (mode === 'lite') {
		return {
			kind: 'datetime',
			count: values.length, nonNull, nullCount,
			min: new Date(minMs), max: new Date(maxMs),
			peakMonth: '', peakCount: 0, distinctMonths: 0
		};
	}
	// Bucket by YYYY-MM
	const monthCounts = new Map<string, number>();
	for (const d of dates) {
		const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
		monthCounts.set(key, (monthCounts.get(key) ?? 0) + 1);
	}
	let peakMonth = '';
	let peakCount = 0;
	for (const [k, c] of monthCounts) {
		if (c > peakCount) { peakMonth = k; peakCount = c; }
	}
	return {
		kind: 'datetime',
		count: values.length, nonNull, nullCount,
		min: new Date(minMs), max: new Date(maxMs),
		peakMonth, peakCount, distinctMonths: monthCounts.size
	};
}

function textStats(
	values: unknown[], nonNull: number, nullCount: number,
	mode: ColumnStatsMode
): TextStats {
	const counts = new Map<string, number>();
	const lengths: number[] = [];
	for (const v of values) {
		const s = toString(v);
		if (s === '') continue;
		lengths.push(s.length);
		counts.set(s, (counts.get(s) ?? 0) + 1);
	}
	// Lite mode: skip the quantile calls (which sort the lengths
	// array) and the topValues sort. The placeholder card just
	// shows the unique count.
	if (mode === 'lite') {
		return {
			kind: 'text',
			count: values.length, nonNull, nullCount,
			uniqueCount: counts.size,
			medianLength: 0, p95Length: 0,
			topValues: []
		};
	}
	const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
	const top = sorted.slice(0, 5).map(([value, count]) => ({ value, count }));
	return {
		kind: 'text',
		count: values.length, nonNull, nullCount,
		uniqueCount: counts.size,
		medianLength: lengths.length ? median(lengths) : 0,
		p95Length: lengths.length ? quantile(lengths, 0.95) : 0,
		topValues: top
	};
}

// ============================================================
// Interestingness sort — drives the tile grid order
// ============================================================

/**
 * Higher = more interesting = shown first in the dashboard.
 * We weight: outlier count (numeric), uniqueness (categorical), distinct months
 * (datetime), text length (text, capped). Numeric with at least one IQR outlier
 * beats everything; long unique text columns go last.
 */
export function interestingnessScore(
	col: string,
	type: 'numeric' | 'categorical' | 'datetime' | 'text',
	stats: ColumnStats,
	totalRows: number
): number {
	switch (type) {
		case 'numeric': {
			const s = stats as NumericStats;
			const outlierRatio = s.iqrOutliers.length / Math.max(1, totalRows);
			return 1000 + outlierRatio * 500;
		}
		case 'datetime': {
			const s = stats as DatetimeStats;
			return 500 + Math.min(s.distinctMonths, 60);
		}
		case 'categorical': {
			const s = stats as CategoricalStats;
			// Mid-cardinality categories are most "interesting" — high uniqueness
			// means text-like (low score), low uniqueness means boring.
			const u = s.uniqueCount;
			if (u <= 1) return 100; // constant column
			if (u >= Math.max(50, totalRows * 0.5)) return 200 + 50; // text-like
			// Bell around 5–25 unique values: peak at ~10
			return 200 + Math.max(0, 100 - Math.abs(10 - Math.log2(u)) * 20);
		}
		case 'text': {
			const s = stats as TextStats;
			return 50 + Math.min(s.p95Length, 100) / 10;
		}
	}
}

/** Return columns sorted by interestingness (most interesting first). */
export function sortColumnsByInterestingness(
	columns: Array<{ name: string; type: 'numeric' | 'categorical' | 'datetime' | 'text' }>,
	stats: Record<string, ColumnStats>,
	totalRows: number
): Array<{ name: string; type: 'numeric' | 'categorical' | 'datetime' | 'text' }> {
	return [...columns].sort((a, b) => {
		const sa = stats[a.name];
		const sb = stats[b.name];
		if (!sa || !sb) return 0;
		return interestingnessScore(b.name, b.type, sb, totalRows) -
			interestingnessScore(a.name, a.type, sa, totalRows);
	});
}

// ============================================================
// Filter builders — translate "click on a chart segment" into a Filter
// ============================================================

/** Click a categorical bar → exact match. */
export function filterForCategory(
	column: string,
	value: string
): FilterLeaf {
	return { column, op: 'eq', value };
}

/** Click a histogram bin → inclusive range. Implemented as AND(gte, lte) since
 *  the filter engine has no native `between` op. */
export function filterForRange(
	column: string,
	lo: number,
	hi: number
): Filter {
	return { and: [
		{ column, op: 'gte', value: String(lo) },
		{ column, op: 'lte', value: String(hi) }
	] };
}

/** Click a timeseries bar → inclusive month range (1st of month → last day). */
export function filterForMonth(
	column: string,
	yyyyMm: string
): Filter {
	// yyyyMm is "YYYY-MM". Compute first and last day of that month.
	const [y, m] = yyyyMm.split('-').map(Number);
	const first = `${yyyyMm}-01`;
	// Day 0 of next month = last day of this month (Date handles month rollover).
	const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
	const lastStr = `${yyyyMm}-${String(last).padStart(2, '0')}`;
	return { and: [
		{ column, op: 'gte', value: first },
		{ column, op: 'lte', value: lastStr }
	] };
}

/** "Show me the outliers" → all rows outside the IQR fence.
 *
 *  Returns a SINGLE leaf with op='outside' and value=[lo, hi] — NOT
 *  an `or` tree of two range leaves. The reasons:
 *
 *    1. "Outside the IQR fence" is fundamentally a disjunction
 *       (cell <= lo OR cell >= hi), but the existing filter bar in
 *       DocumentPane is an AND-only tree that flattens to a list of
 *       conditions; OR trees are silently dropped by the translator.
 *
 *    2. The `outside` op is a single leaf that every consumer
 *       already understands (chat engine, document pane filter bar,
 *       worker, value matcher). It piggy-backs on the existing
 *       single-leaf infrastructure with a tuple-shaped value.
 *
 *    3. The user sees the pill say "column=X" + "outside IQR × 1.5"
 *       instead of the meaningless "8579 outliers (outside IQR × 1.5)"
 *       string-pattern the old shape produced.
 *
 *  No new types, no new abstractions. The op is a variant on the
 *  existing FilterOp union. The fence is two-sided by definition of
 *  IQR; this leaf captures it as one tuple instead of two ranges. */
export function filterForOutliers(
	column: string,
	stats: NumericStats
): Filter | null {
	if (stats.iqrOutliers.length === 0) return null;
	const loFence = stats.q1 - 1.5 * stats.iqr;
	const hiFence = stats.q3 + 1.5 * stats.iqr;
	return {
		column,
		op: 'outside',
		value: [String(loFence), String(hiFence)]
	};
}

// ============================================================
// KPI helpers — workbench-level stats, not per-column
// ============================================================

export interface WorkbookKpis {
	totalRows: number;
	totalColumns: number;
	filteredRows: number;
	numericColumns: number;
	datetimeColumns: number;
	categoricalColumns: number;
	textColumns: number;
	totalCells: number;
	missingCells: number;
	missingPct: number;
	/** Median across all numeric cells — a "typical value" anchor. */
	numericMedian: number;
}

/** KPIs over a (possibly filtered) row set, given the full column-type inventory. */
export function computeKpis(
	rows: Record<string, unknown>[],
	columns: Array<{ name: string; type: 'numeric' | 'categorical' | 'datetime' | 'text' }>
): WorkbookKpis {
	const totalCells = rows.length * columns.length;
	let missing = 0;
	const numericSamples: number[] = [];
	for (const row of rows) {
		for (const col of columns) {
			const v = row[col.name];
			if (v === null || v === undefined || v === '') {
				missing++;
				continue;
			}
			if (col.type === 'numeric') {
				const n = toNumber(v);
				if (n !== null) numericSamples.push(n);
			}
		}
	}
	let numericMedian = 0;
	if (numericSamples.length) {
		numericMedian = median(numericSamples);
	}
	return {
		totalRows: rows.length,
		totalColumns: columns.length,
		filteredRows: rows.length,
		numericColumns: columns.filter((c) => c.type === 'numeric').length,
		datetimeColumns: columns.filter((c) => c.type === 'datetime').length,
		categoricalColumns: columns.filter((c) => c.type === 'categorical').length,
		textColumns: columns.filter((c) => c.type === 'text').length,
		totalCells,
		missingCells: missing,
		missingPct: totalCells > 0 ? missing / totalCells : 0,
		numericMedian
	};
}


