<script lang="ts">
	/**
	 * /test/sheet-tabs — interactive harness for SheetTabs.svelte.
	 *
	 * Three scenarios:
	 *   1. Multi-sheet workbook (4 sheets, one with a large row count to test
	 *      thousands formatting) — fully interactive, click + Ctrl+Tab.
	 *   2. Many sheets (12) — verifies horizontal overflow scrolling.
	 *   3. Single sheet — verifies the bar is hidden entirely.
	 */
	import SheetTabs from '$lib/components/viewer/SheetTabs.svelte';
	import type { Sheet } from '$lib/data/workbook.js';

	function mkSheet(name: string, rowCount: number): Sheet {
		return { name, headers: ['A', 'B'], rows: [], rowCount };
	}

	const multi: Sheet[] = [
		mkSheet('Sales', 8200),
		mkSheet('Marketing', 312),
		mkSheet('Revenue', 1045),
		mkSheet('Summary', 12)
	];
	let multiActive = $state('Sales');

	const many: Sheet[] = Array.from({ length: 12 }, (_, i) =>
		mkSheet(`Quarter_${i + 1}`, (i + 1) * 137)
	);
	let manyActive = $state('Quarter_1');

	const single: Sheet[] = [mkSheet('OnlySheet', 42)];
	let singleActive = $state('OnlySheet');
</script>

<svelte:head><title>Test · SheetTabs</title></svelte:head>

<main class="mx-auto max-w-4xl space-y-8 p-6 text-slate-900 dark:text-slate-100">
	<header class="space-y-1">
		<h1 class="text-2xl font-bold">SheetTabs</h1>
		<p class="text-sm text-slate-500">
			Click tabs to switch. Focus this page and press <kbd>Ctrl</kbd>+<kbd>Tab</kbd> /
			<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Tab</kbd> to cycle.
		</p>
	</header>

	<section class="space-y-2">
		<h2 class="text-lg font-semibold">1 · Multi-sheet (4 sheets, row counts formatted)</h2>
		<div class="rounded-lg border border-slate-200 dark:border-slate-700">
			<SheetTabs sheets={multi} activeSheet={multiActive} onSelect={(n) => (multiActive = n)} />
			<div class="p-4 text-sm" data-testid="multi-active">
				Active sheet: <strong>{multiActive}</strong>
			</div>
		</div>
		<p class="text-xs text-slate-500">
			Expect: "Sales" tab highlighted blue, count shows <code>8,200</code> with a comma. Clicking
			updates the active label; Ctrl+Tab cycles forward and wraps Summary → Sales.
		</p>
	</section>

	<section class="space-y-2">
		<h2 class="text-lg font-semibold">2 · Many sheets (overflow scroll)</h2>
		<div class="max-w-md rounded-lg border border-slate-200 dark:border-slate-700">
			<SheetTabs sheets={many} activeSheet={manyActive} onSelect={(n) => (manyActive = n)} />
			<div class="p-4 text-sm">Active sheet: <strong>{manyActive}</strong></div>
		</div>
		<p class="text-xs text-slate-500">
			Expect: tabs overflow the 28rem container and scroll horizontally (no wrap).
		</p>
	</section>

	<section class="space-y-2">
		<h2 class="text-lg font-semibold">3 · Single sheet (hidden)</h2>
		<div class="rounded-lg border border-slate-200 dark:border-slate-700">
			<SheetTabs sheets={single} activeSheet={singleActive} onSelect={(n) => (singleActive = n)} />
			<div class="p-4 text-sm">
				No tab bar should appear above this line (only 1 sheet).
			</div>
		</div>
	</section>
</main>
