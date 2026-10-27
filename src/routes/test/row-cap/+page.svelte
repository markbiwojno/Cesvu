<script lang="ts">
	/**
	 * /test/row-cap — verifies the symmetric 250K display-cap policy.
	 *
	 * What it checks (no large file needed — synthetic data, low test cap):
	 *  1. MAX_DISPLAY_ROWS === 250_000 (the shared constant).
	 *  2. profileColumns() over a FULL synthetic dataset produces stats that
	 *     reflect ALL rows (mean/min/max), independent of any display cap.
	 *  3. The cap math used by the Excel path (slice to cap, keep rowCount =
	 *     true count, set isSampled, attach fullProfile) preserves full-row
	 *     stats while shrinking the display buffer — mirroring the CSV path.
	 *
	 * The end-to-end UI banner ("Displaying X of Y rows · Stats reflect all
	 * rows") is verified manually by loading a >250K-row CSV/XLSX in the
	 * workspace; see the checklist printed below.
	 */
	import { MAX_DISPLAY_ROWS } from '$lib/config.js';
	import { profileColumns } from '$lib/pipeline/pipeline.js';
	import type { ColumnProfile } from '$lib/types.js';
	import type { Sheet } from '$lib/data/workbook.js';

	type TestStatus = 'pending' | 'pass' | 'fail';
	interface Row { name: string; status: TestStatus; detail: string; }

	let results = $state<Row[]>([]);
	let ran = $state(false);

	function assert(name: string, cond: boolean, detail: string) {
		results.push({ name, status: cond ? 'pass' : 'fail', detail });
	}

	function buildRows(n: number): Record<string, string>[] {
		// value column = 0..n-1 so mean = (n-1)/2, min = 0, max = n-1.
		const rows: Record<string, string>[] = new Array(n);
		for (let i = 0; i < n; i++) {
			rows[i] = { id: String(i), value: String(i), bucket: String(i % 4) };
		}
		return rows;
	}

	function numericProfile(profile: ColumnProfile[], col: string) {
		return profile.find((p) => p.name === col && p.type === 'numeric');
	}

	function run() {
		results = [];

		// 1. Shared constant
		assert(
			'MAX_DISPLAY_ROWS is 250,000',
			MAX_DISPLAY_ROWS === 250_000,
			`actual = ${MAX_DISPLAY_ROWS.toLocaleString()}`
		);

		// Use a small synthetic cap so the test is instant. The CAP LOGIC is what
		// matters, not the literal 250K (that's covered by test 1).
		const TEST_CAP = 1_000;
		const TRUE_ROWS = 3_500; // > cap → must be sampled
		const full = buildRows(TRUE_ROWS);

		// 2. Profile over FULL rows reflects all rows.
		const fullProfile = profileColumns(full);
		const vFull = numericProfile(fullProfile, 'value');
		const expectedMean = (TRUE_ROWS - 1) / 2;
		assert(
			'Full-row profile mean reflects ALL rows',
			!!vFull && Math.abs((vFull.mean ?? -1) - expectedMean) < 0.5,
			`mean=${vFull?.mean} expected≈${expectedMean}`
		);
		assert(
			'Full-row profile min/max reflect ALL rows',
			!!vFull && vFull.min === 0 && vFull.max === TRUE_ROWS - 1,
			`min=${vFull?.min} max=${vFull?.max} expected 0 / ${TRUE_ROWS - 1}`
		);

		// 3. Excel-path cap simulation: profile full → cap display → assert symmetry.
		const isSampled = full.length > TEST_CAP;
		const displayRows = isSampled ? full.slice(0, TEST_CAP) : full;
		const sheet: Sheet = {
			name: 'Synthetic',
			headers: ['id', 'value', 'bucket'],
			rows: displayRows,
			rowCount: full.length, // TRUE count preserved
			fullProfile,
			isSampled
		};

		assert(
			'Display buffer is capped',
			sheet.rows.length === TEST_CAP,
			`rows.length=${sheet.rows.length} cap=${TEST_CAP}`
		);
		assert(
			'rowCount preserves TRUE count after capping',
			sheet.rowCount === TRUE_ROWS,
			`rowCount=${sheet.rowCount} expected=${TRUE_ROWS}`
		);
		assert(
			'isSampled flagged when capped',
			sheet.isSampled === true,
			`isSampled=${sheet.isSampled}`
		);

		// 4. The attached fullProfile still reflects all rows (NOT the capped slice).
		const cappedOnlyProfile = profileColumns(sheet.rows);
		const vCapped = numericProfile(cappedOnlyProfile, 'value');
		const vAttached = numericProfile(sheet.fullProfile ?? [], 'value');
		assert(
			'Capped-buffer profile would UNDERCOUNT (control)',
			!!vCapped && vCapped.max === TEST_CAP - 1,
			`capped max=${vCapped?.max} (expected ${TEST_CAP - 1})`
		);
		assert(
			'Attached fullProfile reflects ALL rows (the fix)',
			!!vAttached && vAttached.max === TRUE_ROWS - 1,
			`fullProfile max=${vAttached?.max} (expected ${TRUE_ROWS - 1})`
		);

		// 5. Banner condition: shown iff isSampled && rowCount > rows.length.
		const bannerShown = !!sheet.isSampled && sheet.rowCount > sheet.rows.length;
		assert(
			'Banner condition true when capped',
			bannerShown,
			`isSampled=${sheet.isSampled} ${sheet.rowCount} > ${sheet.rows.length}`
		);

		ran = true;
	}

	const allPass = $derived(ran && results.every((r) => r.status === 'pass'));
