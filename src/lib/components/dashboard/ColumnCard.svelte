<script lang="ts">
	/**
	 * ColumnCard.svelte — the *cheap* dashboard view of one column.
	 *
	 * This is the placeholder shown for every column by default. It
	 * shows the same outer shape as ColumnTile (header bar + stat
	 * strip + callout) but WITHOUT a chart and WITHOUT any of the
	 * expensive stats (outlier lists, top-N categoricals, month
	 * buckets, length percentiles). The user clicks the "Load
	 * analysis of <column>" button to opt into the full treatment;
	 * the dashboard then dispatches the worker for just that one
	 * column and swaps the card out for a ColumnTile.
	 *
	 * Why: rendering 200 Vega charts at once in Edge blows the JS
	 * heap. The cards cost ~5KB each (plain text) so the user can
	 * browse hundreds of columns at near-zero memory cost. The cost
	 * of compute moves from "automatic" to "user-initiated".
	 *
	 * The card still receives the (lite) `stats` from the worker so
	 * the user can see real numbers — mean / median / σ for numeric,
	 * unique count for categorical, min/max dates for datetime, etc.
	 * Click-to-filter is NOT supported on the card (no chart → no
	 * clickable bars). To filter on a column's values the user loads
	 * the analysis and uses the chart.
	 */

	import type { ColumnStats } from '$lib/pipeline/columnStats.js';
	import type { ColumnProfile } from '$lib/types.js';

	interface Props {
		column: ColumnProfile;
		/** Lite stats from the worker (no outlier/top-N/month data). */
		stats: ColumnStats;
		/** User clicked the "Load analysis" button on this card. */
		onLoad: (columnName: string) => void;
		/** When true, a "Load all" or batch operation is in flight
		 *  and individual buttons are disabled. */
		bulkLoading?: boolean;
	}

	let {
		column,
		stats,
		onLoad,
		bulkLoading = false
	}: Props = $props();

	// Number formatters used by the stats (shared with ColumnTile).
	function formatNum(n: number): string {
		if (n === 0) return '0';
		const abs = Math.abs(n);
		if (abs >= 1000) return n.toFixed(0);
		if (abs >= 1) return n.toFixed(2);
		return n.toFixed(3);
	}

	// Per-type stat strings. Lite stats don't have outlier lists,
	// top-N, peak months, or length percentiles — those live only
	// in the full stats from the worker when a column is "loaded".
	const numericLine = $derived.by(() => {
		if (stats.kind !== 'numeric') return '';
		const s = stats;
		return `mean ${formatNum(s.mean)} · median ${formatNum(s.median)} · σ ${formatNum(s.std)}`;
	});

	const categoricalLine = $derived.by(() => {
		if (stats.kind !== 'categorical') return '';
		return `${stats.uniqueCount.toLocaleString()} unique`;
	});

	const datetimeLine = $derived.by(() => {
		if (stats.kind !== 'datetime') return '';
		return `${stats.min.toISOString().slice(0, 10)} → ${stats.max.toISOString().slice(0, 10)}`;
	});

	const textLine = $derived.by(() => {
		if (stats.kind !== 'text') return '';
		return `${stats.uniqueCount.toLocaleString()} unique`;
	});

	// Callout — a one-line summary. In lite mode we can't say
	// "12 outliers" (we don't have the list), so we say "12 missing"
	// or "range X – Y" instead. The full ColumnTile surfaces the
	// outlier callout once the user has loaded the analysis.
	const callout = $derived.by(() => {
		if (stats.nullCount > 0) {
			return `${stats.nullCount.toLocaleString()} missing`;
		}
		switch (stats.kind) {
			case 'numeric':
				return `range ${formatNum(stats.min)} – ${formatNum(stats.max)}`;
			case 'categorical':
				return stats.uniqueCount === 1 ? 'constant column' : 'load for top values';
			case 'datetime':
				return 'load for monthly trend';
			case 'text':
				return 'load for length distribution';
		}
	});

	// Type chip color (mirrors ColumnTile's color scheme).
	const typeChipColor = $derived(
		column.type === 'numeric'
			? 'bg-blue-100 border-blue-300 text-blue-700 dark:bg-blue-900/40 dark:border-blue-800 dark:text-blue-300'
			: column.type === 'datetime'
				? 'bg-purple-100 border-purple-300 text-purple-700 dark:bg-purple-900/40 dark:border-purple-800 dark:text-purple-300'
				: column.type === 'categorical'
					? 'bg-emerald-100 border-emerald-300 text-emerald-700 dark:bg-emerald-900/40 dark:border-emerald-800 dark:text-emerald-300'
					: 'bg-gray-100 border-gray-300 text-gray-700 dark:bg-slate-800 dark:border-slate-700 dark:text-gray-300'
	);
</script>

<div
	class="rounded-xl border bg-white border-gray-200 dark:bg-slate-900 dark:border-slate-800 overflow-hidden flex flex-col"
	aria-label="Column {column.name} — compact view"
>
	<!-- Header: name + type chip (no pin, no analyze — those require
	     a loaded chart to be useful). -->
	<div class="px-3 py-2 flex items-center gap-2 border-b border-gray-200 bg-gray-50 dark:border-slate-800 dark:bg-slate-900/60">
		<span
			class="text-sm font-medium text-gray-800 dark:text-gray-200 truncate flex-1"
			title={column.name}
		>
			{column.name}
		</span>
		<span
			class="flex-shrink-0 px-1.5 py-0.5 rounded text-[10px] border {typeChipColor}"
		>
			{column.type}
		</span>
	</div>

	<!-- Stat strip — lite stats only. Just enough to give the user
	     a sense of what the column looks like without rendering a
	     chart. -->
	<div class="px-3 py-2 border-b border-gray-200 dark:border-slate-800 min-h-[60px] flex items-center">
		<div class="text-[11px] text-gray-500 dark:text-gray-400 font-mono tabular-nums">
			{#if stats.kind === 'numeric'}
				{numericLine}
			{:else if stats.kind === 'categorical'}
				{categoricalLine}
			{:else if stats.kind === 'datetime'}
				{datetimeLine}
			{:else}
				{textLine}
			{/if}
		</div>
	</div>

	<!-- Callout + Load button -->
	<div class="px-3 py-2 flex items-center justify-between gap-2">
		<span class="text-[11px] text-gray-500 dark:text-gray-400 truncate">
			{callout}
		</span>
		<button
			type="button"
			class="flex-shrink-0 px-2 py-1 rounded text-[10px] font-medium border border-gray-300 bg-white text-gray-700 hover:bg-gray-100 hover:border-blue-600 hover:text-blue-700 dark:border-slate-700 dark:bg-slate-800 dark:text-gray-200 dark:hover:bg-slate-700 dark:hover:border-blue-700 dark:hover:text-blue-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
			onclick={() => onLoad(column.name)}
			disabled={bulkLoading}
			aria-label="Load analysis of column {column.name}"
			title="Compute full stats and render chart for {column.name}"
		>
			{bulkLoading ? 'Loading…' : `Load analysis`}
		</button>
	</div>
</div>
