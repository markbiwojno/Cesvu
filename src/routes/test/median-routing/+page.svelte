<script lang="ts">
	/**
	 * /test/median-routing — guards the "hallucinated median" regression.
	 *
	 * Root cause that this test locks down:
	 *   "what is the median of the LicenseNo" was classified as CONVERSATIONAL
	 *   because isConversationalQuestion()'s keyword list was missing "median"
	 *   (and "stddev", "variance", etc.). Conversational questions skip the
	 *   deterministic operation pipeline and go to the LLM, which then made up
	 *   a number ("1234567890"). "average"/"avg" WERE in the list, so they were
	 *   computed correctly — hence the inconsistency the user reported.
	 *
	 * Checks:
	 *   1. Every statistical keyword routes as NON-conversational (so it reaches
	 *      the deterministic engine), while genuinely conversational questions
	 *      still route as conversational.
	 *   2. The engine computes the median correctly over a known dataset
	 *      (sanity check that the deterministic path produces the right number).
	 */
	import { isConversationalQuestion } from '$lib/pipeline/analysis.js';
	import { executeOnRows } from '$lib/pipeline/engine.js';

	type TestStatus = 'pass' | 'fail';
	interface Row { name: string; status: TestStatus; detail: string; }

	let results = $state<Row[]>([]);
	let ran = $state(false);

	function check(name: string, cond: boolean, detail: string) {
		results.push({ name, status: cond ? 'pass' : 'fail', detail });
	}

	function run() {
		results = [];

		// 1a. Statistical questions must NOT be conversational.
		const statistical = [
			'what is the median of the LicenseNo',
			'median LicenseNo',
			'what is the average of the licenseno',
			'stddev of revenue',
			'standard deviation of price',
			'variance of age',
			'what is the max of amount',
			'min of score',
			'sum of total',
			'count of rows',
			'how many distinct cities',
			'unique values in status'
		];
		for (const q of statistical) {
			const conv = isConversationalQuestion(q);
			check(`NON-conversational: "${q}"`, conv === false, conv ? 'misrouted → LLM (hallucination risk)' : 'routes to engine ✓');
		}

		// 1b. Genuinely conversational questions must STILL be conversational.
		const conversational = [
			'what is this file about?',
			'summarize this',
			'tell me about the data',
			'explain this document'
		];
		for (const q of conversational) {
			const conv = isConversationalQuestion(q);
			check(`Conversational: "${q}"`, conv === true, conv ? 'routes to chat ✓' : 'misrouted → engine');
		}

		// 2. Engine computes the correct median over a known dataset.
		// values 1..7 → median = 4. avg = 4 as well; use 1..6 to differentiate:
		// 1,2,3,4,5,6 → median = (3+4)/2 = 3.5, avg = 3.5 (still equal) → use 1,2,3,4,100
		const rows = [
			{ v: '1' }, { v: '2' }, { v: '3' }, { v: '4' }, { v: '100' }
		];
		const medianRes = executeOnRows(rows, { type: 'aggregate', function: 'median', column: 'v' });
		const medianVal = medianRes.type === 'scalar' ? medianRes.value : null;
		check('Engine median([1,2,3,4,100]) === 3', medianVal === 3, `got ${medianVal}`);

		const avgRes = executeOnRows(rows, { type: 'aggregate', function: 'avg', column: 'v' });
		const avgVal = avgRes.type === 'scalar' ? avgRes.value : null;
		check('Engine avg([1,2,3,4,100]) === 22', avgVal === 22, `got ${avgVal}`);

		// 3. Median ≠ avg here — proves median is a distinct, real computation
		// (not silently aliased to mean / not a fabricated LLM number).
		check('Median differs from avg (distinct computation)', medianVal !== avgVal, `median=${medianVal} avg=${avgVal}`);

		ran = true;
	}

	const allPass = $derived(ran && results.every((r) => r.status === 'pass'));
</script>

<div class="min-h-screen bg-slate-950 text-gray-200 p-8 font-sans">
	<h1 class="text-2xl font-bold mb-2">Median Routing Test</h1>
	<p class="text-sm text-gray-400 mb-6 max-w-2xl">
		Guards the regression where <code class="text-violet-400">"median of LicenseNo"</code> was
		routed to the LLM (which hallucinated a number) instead of the deterministic
		operation engine — because the conversational-detection keyword list was
		missing <code>median</code>/<code>stddev</code>/<code>variance</code>.
	</p>

	<button
		onclick={run}
		class="mb-6 px-4 py-2 rounded bg-violet-600 hover:bg-violet-500 text-white text-sm font-medium"
	>Run tests</button>

	{#if ran}
		<div class="mb-4 inline-block px-3 py-1 rounded text-sm font-semibold {allPass ? 'bg-emerald-900 text-emerald-300' : 'bg-red-900 text-red-300'}">
			{allPass ? '✓ ALL PASS' : '✗ FAILURES'} — {results.filter(r => r.status === 'pass').length}/{results.length}
		</div>

		<ul class="space-y-1.5 max-w-2xl">
			{#each results as r}
				<li class="flex items-start gap-3 p-2.5 rounded border {r.status === 'pass' ? 'border-emerald-900 bg-emerald-950/30' : 'border-red-900 bg-red-950/30'}">
					<span class="mt-0.5">{r.status === 'pass' ? '✓' : '✗'}</span>
					<div>
						<div class="text-sm">{r.name}</div>
						<div class="text-xs text-gray-500 font-mono">{r.detail}</div>
					</div>
				</li>
			{/each}
		</ul>
	{/if}

	<div class="mt-10 max-w-2xl text-sm text-gray-400">
		<h2 class="text-gray-200 font-semibold mb-2">Manual end-to-end check</h2>
		<ol class="list-decimal list-inside space-y-1">
			<li>Upload a CSV with a numeric column (e.g. LicenseNo).</li>
			<li>Ask: <code class="text-gray-300">what is the median of the LicenseNo</code>.</li>
			<li>The answer must be formatted like the deterministic engine output
				(<code class="text-gray-300">**median(LicenseNo)**: …</code>) — NOT a
				free-form prose sentence with a suspiciously round made-up number.</li>
			<li>Confirm median and average return different, plausible values.</li>
		</ol>
	</div>
</div>
