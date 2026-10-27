<script lang="ts">
	/**
	 * DashboardPane.svelte — the right pane for CSV/Excel.
	 *
	 * Replaces ChatPane for tabular files. Composition:
	 *   1. KPI strip (rows / columns / missing / numeric median)
	 *   2. Active filter pill (when a chart-driven filter is active)
	 *   3. Column tile grid, sorted by interestingness
	 *
	 * ── Performance: staged compute ──────────────────────────────────────────
	 *
	 * The dashboard's expensive work (per-column stats, chart series, sort,
	 * KPIs) is run in a single $effect, NOT as a chain of $derived values.
	 *
	 * Why: $derived over `workspace.csvRows` re-fires on every streaming
	 * chunk. For a 200k-row CSV parsed in 1000-row chunks, that's ~200
	 * full recomputes. Each one re-allocates Maps, sorts, re-evaluates
	 * IQR fences, etc. The user sees the tiles "blinking" as the data
	 * trickles in.
	 *
	 * The fix: gate the compute on `workspace.streamingDone`. While chunks
	 * are still arriving, the dashboard renders skeleton placeholders and
	 * a "Crunching N rows…" banner. Once streaming flips true (or for the
	 * non-streaming Excel path, which sets done=true upfront), a SINGLE
	 * effect run produces all four derived values into local $state
	 * slots. Subsequent filter changes re-run the effect (still only
	 * one pass, not a $derived cascade).
	 *
	 * The empty/loading state is the only thing that's truly $derived —
	 * it must be reactive to the row count so the KPI strip shows
	 * "Crunching…" before the heavy work is done.
	 */

	import { onMount, onDestroy } from 'svelte';
	import { workspace } from '$lib/stores/workspace.svelte.js';
	import KpiStrip from './KpiStrip.svelte';
	import ColumnTile from './ColumnTile.svelte';
	import ColumnCard from './ColumnCard.svelte';
	import type { ColumnStats, WorkbookKpis } from '$lib/pipeline/columnStats.js';
	import type { ChartData } from '$lib/visuals/chart-specs.js';
	import type { Filter } from '$lib/pipeline/filter.js';
	import type { ColumnProfile } from '$lib/types.js';
	import { computeDashboardData, type DashboardComputeResult } from '$lib/workers/dashboardClient.js';

	// ── Data sources ──────────────────────────────────────────────────────────

	/** The active row set. For CSV, this is the streaming buffer. For Excel,
	 *  it's the current sheet's rows. We prefer whichever is populated. */
	const rows = $derived(
		workspace.currentSheet
			? workspace.currentRows
			: workspace.csvRows
	);

	/** True once the parser has handed over the final buffer. For the
	 *  non-streaming Excel path this is true from the moment a sheet is
	 *  selected. For CSV streaming it flips true at the end of the stream. */
	const streamingDone = $derived(workspace.streamingDone);

	/** Live row count — increases during streaming. Drives the KPI strip's
	 *  "Crunching N rows…" message and the skeleton-tile count. */
	const rowCount = $derived(rows.length);

	/** Column profiles from the workspace summary. We only use the type
	 *  field, but we keep the full ColumnProfile shape so ColumnTile gets
	 *  the name, type, topValues/sampleValues fallback, etc. */
	const columns = $derived<ColumnProfile[]>(
		workspace.summary?.columnProfiles ?? []
	);

	/** Active filter tree (if any). Used to compute the filtered subset. */
	const activeFilter = $derived(workspace.activeFilter);

	// ── Computed state (single-pass, gated) ──────────────────────────────────
	//
	// These four $state slots are the dashboard's source of truth. They're
	// populated by a single $effect (below) that runs once per data load
	// or filter change, NOT per streaming chunk. Reads of these slots in
	// the template are zero-cost.

	let statsByColumn: Record<string, ColumnStats> = $state({});
	let chartDataByColumn: Record<string, ChartData | null> = $state({});
	let sortedColumns: ColumnProfile[] = $state([]);

	// ── Focus mode (AnalyzerPopover) ────────────────────────────────────────
	// When the analyzer popover is opened via "Analyze this column", the
	// popover passes the focused column name. The dashboard then renders
	// ONLY that column (not the full sheet) — matching the user's intent.
	// `null` (or absent) = full sheet view (legacy behavior).
	interface Props {
		/** Render only this column. null/undefined = full sheet. */
		focusedColumn?: string | null;
	}
	let { focusedColumn = null }: Props = $props();

	/**
	 * The columns to render. When `focusedColumn` is set, this is a 1-element
	 * array of just that column. Otherwise, the full interestingness-sorted
	 * list. Same shape so the `{#each}` block below is unchanged.
	 */
	const displayedColumns = $derived(
		focusedColumn
			? sortedColumns.filter((c) => c.name === focusedColumn)
			: sortedColumns
	);
	let kpis: WorkbookKpis = $state({
		totalRows: 0, totalColumns: 0, filteredRows: 0,
		numericColumns: 0, datetimeColumns: 0, categoricalColumns: 0,
		textColumns: 0, totalCells: 0, missingCells: 0,
		missingPct: 0, numericMedian: 0
	});

	/** True while the effect is computing. Drives the skeleton-tile view. */
	let computing = $state(false);

	/** True when rows are present but the dashboard hasn't computed yet
	 *  (either the parser is still streaming OR the effect is mid-pass). */
	const showSkeleton = $derived(
		computing || (rowCount > 0 && !streamingDone)
	);

	// ── Lazy-loaded column allowlist ───────────────────────────────────────
	//
	// By default, EVERY column is rendered as a <ColumnCard> (cheap
	// text-only view). The user clicks "Load analysis of X" on a card
	// to opt into the full treatment: a <ColumnTile> with a Vega
	// chart, click-to-filter, and "Show outliers" button.
	//
	// The worker uses this allowlist to decide which columns get the
	// full (expensive) compute and which get the cheap "lite" pass.
	// On a 200-column sheet that means 199 lite passes (~5KB each)
	// and 1 full pass, instead of 200 full passes blowing the heap.
	//
	// Per-session only. On file reload, the set resets. Matches the
	// existing "Pin" state behavior.
	let loadedColumns: Set<string> = $state(new Set());
	/** LRU queue: earliest load at index 0, most recent at the end. */
	let loadedOrder: string[] = $state([]);
	let bulkLoading = $state(false);
	/** Hard cap on rendered-tile count. Above this, the oldest loaded
	 *  column is auto-evicted back to a ColumnCard. This is the safety
	 *  net against the user clicking "Load all" on a 200-column sheet
	 *  and OOMing the tab. The worker still computes full stats for
	 *  every column in one shot — only the 50 most recently loaded
	 *  ones get rendered. */
	const MAX_LOADED = 50;
	/** Above this column count, "Load all" shows a confirm() warning
	 *  about OOM risk before committing. The MAX_LOADED cap is the
	 *  hard guarantee; this is just a soft nudge. */
	const LOAD_ALL_CONFIRM_THRESHOLD = 30;

	// ── The one expensive $effect ────────────────────────────────────────────
	//
	// Dependency set is intentionally MINIMAL. It re-runs when:
	//   - row buffer identity changes (new upload / new sheet)
	//   - column count or types change (new file)
	//   - active filter tree changes (chart click)
	//
	// It does NOT re-run on every streaming chunk because of the
	// `streamingDone` guard. Once chunks stop, the effect fires once.

	$effect(() => {
		// Read all reactive dependencies up front so Svelte tracks them.
		const rowCountNow = rowCount;
		const done = streamingDone;
		const cols = columns;
		const filter = activeFilter;

		// No data yet → reset and bail. This case is handled by the
		// empty state further down.
		if (rowCountNow === 0 || cols.length === 0) {
			statsByColumn = {};
			chartDataByColumn = {};
			sortedColumns = [];
			kpis = {
				totalRows: 0, totalColumns: 0, filteredRows: 0,
				numericColumns: 0, datetimeColumns: 0, categoricalColumns: 0,
				textColumns: 0, totalCells: 0, missingCells: 0,
				missingPct: 0, numericMedian: 0
			};
			computing = false;
			return;
		}

		// Parser still streaming — show the skeleton, do NOTHING.
		// This is the whole point of the rewrite: zero work per chunk.
		if (!done) {
			computing = false;
			return;
		}

		// We have a complete buffer. Hand the work off to the Web
		// Worker (src/lib/workers/dashboard.worker.ts). The main
		// thread stays free while the worker chews — the user can
		// scroll, click chat, etc.
		computing = true;

		// Snapshot the filter tree so the worker doesn't see a stale
		// view if a new filter lands mid-compute. The worker's
		// internal one-shot semantics handle late results: when a
		// newer compute starts, this worker's terminate() is called
		// from the client and its result is discarded.
		const filterTree = filter?.filterTree ?? null;

		// Fire-and-forget. The effect is sync, so we can't await
		// inside it. The promise resolves on the microtask queue
		// and we commit results to the $state slots there.
		//
		// Pass `loadedColumns` as an ARRAY. The worker uses this
		// to decide which columns get the full (expensive) compute
		// vs the cheap "lite" pass. An empty array means "every
		// column gets lite" — i.e. NO chart data, NO outlier walks,
		// NO top-N categoricals. This is the new default on a fresh
		// file load: the user sees cheap cards with lite stats,
		// and only "Load analysis" / "Load all" opts columns into
		// the full treatment.
		//
		// The legacy "undefined = full" interpretation was the
		// pre-lazy-load default; it's been removed because it
		// was the OOM root cause for 200-column sheets (worker
		// still shipped full stats + chart data for all 200 even
		// though only 0 were displayed).
		const loadedList = [...loadedColumns];
		computeDashboardData(cols, rows, filterTree, loadedList)
			.then((result: DashboardComputeResult) => {
				statsByColumn = result.statsByColumn;
				chartDataByColumn = result.chartDataByColumn;
				sortedColumns = result.sortedColumns;
				kpis = result.kpis;
				computing = false;
				// "Load all" runs the full pass. The button shows
				// "Loading…" while bulkLoading is true; clear it
				// now that the worker has finished.
				if (bulkLoading) bulkLoading = false;
				if (typeof console !== 'undefined') {
					const fullCount = loadedList.length;
					const liteCount = cols.length - fullCount;
					console.debug(
						`[dashboard] worker computed ${cols.length} cols × ${rows.length} rows in ${result.elapsedMs.toFixed(0)}ms (${fullCount} full, ${liteCount} lite)`
					);
				}
			})
			.catch((err) => {
				// Swallow the cancel error. Any other failure is logged
				// so we can see it in DevTools without taking down the UI.
				if (err?.name === 'DashboardComputeCancelledError') return;
				computing = false;
				if (bulkLoading) bulkLoading = false;
				if (typeof console !== 'undefined') {
					console.error('[dashboard] worker compute failed:', err);
				}
			});
	});

	// ── New-file detection: reset the lazy-load allowlist ─────────────────
	//
	// When the user uploads a different CSV, the column names in
	// `loadedColumns` will mostly not match the new file's columns.
	// Pruning the set to "names that still exist" keeps any carry-
	// over (unlikely) but drops the dead entries. Per-session only,
	// per the locked-in plan.
	$effect(() => {
		const names = new Set(columns.map((c) => c.name));
		const current = loadedColumns;
		const currentOrder = loadedOrder;
		let changed = false;
		const next = new Set<string>();
		for (const n of current) {
			if (names.has(n)) next.add(n);
			else changed = true;
		}
		// Also prune the LRU queue to match the set. (When a column
		// is removed from the set on a new file, it should also be
		// removed from the order queue so a future "Load all" doesn't
		// try to re-evict it.)
		const nextOrder: string[] = [];
		for (const n of currentOrder) {
			if (next.has(n)) nextOrder.push(n);
			else changed = true;
		}
		if (changed) {
			loadedColumns = next;
			loadedOrder = nextOrder;
		}
	});

	// ── Active filter pill (cheap $derived over the filter tree) ─────────────

	const activeFilterColumn = $derived.by<string | null>(() => {
		const f = activeFilter?.filterTree;
		if (!f) return null;
		if ('column' in f) return f.column;
		if ('and' in f) {
			for (const sub of f.and) {
				if ('column' in sub) return sub.column;
			}
		}
		return null;
	});

	const isFiltered = $derived(Boolean(activeFilter?.filterTree));

	function clearFilter() {
		workspace.clearActiveFilter();
		workspace.clearActiveSort();
	}

	// ── Click-to-filter ───────────────────────────────────────────────────────

	function handleChartClick(filter: Filter, label: string) {
		// Silently ignore clicks during streaming — the dashboard isn't
		// ready to filter yet and a click before the data is in is
		// confusing. (Locked-in behavior.)
		if (showSkeleton) return;
		// Pick a human-readable column label for the pill. The `filter`
		// tree already carries the column name inside its leaf; this is
		// just for the pill's "Active filter: <column>" chip text.
		const colFromTree = readColumnFromFilter(filter);
		workspace.setActiveFilter({
			pattern: label,
			column: colFromTree ?? activeFilterColumn ?? '(chart click)',
			matchCount: 0,
			valueOp: 'eq',
			filterTree: filter
		});
	}

	/** Read the column name from a single-leaf or range-tree filter. */
	function readColumnFromFilter(f: Filter): string | null {
		if ('and' in f) {
			for (const sub of f.and) {
				const c = readColumnFromFilter(sub);
				if (c) return c;
			}
			return null;
		}
		if ('or' in f) {
			for (const sub of f.or) {
				const c = readColumnFromFilter(sub);
				if (c) return c;
			}
			return null;
		}
		if ('not' in f) return readColumnFromFilter(f.not);
		return f.column ?? null;
	}

	// ── Pin state (per-session, not persisted) ────────────────────────────────

	let pinnedColumns = $state<Set<string>>(new Set());

	function togglePin(name: string) {
		const next = new Set(pinnedColumns);
		if (next.has(name)) next.delete(name);
		else next.add(name);
		pinnedColumns = next;
	}

	// ── "Analyze" expansion (right-click replacement) ─────────────────────────

	let expandedColumn = $state<string | null>(null);

	function analyzeColumn(name: string) {
		expandedColumn = expandedColumn === name ? null : name;
	}

	// ── Lazy-load actions ─────────────────────────────────────────────────────

	/** User clicked "Load analysis of <col>" on a ColumnCard. Adds
	 *  the column to the loaded set; the $effect re-fires and
	 *  dispatches the worker for full stats + chart data. */
	/**
	 * Mark a column as loaded. Adds to the LRU queue (end) and
	 * evicts the oldest entries if we exceed MAX_LOADED. Evicted
	 * columns revert to ColumnCard — no data loss, just rendering.
	 */
	function handleLoadColumn(name: string) {
		// If already loaded, bump it to the most-recent position so
		// the user can refresh its slot without losing it to LRU.
		if (loadedColumns.has(name)) {
			const without = loadedOrder.filter((n) => n !== name);
			loadedOrder = [...without, name];
			return;
		}
		const next = new Set(loadedColumns);
		next.add(name);
		loadedColumns = next;
		// Append to the LRU end. If we've crossed the cap, evict
		// the oldest. Per-add FIFO eviction is O(1) amortized.
		const orderNext = [...loadedOrder, name];
		while (orderNext.length > MAX_LOADED) {
			const evicted = orderNext.shift();
			if (evicted !== undefined) next.delete(evicted);
		}
		loadedColumns = next;
		loadedOrder = orderNext;
	}

	// ── Auto-load the focused column (AnalyzerPopover flow) ──────────────────
	//
	// When the user right-clicks "Analyze this column" the popover mounts
	// with `focusedColumn = 'MyCol'`. Without this effect, the column shows
	// up in the dashboard as a ColumnCard (cheap text view) and the user
	// has to click "Load analysis of MyCol" a second time to see the chart
	// — exactly the "have to click again" the user reported.
	//
	// Auto-loading on focus makes the chart appear on the very first
	// click. The trade-off: one extra full-pass column compute per
	// right-click. That's the same cost as the second click the user was
	// making anyway, just paid up front so the chart is ready when the
	// popover mounts.
	//
	// Guarded so this only fires when `focusedColumn` transitions from
	// null/undefined to a real value (or from one value to another). We
	// don't want to re-load the same column every reactive tick.
	let lastAutoLoadedFocus: string | null = null;
	$effect(() => {
		const focus = focusedColumn;
		if (!focus) {
			lastAutoLoadedFocus = null;
			return;
		}
		if (focus === lastAutoLoadedFocus) return;
		lastAutoLoadedFocus = focus;
		handleLoadColumn(focus);
	});

	/** "Load all" — opt every column into the full treatment. The
	 *  worker computes the full pass for the whole sheet in one
	 *  shot. Useful for the user who knows they want everything. */
	/**
	 * "Load all" — opt every column into the full treatment. The
	 * worker computes the full pass for the whole sheet in one
	 * shot. Useful for the user who knows they want everything.
	 *
	 * Safety net (Part 1 of the OOM fix): if the column count
	 * exceeds LOAD_ALL_CONFIRM_THRESHOLD, we surface a confirm()
	 * warning about OOM risk. The user can still click through.
	 *
	 * Hard cap (Part 2 of the OOM fix): MAX_LOADED columns can be
	 * in the rendered-Tile state simultaneously. We trim in
	 * interestingness order, keeping the LAST MAX_LOADED columns
	 * (the most interesting). The rest stay in the Set for the
	 * worker allowlist (so they get full stats) but they render
	 * as ColumnCards. The LRU queue is updated to match.
	 */
	function loadAll() {
		if (columns.length > LOAD_ALL_CONFIRM_THRESHOLD) {
			const ok = (typeof window !== 'undefined' && typeof window.confirm === 'function')
				? window.confirm(
					`Loading all ${columns.length} columns will compute full stats for every one at once. ` +
					`Only the ${MAX_LOADED} most interesting columns stay rendered (older ones auto-revert to compact view). ` +
					`Continue?`
				)
				: true;
			if (!ok) return;
		}
		bulkLoading = true;
		// Walk in interestingness order (sortedColumns is already
		// sorted by the worker) and keep only the LAST MAX_LOADED.
		// The first `columns.length - MAX_LOADED` are evicted.
		const allNames = columns.map((c) => c.name);
		const keepStart = Math.max(0, allNames.length - MAX_LOADED);
		const newSet = new Set<string>();
		const newOrder: string[] = [];
		for (let i = keepStart; i < allNames.length; i++) {
			newSet.add(allNames[i]);
			newOrder.push(allNames[i]);
		}
		loadedColumns = newSet;
		loadedOrder = newOrder;
		// bulkLoading clears in the $effect's .then (see below).
	}

	/** Unload a column. Drops the chart, reverts to the cheap card.
	 *  Currently unused in the UI (we don't expose an "unload"
	 *  button) but kept for future use. */
	function unloadColumn(name: string) {
		if (!loadedColumns.has(name)) return;
		const next = new Set(loadedColumns);
		next.delete(name);
		loadedColumns = next;
	}

	/** True when at least one column is in the loaded set. Used by
	 *  the "Load all" button to render its "Loaded" state. */
	const allLoaded = $derived(
		columns.length > 0 && loadedColumns.size === columns.length
	);

	// ── Source label ──────────────────────────────────────────────────────────

	const sourceLabel = $derived.by(() => {
		if (workspace.workbook && workspace.activeSheet) {
			return `${workspace.file?.name ?? 'Workbook'} · ${workspace.activeSheet}`;
		}
		return workspace.file?.name ?? '';
	});

	// ── "Analyze this column" cross-pane hookup ──────────────────────────────

	function handleAnalyzeEvent(ev: Event) {
		const e = ev as CustomEvent<{ column?: string }>;
		const col = e.detail?.column;
		if (col && !showSkeleton) analyzeColumn(col);
	}

	onMount(() => {
		if (typeof window !== 'undefined') {
			window.addEventListener('cesvu:analyze-column', handleAnalyzeEvent);
		}
	});

	onDestroy(() => {
		if (typeof window !== 'undefined') {
			window.removeEventListener('cesvu:analyze-column', handleAnalyzeEvent);
		}
	});

	// ── Skeleton tile count ──────────────────────────────────────────────────
	// We don't know how many columns will load until the parser is done,
	// so we render a fixed grid of 6 placeholders. Matches the auto-fill
	// column-tile width so the layout doesn't shift when the data lands.

	const SKELETON_TILES = 6;
