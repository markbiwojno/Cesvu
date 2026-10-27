<script lang="ts">
	/**
	 * /test/docx — DOCX two-pipeline test harness
	 *
	 * Drop a .docx and verify:
	 *   - LEFT  : mammoth.convertToHtml() rendered as native styled HTML
	 *             (headings, bold, lists, tables) — fully selectable DOM text.
	 *   - RIGHT : the markdown that feeds the AI pipeline (StructuredText.text).
	 *   - BOTTOM: captured selections via window.getSelection() — the same flow
	 *             the workspace uses for [+ Add to context].
	 */
	import { parseDOCX } from '$lib/parsers/docx.js';
	import type { StructuredText } from '$lib/types.js';

	let fileName = $state('');
	let html = $state('');
	let markdown = $state('');
	let error = $state('');
	let loading = $state(false);
	let selections = $state<string[]>([]);

	async function onFile(e: Event) {
		const input = e.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		error = '';
		html = '';
		markdown = '';
		selections = [];
		loading = true;
		fileName = file.name;
		try {
			const parsed = await parseDOCX(file);
			const data = parsed.parsedData as StructuredText;
			html = data.html ?? '';
			markdown = data.text; // text IS the markdown for DOCX
		} catch (err) {
			error = String(err);
		} finally {
			loading = false;
		}
	}

	function captureSelection() {
		const sel = window.getSelection();
		if (!sel || sel.isCollapsed) return;
		const text = sel.toString().trim();
		if (text.length < 3) return;
		selections = [...selections, text];
	}
</script>

<svelte:head><title>Test · DOCX two-pipeline</title></svelte:head>

<div class="min-h-screen bg-slate-950 text-gray-200 p-6">
	<h1 class="text-xl font-bold mb-1">DOCX — two pipelines (display HTML + AI markdown)</h1>
	<p class="text-sm text-gray-500 mb-4">
		Drop a .docx. Left = rendered HTML (select text to capture). Right = markdown sent to the AI.
	</p>

	<input
		type="file"
		accept=".docx"
		onchange={onFile}
		class="mb-6 text-sm file:mr-3 file:rounded file:border-0 file:bg-blue-600 file:px-3 file:py-1.5 file:text-white"
	/>

	{#if loading}
		<p class="text-blue-400 text-sm">Parsing {fileName}…</p>
	{/if}
	{#if error}
		<p class="text-red-400 text-sm border border-red-800 bg-red-950/40 rounded p-3">{error}</p>
	{/if}

	{#if html || markdown}
		<div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
			<!-- Display HTML -->
			<div class="rounded-lg border border-slate-800 bg-slate-900 overflow-hidden">
				<div class="px-3 py-2 border-b border-slate-800 text-xs font-semibold text-gray-400">
					Display — convertToHtml (selectable)
				</div>
				<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
				<div
					class="docx-content max-h-[70vh] overflow-auto p-6"
					role="region"
					aria-label="Rendered DOCX"
					onmouseup={captureSelection}
				>
					<!-- eslint-disable-next-line svelte/no-at-html-tags -->
					{@html html}
				</div>
			</div>

			<!-- Markdown for AI -->
			<div class="rounded-lg border border-slate-800 bg-slate-900 overflow-hidden">
				<div class="px-3 py-2 border-b border-slate-800 text-xs font-semibold text-gray-400">
					AI input — convertToMarkdown ({markdown.length.toLocaleString()} chars)
				</div>
				<pre class="max-h-[70vh] overflow-auto p-4 text-xs text-gray-300 whitespace-pre-wrap font-mono">{markdown}</pre>
			</div>
		</div>

		<!-- Captured selections -->
		<div class="mt-4 rounded-lg border border-slate-800 bg-slate-900 p-4">
			<p class="text-xs font-semibold text-gray-400 mb-2">
				Added context ({selections.length}) — select text on the left
			</p>
			{#if selections.length === 0}
				<p class="text-xs text-gray-600 italic">No selections yet.</p>
			{:else}
				<ul class="space-y-1">
					{#each selections as s, i}
						<li class="text-xs text-gray-300 bg-slate-800 rounded px-2 py-1">
							<span class="text-gray-500 mr-1">{i + 1}.</span>{s.slice(0, 200)}{s.length > 200 ? '…' : ''}
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	{/if}
</div>

<style>
	.docx-content :global(h1) { font-size: 1.6rem; font-weight: 700; color: #f1f5f9; margin: 1.4em 0 0.5em; line-height: 1.25; }
	.docx-content :global(h2) { font-size: 1.3rem; font-weight: 700; color: #e2e8f0; margin: 1.3em 0 0.45em; line-height: 1.3; }
	.docx-content :global(h3) { font-size: 1.1rem; font-weight: 600; color: #e2e8f0; margin: 1.2em 0 0.4em; }
	.docx-content :global(h4),
	.docx-content :global(h5),
	.docx-content :global(h6) { font-size: 1rem; font-weight: 600; color: #cbd5e1; margin: 1.1em 0 0.35em; }
	.docx-content :global(p) { color: #cbd5e1; line-height: 1.7; margin: 0 0 0.9em; }
	.docx-content :global(strong) { font-weight: 700; color: #f1f5f9; }
	.docx-content :global(em) { font-style: italic; }
	.docx-content :global(a) { color: #60a5fa; text-decoration: underline; }
	.docx-content :global(ul),
	.docx-content :global(ol) { margin: 0 0 0.9em 1.5em; color: #cbd5e1; line-height: 1.7; }
	.docx-content :global(ul) { list-style: disc; }
	.docx-content :global(ol) { list-style: decimal; }
	.docx-content :global(li) { margin: 0.2em 0; }
	.docx-content :global(table) { border-collapse: collapse; width: 100%; margin: 0 0 1.2em; font-size: 0.875rem; }
	.docx-content :global(th),
	.docx-content :global(td) { border: 1px solid #334155; padding: 0.4em 0.7em; text-align: left; color: #cbd5e1; vertical-align: top; }
	.docx-content :global(th) { background: #1e293b; color: #f1f5f9; font-weight: 600; }
	.docx-content :global(tr:nth-child(even) td) { background: #0f172a; }
</style>
