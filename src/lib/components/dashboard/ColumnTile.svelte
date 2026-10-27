<script lang="ts">
	/**
	 * ColumnTile.svelte — one column's card in the Data Workbench dashboard.
	 *
	 * Renders, for a single column:
	 *   - column name + type chip
	 *   - 2–3 type-specific stats
	 *   - the deterministic chart (bar / histogram / timeseries) — same
	 *     `buildChartSpec` engine the chat column-analysis bubbles use
	 *   - outliers / "long tail" / peak month callouts
	 *
	 * Interactions (no LLM):
	 *   - Click a bar / histogram bin / timeseries bar → calls onChartClick
	 *     with a Filter the dashboard applies to the row buffer
	 *   - "Show outliers" (numeric) → onChartClick with the IQR-fence filter
	 *   - "Pin" / "Unpin" → tells the parent which tile to expand
	 *   - Right-click the column header → still uses cellMenuActions
	 *
	 * Stats are recomputed by the parent whenever the filtered row set
	 * changes. We don't recompute here.
	 */

	import VegaChart from '$lib/components/visuals/VegaChart.svelte';
	import { buildChartSpec, type ChartData } from '$lib/visuals/chart-specs.js';
	import { filterForOutliers, type ColumnStats } from '$lib/pipeline/columnStats.js';
	import type { Filter } from '$lib/pipeline/filter.js';
	import type { ColumnProfile } from '$lib/types.js';

	interface Props {
		column: ColumnProfile;
		stats: ColumnStats;
		/** Precomputed chart data series for the filtered subset. */
		chartData: ChartData | null;
		/** True when the dashboard is the focused/expanded tile. */
		expanded: boolean;
		/** User pinned this tile (manual). */
		pinned: boolean;
		/** When set, the tile renders an "active filter" badge. */
		activeFilterColumn?: string | null;
		/** Click a chart segment — dashboard applies the returned Filter. */
		onChartClick?: (filter: Filter, label: string) => void;
		/** Pin/unpin this tile. */
		onTogglePin?: (columnName: string) => void;
		/** "Analyze this column" — preserves the right-click affordance. */
		onAnalyze?: (columnName: string) => void;
	}

	let {
		column,
		stats,
		chartData,
		expanded,
		pinned,
		activeFilterColumn = null,
		onChartClick,
		onTogglePin,
		onAnalyze
	}: Props = $props();

	/** Build the Vega-Lite spec for this column. Memo-equivalent: cheap
	 *  to call, so we don't need a $derived. */
	const spec = $derived(buildChartSpec(column, column.type, chartData));

	/** Chart data series the Vega spec needs for the click handler. We
	 *  pass them through as a data-side helper since the spec only embeds
	 *  the values, not click metadata. */
	const categories = $derived(chartData?.kind === 'category' ? chartData.values : null);
	const bins = $derived(chartData?.kind === 'histogram' ? chartData.bins : null);
	const buckets = $derived(chartData?.kind === 'timeseries' ? chartData.buckets : null);

	/** Wire the Vega chart's selection signal. We use Vega's native
	 *  selection mechanism for click-to-filter: a single selection point
	 *  fires a `selectPoint` event with the datum. The component below
	 *  wires this on mount via the `signalListeners` prop. */
	let chartContainerEl = $state<HTMLDivElement | null>(null);

	/** Map a clicked datum → Filter. The shape differs by chart kind. */
	function filterForDatum(d: Record<string, unknown>): { filter: Filter; label: string } | null {
		if (chartData?.kind === 'category') {
			const label = String(d.label ?? '');
			if (!label) return null;
			return { filter: { column: column.name, op: 'eq', value: label }, label };
		}
		if (chartData?.kind === 'histogram') {
			const lo = Number(d.lo);
			const hi = Number(d.hi);
			return {
				filter: { and: [
					{ column: column.name, op: 'gte', value: String(lo) },
					{ column: column.name, op: 'lte', value: String(hi) }
				] },
				label: `${formatNum(lo)} – ${formatNum(hi)}`
			};
		}
		if (chartData?.kind === 'timeseries') {
			const month = String(d.month ?? '');
			// d.month is "YYYY-MM-01" — strip the "-01"
			const yyyyMm = month.length >= 7 ? month.slice(0, 7) : month;
			if (!yyyyMm) return null;
			// Compute last day of that month for the inclusive range
			const [y, m] = yyyyMm.split('-').map(Number);
			const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
			const lastStr = `${yyyyMm}-${String(last).padStart(2, '0')}`;
			return {
				filter: { and: [
					{ column: column.name, op: 'gte', value: `${yyyyMm}-01` },
					{ column: column.name, op: 'lte', value: lastStr }
				] },
				label: yyyyMm
			};
		}
		return null;
	}

	/** Hook into Vega's click on a mark. We listen at the container level
	 *  and resolve the nearest datum. */
	function handleChartClick(ev: MouseEvent) {
		if (!onChartClick) return;
		const target = ev.target as Element | null;
		if (!target) return;
		// Vega renders <path> for bars. The data is on `__data__` on Vega marks.
		const node = target.closest('[data-datum]') as HTMLElement | null;
		if (!node) return;
		try {
			const raw = node.getAttribute('data-datum');
			if (!raw) return;
			const d = JSON.parse(raw);
			const out = filterForDatum(d);
			if (out) onChartClick(out.filter, out.label);
		} catch {
			/* ignore */
		}
	}

	// Number formatters used by the stats
	function formatNum(n: number): string {
		if (n === 0) return '0';
		const abs = Math.abs(n);
		if (abs >= 1000) return n.toFixed(0);
		if (abs >= 1) return n.toFixed(2);
		return n.toFixed(3);
	}

	/** Build a "show me the outliers" filter for the outlier-callout button.
	 *  Delegates to the helper in columnStats.ts so the filter shape stays
	 *  in one place — earlier this inlined an `and(lte, gte)` which is
	 *  unsatisfiable by definition of IQR fence. */
	function handleShowOutliers() {
		if (!onChartClick || stats.kind !== 'numeric') return;
		const filter = filterForOutliers(column.name, stats);
		if (!filter) return;
		onChartClick(
			filter,
			`${stats.iqrOutliers.length} outliers (outside IQR × 1.5)`
		);
	}

	// Per-type derived stats shown in the chip row
	const typeChipColor = $derived(
		column.type === 'numeric'
			? 'bg-blue-100 border-blue-300 text-blue-700 dark:bg-blue-900/40 dark:border-blue-800 dark:text-blue-300'
			: column.type === 'datetime'
				? 'bg-purple-100 border-purple-300 text-purple-700 dark:bg-purple-900/40 dark:border-purple-800 dark:text-purple-300'
				: column.type === 'categorical'
					? 'bg-emerald-100 border-emerald-300 text-emerald-700 dark:bg-emerald-900/40 dark:border-emerald-800 dark:text-emerald-300'
					: 'bg-gray-100 border-gray-300 text-gray-700 dark:bg-slate-800 dark:border-slate-700 dark:text-gray-300'
	);

	// "Interesting" callout line per type
	const callout = $derived(buildCallout(column, stats));

	function buildCallout(col: ColumnProfile, s: ColumnStats): string {
		if (s.kind === 'numeric') {
			if (s.iqrOutliers.length > 0) {
				return `${s.iqrOutliers.length} outlier${s.iqrOutliers.length === 1 ? '' : 's'} (IQR × 1.5)`;
			}
			if (s.nullCount > 0) {
				return `${s.nullCount} missing`;
			}
			return `range ${formatNum(s.min)} – ${formatNum(s.max)}`;
		}
		if (s.kind === 'categorical') {
			if (s.hasLongTail) {
				return `long tail (${s.uniqueCount} unique)`;
			}
			if (s.uniqueCount === 1) {
				return 'constant column';
			}
			return `${s.uniqueCount} unique`;
		}
		if (s.kind === 'datetime') {
			if (s.peakMonth) {
				return `peak ${s.peakMonth} (${s.peakCount})`;
			}
			return `${s.distinctMonths} months`;
		}
		// text
		if (s.uniqueCount > 50) {
			return `text-like (${s.uniqueCount} unique)`;
		}
		return `${s.uniqueCount} unique · median ${Math.round(s.medianLength)} chars`;
	}
