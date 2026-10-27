<script lang="ts">
	/**
	 * /test/spreadsheet — harness for SpreadsheetViewer.svelte (non-streaming
	 * workbook path). Seeds workspace.setWorkbook() with synthetic workbooks,
	 * then renders SpreadsheetViewer which reads from the store.
	 *
	 * Buttons swap between:
	 *   - Multi-sheet workbook (3 sheets, mixed numeric/categorical columns,
	 *     one large sheet to exercise virtual scrolling)
	 *   - Single-sheet workbook (SheetTabs must hide)
	 *   - Clear (empty state)
	 */
	import SpreadsheetViewer from '$lib/components/viewer/SpreadsheetViewer.svelte';
	import { workspace } from '$lib/stores/workspace.svelte.js';
	import type { Workbook, Sheet } from '$lib/data/workbook.js';

	const REGIONS = ['North', 'South', 'East', 'West'];

	function bigSheet(name: string, n: number): Sheet {
		const headers = ['id', 'region', 'revenue', 'units'];
		const rows = Array.from({ length: n }, (_, i) => ({
			id: String(i + 1),
			region: REGIONS[i % REGIONS.length],
			revenue: String(1000 + ((i * 37) % 9000)),
			units: String((i % 50) + 1)
		}));
		return { name, headers, rows, rowCount: n };
	}

	function smallSheet(name: string, n: number): Sheet {
		const headers = ['product', 'price', 'in_stock'];
		const rows = Array.from({ length: n }, (_, i) => ({
			product: `Item ${String.fromCharCode(65 + (i % 26))}`,
			price: (9.99 + i).toFixed(2),
			in_stock: i % 2 === 0 ? 'yes' : 'no'
		}));
		return { name, headers, rows, rowCount: n };
	}

	const multi: Workbook = {
		fileName: 'q3_report.xlsx',
		activeSheet: 'Sales',
		sheets: [bigSheet('Sales', 8200), smallSheet('Catalog', 18), bigSheet('Forecast', 240)]
	};

	const single: Workbook = {
		fileName: 'data.csv',
		activeSheet: 'data',
		sheets: [bigSheet('data', 500)]
	};

	function loadMulti() { workspace.setWorkbook(multi); }
	function loadSingle() { workspace.setWorkbook(single); }
	function clearWb() { workspace.setWorkbook(null); }

	// Load multi-sheet by default on mount.
	$effect(() => {
		if (!workspace.workbook) workspace.setWorkbook(multi);
	});
</script>

<svelte:head><title>Test · SpreadsheetViewer</title></svelte:head>

<div class="flex flex-col h-screen bg-slate-950 text-gray-200">
	<div class="flex items-center gap-2 p-3 border-b border-slate-800 flex-shrink-0">
		<h1 class="text-sm font-bold mr-2">SpreadsheetViewer</h1>
		<button onclick={loadMulti} class="px-3 py-1 text-xs rounded bg-blue-700 hover:bg-blue-600">Multi-sheet (3)</button>
		<button onclick={loadSingle} class="px-3 py-1 text-xs rounded bg-blue-700 hover:bg-blue-600">Single sheet</button>
		<button onclick={clearWb} class="px-3 py-1 text-xs rounded bg-slate-700 hover:bg-gray-600">Clear</button>
		<span class="ml-auto text-xs text-gray-500">
			selection: {workspace.selection?.label ?? '—'}
		</span>
	</div>

	<div class="flex-1 overflow-hidden">
		<SpreadsheetViewer />
	</div>
</div>
