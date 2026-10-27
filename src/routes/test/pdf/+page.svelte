<script lang="ts">
	/**
	 * /test/pdf — Exercises the NEW PDF pipeline (two independent paths):
	 *
	 *   1. VISUAL  — PdfViewer renders each page to a canvas with an invisible,
	 *      selectable text layer on top. Virtual scrolling (visible ± 1 buffer).
	 *      Select text → "+ Add to context" button → captured below.
	 *
	 *   2. AI TEXT — parsePDF() extracts FLAT per-page text (reading order, no
	 *      heading/column reconstruction) and joins it as "Page N:\n…" for the LLM.
	 *
	 * Drop a PDF and verify: the page looks pixel-perfect, you can drag-select and
	 * Ctrl+F, the flat text per page is correct, and selections land in the
	 * "Added context" list with the right page number.
	 */
	import { parsePDF } from '$lib/parsers/pdf.js';
	import PdfViewer from '$lib/components/viewer/PdfViewer.svelte';
	import EmptyState from '$lib/components/common/EmptyState.svelte';
	import type { ParsedFile, StructuredText, PdfPageText } from '$lib/types.js';

	let status = $state<'idle' | 'loading' | 'ready' | 'error'>('idle');
	let errorMsg = $state('');
	let fileName = $state('');

	let bytes = $state<ArrayBuffer | null>(null);
	let pages = $state<PdfPageText[]>([]);
	let aiContext = $state('');
	let pageCount = $state(0);

	let added = $state<Array<{ text: string; pageNumber: number }>>([]);

	async function handleFile(e: Event) {
		const input = e.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;

		fileName = file.name;
		status = 'loading';
		errorMsg = '';
		added = [];

		try {
			// Keep a copy of the bytes for the viewer (parsePDF may consume its own copy).
			bytes = await file.arrayBuffer();

			const parsed: ParsedFile = await parsePDF(file);
			const data = parsed.parsedData as StructuredText;
			pages = data.pages ?? [];
			pageCount = data.pageCount ?? 0;
			aiContext = data.text;
			status = 'ready';
		} catch (err) {
			errorMsg = err instanceof Error ? err.message : String(err);
			status = 'error';
		}
	}

	function handleAddToContext(payload: { text: string; pageNumber: number }) {
		added = [...added, payload];
	}
</script>

<svelte:head><title>PDF Pipeline Test</title></svelte:head>

<div class="min-h-screen bg-white p-6 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
	<h1 class="mb-1 text-2xl font-bold">PDF Pipeline Test</h1>
	<p class="mb-4 text-sm text-slate-500 dark:text-slate-400">
		Render-as-canvas + invisible selectable text layer (left) and flat per-page text for the AI
		(right). Two independent pipelines.
	</p>

	<input
		type="file"
		accept="application/pdf,.pdf"
		onchange={handleFile}
		class="mb-4 text-sm file:mr-3 file:rounded file:border-0 file:bg-indigo-600 file:px-3 file:py-1.5 file:text-white"
	/>
	{#if fileName}<span class="ml-2 text-sm text-slate-500">{fileName} · {pageCount} pages</span>{/if}

	{#if status === 'loading'}
		<p class="text-sm text-indigo-600">Loading…</p>
	{:else if status === 'error'}
		<p class="rounded bg-rose-100 p-3 text-sm text-rose-700 dark:bg-rose-950/50 dark:text-rose-300">
			{errorMsg}
		</p>
	{:else if status === 'idle'}
		<div class="mt-6">
			<EmptyState
				icon="📄"
				title="No PDF loaded yet"
				description="Drop a PDF above. It renders pixel-perfect with selectable text; flat text is extracted for the AI."
			/>
		</div>
	{/if}

	{#if status === 'ready' && bytes}
		<div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
			<!-- LEFT: pixel-perfect viewer -->
			<div class="h-[80vh] overflow-hidden rounded-lg border border-slate-200 dark:border-slate-700">
				<PdfViewer {bytes} onAddToContext={handleAddToContext} />
			</div>

			<!-- RIGHT: extracted text + captured context -->
			<div class="flex h-[80vh] flex-col gap-4">
				{#if added.length}
					<div class="rounded-lg border border-indigo-300 bg-indigo-50 p-3 dark:border-indigo-800 dark:bg-indigo-950/40">
						<h2 class="mb-2 text-sm font-semibold">Added context ({added.length})</h2>
						<ul class="space-y-1 text-xs">
							{#each added as a, i (i)}
								<li class="flex gap-2">
									<span class="shrink-0 rounded bg-indigo-200 px-1.5 font-mono dark:bg-indigo-900">p.{a.pageNumber}</span>
									<span class="truncate">{a.text}</span>
								</li>
							{/each}
						</ul>
					</div>
				{/if}

				<div class="flex-1 overflow-auto rounded-lg border border-slate-200 dark:border-slate-700">
					<h2 class="sticky top-0 bg-slate-100 px-3 py-2 text-sm font-semibold dark:bg-slate-900">
						Flat per-page text (AI context — {aiContext.length.toLocaleString()} chars)
					</h2>
					<div class="space-y-4 p-3">
						{#each pages as p (p.pageNumber)}
							<div>
								<div class="mb-1 text-xs font-semibold text-indigo-600 dark:text-indigo-400">
									Page {p.pageNumber}
								</div>
								<pre class="whitespace-pre-wrap break-words font-sans text-xs text-slate-700 dark:text-slate-300">{p.text || '(no extractable text)'}</pre>
							</div>
						{/each}
					</div>
				</div>
			</div>
		</div>
	{/if}
</div>
