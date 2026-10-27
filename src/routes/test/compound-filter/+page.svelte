<script lang="ts">
	/**
	 * /test/compound-filter — verifies multi-word values inside compound
	 * (AND / OR / NOT) filters.
	 *
	 * The bug: "show me where businessname = d k iron and mailingaddress =
	 * 2316 RALSTON ROAD" returned 0 rows because the value capture stopped at
	 * the first space — "d k iron" became "d", and "k", "iron", "ralston",
	 * "road" leaked in as stray _any_ terms that ANDed the result down to zero.
	 *
	 * Fix: value capture now runs to the next AND/OR/NOT keyword (or end), the
	 * value is quoted, and the tokenizer consumes quoted multi-word values.
	 */
	import {
		naturalLanguageToFilter,
		countMatches,
		describeFilter,
		type Filter
	} from '$lib/pipeline/filter.js';


	type Case = { name: string; pass: boolean; detail: string };
	const results: Case[] = [];
	function check(name: string, pass: boolean, detail = '') {
		results.push({ name, pass, detail });
	}

	const COLUMNS = ['BusinessName', 'MailingAddress', 'City', 'Status', 'Revenue'];

	// Fixture: one row matches BOTH conditions in the user's example.
	const ROWS: Record<string, string>[] = [
		{ BusinessName: 'D K IRON', MailingAddress: '2316 RALSTON ROAD', City: 'Hayward', Status: 'Active', Revenue: '1200' },
		{ BusinessName: 'D K IRON', MailingAddress: '99 OTHER ST',       City: 'Fremont', Status: 'Active', Revenue: '800' },
		{ BusinessName: 'ACME LLC',  MailingAddress: '2316 RALSTON ROAD', City: 'Hayward', Status: 'Closed', Revenue: '5000' },
		{ BusinessName: 'SMITH AND SONS', MailingAddress: '1 MAIN ST',    City: 'Oakland', Status: 'Active', Revenue: '300' }
	];

	function run(name: string, phrase: string, expectMatches: number, expectDesc?: (d: string) => boolean) {
		const tree = naturalLanguageToFilter(phrase, COLUMNS);
		if (!tree) {
			check(name, false, 'parse returned null');
			return null;
		}
		const n = countMatches(tree as Filter, ROWS);
		const desc = describeFilter(tree as Filter);
		const ok = n === expectMatches && (!expectDesc || expectDesc(desc));
		check(name, ok, `matches=${n} (expected ${expectMatches}) · tree=${desc}`);
		return tree;
	}

	// ── The exact reported case ──────────────────────────────────────────────
	run(
		'businessname = d k iron AND mailingaddress = 2316 RALSTON ROAD → 1 row',
		'show me where businessname = d k iron and mailingaddress = 2316 RALSTON ROAD',
		1
	);

	// ── Single multi-word condition (regression — must still work) ───────────
	run(
		'businessname = d k iron → 2 rows',
		'show me where businessname = d k iron',
		2
	);

	// ── Multi-word value on the right of AND only ────────────────────────────
	run(
		'status = active AND mailingaddress = 2316 RALSTON ROAD → 1 row',
		'show me where status = active and mailingaddress = 2316 ralston road',
		1
	);

	// ── OR with multi-word values ────────────────────────────────────────────
	run(
		'businessname = acme llc OR mailingaddress = 99 OTHER ST → 2 rows',
		'businessname = acme llc or mailingaddress = 99 other st',
		2
	);

	// ── NOT with multi-word value ────────────────────────────────────────────
	run(
		'businessname = d k iron AND NOT mailingaddress = 2316 ralston road → 1 row',
		'businessname = d k iron but not mailingaddress = 2316 ralston road',
		1
	);

	// ── Quoted value containing the word "and" (escape hatch) ────────────────
	run(
		'businessname = "smith and sons" → 1 row (quotes protect the "and")',
		'show me where businessname = "smith and sons"',
		1
	);

	// ── Numeric comparison still works alongside multi-word string ───────────
	run(
		'status = active AND revenue > 1000 → 1 row',
		'show me where status = active and revenue > 1000',
		1
	);

	const passCount = results.filter((r) => r.pass).length;
</script>

<div class="min-h-screen bg-slate-950 text-slate-200 p-8 font-mono text-sm">
	<h1 class="text-xl font-bold mb-2">compound-filter tests (multi-word values)</h1>
	<p class="mb-4 {passCount === results.length ? 'text-emerald-400' : 'text-amber-400'}">
		{passCount} / {results.length} passing
	</p>
	<ul class="space-y-2">
		{#each results as r}
			<li class="flex gap-2 items-start">
				<span class={r.pass ? 'text-emerald-400' : 'text-red-400'}>{r.pass ? '✓' : '✗'}</span>
				<span class="flex-1">
					{r.name}
					{#if r.detail}<span class="block text-slate-500 text-xs mt-0.5">{r.detail}</span>{/if}
				</span>
			</li>
		{/each}
	</ul>
</div>