</script>

<div class="flex flex-col h-full bg-surface dark:bg-slate-950 overflow-hidden">
	<!-- KPI strip — always rendered. While the heavy compute is pending
	     the kpis object is all zeros; once the effect commits, the real
	     numbers appear in the same DOM nodes (no layout shift). -->
	<KpiStrip {kpis} filtered={isFiltered} {sourceLabel} />

	<!-- Crunching banner. Shown while chunks are still arriving. -->
	{#if rowCount > 0 && !streamingDone}
		<div class="px-4 py-2 border-b border-gray-200 dark:border-slate-800 flex items-center gap-2 bg-amber-50 dark:bg-amber-950/20">
			<div class="w-3 h-3 rounded-full border border-amber-500 border-t-transparent animate-spin flex-shrink-0"></div>
			<span class="text-xs text-amber-700 dark:text-amber-200">
				Crunching {rowCount.toLocaleString()} row{rowCount === 1 ? '' : 's'}…
			</span>
			<span class="text-[10px] text-gray-500 ml-auto">Charts will appear when the file finishes loading</span>
		</div>
	{/if}

	<!-- Active filter pill. -->
	{#if isFiltered && activeFilterColumn}
		<div class="px-4 py-2 border-b border-gray-200 dark:border-slate-800 flex items-center gap-2 bg-blue-50 dark:bg-blue-950/20">
			<span class="text-[10px] text-gray-500 uppercase tracking-wide">Active filter</span>
			<span class="px-2 py-0.5 rounded-full bg-blue-100 dark:bg-blue-900/40 border border-blue-300 dark:border-blue-800 text-blue-700 dark:text-blue-300 text-xs flex items-center gap-1.5">
				{activeFilterColumn}
				<button
					type="button"
					class="text-blue-500 hover:text-blue-700 dark:hover:text-blue-200"
					onclick={clearFilter}
					aria-label="Clear filter"
					title="Clear filter"
				>✕</button>
			</span>
			<div class="flex-1"></div>
			<button
				type="button"
				class="text-[10px] text-gray-500 hover:text-blue-600 dark:hover:text-blue-300 transition-colors"
				onclick={() => workspace.setActiveTab('chat')}
				title="Ask a question about this filter"
			>
				Ask in chat →
			</button>
		</div>
	{/if}

	<!-- Column tile grid OR skeleton -->
	<div class="flex-1 overflow-y-auto p-4">
		<!-- Lazy-load header. Hidden when focusedColumn is set — in
		     focus mode the popover is showing ONE column, no "Load
		     all" affordance makes sense. Also hidden during streaming. -->
		{#if !showSkeleton && columns.length > 0 && !focusedColumn}
			<div class="px-4 py-2 border-b border-gray-200 dark:border-slate-800 flex items-center gap-3 bg-gray-50 dark:bg-slate-900/40">
				<span class="text-[10px] text-gray-500 uppercase tracking-wide">
					{loadedColumns.size} of {columns.length} columns loaded
				</span>
				<div class="flex-1"></div>
				<button
					type="button"
					class="px-2.5 py-1 rounded text-[11px] font-medium border border-gray-300 bg-white text-gray-700 hover:bg-gray-100 hover:border-blue-600 hover:text-blue-700 dark:border-slate-700 dark:bg-slate-800 dark:text-gray-200 dark:hover:bg-slate-700 dark:hover:border-blue-700 dark:hover:text-blue-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
					onclick={loadAll}
					disabled={allLoaded || bulkLoading}
					aria-label="Load full analysis for every column"
					title="Compute full stats and charts for every column at once"
				>
					{allLoaded ? 'All loaded' : bulkLoading ? 'Loading…' : `Load all (${columns.length})`}
				</button>
			</div>
		{/if}

		{#if columns.length === 0 && rowCount === 0}
			<div class="h-full flex flex-col items-center justify-center text-center">
				<div class="text-3xl mb-3">📊</div>
				<p class="text-sm font-medium text-gray-500 dark:text-gray-400">No columns yet</p>
				<p class="text-xs text-gray-400 dark:text-gray-600 mt-1">Upload a CSV or Excel file to start.</p>
			</div>

		{:else if showSkeleton}
			<!-- Skeleton tiles. Same grid + same width as the
			     real tile grid so the layout doesn't shift when the
			     data lands. Each tile mirrors a ColumnTile's outer
			     structure (header bar + chart area + stat strip) but
			     with shimmering placeholders. The animation is
			     pure CSS — no JS, no flicker, no setInterval. -->
			<div
				class="grid gap-3"
				style="grid-template-columns: repeat(auto-fill, minmax(280px, 1fr))"
			>
				{#each Array(SKELETON_TILES) as _, i}
					<div class="rounded-xl border border-gray-200 bg-white dark:border-slate-800 dark:bg-slate-900 overflow-hidden flex flex-col">
						<!-- Header bar -->
						<div class="px-3 py-2 flex items-center gap-2 border-b border-gray-200 bg-gray-50 dark:border-slate-800 dark:bg-slate-900/60">
							<div class="h-4 flex-1 rounded bg-gray-200 dark:bg-slate-800 animate-pulse"></div>
							<div class="h-3 w-10 rounded bg-gray-200 dark:bg-slate-800 animate-pulse flex-shrink-0"></div>
							<div class="h-3 w-3 rounded-full bg-gray-200 dark:bg-slate-800 animate-pulse flex-shrink-0"></div>
						</div>
						<!-- Chart placeholder -->
						<div class="h-[200px] bg-gray-50 dark:bg-slate-900/40 flex items-end gap-1 p-3">
							{#each [40, 70, 55, 90, 35, 80, 60, 45, 75, 50] as h, j}
								<div
									class="flex-1 rounded-sm bg-gray-200 dark:bg-slate-800 animate-pulse"
									style="height: {h}%; animation-delay: {j * 80}ms"
								></div>
							{/each}
						</div>
						<!-- Stat strip placeholder -->
						<div class="px-3 py-2 border-t border-gray-200 dark:border-slate-800 space-y-1.5">
							<div class="flex flex-wrap gap-x-3 gap-y-0.5">
								<div class="h-2.5 w-12 rounded bg-gray-200 dark:bg-slate-800 animate-pulse"></div>
								<div class="h-2.5 w-16 rounded bg-gray-200 dark:bg-slate-800 animate-pulse"></div>
								<div class="h-2.5 w-10 rounded bg-gray-200 dark:bg-slate-800 animate-pulse"></div>
							</div>
							<div class="flex items-center justify-between">
								<div class="h-2.5 w-24 rounded bg-gray-200 dark:bg-slate-800 animate-pulse"></div>
							</div>
						</div>
					</div>
				{/each}
			</div>

		{:else}
			<!-- Real column grid. Loaded columns get the full
			     ColumnTile (chart + click-to-filter). Unloaded columns
			     get the cheap ColumnCard (text + "Load analysis"
			     button). The interestingness-first order applies
			     regardless. -->
			<div
				class="grid gap-3"
				style="grid-template-columns: repeat(auto-fill, minmax(280px, 1fr))"
			>
				{#each displayedColumns as col (col.name)}
					{@const s = statsByColumn[col.name]}
					{@const cd = chartDataByColumn[col.name]}
					{@const isLoaded = loadedColumns.has(col.name)}
					{#if !isLoaded && s}
						<ColumnCard
							column={col}
							stats={s}
							onLoad={handleLoadColumn}
							bulkLoading={bulkLoading}
						/>
					{:else if s && expandedColumn !== col.name}
						<ColumnTile
							column={col}
							stats={s}
							chartData={cd}
							expanded={pinnedColumns.has(col.name)}
							pinned={pinnedColumns.has(col.name)}
							{activeFilterColumn}
							onChartClick={handleChartClick}
							onTogglePin={togglePin}
							onAnalyze={analyzeColumn}
						/>
					{:else if s}
						<!-- Expanded view: a single full-width tile. -->
						<div class="col-span-full">
							<ColumnTile
								column={col}
								stats={s}
								chartData={cd}
								expanded={true}
								pinned={true}
								{activeFilterColumn}
								onChartClick={handleChartClick}
								onTogglePin={analyzeColumn}
								onAnalyze={analyzeColumn}
							/>
						</div>
					{/if}
				{/each}
			</div>
		{/if}
	</div>
</div>
