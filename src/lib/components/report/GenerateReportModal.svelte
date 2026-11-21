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
		type GenerateReportResult,
		type GenerateReportHandle,
		type ReportProgress
	} from '$lib/report/generate-report.js';
	import { defaultColumnAggregations, type AggregationChoice, type SortOption } from '$lib/report/summary-report.js';
	import type { ReportBuildRequest } from '$lib/report/report-worker.js';

	interface Props {
		onclose: () => void;
	}
	let { onclose }: Props = $props();

	type ReportType = 'summary' | 'batch' | 'data-review';
	type Phase = 'type' | 'options' | 'generating' | 'done' | 'error';

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

	let result: GenerateReportResult | null = null;

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

	let activeHandle: GenerateReportHandle | null = null;

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
			activeHandle = generateReport(request, (progress) => {
				progressStage = progress.stage;
				progressProcessed = progress.processed;
				progressTotal = progress.total;
			});
			result = await activeHandle.promise;
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

	function cancelGenerate() {
		activeHandle?.cancel();
		activeHandle = null;
		phase = 'options';
	}

	function downloadPdf() {
		if (!result) return;
		const blob = new Blob([result.pdfBytes as BlobPart], { type: 'application/pdf' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `${(workspace.file?.name ?? 'report').replace(/\.[^.]+$/, '')}-summary-report.pdf`;
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
				onclick={() => { reportType = 'summary'; phase = 'options'; }}
				class="w-full text-left p-4 rounded-xl border border-blue-300 dark:border-blue-700 bg-blue-50 dark:bg-blue-950/30 hover:bg-blue-100 dark:hover:bg-blue-900/40 transition-colors"
			>
				<div class="font-semibold text-sm text-gray-900 dark:text-white">Summary report</div>
				<p class="text-xs text-gray-600 dark:text-gray-400 mt-1">
					Group rows by a column, add subtotals and a grand total, and get a KPI
					header with page-by-page tables.
				</p>
			</button>

			<div class="w-full text-left p-4 rounded-xl border border-gray-200 dark:border-slate-800 opacity-60 cursor-not-allowed">
				<div class="flex items-center gap-2">
					<span class="font-semibold text-sm text-gray-700 dark:text-gray-300">Batch documents</span>
					<span class="px-1.5 py-0.5 rounded text-[10px] font-medium bg-gray-200 text-gray-600 dark:bg-slate-800 dark:text-gray-400">Coming soon</span>
				</div>
				<p class="text-xs text-gray-500 dark:text-gray-500 mt-1">One PDF per row or group — invoices, statements, pay stubs.</p>
			</div>

			<div class="w-full text-left p-4 rounded-xl border border-gray-200 dark:border-slate-800 opacity-60 cursor-not-allowed">
				<div class="flex items-center gap-2">
					<span class="font-semibold text-sm text-gray-700 dark:text-gray-300">Data Review</span>
					<span class="px-1.5 py-0.5 rounded text-[10px] font-medium bg-gray-200 text-gray-600 dark:bg-slate-800 dark:text-gray-400">Coming soon</span>
				</div>
				<p class="text-xs text-gray-500 dark:text-gray-500 mt-1">Duplicates, outliers, and rule-based flags.</p>
			</div>
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
			<p class="text-sm text-gray-500 dark:text-gray-400">{progressLabel}</p>
			{#if progressPercent !== null}
				<div class="w-full max-w-xs h-1.5 rounded-full bg-gray-200 dark:bg-slate-800 overflow-hidden">
					<div
						class="h-full rounded-full bg-blue-500 transition-[width] duration-150"
						style={`width: ${progressPercent}%`}
					></div>
				</div>
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
			<button onclick={generate} class="rounded-lg bg-gray-100 px-3 py-1.5 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-200 dark:bg-slate-800 dark:text-gray-200 dark:hover:bg-slate-700">
				Try again
			</button>
		</div>
	{:else if phase === 'done'}
		<div class="flex flex-col items-center justify-center gap-3 py-8 text-center">
			<div class="flex h-12 w-12 items-center justify-center rounded-full bg-green-100 dark:bg-green-900/40 text-2xl">✓</div>
			<p class="text-sm font-medium text-gray-900 dark:text-white">Your report is downloading.</p>
			{#if result && result.replacedCharacterCount > 0}
				<p class="text-xs text-amber-600 dark:text-amber-400 max-w-sm">
					{result.replacedCharacterCount.toLocaleString()} character(s) could not be displayed and were replaced
					with "?" — likely a non-Latin script (e.g. Japanese, Arabic) this report doesn't yet support.
				</p>
			{/if}
			{#if result}
				{#each result.warnings as w (w)}
					<p class="text-xs text-gray-500 dark:text-gray-400 max-w-sm">⚠ {w}</p>
				{/each}
			{/if}
		</div>
	{/if}

	{#snippet footer()}
		{#if phase === 'options'}
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
