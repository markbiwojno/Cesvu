<script lang="ts">
	/**
	 * /test/value-match — verifies the two fixes for
	 * "show me all with LastUpdate = 46133" returning 0 rows:
	 *
	 *   1. detectQueryIntent() now parses "column <op> value" so the VALUE
	 *      (46133) becomes the pattern, not the column name ("lastupdate").
	 *   2. matchesValue() bridges Excel date-serial ⇄ formatted date string,
	 *      so 46133 matches the cell that shows that serial's calendar date.
	 */
	import { detectQueryIntent } from '$lib/pipeline/query.js';
	import { matchesValue, excelSerialToDate } from '$lib/pipeline/valueMatch.js';

	type Case = { name: string; pass: boolean; detail: string };
	const results: Case[] = [];

	function check(name: string, pass: boolean, detail: string) {
		results.push({ name, pass, detail });
	}

	const COLUMNS = ['BusinessName', 'LastUpdate', 'ZipCode', 'Status'];

	// ── Intent parsing ────────────────────────────────────────────────────────
	{
		const i = detectQueryIntent('show me all with LastUpdate = 46133', COLUMNS);
		check(
			'"LastUpdate = 46133" → column=LastUpdate, pattern=46133',
			i.type === 'filter_rows' && i.column === 'LastUpdate' && i.pattern === '46133',
			`got type=${i.type} column=${i.column} pattern=${i.pattern}`
		);
	}
	{
		const i = detectQueryIntent('Status = Active', COLUMNS);
		check(
			'"Status = Active" → column=Status, pattern=Active',
			i.type === 'filter_rows' && i.column === 'Status' && i.pattern === 'Active',
			`got column=${i.column} pattern=${i.pattern}`
		);
	}
	{
		const i = detectQueryIntent('show me all ZipCode = 90210', COLUMNS);
		check(
			'"ZipCode = 90210" → column=ZipCode, pattern=90210',
			i.type === 'filter_rows' && i.column === 'ZipCode' && i.pattern === '90210',
			`got column=${i.column} pattern=${i.pattern}`
		);
	}
	{
		// Regression: free-text "contains" filter still works (no operator).
		const i = detectQueryIntent('show me all business name with "mark"', COLUMNS);
		check(
			'"BusinessName with mark" still resolves to BusinessName + mark',
			i.type === 'filter_rows' && i.column === 'BusinessName' && /mark/i.test(i.pattern ?? ''),
			`got column=${i.column} pattern=${i.pattern}`
		);
	}

	// ── Value matching: serial ⇄ date ─────────────────────────────────────────
	const serial = 46133;
	const dateStr = excelSerialToDate(serial).toLocaleDateString('en-US'); // e.g. "4/15/2026"
	{
		check(
			`serial ${serial} matches formatted date cell "${dateStr}"`,
			matchesValue(dateStr, String(serial), 'contains'),
			`excelSerialToDate(${serial}) = ${excelSerialToDate(serial).toDateString()}`
		);
	}
	{
		// reverse: cell holds the serial, user typed a date string
		check(
			`typed date "${dateStr}" matches cell holding serial ${serial}`,
			matchesValue(String(serial), dateStr, 'eq'),
			''
		);
	}
	{
		check(
			'plain numeric equality: cell "46133" matches query "46133"',
			matchesValue('46133', '46133', 'eq'),
			''
		);
	}
	{
		check(
			'substring still works: cell "Marketing" contains "mark"',
			matchesValue('Marketing', 'mark', 'contains'),
			''
		);
	}
	{
		check(
			'non-match: cell "Sales" does NOT contain "mark"',
			!matchesValue('Sales', 'mark', 'contains'),
			''
		);
	}
	{
		// A real quantity (not a serial) must not be mis-read as a date.
		check(
			'quantity 5 does NOT spuriously match a date cell',
			!matchesValue('1/5/2026', '5', 'eq'),
			''
		);
	}

	const passCount = results.filter((r) => r.pass).length;
</script>

<div class="min-h-screen bg-slate-950 text-slate-200 p-8 font-mono text-sm">
	<h1 class="text-xl font-bold mb-2">value-match / query-intent tests</h1>
	<p class="mb-4 {passCount === results.length ? 'text-emerald-400' : 'text-amber-400'}">
		{passCount} / {results.length} passing
	</p>
	<ul class="space-y-1">
		{#each results as r}
			<li class="flex gap-2 items-start">
				<span class={r.pass ? 'text-emerald-400' : 'text-red-400'}>{r.pass ? '✓' : '✗'}</span>
				<span class="flex-1">
					{r.name}
					{#if r.detail && !r.pass}<span class="block text-slate-500">{r.detail}</span>{/if}
				</span>
			</li>
		{/each}
	</ul>
</div>