</script>

<div
	class="rounded-xl border bg-white border-gray-200 dark:bg-slate-900 dark:border-slate-800 overflow-hidden flex flex-col"
	class:ring-2={pinned}
	class:ring-blue-500={pinned}
	class:opacity-60={!pinned && activeFilterColumn && activeFilterColumn !== column.name && !expanded}
>
	<!-- Header: name + type chip + pin + analyze -->
	<div class="px-3 py-2 flex items-center gap-2 border-b border-gray-200 bg-gray-50 dark:border-slate-800 dark:bg-slate-900/60">
		<button
			type="button"
			class="text-sm font-medium text-gray-800 hover:text-blue-600 dark:text-gray-200 dark:hover:text-blue-300 transition-colors truncate text-left flex-1"
			onclick={() => onAnalyze?.(column.name)}
			title={`Analyze ${column.name}`}
		>
			{column.name}
		</button>
		<span
			class="flex-shrink-0 px-1.5 py-0.5 rounded text-[10px] border {typeChipColor}"
		>
			{column.type}
		</span>
		<button
			type="button"
			class="flex-shrink-0 text-gray-400 hover:text-blue-600 dark:text-gray-500 dark:hover:text-blue-300 transition-colors text-xs"
			onclick={() => onTogglePin?.(column.name)}
			aria-label={pinned ? 'Unpin column' : 'Pin column'}
			title={pinned ? 'Unpin' : 'Pin (focus this column)'}
		>
			{pinned ? '📌' : '📍'}
		</button>
	</div>

	<!-- Chart area. On click, we find the clicked datum and route through
	     the parent's chart-click handler. -->
	<div
		bind:this={chartContainerEl}
		onclick={handleChartClick}
		class="cursor-pointer"
		role="presentation"
	>
		{#if spec}
			<VegaChart {spec} label="{column.name} chart" />
		{:else}
			<div class="h-[200px] flex items-center justify-center text-xs text-gray-400 dark:text-gray-600">
				No chart available
			</div>
		{/if}
		<!-- Hidden datum mirror so the click handler can resolve the nearest bar.
		     We re-render the same chart data as a 0-height overlay keyed by index.
		     The closest ancestor with data-datum wins on click. -->
		{#if categories}
			<div class="sr-only" aria-hidden="true">
				{#each categories as c, i}
					<span data-datum={JSON.stringify({ kind: 'category', label: c.label, count: c.count, idx: i })}></span>
				{/each}
			</div>
		{:else if bins}
			<div class="sr-only" aria-hidden="true">
				{#each bins as b, i}
					<span data-datum={JSON.stringify({ kind: 'histogram', lo: b.lo, hi: b.hi, count: b.count, idx: i })}></span>
				{/each}
			</div>
		{:else if buckets}
			<div class="sr-only" aria-hidden="true">
				{#each buckets as b, i}
					<span data-datum={JSON.stringify({ kind: 'timeseries', month: `${b.month}-01`, count: b.count, idx: i })}></span>
				{/each}
			</div>
		{/if}
	</div>

	<!-- Stat strip + callout -->
	<div class="px-3 py-2 border-t border-gray-200 dark:border-slate-800 space-y-1.5">
		<!-- Per-type stats -->
		<div class="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-gray-500">
			{#if stats.kind === 'numeric'}
				<span>mean {formatNum(stats.mean)}</span>
				<span>median {formatNum(stats.median)}</span>
				<span>σ {formatNum(stats.std)}</span>
				<span>p5 {formatNum(stats.p5)}</span>
				<span>p95 {formatNum(stats.p95)}</span>
			{:else if stats.kind === 'categorical'}
				{#each stats.topValues.slice(0, 3) as t}
					<span class="truncate max-w-[8rem]">{t.value} · {(t.pct * 100).toFixed(0)}%</span>
				{/each}
			{:else if stats.kind === 'datetime'}
				<span>{stats.min.toISOString().slice(0, 10)}</span>
				<span>→</span>
				<span>{stats.max.toISOString().slice(0, 10)}</span>
			{:else}
				<span>med {Math.round(stats.medianLength)} chars</span>
				<span>p95 {Math.round(stats.p95Length)} chars</span>
			{/if}
		</div>
		<!-- Callout + action -->
		<div class="flex items-center justify-between gap-2">
			<span
				class="text-[11px] {stats.kind === 'numeric' && stats.iqrOutliers.length > 0
					? 'text-amber-600 dark:text-amber-300'
					: 'text-gray-500 dark:text-gray-400'}"
			>
				{callout}
			</span>
			{#if stats.kind === 'numeric' && stats.iqrOutliers.length > 0}
				<button
					type="button"
					class="flex-shrink-0 px-1.5 py-0.5 rounded text-[10px] border border-amber-300 bg-amber-100 text-amber-800 hover:bg-amber-200 dark:border-amber-800 dark:bg-amber-900/30 dark:text-amber-200 dark:hover:bg-amber-900/50 transition-colors"
					onclick={handleShowOutliers}
				>
					Show outliers
				</button>
			{/if}
		</div>
	</div>
</div>
