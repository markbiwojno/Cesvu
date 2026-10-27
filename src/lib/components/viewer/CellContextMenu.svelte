<script lang="ts">
	/**
	 * CellContextMenu.svelte — right-click context menu for the spreadsheet grids
	 * (DocumentPane CSV table + SpreadsheetViewer .xlsx table).
	 *
	 * Items are organized in groups separated by dividers:
	 *   Group 1 — Copy:    Copy · Copy row (TSV)
	 *   Group 2 — Filter:  Filter by this value · Exclude this value ·
	 *                      Show duplicates of this value (cell-level, no LLM)
	 *   Group 3 — AI:      Add to AI context · Analyze this column


	 *
	 * Context-aware: items that don't apply to the right-clicked target
	 * (cell / column header / row header) are DISABLED, not hidden.
	 *
	 * Behavior: positioned at the cursor, flips when near a viewport edge.
	 * Dismisses on outside click, Escape, or selecting any action. Copy actions
	 * raise a toast via the shared cellMenuActions helpers.
	 */
	import type { MenuTarget } from './cellMenuActions.js';
	import {
		copyPrimary,
		copyRow,
		filterByValue,
		excludeValue,
		showDuplicates,
		addCellNote,
		analyzeColumn
	} from './cellMenuActions.js';


	interface Props {
		/** Cursor position (viewport coords, clientX/clientY). */
		x: number;
		y: number;
		/** What was right-clicked. */
		target: MenuTarget;
		/** Called to dismiss the menu (parent sets its state to null). */
		onClose: () => void;
	}
	let { x, y, target, onClose }: Props = $props();

	// ── Per-item enablement (context awareness) ───────────────────────────────
	// Cell: everything. Column header: copy name, add-to-context, analyze.
	// Row header: copy row, add-to-context.
	const isCell = $derived(target.kind === 'cell');
	const isColumn = $derived(target.kind === 'column');
	const isRow = $derived(target.kind === 'row');

	type Item = {
		label: string;
		enabled: boolean;
		run: () => void;
	};
	const groups = $derived<Item[][]>([
		// Group 1 — Copy
		[
			{ label: 'Copy', enabled: true, run: () => copyPrimary(target) },
			{ label: 'Copy row', enabled: isCell || isRow, run: () => copyRow(target) }
		],
		// Group 2 — Filter. "Show duplicates of this value" is cell-level: it's the
		// same column == value operation as "Filter by this value" with a duplicates
		// banner, so it lives here and is enabled only for cells.
		[
			{ label: 'Filter by this value', enabled: isCell, run: () => filterByValue(target) },
			{ label: 'Exclude this value', enabled: isCell, run: () => excludeValue(target) },
		{ label: 'Show duplicates of this value', enabled: isCell, run: () => showDuplicates(target) }
		],
		// Group 3 — Notes. Pin a free-text note to the right-clicked cell or
		// column. The same NotesPane bubble list as the contract view; the
		// only difference is the anchor (cell coordinate vs char offset).
		[
			{ label: 'Add note', enabled: isCell || isColumn, run: () => addCellNote(target) }
		],
		// Group 4 — Analyze. Opens the AnalyzerPopover (lazy DashboardPane
		// in popover form) scoped to the right-clicked column. For cells,
		// the analyzer still opens against that cell's column. The popover
		// doesn't exist until the user clicks this — the worker only
		// spawns when the popover opens.
		[
			{ label: 'Analyze this column', enabled: isCell || isColumn, run: () => analyzeColumn(target) }
		]
	]);



	function pick(item: Item) {
		if (!item.enabled) return;
		item.run();
		onClose();
	}

	// ── Positioning — flip near viewport edges ────────────────────────────────
	let menuEl = $state<HTMLDivElement | null>(null);
	let pos = $state<{ left: number; top: number }>({ left: x, top: y });

	$effect(() => {
		// Re-measure once mounted; flip left/up if we'd overflow the viewport.
		const el = menuEl;
		if (!el) return;
		const rect = el.getBoundingClientRect();
		const vw = window.innerWidth;
		const vh = window.innerHeight;
		const margin = 4;
		let left = x;
		let top = y;
		if (left + rect.width > vw - margin) left = Math.max(margin, x - rect.width);
		if (top + rect.height > vh - margin) top = Math.max(margin, y - rect.height);
		pos = { left, top };
	});

	// ── Dismiss handlers ──────────────────────────────────────────────────────
	// pointerdown anywhere outside closes; capture phase so it fires before the
	// browser handles the click on whatever was under the cursor.
	function onWindowPointerDown(e: PointerEvent) {
		if (menuEl && !menuEl.contains(e.target as Node)) onClose();
	}
	function onWindowKeyDown(e: KeyboardEvent) {
		if (e.key === 'Escape') onClose();
	}
</script>

<svelte:window
	onpointerdown={onWindowPointerDown}
	onkeydown={onWindowKeyDown}
	onresize={onClose}
/>

<!-- Menu — fixed at the (possibly flipped) cursor position. -->
<div
	bind:this={menuEl}
	class="fixed z-50 min-w-[11rem] py-1 rounded-lg border border-slate-700 bg-slate-900 shadow-2xl text-xs select-none"
	style="left: {pos.left}px; top: {pos.top}px;"
	role="menu"
	tabindex="-1"
	aria-label="Cell actions"
	oncontextmenu={(e) => e.preventDefault()}
>
	{#each groups as group, gi}
		{#if gi > 0}
			<div class="my-1 border-t border-slate-800" role="separator"></div>
		{/if}
		{#each group as item}
			<button
				type="button"
				role="menuitem"
				disabled={!item.enabled}
				onclick={() => pick(item)}
				class="block w-full text-left px-3 py-1.5 transition-colors
					{item.enabled
						? 'text-gray-200 hover:bg-blue-900/50 hover:text-white cursor-pointer'
						: 'text-gray-600 cursor-not-allowed'}"
			>
				{item.label}
			</button>
		{/each}
	{/each}
</div>
