<script lang="ts">
	/**
	 * SheetTabs.svelte — Horizontal sheet tab bar for multi-sheet workbooks.
	 *
	 * Renders one tab per sheet with its row count (e.g. "Sales (8,200)").
	 * The active tab is highlighted. Clicking a tab calls `onSelect(name)`
	 * (the workspace store wires this to setActiveSheet). Hidden entirely when
	 * the workbook has only one sheet — a lone tab adds no value.
	 *
	 * Keyboard: Ctrl+Tab cycles to the next sheet, Ctrl+Shift+Tab to the
	 * previous (wrapping at both ends). Listener is attached at the window so
	 * the shortcut works regardless of which pane has focus.
	 *
	 * Props:
	 *   - sheets: Sheet[]            all sheets in the workbook (tab order)
	 *   - activeSheet: string        name of the currently-active sheet
	 *   - onSelect: (name) => void   called when the user picks a sheet
	 */
	import type { Sheet } from '$lib/data/workbook.js';

	interface Props {
		sheets: Sheet[];
		activeSheet: string;
		onSelect: (name: string) => void;
	}

	let { sheets, activeSheet, onSelect }: Props = $props();

	// Hidden when there is nothing to switch between.
	const visible = $derived(sheets.length > 1);

	/** Format a row count with thousands separators, e.g. 8200 → "8,200". */
	function fmt(n: number): string {
		return n.toLocaleString('en-US');
	}

	/** Cycle the active sheet by `delta` (+1 next, -1 previous), wrapping. */
	function cycle(delta: number) {
		if (sheets.length < 2) return;
		const idx = sheets.findIndex((s) => s.name === activeSheet);
		const from = idx === -1 ? 0 : idx;
		const next = (from + delta + sheets.length) % sheets.length;
		onSelect(sheets[next].name);
	}

	function onKeydown(e: KeyboardEvent) {
		// Ctrl+Tab / Ctrl+Shift+Tab — cycle sheets.
		if (e.ctrlKey && e.key === 'Tab') {
			e.preventDefault();
			cycle(e.shiftKey ? -1 : 1);
		}
	}
</script>

<svelte:window onkeydown={onKeydown} />

{#if visible}
	<div
		class="flex items-stretch gap-1 overflow-x-auto border-b border-slate-200 bg-slate-50 px-1
			dark:border-slate-700 dark:bg-slate-900"
		role="tablist"
		aria-label="Workbook sheets"
		data-testid="sheet-tabs"
	>
		{#each sheets as sheet (sheet.name)}
			{@const isActive = sheet.name === activeSheet}
			<button
				type="button"
				role="tab"
				aria-selected={isActive}
				title={`${sheet.name} — ${fmt(sheet.rowCount)} rows`}
				class="flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-sm
					font-medium transition-colors focus:outline-none focus-visible:ring-2
					focus-visible:ring-blue-500
					{isActive
						? 'border-blue-500 text-blue-600 dark:border-blue-400 dark:text-blue-300'
						: 'border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-700 dark:text-slate-400 dark:hover:border-slate-600 dark:hover:text-slate-200'}"
				onclick={() => onSelect(sheet.name)}
			>
				<span>{sheet.name}</span>
				<span
					class="rounded px-1 text-xs tabular-nums
						{isActive
							? 'bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-200'
							: 'bg-slate-200 text-slate-500 dark:bg-slate-800 dark:text-slate-400'}"
				>
					{fmt(sheet.rowCount)}
				</span>
			</button>
		{/each}
	</div>
{/if}
