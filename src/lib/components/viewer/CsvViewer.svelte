<script lang="ts">
	/**
	 * CsvViewer.svelte — Legacy CSV viewer.
	 * The new DocumentPane.svelte handles CSV rendering in the workspace.
	 * This file is kept for backward compatibility.
	 */
	import { workspace } from '$lib/stores/workspace.svelte.js';
	import type { CsvData } from '$lib/types.js';

	const csvData = $derived(
		workspace.file?.type === 'csv' ? (workspace.file.parsedData as CsvData) : null
	);

	function selectColumn(col: string) {
		workspace.setSelection({
			type: 'column',
			label: `${col} column`,
			data: { column: col }
		});
	}
</script>

{#if csvData}
	<div class="overflow-auto h-full">
		<table class="w-full text-xs border-collapse">
			<thead class="sticky top-0 bg-slate-900 border-b border-slate-800">
				<tr>
					{#each csvData.columns as col}
						<th
							class="px-3 py-2 text-left text-gray-400 font-semibold whitespace-nowrap cursor-pointer hover:text-gray-200"
							onclick={() => selectColumn(col)}
						>{col}</th>
					{/each}
				</tr>
			</thead>
			<tbody>
				{#each csvData.rows as row, i}
					<tr class="border-b border-slate-900 hover:bg-slate-900/60">
						{#each csvData.columns as col}
							<td class="px-3 py-1.5 text-gray-300 whitespace-nowrap">{row[col] ?? ''}</td>
						{/each}
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
{:else}
	<p class="text-xs text-gray-600 p-4">No CSV data loaded.</p>
{/if}
