<script lang="ts">
	/**
	 * KpiStrip.svelte — the top of the Data Workbench dashboard.
	 *
	 * Pure presentational component. Receives a WorkbookKpis (the workbench
	 * level numbers — total rows, filtered rows, column counts by type,
	 * missing cells) and renders a 4-up grid of small cards.
	 *
	 * The `filtered` boolean drives styling — when a filter is active,
	 * the "filtered rows" card is highlighted in blue and the "total" card
	 * dims. No interactivity here; the DashboardPane owns the active filter.
	 */

	import type { WorkbookKpis } from '$lib/pipeline/columnStats.js';

	interface Props {
		kpis: WorkbookKpis;
		filtered: boolean;
		/** Source file/sheet name, for the header label. */
		sourceLabel?: string;
	}

	let { kpis, filtered, sourceLabel = '' }: Props = $props();

	/** Compact number formatter: 12,345 → "12.3k", 1,234,567 → "1.23M". */
	function fmtInt(n: number): string {
		if (n < 1000) return String(n);
		if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
		return `${(n / 1_000_000).toFixed(2)}M`;
	}

	/** Format a percentage to one decimal place. */
	function fmtPct(p: number): string {
		return `${(p * 100).toFixed(1)}%`;
	}

	/** Format the median across all numeric cells with sensible precision. */
	function fmtMedian(n: number): string {
		if (n === 0) return '—';
		if (Math.abs(n) >= 1000) return n.toFixed(0);
		if (Math.abs(n) >= 1) return n.toFixed(2);
		return n.toFixed(3);
	}

	// "Filtered" = a filter is active. The header swaps its label so the user
	// knows the KPIs are reflecting a subset.
	const headerLabel = $derived(
		sourceLabel
			? filtered
				? `${sourceLabel} — filtered`
				: sourceLabel
			: 'Workbook'
	);
</script>

<div class="border-b border-gray-200 dark:border-slate-800 bg-gray-50 dark:bg-slate-900/50">
	<!-- Header strip -->
	<div class="px-4 py-2 flex items-center justify-between">
		<div class="flex items-center gap-2 text-xs text-gray-500">
			<span class="font-semibold text-gray-700 dark:text-gray-300">{headerLabel}</span>
			{#if filtered}
				<span class="px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-900/40 border border-blue-300 dark:border-blue-800 text-blue-700 dark:text-blue-300 text-[10px]">
					filtered
				</span>
			{/if}
		</div>
		<span class="text-[10px] text-gray-400 dark:text-gray-600 uppercase tracking-wide">Workbench</span>
	</div>

	<!-- KPI cards -->
	<div class="grid grid-cols-2 md:grid-cols-4 gap-px bg-gray-200 dark:bg-slate-800">
		<!-- Total / filtered rows -->
		<div class="bg-white dark:bg-slate-950 px-4 py-3">
			<div class="text-[10px] text-gray-500 uppercase tracking-wide">Rows</div>
			<div class="mt-1 flex items-baseline gap-2">
				<span
					class="text-xl font-semibold {filtered ? 'text-blue-600 dark:text-blue-300' : 'text-gray-800 dark:text-gray-200'}"
				>
					{fmtInt(kpis.filteredRows)}
				</span>
				{#if filtered}
					<span class="text-xs text-gray-500">
						of {fmtInt(kpis.totalRows)}
					</span>
				{/if}
			</div>
		</div>

		<!-- Columns by type -->
		<div class="bg-white dark:bg-slate-950 px-4 py-3">
			<div class="text-[10px] text-gray-500 uppercase tracking-wide">Columns</div>
			<div class="mt-1 flex items-baseline gap-2">
				<span class="text-xl font-semibold text-gray-800 dark:text-gray-200">
					{kpis.totalColumns}
				</span>
			</div>
			<div class="mt-1 flex gap-2 text-[10px] text-gray-500">
				<span title="Numeric">{kpis.numericColumns} num</span>
				<span title="Datetime">{kpis.datetimeColumns} date</span>
				<span title="Categorical">{kpis.categoricalColumns} cat</span>
				<span title="Text">{kpis.textColumns} txt</span>
			</div>
		</div>

		<!-- Missing cells -->
		<div class="bg-white dark:bg-slate-950 px-4 py-3">
			<div class="text-[10px] text-gray-500 uppercase tracking-wide">Missing</div>
			<div class="mt-1 flex items-baseline gap-2">
				<span
					class="text-xl font-semibold {kpis.missingPct > 0.1 ? 'text-amber-600 dark:text-amber-300' : 'text-gray-800 dark:text-gray-200'}"
				>
					{fmtPct(kpis.missingPct)}
				</span>
			</div>
			<div class="mt-1 text-[10px] text-gray-500">
				{fmtInt(kpis.missingCells)} of {fmtInt(kpis.totalCells)} cells
			</div>
		</div>

		<!-- Numeric anchor -->
		<div class="bg-white dark:bg-slate-950 px-4 py-3">
			<div class="text-[10px] text-gray-500 uppercase tracking-wide">Numeric median</div>
			<div class="mt-1 flex items-baseline gap-2">
				<span class="text-xl font-semibold text-gray-800 dark:text-gray-200">
					{fmtMedian(kpis.numericMedian)}
				</span>
			</div>
			<div class="mt-1 text-[10px] text-gray-500">
				across all numeric cells
			</div>
		</div>
	</div>
</div>
