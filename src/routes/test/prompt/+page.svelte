<script lang="ts">
	/**
	 * /test/prompt — exercises the multi-sheet operation-prompt changes:
	 *   - buildOperationPrompt(WorkbookProfile, …)
	 *   - formatSummaryForPrompt() → buildCompressedSummary()
	 *   - CSV_OPERATION_SYSTEM_PROMPT multi-sheet instructions + crossSheet op
	 *
	 * Pure, synchronous, no model load. Renders the generated prompts so you can
	 * eyeball that single-sheet output has NO "Sheet:" prefix and multi-sheet
	 * output does.
	 */
	import { buildOperationPrompt, formatSummaryForPrompt } from '$lib/pipeline/operationPrompt.js';
	import { profileWorkbook } from '$lib/pipeline/pipeline.js';
	import type { Workbook } from '$lib/data/workbook.js';

	type Check = { name: string; pass: boolean; detail: string };

	// ── Fixtures ───────────────────────────────────────────────────────────────
	const singleSheetWb: Workbook = {
		fileName: 'sales.csv',
		activeSheet: 'sales.csv',
		sheets: [
			{

				name: 'sales.csv',
				headers: ['Region', 'Revenue'],
				rows: [
					{ Region: 'West', Revenue: '100' },
					{ Region: 'East', Revenue: '200' },
					{ Region: 'West', Revenue: '150' }
				],
				rowCount: 3
			}
		]
	};

	const multiSheetWb: Workbook = {
		fileName: 'company.xlsx',
		activeSheet: 'Marketing',
		sheets: [

			{
				name: 'Marketing',
				headers: ['Month', 'Spend'],
				rows: [
					{ Month: '2024-01', Spend: '500' },
					{ Month: '2024-02', Spend: '700' }
				],
				rowCount: 2
			},
			{
				name: 'Revenue',
				headers: ['Month', 'Amount'],
				rows: [
					{ Month: '2024-01', Amount: '1200' },
					{ Month: '2024-02', Amount: '1800' }
				],
				rowCount: 2
			}
		]
	};

	const singleProfile = profileWorkbook(singleSheetWb);
	const multiProfile = profileWorkbook(multiSheetWb);

	const singleSummary = formatSummaryForPrompt(singleProfile);
	const multiSummary = formatSummaryForPrompt(multiProfile);

	const singlePrompt = buildOperationPrompt(singleProfile, 'total revenue');
	const multiPrompt = buildOperationPrompt(
		multiProfile,
		'does marketing spend correlate with revenue?'
	);

	// ── Assertions ───────────────────────────────────────────────────────────
	const checks: Check[] = [
		{
			name: 'Single-sheet summary has NO "Sheet:" prefix',
			pass: !singleSummary.includes('## Sheet:'),
			detail: 'single-sheet output must match the legacy prefix-free format'
		},
		{
			name: 'Single-sheet summary wrapped in === DATASET === markers',
			pass:
				singleSummary.includes('=== DATASET ===') &&
				singleSummary.includes('=== END DATASET ==='),
			detail: 'capPrompt() relies on these markers to locate the dataset block'
		},
		{
			name: 'Multi-sheet summary lists both sheet names',
			pass: multiSummary.includes('## Sheet: Marketing') && multiSummary.includes('## Sheet: Revenue'),
			detail: 'each sheet should get its own section'
		},
		{
			name: 'Multi-sheet summary reports sheet count',
			pass: multiSummary.includes('Sheets: 2'),
			detail: 'tells the LLM there is more than one sheet'
		},
		{
			name: 'System prompt documents crossSheet operation',
			pass: singlePrompt.includes('crossSheet') && multiPrompt.includes('crossSheet'),
			detail: 'operation #12 must be present in the static system prompt'
		},
		{
			name: 'System prompt includes the 3 multi-sheet examples',
			pass:
				multiPrompt.includes('compare revenue across all sheets') &&
				multiPrompt.includes('does marketing spend correlate with revenue?') &&
				multiPrompt.includes("what's the formula in cell D23 on the Summary sheet?"),
			detail: 'the three requested example questions'
		},
		{
			name: 'System prompt instructs sheet field on multiple sheets',
			pass: multiPrompt.includes('you MUST include a "sheet" field'),
			detail: 'multi-sheet disambiguation rule'
		},
		{
			name: 'Question is embedded in the built prompt',
			pass:
				singlePrompt.includes('Question: total revenue') &&
				multiPrompt.includes('Question: does marketing spend correlate with revenue?'),
			detail: 'buildOperationPrompt appends the user question'
		}
	];

	const allPass = $derived(checks.every((c) => c.pass));
</script>

<svelte:head><title>Test · Multi-sheet operation prompt</title></svelte:head>

<main class="mx-auto max-w-4xl space-y-6 p-6 text-slate-900 dark:text-slate-100">
	<header class="space-y-1">
		<h1 class="text-2xl font-bold">Multi-sheet operation prompt</h1>
		<p class="text-sm text-slate-500">
			Exercises <code>buildOperationPrompt(WorkbookProfile)</code>,
			<code>formatSummaryForPrompt()</code> → <code>buildCompressedSummary()</code>, and the new
			<code>crossSheet</code> instructions.
		</p>
	</header>

	<div
		class="rounded-lg px-4 py-3 text-sm font-semibold {allPass
			? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200'
			: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200'}"
		data-testid="overall"
	>
		{allPass ? '✓ All checks pass' : '✗ Some checks failed'}
		({checks.filter((c) => c.pass).length}/{checks.length})
	</div>

	<ul class="space-y-2">
		{#each checks as c}
			<li class="rounded border border-slate-200 p-3 text-sm dark:border-slate-700">
				<div class="flex items-center gap-2">
					<span>{c.pass ? '✅' : '❌'}</span>
					<span class="font-medium">{c.name}</span>
				</div>
				<p class="ml-6 text-xs text-slate-500">{c.detail}</p>
			</li>
		{/each}
	</ul>

	<section class="space-y-2">
		<h2 class="text-lg font-semibold">Single-sheet summary (no prefix expected)</h2>
		<pre class="overflow-auto rounded bg-slate-100 p-3 text-xs dark:bg-slate-800">{singleSummary}</pre>
	</section>

	<section class="space-y-2">
		<h2 class="text-lg font-semibold">Multi-sheet summary (per-sheet sections)</h2>
		<pre class="overflow-auto rounded bg-slate-100 p-3 text-xs dark:bg-slate-800">{multiSummary}</pre>
	</section>

	<section class="space-y-2">
		<h2 class="text-lg font-semibold">Full multi-sheet operation prompt</h2>
		<pre class="overflow-auto rounded bg-slate-100 p-3 text-xs dark:bg-slate-800">{multiPrompt}</pre>
	</section>
</main>