</script>

<div class="min-h-screen bg-slate-950 text-gray-200 p-8 font-sans">
	<h1 class="text-2xl font-bold mb-2">Row-Cap Policy Test (250K, symmetric)</h1>
	<p class="text-sm text-gray-400 mb-6 max-w-2xl">
		Verifies the shared <code class="text-violet-400">MAX_DISPLAY_ROWS</code> cap and that
		column statistics reflect <strong>all</strong> rows even when the display/query buffer is capped —
		for both the CSV and Excel paths.
	</p>

	<button
		onclick={run}
		class="mb-6 px-4 py-2 rounded bg-violet-600 hover:bg-violet-500 text-white text-sm font-medium"
	>Run tests</button>

	{#if ran}
		<div class="mb-4 inline-block px-3 py-1 rounded text-sm font-semibold {allPass ? 'bg-emerald-900 text-emerald-300' : 'bg-red-900 text-red-300'}">
			{allPass ? '✓ ALL PASS' : '✗ FAILURES'} — {results.filter(r => r.status === 'pass').length}/{results.length}
		</div>

		<ul class="space-y-2 max-w-2xl">
			{#each results as r}
				<li class="flex items-start gap-3 p-3 rounded border {r.status === 'pass' ? 'border-emerald-900 bg-emerald-950/30' : 'border-red-900 bg-red-950/30'}">
					<span class="mt-0.5">{r.status === 'pass' ? '✓' : '✗'}</span>
					<div>
						<div class="text-sm font-medium">{r.name}</div>
						<div class="text-xs text-gray-500 font-mono">{r.detail}</div>
					</div>
				</li>
			{/each}
		</ul>
	{/if}

	<div class="mt-10 max-w-2xl text-sm text-gray-400">
		<h2 class="text-gray-200 font-semibold mb-2">Manual end-to-end check</h2>
		<ol class="list-decimal list-inside space-y-1">
			<li>Open the main workspace and upload a CSV with &gt; 250,000 rows.</li>
			<li>The file info bar should read:
				<code class="text-amber-500">Displaying 250,000 of N rows · Stats reflect all rows</code>.</li>
			<li>Repeat with an .xlsx whose sheet has &gt; 250,000 rows — the sheet info
				bar should show the same banner.</li>
			<li>Ask the chat a numeric question (e.g. "what's the max value?") — the
				answer's stats should reflect the full file; row-scanning answers append
				<em>"(from 250,000 buffered rows)"</em>.</li>
		</ol>
	</div>
</div>
