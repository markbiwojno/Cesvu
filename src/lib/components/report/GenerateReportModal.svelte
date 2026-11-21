<script lang="ts">
	/**
	 * GenerateReportModal.svelte — "Generate Report" popup.
	 *
	 * Step flow:
	 *   'type'    — pick a report type. Only "Summary report" is wired up;
	 *               "Batch documents" and "Data Review" are shown as visible,
	 *               disabled "Coming soon" cards (req. #8 — keeps the scaffold
	 *               ready for them without touching this step's structure).
	 *   'options' — Summary report: sheet/group-by/aggregation/sort/detail/
	 *               page-size controls.
	 *   'generating' — spinner while report-worker.ts builds the PDF.
	 *   'done'    — PDF downloaded; offer "Download again".
	 *   'error'   — show the error with a retry.
	 */
	import { untrack } from 'svelte';
	import Modal from '$lib/components/common/Modal.svelte';
	import { workspace } from '$lib/stores/workspace.svelte.js';
	import {
		generateReport,
		generateColumnVisualReport,
		generateCellCommentaryReport,
		generateDuplicationReport,
		type GenerateReportResult,
		type GenerateReportHandle,
		type GenerateColumnVisualResult,
		type GenerateColumnVisualHandle,
		type GenerateCellCommentaryResult,
		type GenerateCellCommentaryHandle,
		type GenerateDuplicationResult,
		type GenerateDuplicationHandle,
		type ReportProgress,
		type ColumnVisualInput
	} from '$lib/report/generate-report.js';
	import { defaultColumnAggregations, type AggregationChoice, type SortOption } from '$lib/report/summary-report.js';
	import type { ReportBuildRequest } from '$lib/report/report-worker.js';
	import {
		defaultChartType,
		availableChartTypes,
		CHART_DEFAULT_COLOR,
		type ReportChartType,
		type ReportCategorySort,
		type ColumnChartConfig
	} from '$lib/report/report-chart-specs.js';
	import { renderColumnCharts } from '$lib/report/column-chart-renderer.js';
	import { formatStatSummary } from '$lib/report/column-visual-report.js';
	import { computeColumnStats } from '$lib/pipeline/columnStats.js';
	import { notesStore } from '$lib/stores/notesStore.svelte.js';
	import {
		buildCellCommentaryRows,
		buildCellCommentarySection,
		sheetsWithCellNotes
	} from '$lib/report/cell-commentary-report.js';
	import type { DuplicationDetail } from '$lib/report/duplication-report.js';

	interface Props {
		onclose: () => void;
	}
	let { onclose }: Props = $props();

	type ReportType = 'summary' | 'column-visual' | 'cell-commentary' | 'duplication' | 'batch';
	type Phase =
		| 'type'
		| 'options'
		| 'column-visual-options'
		| 'cell-commentary-options'
		| 'duplication-options'
		| 'generating'
		| 'done'
		| 'error';

	let phase = $state<Phase>('type');
	let reportType = $state<ReportType>('summary');
	let error = $state('');

	// ── Data source (CSV = single implicit sheet; Excel = pick a tab) ───────
	const workbook = $derived(workspace.workbook);
	const isExcel = $derived(workspace.file?.type === 'excel');
	let selectedSheetName = $state<string | null>(null);
	$effect(() => {
		if (workbook && selectedSheetName === null) {
			selectedSheetName = workspace.activeSheet || workbook.sheets[0]?.name || null;
		}
	});
	const activeSheetProfile = $derived(
		workspace.workbookProfile?.sheets.find((s) => s.name === selectedSheetName) ?? null
	);
	const headers = $derived(
		workbook?.sheets.find((s) => s.name === selectedSheetName)?.headers ?? []
	);
	const numericHeaders = $derived(
		(activeSheetProfile?.columns ?? []).filter((c) => c.type === 'numeric').map((c) => c.name)
	);

	// ── Column Visual Analysis state ─────────────────────────────────────
	// Any column can be added fresh (not tied to the dashboard's "loaded"
	// set) and gets a fully independent chart config — more configuration
	// than the dashboard's fixed one-chart-type-per-column-type behavior.
	interface VisualColumnEntry {
		column: string;
		columnType: 'numeric' | 'categorical' | 'datetime' | 'text';
		chartType: ReportChartType;
		title: string;
		color: string;
		topN: number;
		sort: ReportCategorySort;
		binCount: number;
	}
	let visualColumns = $state<VisualColumnEntry[]>([]);
	let visualColumnToAdd = $state<string>('');

	const availableColumnsToAdd = $derived(
		(activeSheetProfile?.columns ?? []).filter(
			(c) => !visualColumns.some((v) => v.column === c.name)
		)
	);

	/** Shared default-config construction so addVisualColumn() and
	 *  addAllVisualColumns() never drift out of sync. */
	function makeVisualColumnEntry(profile: { name: string; type: VisualColumnEntry['columnType'] }): VisualColumnEntry {
		return {
			column: profile.name,
			columnType: profile.type,
			chartType: defaultChartType(profile.type),
			title: profile.name,
			color: CHART_DEFAULT_COLOR,
			topN: 10,
			sort: 'count-desc',
			binCount: 20
		};
	}

	function addVisualColumn(name: string) {
		const profile = activeSheetProfile?.columns.find((c) => c.name === name);
		if (!profile) return;
		visualColumns = [...visualColumns, makeVisualColumnEntry(profile)];
		visualColumnToAdd = '';
	}

	/** Add every column not already added, each with its own default chart
	 *  config (same defaults as adding one-by-one) — in a single state
	 *  update so the UI doesn't re-render once per column. */
	function addAllVisualColumns() {
		if (availableColumnsToAdd.length === 0) return;
		visualColumns = [...visualColumns, ...availableColumnsToAdd.map(makeVisualColumnEntry)];
		visualColumnToAdd = '';
	}

	function removeVisualColumn(name: string) {
		visualColumns = visualColumns.filter((v) => v.column !== name);
	}

	// ── Cell Commentary Report state ─────────────────────────────────────
	// Only cell-anchored notes qualify (prose notes have no sheet/column/row
	// to report). Column-level notes (rowIndex === -1) are included per
	// requirement. Sheet picker: 'all' or one specific sheet name.
	const cellNotes = $derived(notesStore.notes.filter((n) => n.anchor.kind === 'cell'));
	const hasCellNotes = $derived(cellNotes.length > 0);
	const cellNoteSheets = $derived(sheetsWithCellNotes(cellNotes));
	let cellCommentarySheetFilter = $state<string>('all');

	const cellCommentaryPreviewCount = $derived.by(() => {
		const filter = cellCommentarySheetFilter === 'all' ? null : cellCommentarySheetFilter;
		return cellNotes.filter((n) => filter === null || (n.anchor.kind === 'cell' && n.anchor.sheet === filter)).length;
	});

	// ── Data Duplication Report state ────────────────────────────────────
	// Key columns are selected via checkboxes (at least one required).
	// Case/whitespace normalization default ON. Detail defaults to compact
	// (key columns + row count + row numbers); "full row detail" expands
	// each group to show every column for every duplicated row.
	let duplicationKeyColumns = $state<Set<string>>(new Set());
	let duplicationCaseInsensitive = $state(true);
	let duplicationTrimWhitespace = $state(true);
	let duplicationDetail = $state<DuplicationDetail>('compact');

	function toggleDuplicationKeyColumn(name: string) {
		const next = new Set(duplicationKeyColumns);
		if (next.has(name)) next.delete(name);
		else next.add(name);
		duplicationKeyColumns = next;
	}

	/** Live preview over the already-loaded display buffer — same
	 *  instant-feedback pattern as groupCountPreview below. Re-parses
	 *  nothing; just enough to tell the user roughly what to expect before
	 *  they commit to the full (worker-side, original-bytes) build. */
	const duplicationPreview = $derived.by(() => {
		const sheet = workbook?.sheets.find((s) => s.name === selectedSheetName);
		const keyColumns = [...duplicationKeyColumns];
		if (!sheet || keyColumns.length === 0) return { groupCount: 0, rowCount: 0 };
		const normalize = (v: string) => {
			let s = v;
			if (duplicationTrimWhitespace) s = s.trim().replace(/\s+/g, ' ');
			if (duplicationCaseInsensitive) s = s.toLowerCase();
			return s;
		};
		const byKey = new Map<string, number>();
		for (const row of sheet.rows) {
			const key = keyColumns.map((c) => normalize(row[c] ?? '')).join('\u0001');
			byKey.set(key, (byKey.get(key) ?? 0) + 1);
		}
		let groupCount = 0;
		let rowCount = 0;
		for (const count of byKey.values()) {
			if (count > 1) {
				groupCount++;
				rowCount += count;
			}
		}
		return { groupCount, rowCount };
	});

	// ── Options state ────────────────────────────────────────────────────
	let groupByColumn = $state<string | null>(null);
	let aggregations = $state<Record<string, AggregationChoice>>({});
	$effect(() => {
		// Re-derive defaults whenever the numeric column SET changes (sheet
		// switch) — but only overwrite entries the user hasn't already set
		// for THIS sheet, so flipping a toggle doesn't get clobbered by this
		// effect re-running for unrelated reasons.
		//
		// IMPORTANT: reading `aggregations` here (even just to preserve the
		// user's existing choices) makes it a tracked dependency of this
		// effect — and the effect's own `aggregations = next` write at the
		// end then re-triggers it, forever (Svelte throws
		// effect_update_depth_exceeded once the re-run limit is hit, which is
		// what froze the tab). `untrack()` reads the CURRENT value without
		// subscribing to it, so this effect only re-runs when `numericHeaders`
		// itself changes, never because of its own write.
		const defaults = defaultColumnAggregations(numericHeaders);
		const next: Record<string, AggregationChoice> = {};
		const current = untrack(() => aggregations);
		for (const { column, aggregation } of defaults) {
			next[column] = current[column] ?? aggregation;
		}
		aggregations = next;
	});

	let sortBy = $state<'group-key' | 'row-count' | 'column-subtotal'>('group-key');
	let sortDirection = $state<'asc' | 'desc'>('asc');
	let sortColumn = $state<string | null>(null);
	let detail = $state<'summary' | 'summary-and-detail'>('summary-and-detail');
	let pageSize = $state<'Letter' | 'A4'>(
		/en-(us|ca)/i.test(typeof navigator !== 'undefined' ? navigator.language : 'en-US')
			? 'Letter'
			: 'A4'
	);

	const groupCountPreview = $derived.by(() => {
		if (!groupByColumn) return 1;
		const sheet = workbook?.sheets.find((s) => s.name === selectedSheetName);
		if (!sheet) return 0;
		return new Set(sheet.rows.map((r) => String(r[groupByColumn!] ?? '').trim() || '(blank)')).size;
	});
	const manyGroupsWarning = $derived(groupCountPreview > 500);

	function buildSortOption(): SortOption | null {
		if (sortBy === 'column-subtotal') {
			if (!sortColumn) return null;
			return { by: 'column-subtotal', column: sortColumn, direction: sortDirection };
		}
		return { by: sortBy, direction: sortDirection };
	}

	function sortDescription(): string {
		if (sortBy === 'group-key') return `Group key (${sortDirection})`;
		if (sortBy === 'row-count') return `Row count (${sortDirection})`;
		return `${sortColumn ?? '—'} subtotal (${sortDirection})`;
	}

	let result = $state<GenerateReportResult | null>(null);

	// ── Progress UI state (shown during the 'generating' phase) ────────────
	const STAGE_LABELS: Record<ReportProgress['stage'], string> = {
		reading: 'Reading file…',
		preparing: 'Preparing rows…',
		grouping: 'Grouping rows…',
		drawing: 'Drawing pages…',
		saving: 'Saving PDF…'
	};
	let progressStage = $state<ReportProgress['stage']>('reading');
	let progressProcessed = $state(0);
	let progressTotal = $state(0);
	const progressLabel = $derived(
		progressTotal > 0
			? `${STAGE_LABELS[progressStage]} (${progressProcessed.toLocaleString()} of ${progressTotal.toLocaleString()})`
			: STAGE_LABELS[progressStage]
	);
	const progressPercent = $derived(progressTotal > 0 ? Math.round((progressProcessed / progressTotal) * 100) : null);

	let activeHandle:
		| GenerateReportHandle
		| GenerateColumnVisualHandle
		| GenerateCellCommentaryHandle
		| GenerateDuplicationHandle
		| null = null;
	let visualResult = $state<GenerateColumnVisualResult | null>(null);

	async function generate() {
		if (!workbook || !selectedSheetName) return;
		const file = workspace.file;
		if (!file) return;

		progressStage = 'reading';
		progressProcessed = 0;
		progressTotal = 0;
		phase = 'generating';
		try {
			const request: ReportBuildRequest = {
				fileName: file.name,
				sourceType: isExcel ? 'excel' : 'csv',
				fileBytes: file.rawContent,
				sheetName: selectedSheetName,
				title: `${file.name} — Summary Report`,
				groupByColumn,
				columnAggregations: Object.entries(aggregations).map(([column, aggregation]) => ({
					column,
					aggregation
				})),
				sort: buildSortOption(),
				sortDescription: sortDescription(),
				detail,
				pageSize,
				generatedAtDisplay: new Date().toLocaleString()
			};
			const handle = generateReport(request, (progress) => {
				progressStage = progress.stage;
				progressProcessed = progress.processed;
				progressTotal = progress.total;
			});
			activeHandle = handle;
			result = await handle.promise;
			activeHandle = null;
			downloadPdf();
			phase = 'done';
		} catch (err) {
			activeHandle = null;
			// A user-initiated cancel also lands here (the worker is
			// terminated, which the browser surfaces as a rejection) — show
			// the options screen again rather than an error for that case.
			if (phase === 'generating') {
				error = err instanceof Error ? err.message : String(err);
				phase = 'error';
			}
		}
	}

	/** Rendering stage shown before the worker even starts (main-thread chart
	 *  rasterization) — distinct from the worker's own progress stages. */
	let renderingCharts = $state(false);
	let renderedCount = $state(0);
	let renderTotal = $state(0);

	async function generateColumnVisual() {
		const file = workspace.file;
		if (!file || visualColumns.length === 0) return;
		const sheet = workbook?.sheets.find((s) => s.name === selectedSheetName);
		if (!sheet) return;

		phase = 'generating';
		renderingCharts = true;
		renderedCount = 0;
		renderTotal = visualColumns.length;
		try {
			const configs: ColumnChartConfig[] = visualColumns.map((v) => ({
				column: v.column,
				columnType: v.columnType,
				chartType: v.chartType,
				title: v.title,
				color: v.color,
				topN: v.topN,
				sort: v.sort,
				binCount: v.binCount
			}));
			const rendered = await renderColumnCharts(sheet.rows, configs, (n, total) => {
				renderedCount = n;
				renderTotal = total;
			});
			renderingCharts = false;

			const columns: ColumnVisualInput[] = rendered.map((r) => {
				const entry = visualColumns.find((v) => v.column === r.column)!;
				const stats = computeColumnStats(entry.column, sheet.rows, entry.columnType, 'full');
				return {
					column: r.column,
					title: entry.title,
					chartPng: r.pngBytes,
					chartWidth: r.width,
					chartHeight: r.height,
					statSummary: formatStatSummary(stats)
				};
			});

			progressStage = 'reading';
			progressProcessed = 0;
			progressTotal = 0;
			const handle = generateColumnVisualReport(
				{
					fileName: file.name,
					title: `${file.name} — Column Visual Analysis`,
					pageSize,
					generatedAtDisplay: new Date().toLocaleString(),
					fileBytes: file.rawContent,
					columns
				},
				(progress) => {
					progressStage = progress.stage;
					progressProcessed = progress.processed;
					progressTotal = progress.total;
				}
			);
			activeHandle = handle;
			visualResult = await handle.promise;
			activeHandle = null;
			downloadPdf();
			phase = 'done';
		} catch (err) {
			activeHandle = null;
			renderingCharts = false;
			if (phase === 'generating') {
				error = err instanceof Error ? err.message : String(err);
				phase = 'error';
			}
		}
	}

	let cellCommentaryResult = $state<GenerateCellCommentaryResult | null>(null);

	async function generateCellCommentary() {
		const file = workspace.file;
		if (!file || !hasCellNotes) return;

		phase = 'generating';
		progressStage = 'reading';
		progressProcessed = 0;
		progressTotal = 0;
		try {
			const filter = cellCommentarySheetFilter === 'all' ? null : cellCommentarySheetFilter;
			const rows = buildCellCommentaryRows(cellNotes, workbook?.sheets ?? [], filter);
			const section = buildCellCommentarySection(rows);

			const handle = generateCellCommentaryReport(
				{
					fileName: file.name,
					title: `${file.name} — Your Cell Commentary Report`,
					pageSize,
					generatedAtDisplay: new Date().toLocaleString(),
					fileBytes: file.rawContent,
					section
				},
				(progress) => {
					progressStage = progress.stage;
					progressProcessed = progress.processed;
					progressTotal = progress.total;
				}
			);
			activeHandle = handle;
			cellCommentaryResult = await handle.promise;
			activeHandle = null;
			downloadPdf();
			phase = 'done';
		} catch (err) {
			activeHandle = null;
			if (phase === 'generating') {
				error = err instanceof Error ? err.message : String(err);
				phase = 'error';
			}
		}
	}

	let duplicationResult = $state<GenerateDuplicationResult | null>(null);

	async function generateDuplication() {
		const file = workspace.file;
		if (!file || !selectedSheetName || duplicationKeyColumns.size === 0) return;

		phase = 'generating';
		progressStage = 'reading';
		progressProcessed = 0;
		progressTotal = 0;
		try {
			const handle = generateDuplicationReport(
				{
					fileName: file.name,
					sourceType: isExcel ? 'excel' : 'csv',
					fileBytes: file.rawContent,
					sheetName: selectedSheetName,
					title: `${file.name} — Data Duplication Report`,
					keyColumns: [...duplicationKeyColumns],
					caseInsensitive: duplicationCaseInsensitive,
					trimWhitespace: duplicationTrimWhitespace,
					detail: duplicationDetail,
					pageSize,
					generatedAtDisplay: new Date().toLocaleString()
				},
				(progress) => {
					progressStage = progress.stage;
					progressProcessed = progress.processed;
					progressTotal = progress.total;
				}
			);
			activeHandle = handle;
			duplicationResult = await handle.promise;
			activeHandle = null;
			downloadPdf();
			phase = 'done';
		} catch (err) {
			activeHandle = null;
			if (phase === 'generating') {
				error = err instanceof Error ? err.message : String(err);
				phase = 'error';
			}
		}
	}

	function cancelGenerate() {
		activeHandle?.cancel();
		activeHandle = null;
		renderingCharts = false;
		phase =
			reportType === 'column-visual'
				? 'column-visual-options'
				: reportType === 'cell-commentary'
					? 'cell-commentary-options'
					: reportType === 'duplication'
						? 'duplication-options'
						: 'options';
	}

	function downloadPdf() {
		const bytes =
			reportType === 'column-visual'
				? visualResult?.pdfBytes
				: reportType === 'cell-commentary'
					? cellCommentaryResult?.pdfBytes
					: reportType === 'duplication'
						? duplicationResult?.pdfBytes
						: result?.pdfBytes;
		if (!bytes) return;
		const suffix =
			reportType === 'column-visual'
				? 'column-visual-analysis'
				: reportType === 'cell-commentary'
					? 'cell-commentary-report'
					: reportType === 'duplication'
						? 'data-duplication-report'
						: 'summary-report';
		const blob = new Blob([bytes as BlobPart], { type: 'application/pdf' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `${(workspace.file?.name ?? 'report').replace(/\.[^.]+$/, '')}-${suffix}.pdf`;
		document.body.appendChild(a);
		a.click();
		a.remove();
		setTimeout(() => URL.revokeObjectURL(url), 1000);
	}

	function isDismissiblePhase(p: Phase): boolean {
		return p !== 'generating';
	}
</script>

<Modal open={true} title="Generate Report" onclose={isDismissiblePhase(phase) ? onclose : undefined} dismissible={isDismissiblePhase(phase)}>
	{#if phase === 'type'}
		<div class="space-y-3">
			<p class="text-sm text-gray-600 dark:text-gray-400">Choose what kind of report to generate.</p>

			<button
				type="button"
				onclick={() => { reportType = 'column-visual'; phase = 'column-visual-options'; }}
				class="w-full text-left p-4 rounded-xl border border-blue-300 dark:border-blue-700 bg-blue-50 dark:bg-blue-950/30 hover:bg-blue-100 dark:hover:bg-blue-900/40 transition-colors"
			>
				<div class="font-semibold text-sm text-gray-900 dark:text-white">Column Visual Analysis</div>
				<p class="text-xs text-gray-600 dark:text-gray-400 mt-1">
					Pick any columns and customize each chart — bar, pie, histogram, or
					timeline — then export a compact PDF (3 charts per page).
				</p>
			</button>

			<button
				type="button"
				onclick={() => { reportType = 'summary'; phase = 'options'; }}
				class="w-full text-left p-4 rounded-xl border border-blue-300 dark:border-blue-700 bg-blue-50 dark:bg-blue-950/30 hover:bg-blue-100 dark:hover:bg-blue-900/40 transition-colors"
			>
				<div class="font-semibold text-sm text-gray-900 dark:text-white">Summary report</div>
				<p class="text-xs text-gray-600 dark:text-gray-400 mt-1">
					Group rows by a column, add subtotals and a grand total, and get a KPI
					header with page-by-page tables.
				</p>
			</button>

			{#if hasCellNotes}
				<button
					type="button"
					onclick={() => { reportType = 'cell-commentary'; phase = 'cell-commentary-options'; }}
					class="w-full text-left p-4 rounded-xl border border-blue-300 dark:border-blue-700 bg-blue-50 dark:bg-blue-950/30 hover:bg-blue-100 dark:hover:bg-blue-900/40 transition-colors"
				>
					<div class="font-semibold text-sm text-gray-900 dark:text-white">Your Cell Commentary Report</div>
					<p class="text-xs text-gray-600 dark:text-gray-400 mt-1">
						Every cell-anchored note you've left — note content, cell content, and row
						number — newest first.
					</p>
				</button>
			{:else}
				<div class="w-full text-left p-4 rounded-xl border border-gray-200 dark:border-slate-800 opacity-60 cursor-not-allowed">
					<div class="flex items-center gap-2">
						<span class="font-semibold text-sm text-gray-700 dark:text-gray-300">Your Cell Commentary Report</span>
					</div>
					<p class="text-xs text-gray-500 dark:text-gray-500 mt-1">
						Right-click a cell and "Add note" to unlock this report.
					</p>
				</div>
			{/if}

			<div class="w-full text-left p-4 rounded-xl border border-gray-200 dark:border-slate-800 opacity-60 cursor-not-allowed">
				<div class="flex items-center gap-2">
					<span class="font-semibold text-sm text-gray-700 dark:text-gray-300">Batch documents</span>
					<span class="px-1.5 py-0.5 rounded text-[10px] font-medium bg-gray-200 text-gray-600 dark:bg-slate-800 dark:text-gray-400">Coming soon</span>
				</div>
				<p class="text-xs text-gray-500 dark:text-gray-500 mt-1">One PDF per row or group — invoices, statements, pay stubs.</p>
			</div>

			<button
				type="button"
				onclick={() => { reportType = 'duplication'; phase = 'duplication-options'; }}
				class="w-full text-left p-4 rounded-xl border border-blue-300 dark:border-blue-700 bg-blue-50 dark:bg-blue-950/30 hover:bg-blue-100 dark:hover:bg-blue-900/40 transition-colors"
			>
				<div class="font-semibold text-sm text-gray-900 dark:text-white">Data Duplication Report</div>
				<p class="text-xs text-gray-600 dark:text-gray-400 mt-1">
					Pick one or more columns to match on and find rows that are duplicates
					of each other.
				</p>
			</button>
		</div>
	{:else if phase === 'column-visual-options'}
		<div class="space-y-4">
			{#if isExcel && workbook && workbook.sheets.length > 1}
				<label class="block">
					<span class="text-xs font-medium text-gray-700 dark:text-gray-300">Sheet</span>
					<select bind:value={selectedSheetName} class="mt-1 w-full rounded-lg border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm px-2 py-1.5">
						{#each workbook.sheets as s (s.name)}
							<option value={s.name}>{s.name}</option>
						{/each}
					</select>
				</label>
			{/if}

			<div class="flex items-end gap-2">
				<label class="flex-1 block">
					<span class="text-xs font-medium text-gray-700 dark:text-gray-300">Add a column</span>
					<select
						bind:value={visualColumnToAdd}
						onchange={() => visualColumnToAdd && addVisualColumn(visualColumnToAdd)}
						disabled={availableColumnsToAdd.length === 0}
						class="mt-1 w-full rounded-lg border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm px-2 py-1.5 disabled:opacity-50"
					>
						<option value="">Choose a column…</option>
						{#each availableColumnsToAdd as c (c.name)}
							<option value={c.name}>{c.name} ({c.type})</option>
						{/each}
					</select>
				</label>
				<button
					type="button"
					onclick={addAllVisualColumns}
					disabled={availableColumnsToAdd.length === 0}
					class="rounded-lg border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-1.5 text-xs font-medium text-gray-700 dark:text-gray-200 transition-colors hover:bg-gray-100 dark:hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
				>
					Add all columns{availableColumnsToAdd.length > 0 ? ` (${availableColumnsToAdd.length})` : ''}
				</button>
			</div>

			{#if visualColumns.length === 0}
				<p class="text-xs text-gray-500 dark:text-gray-400">
					No columns added yet. Pick one above to configure its chart.
				</p>
			{/if}

			{#each visualColumns as entry (entry.column)}
				<div class="rounded-xl border border-gray-200 dark:border-slate-800 p-3 space-y-2">
					<div class="flex items-center justify-between gap-2">
						<span class="font-semibold text-sm text-gray-900 dark:text-white">{entry.column}</span>
						<button
							type="button"
							onclick={() => removeVisualColumn(entry.column)}
							class="text-xs text-red-500 hover:text-red-600 dark:text-red-400 dark:hover:text-red-300"
						>
							Remove
						</button>
					</div>

					<label class="block">
						<span class="text-[11px] font-medium text-gray-600 dark:text-gray-400">Chart title</span>
						<input
							type="text"
							bind:value={entry.title}
							class="mt-0.5 w-full rounded-lg border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs px-2 py-1"
						/>
					</label>

					<div class="grid grid-cols-2 gap-2">
						<label class="block">
							<span class="text-[11px] font-medium text-gray-600 dark:text-gray-400">Chart type</span>
							<select bind:value={entry.chartType} class="mt-0.5 w-full rounded-lg border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs px-2 py-1">
								{#each availableChartTypes(entry.columnType) as t (t)}
									<option value={t}>{t}</option>
								{/each}
							</select>
						</label>
						<label class="block">
							<span class="text-[11px] font-medium text-gray-600 dark:text-gray-400">Color</span>
							<input type="color" bind:value={entry.color} class="mt-0.5 w-full h-7 rounded-lg border border-gray-300 dark:border-slate-700" />
						</label>
					</div>

					{#if entry.columnType === 'numeric'}
						<label class="block">
							<span class="text-[11px] font-medium text-gray-600 dark:text-gray-400">Bin count ({entry.binCount})</span>
							<input type="range" min="5" max="50" bind:value={entry.binCount} class="mt-0.5 w-full" />
						</label>
					{:else if entry.columnType === 'categorical' || entry.columnType === 'text'}
						<div class="grid grid-cols-2 gap-2">
							<label class="block">
								<span class="text-[11px] font-medium text-gray-600 dark:text-gray-400">Top N ({entry.topN})</span>
								<input type="range" min="3" max="25" bind:value={entry.topN} class="mt-0.5 w-full" />
							</label>
							<label class="block">
								<span class="text-[11px] font-medium text-gray-600 dark:text-gray-400">Sort</span>
								<select bind:value={entry.sort} class="mt-0.5 w-full rounded-lg border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs px-2 py-1">
									<option value="count-desc">By count</option>
									<option value="alpha-asc">Alphabetical</option>
								</select>
							</label>
						</div>
					{/if}
				</div>
			{/each}

			<label class="block">
				<span class="text-xs font-medium text-gray-700 dark:text-gray-300">Page size</span>
				<select bind:value={pageSize} class="mt-1 w-full rounded-lg border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm px-2 py-1.5">
					<option value="Letter">Letter</option>
					<option value="A4">A4</option>
				</select>
			</label>
		</div>
	{:else if phase === 'cell-commentary-options'}
		<div class="space-y-4">
			{#if cellNoteSheets.length > 1}
				<label class="block">
					<span class="text-xs font-medium text-gray-700 dark:text-gray-300">Sheet</span>
					<select bind:value={cellCommentarySheetFilter} class="mt-1 w-full rounded-lg border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm px-2 py-1.5">
						<option value="all">All sheets</option>
						{#each cellNoteSheets as s (s)}
							<option value={s}>{s}</option>
						{/each}
					</select>
				</label>
			{/if}

			<p class="text-sm text-gray-600 dark:text-gray-400">
				{cellCommentaryPreviewCount.toLocaleString()} note{cellCommentaryPreviewCount === 1 ? '' : 's'}
				will be included, newest first.
			</p>

			<label class="block">
				<span class="text-xs font-medium text-gray-700 dark:text-gray-300">Page size</span>
				<select bind:value={pageSize} class="mt-1 w-full rounded-lg border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm px-2 py-1.5">
					<option value="Letter">Letter</option>
					<option value="A4">A4</option>
				</select>
			</label>
		</div>
	{:else if phase === 'duplication-options'}
		<div class="space-y-4">
			{#if isExcel && workbook && workbook.sheets.length > 1}
				<label class="block">
					<span class="text-xs font-medium text-gray-700 dark:text-gray-300">Sheet</span>
					<select bind:value={selectedSheetName} class="mt-1 w-full rounded-lg border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm px-2 py-1.5">
						{#each workbook.sheets as s (s.name)}
							<option value={s.name}>{s.name}</option>
						{/each}
					</select>
				</label>
			{/if}

			<div>
				<span class="text-xs font-medium text-gray-700 dark:text-gray-300">Match on these columns</span>
				<div class="mt-1 space-y-1 max-h-40 overflow-y-auto rounded-lg border border-gray-200 dark:border-slate-800 p-2">
					{#each headers as h (h)}
						<label class="flex items-center gap-2 text-xs text-gray-700 dark:text-gray-300">
							<input
								type="checkbox"
								checked={duplicationKeyColumns.has(h)}
								onchange={() => toggleDuplicationKeyColumn(h)}
								class="rounded border-gray-300 dark:border-slate-700"
							/>
							<span class="truncate" title={h}>{h}</span>
						</label>
					{/each}
				</div>
				{#if duplicationKeyColumns.size === 0}
					<p class="text-xs text-amber-600 dark:text-amber-400 mt-1">Select at least one column.</p>
				{/if}
			</div>

			<div class="flex gap-4">
				<label class="flex items-center gap-2 text-xs text-gray-700 dark:text-gray-300">
					<input type="checkbox" bind:checked={duplicationCaseInsensitive} class="rounded border-gray-300 dark:border-slate-700" />
					Ignore case
				</label>
				<label class="flex items-center gap-2 text-xs text-gray-700 dark:text-gray-300">
					<input type="checkbox" bind:checked={duplicationTrimWhitespace} class="rounded border-gray-300 dark:border-slate-700" />
					Ignore extra whitespace
				</label>
			</div>

			<label class="block">
				<span class="text-xs font-medium text-gray-700 dark:text-gray-300">Report detail</span>
				<select bind:value={duplicationDetail} class="mt-1 w-full rounded-lg border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm px-2 py-1.5">
					<option value="compact">Compact (key columns + row numbers)</option>
					<option value="full">Full row detail (every column for every duplicated row)</option>
				</select>
			</label>

			{#if duplicationKeyColumns.size > 0}
				<p class="text-sm text-gray-600 dark:text-gray-400">
					{duplicationPreview.groupCount.toLocaleString()} duplicate group{duplicationPreview.groupCount === 1 ? '' : 's'}
					found ({duplicationPreview.rowCount.toLocaleString()} row{duplicationPreview.rowCount === 1 ? '' : 's'} total).
				</p>
			{/if}

			<label class="block">
				<span class="text-xs font-medium text-gray-700 dark:text-gray-300">Page size</span>
				<select bind:value={pageSize} class="mt-1 w-full rounded-lg border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm px-2 py-1.5">
					<option value="Letter">Letter</option>
					<option value="A4">A4</option>
				</select>
			</label>
		</div>

	{:else if phase === 'options'}
		<div class="space-y-4">
			{#if isExcel && workbook && workbook.sheets.length > 1}
				<label class="block">
					<span class="text-xs font-medium text-gray-700 dark:text-gray-300">Sheet</span>
					<select bind:value={selectedSheetName} class="mt-1 w-full rounded-lg border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm px-2 py-1.5">
						{#each workbook.sheets as s (s.name)}
							<option value={s.name}>{s.name}</option>
						{/each}
					</select>
				</label>
			{/if}

			<label class="block">
				<span class="text-xs font-medium text-gray-700 dark:text-gray-300">Group by</span>
				<select bind:value={groupByColumn} class="mt-1 w-full rounded-lg border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm px-2 py-1.5">
					<option value={null}>No grouping (all rows in one group)</option>
					{#each headers as h (h)}
						<option value={h}>{h}</option>
					{/each}
				</select>
			</label>

			{#if manyGroupsWarning}
				<p class="text-xs text-amber-600 dark:text-amber-400">
					⚠ This would create {groupCountPreview.toLocaleString()} groups, which is a lot — consider a different column.
				</p>
			{/if}

			{#if numericHeaders.length > 0}
				<div>
					<span class="text-xs font-medium text-gray-700 dark:text-gray-300">Column aggregation</span>
					<div class="mt-1 space-y-1 max-h-40 overflow-y-auto rounded-lg border border-gray-200 dark:border-slate-800 p-2">
						{#each numericHeaders as h (h)}
							<div class="flex items-center justify-between gap-2 text-xs">
								<span class="truncate text-gray-700 dark:text-gray-300" title={h}>{h}</span>
								<select bind:value={aggregations[h]} class="rounded border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs px-1 py-0.5">
									<option value="sum">Sum</option>
									<option value="average">Average</option>
									<option value="none">None</option>
								</select>
							</div>
						{/each}
					</div>
				</div>
			{/if}

			<div class="flex gap-2">
				<label class="flex-1 block">
					<span class="text-xs font-medium text-gray-700 dark:text-gray-300">Sort</span>
					<select bind:value={sortBy} class="mt-1 w-full rounded-lg border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm px-2 py-1.5">
						<option value="group-key">Group name</option>
						<option value="row-count">Row count</option>
						<option value="column-subtotal">Column subtotal</option>
					</select>
				</label>
				{#if sortBy === 'column-subtotal'}
					<label class="flex-1 block">
						<span class="text-xs font-medium text-gray-700 dark:text-gray-300">Column</span>
						<select bind:value={sortColumn} class="mt-1 w-full rounded-lg border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm px-2 py-1.5">
							{#each numericHeaders as h (h)}
								<option value={h}>{h}</option>
							{/each}
						</select>
					</label>
				{/if}
				<label class="flex-1 block">
					<span class="text-xs font-medium text-gray-700 dark:text-gray-300">Direction</span>
					<select bind:value={sortDirection} class="mt-1 w-full rounded-lg border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm px-2 py-1.5">
						<option value="asc">Ascending</option>
						<option value="desc">Descending</option>
					</select>
				</label>
			</div>

			<div class="flex gap-2">
				<label class="flex-1 block">
					<span class="text-xs font-medium text-gray-700 dark:text-gray-300">Detail</span>
					<select bind:value={detail} class="mt-1 w-full rounded-lg border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm px-2 py-1.5">
						<option value="summary-and-detail">Summary + detail</option>
						<option value="summary">Summary only</option>
					</select>
				</label>
				<label class="flex-1 block">
					<span class="text-xs font-medium text-gray-700 dark:text-gray-300">Page size</span>
					<select bind:value={pageSize} class="mt-1 w-full rounded-lg border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm px-2 py-1.5">
						<option value="Letter">Letter</option>
						<option value="A4">A4</option>
					</select>
				</label>
		</div>

			</div>
	{:else if phase === 'generating'}
		<div class="flex flex-col items-center justify-center gap-4 py-10 text-center">
			<div class="h-8 w-8 animate-spin rounded-full border-2 border-gray-200 dark:border-slate-700 border-t-blue-500"></div>
			{#if renderingCharts}
				<p class="text-sm text-gray-500 dark:text-gray-400">
					Rendering chart {renderedCount} of {renderTotal}…
				</p>
				<div class="w-full max-w-xs h-1.5 rounded-full bg-gray-200 dark:bg-slate-800 overflow-hidden">
					<div
						class="h-full rounded-full bg-blue-500 transition-[width] duration-150"
						style={`width: ${renderTotal > 0 ? Math.round((renderedCount / renderTotal) * 100) : 0}%`}
					></div>
				</div>
			{:else}
				<p class="text-sm text-gray-500 dark:text-gray-400">{progressLabel}</p>
				{#if progressPercent !== null}
					<div class="w-full max-w-xs h-1.5 rounded-full bg-gray-200 dark:bg-slate-800 overflow-hidden">
						<div
							class="h-full rounded-full bg-blue-500 transition-[width] duration-150"
							style={`width: ${progressPercent}%`}
						></div>
					</div>
				{/if}
			{/if}
			<p class="text-xs text-gray-400 dark:text-gray-500">Large sheets can take several seconds to build.</p>
			<button
				onclick={cancelGenerate}
				class="rounded-lg px-3 py-1.5 text-xs font-medium text-gray-500 transition-colors hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200"
			>
				Cancel
			</button>
		</div>
	{:else if phase === 'error'}
		<div class="space-y-4 py-4">
			<p class="text-sm text-red-600 dark:text-red-300">{error}</p>
			<button
				onclick={
					reportType === 'column-visual'
						? generateColumnVisual
						: reportType === 'cell-commentary'
							? generateCellCommentary
							: reportType === 'duplication'
								? generateDuplication
								: generate
				}
				class="rounded-lg bg-gray-100 px-3 py-1.5 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-200 dark:bg-slate-800 dark:text-gray-200 dark:hover:bg-slate-700"
			>
				Try again
			</button>
		</div>
	{:else if phase === 'done'}
		<div class="flex flex-col items-center justify-center gap-3 py-8 text-center">
			<div class="flex h-12 w-12 items-center justify-center rounded-full bg-green-100 dark:bg-green-900/40 text-2xl">✓</div>
			<p class="text-sm font-medium text-gray-900 dark:text-white">Your report is downloading.</p>
			{#if duplicationResult && reportType === 'duplication'}
				<p class="text-xs text-gray-500 dark:text-gray-400 max-w-sm">
					{duplicationResult.groupCount.toLocaleString()} duplicate group{duplicationResult.groupCount === 1 ? '' : 's'}
					({duplicationResult.duplicateRowCount.toLocaleString()} row{duplicationResult.duplicateRowCount === 1 ? '' : 's'}).
				</p>
			{/if}
			{#if result && reportType !== 'column-visual' && reportType !== 'cell-commentary' && reportType !== 'duplication' && result.replacedCharacterCount > 0}
				<p class="text-xs text-amber-600 dark:text-amber-400 max-w-sm">
					{result.replacedCharacterCount.toLocaleString()} character(s) could not be displayed and were replaced
					with "?" — likely a non-Latin script (e.g. Japanese, Arabic) this report doesn't yet support.
				</p>
			{/if}
			{#if visualResult && reportType === 'column-visual' && visualResult.replacedCharacterCount > 0}
				<p class="text-xs text-amber-600 dark:text-amber-400 max-w-sm">
					{visualResult.replacedCharacterCount.toLocaleString()} character(s) could not be displayed and were replaced
					with "?" — likely a non-Latin script this report doesn't yet support.
				</p>
			{/if}
			{#if cellCommentaryResult && reportType === 'cell-commentary' && cellCommentaryResult.replacedCharacterCount > 0}
				<p class="text-xs text-amber-600 dark:text-amber-400 max-w-sm">
					{cellCommentaryResult.replacedCharacterCount.toLocaleString()} character(s) could not be displayed and were
					replaced with "?" — likely a non-Latin script this report doesn't yet support.
				</p>
			{/if}
			{#if duplicationResult && reportType === 'duplication' && duplicationResult.replacedCharacterCount > 0}
				<p class="text-xs text-amber-600 dark:text-amber-400 max-w-sm">
					{duplicationResult.replacedCharacterCount.toLocaleString()} character(s) could not be displayed and were
					replaced with "?" — likely a non-Latin script this report doesn't yet support.
				</p>
			{/if}
			{#if result && reportType !== 'column-visual' && reportType !== 'cell-commentary' && reportType !== 'duplication'}
				{#each result.warnings as w (w)}
					<p class="text-xs text-gray-500 dark:text-gray-400 max-w-sm">⚠ {w}</p>
				{/each}
			{/if}
		</div>
	{/if}

	{#snippet footer()}
		{#if phase === 'column-visual-options'}
			<div class="flex justify-between gap-2">
				<button onclick={() => (phase = 'type')} class="rounded-lg px-3 py-1.5 text-xs font-medium text-gray-500 transition-colors hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200">
					Back
				</button>
				<button
					onclick={generateColumnVisual}
					disabled={visualColumns.length === 0}
					class="rounded-lg bg-green-600 px-4 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-green-500 disabled:opacity-50 disabled:cursor-not-allowed"
				>
					Generate
				</button>
			</div>
		{:else if phase === 'cell-commentary-options'}
			<div class="flex justify-between gap-2">
				<button onclick={() => (phase = 'type')} class="rounded-lg px-3 py-1.5 text-xs font-medium text-gray-500 transition-colors hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200">
					Back
				</button>
				<button
					onclick={generateCellCommentary}
					disabled={cellCommentaryPreviewCount === 0}
					class="rounded-lg bg-green-600 px-4 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-green-500 disabled:opacity-50 disabled:cursor-not-allowed"
				>
					Generate
				</button>
			</div>
		{:else if phase === 'duplication-options'}
			<div class="flex justify-between gap-2">
				<button onclick={() => (phase = 'type')} class="rounded-lg px-3 py-1.5 text-xs font-medium text-gray-500 transition-colors hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200">
					Back
				</button>
				<button
					onclick={generateDuplication}
					disabled={duplicationKeyColumns.size === 0}
					class="rounded-lg bg-green-600 px-4 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-green-500 disabled:opacity-50 disabled:cursor-not-allowed"
				>
					Generate
				</button>
			</div>
		{:else if phase === 'options'}
			<div class="flex justify-between gap-2">
				<button onclick={() => (phase = 'type')} class="rounded-lg px-3 py-1.5 text-xs font-medium text-gray-500 transition-colors hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200">
					Back
				</button>
				<button onclick={generate} class="rounded-lg bg-green-600 px-4 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-green-500">
					Generate
				</button>
			</div>
		{:else if phase === 'done'}
			<div class="flex justify-end gap-2">
				<button onclick={downloadPdf} class="rounded-lg px-3 py-1.5 text-xs font-medium text-gray-500 transition-colors hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200">
					Download again
				</button>
				<button onclick={onclose} class="rounded-lg bg-blue-700 px-4 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-blue-600">
					Done
				</button>
			</div>
		{/if}
	{/snippet}
</Modal>
