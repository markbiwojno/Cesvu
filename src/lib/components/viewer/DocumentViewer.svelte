<script lang="ts">
	/**
	 * DocumentViewer.svelte — viewer router.
	 *
	 * Routes tabular files to the correct viewer based on parsedData.type:
	 *   - 'excel' → SpreadsheetViewer (non-streaming workbook path, multi-sheet)
	 *   - 'csv'   → CsvViewer (streaming parseCSV path, unchanged)
	 *
	 * Non-tabular files (pdf/docx/txt/md) are handled by DocumentPane in the
	 * main workspace flow; this component renders a lightweight header for them.
	 */
	import { workspace } from '$lib/stores/workspace.svelte.js';
	import CsvViewer from './CsvViewer.svelte';
	import SpreadsheetViewer from './SpreadsheetViewer.svelte';

	const file = $derived(workspace.file);
</script>

{#if file}
	{#if file.type === 'excel'}
		<!-- Excel workbooks → non-streaming SpreadsheetViewer (multi-sheet, tabs) -->
		<SpreadsheetViewer />
	{:else if file.type === 'csv'}
		<!-- CSV → streaming CsvViewer (unchanged) -->
		<CsvViewer />
	{:else}
		<!-- Non-tabular fallback header (full rendering handled by DocumentPane) -->
		<div class="p-6 max-w-4xl mx-auto" role="document" aria-label={file.name}>
			<div class="flex items-center gap-3 mb-6 pb-4 border-b border-slate-800">
				<div class="text-2xl">
					{file.type === 'pdf' ? '📄' : file.type === 'docx' ? '📝' : file.type === 'md' ? '📋' : '📃'}
				</div>
				<div>
					<p class="text-sm font-medium text-gray-200">{file.name}</p>
					<p class="text-xs text-gray-500">{(file.size / 1024).toFixed(1)} KB</p>
				</div>
			</div>
			<p class="text-xs text-gray-600 italic">Use DocumentPane for full rendering.</p>
		</div>
	{/if}
{/if}
