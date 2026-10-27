<script lang="ts">
	import { workspace, type ChatMessage } from '$lib/stores/workspace.svelte.js';
	import LoadingSpinner from '$lib/components/ui/LoadingSpinner.svelte';
	import Toast from '$lib/components/ui/Toast.svelte';
	import VegaChart from '$lib/components/visuals/VegaChart.svelte';
	import { CHART_SLOT } from '$lib/pipeline/analysis.js';
	import Modal from '$lib/components/common/Modal.svelte';
	import { onMount } from 'svelte';
	import { newId } from '$lib/utils/id.js';


	/**
	 * Split an assistant message's content on the CHART_SLOT sentinel into
	 * { header, body }. When the message has a chartSpec, the chart is rendered
	 * between the two (header → chart → body). Messages without the sentinel
	 * return their whole content as `header` and an empty `body` (the sentinel
	 * is always stripped, so plain-text rendering is unaffected).
	 */
	function splitChartContent(content: string): { header: string; body: string } {
		const idx = content.indexOf(CHART_SLOT);
		if (idx === -1) return { header: content, body: '' };
		return {
			header: content.slice(0, idx),
			body: content.slice(idx + CHART_SLOT.length)
		};
	}


	let inputText = $state('');
	let messagesEl = $state<HTMLDivElement | null>(null);
	let inputEl = $state<HTMLTextAreaElement | null>(null);

	/** Help-guide popup (how to query CSV/Excel data). */
	let showGuide = $state(false);
	/** Tabular file → surface the "?" query-guide button next to the input. */
	const isTabular = $derived(
		workspace.file?.type === 'csv' || workspace.file?.type === 'excel'
	);


	/**
	 * Set when a prefill flagged skipQueryEngine (the "Analyze this column"
	 * action) is consumed into the input. Passed to runChatInference on the next
	 * send so the prompt bypasses the filter/intent query engine and goes
	 * straight to the LLM. Cleared after that send, and if the user clears the
	 * input (so a manually-typed follow-up query isn't accidentally flagged).
	 */
	let pendingSkipQueryEngine = false;


	/**
	 * Consume a pending chat-input prefill (PULL pattern — NOT a reactive
	 * $effect). A producer like the spreadsheet "Analyze this column" action
	 * calls workspace.setChatPrefill(text); we read it here from explicit
	 * handlers (onMount + the textarea's onfocus, both of which fire when the
	 * chat surface is shown/interacted with) and immediately clear it so the
	 * same text is never re-applied. We don't clobber text the user already
	 * typed, and we don't overwrite a draft mid-edit.
	 */
	function consumeChatPrefill() {
		const pending = workspace.chatPrefill;
		if (pending == null) return;
		workspace.clearChatPrefill();
		// Only fill an empty input — never stomp on something the user is typing.
		if (inputText.trim() === '') {
			inputText = pending.text;
			// Carry the skip-query-engine flag through to the next send so this
			// analysis prompt reaches the LLM instead of the filter engine.
			pendingSkipQueryEngine = pending.skipQueryEngine;
		}

		// Focus + place caret at end so the user can edit before sending.
		queueMicrotask(() => {
			if (!inputEl) return;
			inputEl.focus();
			const len = inputEl.value.length;
			inputEl.setSelectionRange(len, len);
		});
	}

	onMount(() => {
		// Clear a STALE loading flag. A chat send sets isLoading=true then clears
		// it within the same call, so a freshly-(re)mounted ChatPane should never
		// start out loading. If it does, the flag was orphaned — e.g. this pane
		// was swapped out for the full-width Notes pane mid-request and remounted
		// later — and it would wrongly keep the input disabled. We only clear when
		// NOT in the template Analyze flow (step==='analyzing' owns isLoading then).
		if (workspace.isLoading && workspace.step !== 'analyzing') {
			workspace.setLoading(false);
		}

		consumeChatPrefill();
		// Producers (e.g. "Analyze this column") dispatch this after queuing a
		// prefill so an already-mounted ChatPane pulls it without a reactive
		// $effect. Still a handler-driven pull.
		window.addEventListener('cesvu:chat-prefill', consumeChatPrefill);
		return () => window.removeEventListener('cesvu:chat-prefill', consumeChatPrefill);
	});




	/** Cap any selection-derived text so a long cell/column value (common in
	 *  header-less sheets, where the column key IS the cell content) can't flood
	 *  the placeholder and read like a typed-in draft. */
	function shortLabel(s: string, max = 32): string {
		const flat = String(s).replace(/\s+/g, ' ').trim();
		return flat.length > max ? `${flat.slice(0, max)}…` : flat;
	}

	// Placeholder text based on selection
	const placeholder = $derived(
		workspace.selection?.type === 'column'
			? `Ask about ${shortLabel((workspace.selection.data as { column: string }).column)}…`
			: workspace.selection?.type === 'text'
				? 'Ask about selected text…'
				: workspace.selection?.type === 'row'
					? `Ask about ${shortLabel(workspace.selection.label)}…`
					: workspace.selection?.type === 'cell'
						? `Ask about ${shortLabel(workspace.selection.label)}…`
						: 'Ask about this document…'
	);


	// ============================================================
	// Contract-lens suggested questions
	// ============================================================
	/** Starter questions surfaced as chips when the contract lens is active. */
	const contractSuggestions = [
		'What are the key obligations?',
		'Summarize the risky clauses',
		'Who are the parties and key dates?',
		'What standard clauses are missing?'
	];

	/** Fill the input with a suggested question and send it immediately. */
	function askSuggestion(q: string) {
		if (workspace.isLoading) return;
		inputText = q;
		sendMessage();
	}



	// ============================================================
	// LLM inference

	// ============================================================
	// ── Instant command detection — bypass LLM entirely ──────────────────────
	// Phrases that map to immediate actions without any model call.
	function tryInstantCommand(msg: string): boolean {
		const q = msg.toLowerCase().trim();

		// ── Clear chat messages ───────────────────────────────────────────────
		// "clear" / "clear chat" / "clear messages" / "new chat" / "/clear"
		const isClearChat = q === 'clear'
			|| q === 'clear chat'
			|| q === 'clear messages'
			|| q === 'new chat'
			|| q === '/clear'
			|| q === 'cls';

		if (isClearChat) {
			workspace.clearMessages();
			return true; // No reply message — chat is now empty
		}

		// ── Clear filter / show all rows ──────────────────────────────────────
		const isClearFilter = /\b(clear filter|reset filter|remove filter|show all|show all rows|reset view|clear search|no filter|unfilter)\b/.test(q)
			|| q === 'reset'
			|| q === 'show all';

		if (isClearFilter) {
			workspace.clearActiveFilter();
			workspace.clearActiveSort();
			workspace.addMessage({
				id: newId('msg'),
				role: 'assistant',
				content: 'Filter cleared. Showing all rows.',
				timestamp: new Date().toISOString()
			});
			return true;
		}

		return false;
	}

	async function runLLMInference(userMessage: string) {
		// Check for instant commands first — no LLM call needed
		if (tryInstantCommand(userMessage)) return;

		const summary = workspace.summary;
		const modelConfig = workspace.selectedModel;

		if (!summary) {
			workspace.addMessage({
				id: newId('msg'),
				role: 'assistant',
				content: 'Please upload a document first.',
				timestamp: new Date().toISOString()
			});
			return;
		}

		workspace.setAnalysisProgress({ step: 'Thinking…', percent: 5 });

		try {
			const { runChatInference } = await import('$lib/pipeline/analysis.js');

		// Build selection context if user has highlighted text/cells.
		//
		// For multi-sheet workbooks (.xlsx), prefix tabular selections with the
		// active sheet name so the LLM knows WHICH sheet the column/row/cell
		// belongs to. Single-sheet documents (CSV, or any workbook with one
		// sheet) get no prefix — it would be noise.
		let selectionContext: string | undefined;
		if (workspace.selection) {
			const wb = workspace.workbook;
			const sheetPrefix =
				wb && wb.sheets.length > 1 ? `Sheet: ${workspace.activeSheet}\n` : '';

			if (workspace.selection.type === 'text') {
				// Text selections come from document viewers (PDF/DOCX/TXT/MD),
				// which are never multi-sheet — leave as-is.
				selectionContext = (workspace.selection.data as { text: string }).text;
			} else if (workspace.selection.type === 'column') {
				selectionContext = `${sheetPrefix}Column: ${(workspace.selection.data as { column: string }).column}`;
			} else if (workspace.selection.type === 'row') {
				const d = workspace.selection.data as { rowIndex: number; rowData: Record<string, unknown> };
				const rowLines = Object.entries(d.rowData)
					.map(([k, v]) => `  ${k}: ${v}`)
					.join('\n');
				selectionContext = `${sheetPrefix}Row ${d.rowIndex + 1}:\n${rowLines}`;
			} else if (workspace.selection.type === 'cell') {
				// ← Previously missing: cell selection was silently dropped
				const d = workspace.selection.data as { column: string; rowIndex: number; value: unknown };
				selectionContext = `${sheetPrefix}Selected cell — Column: ${d.column}, Row: ${d.rowIndex + 1}, Value: ${d.value}`;
			}
		}

		// Contract lens: pass the locally-computed ContractProfile to the
		// inference layer. runChatInference takes a dedicated contract path that
		// builds a structured, risk-grouped prompt and applies anti-hallucination
		// guardrails — so chat answers reference the ACTUAL classified clauses
		// rather than the small model confabulating clause text/risk levels.
		const contractProfile =
			workspace.effectiveLens === 'contract' ? workspace.contractProfile : undefined;


		// Build queryContext for tabular files (CSV + Excel) so the query engine

		// can run real counts/filters/aggregates against the buffered rows before
		// the LLM call. Without this, Excel files fell through to the
		// conversational prompt and the small model looped on the column-profile
		// summary (e.g. repeating "Licensee | categorical | top …").
		let queryContext: import('$lib/pipeline/query.js').QueryContext | undefined;
		if (summary.fileType === 'csv' && workspace.csvRows.length > 0) {
			const csvData = workspace.file?.parsedData as import('$lib/types.js').CsvData | undefined;
			queryContext = {
				rows: workspace.csvRows,
				columns: csvData?.columns ?? [],
				columnProfiles: summary.columnProfiles ?? [],
				totalRowCount: workspace.streamingTotal > 0 ? workspace.streamingTotal : workspace.csvRows.length
			};
		} else if (summary.fileType === 'excel') {
			// Excel rows live on the active sheet (workspace.currentRows), not the
			// streaming csvRows buffer. Columns come from the active sheet headers.
			const sheet = workspace.currentSheet;
			const rows = workspace.currentRows;
			if (sheet && rows.length > 0) {
				queryContext = {
					rows,
					columns: sheet.headers,
					columnProfiles: summary.columnProfiles ?? [],
					totalRowCount: sheet.rowCount > 0 ? sheet.rowCount : rows.length
				};
			}
		}


		const result = await runChatInference(summary, userMessage, modelConfig, {
			onProgress(step, percent) {
				workspace.setAnalysisProgress({ step, percent });
				workspace.setModelLoadProgress(percent);
			},
			onModelProgress(percent) {
				workspace.setModelLoadProgress(percent);
			},
			selectionContext,
			queryContext,
			contractProfile: contractProfile ?? undefined,
			skipQueryEngine: pendingSkipQueryEngine
		});


		// One-shot: this flag only applies to the send it was queued for.
		pendingSkipQueryEngine = false;


			workspace.setAnalysisProgress(null);
			workspace.setModelLoadProgress(0);

			if (result.error) {
				workspace.addMessage({
					id: newId('msg'),
					role: 'assistant',
					content: `Error: ${result.error}`,
					timestamp: new Date().toISOString()
				});
			} else {
				workspace.addMessage({
					id: newId('msg'),
					role: 'assistant',
					content: result.text || '(No response generated)',
					timestamp: new Date().toISOString(),
					// Deterministic chart for "Analyze this column" output (null otherwise).
					chartSpec: result.chartSpec ?? null
				});
			}
		} catch (err) {
			workspace.setAnalysisProgress(null);
			workspace.setModelLoadProgress(0);
			workspace.setLoading(false);
			workspace.addMessage({
				id: newId('msg'),
				role: 'assistant',
				content: `Analysis failed: ${err instanceof Error ? err.message : String(err)}`,
				timestamp: new Date().toISOString()
			});
		}
	}

	function formatAnalysisAsMessage(sections: Record<string, unknown>): string {
		const lines: string[] = [];
		for (const [key, val] of Object.entries(sections)) {
			if (key === 'error') continue;
			const label = key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
			if (Array.isArray(val)) {
				lines.push(`**${label}:**`);
				for (const item of val) lines.push(`• ${item}`);
			} else if (typeof val === 'string' && val.trim()) {
				lines.push(`**${label}:** ${val}`);
			}
		}
		return lines.join('\n') || 'Analysis complete. Switch to the Insights tab to see results.';
	}

	// ============================================================
	// Send message
	// ============================================================
	async function sendMessage() {
		const text = inputText.trim();
		if (!text || workspace.isLoading) return;

		inputText = '';

		// Check for instant commands BEFORE adding the user message to the chat.
		// This prevents "clear" from appearing as a bubble before the chat is wiped.
		if (tryInstantCommand(text)) {
			setTimeout(() => {
				if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
			}, 0);
			return;
		}

		const msg: ChatMessage = {
			id: newId('msg'),
			role: 'user',
			content: text,
			timestamp: new Date().toISOString(),
			selectionContext: workspace.selection ?? undefined
		};

		workspace.addMessage(msg);
		// Use setLoading instead of startAnalysis — does NOT change step or activeTab
		workspace.setLoading(true);

		// Scroll to bottom after DOM update
		setTimeout(() => {
			if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
		}, 0);

		await runLLMInference(text);

		workspace.setLoading(false);
		setTimeout(() => {
			if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
		}, 0);
	}

	function handleKeyDown(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			sendMessage();
		}
	}

	function formatTime(iso: string): string {
		return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
	}

	// Progress display
	const progressStep = $derived(workspace.analysisProgress?.step ?? '');
	const progressPct = $derived(workspace.analysisProgress?.percent ?? 0);
	const modelPct = $derived(workspace.modelLoadProgress);
</script>

<!-- Transient "Copied" / "Copied row" feedback from context-menu copy actions.
     (The chat-prefill pull listener is registered imperatively in onMount —
     custom events aren't typed on <svelte:window>.) -->
<Toast />


<div class="flex flex-col h-full bg-surface dark:bg-slate-950">


	<!-- Messages area -->
	<div
		bind:this={messagesEl}
		class="flex-1 overflow-y-auto p-4 space-y-4 min-h-0"
	>
		{#if workspace.messages.length === 0}
			<!-- This pane is only mounted after a file is uploaded (Workspace
			     hides the right panel before upload), so we never need the
			     "upload a file to start chatting" prompt here. -->
			<div class="h-full flex flex-col items-center justify-center text-center py-8">
				<div class="text-3xl mb-3">💬</div>
				<p class="text-sm font-medium text-gray-500 dark:text-gray-400">
					Ask a question about your document
				</p>
				<p class="text-xs text-gray-400 dark:text-gray-600 mt-1">Select text or a column, then ask a question</p>

				<!-- Contract-lens suggested questions — tuned to the detected lens.
				     Clicking a chip fills the input and sends it immediately. -->
				{#if workspace.hasFile && workspace.effectiveLens === 'contract'}
					<div class="mt-5 flex flex-wrap items-center justify-center gap-2 max-w-sm">
						{#each contractSuggestions as q}
							<button
								onclick={() => askSuggestion(q)}
								disabled={workspace.isLoading}
								class="text-xs px-3 py-1.5 rounded-full border border-gray-300 dark:border-slate-700 text-gray-600 dark:text-gray-300
									hover:border-blue-600 hover:text-blue-600 hover:bg-blue-50 dark:hover:text-blue-300 dark:hover:bg-blue-950/30 transition-colors
									disabled:opacity-50 disabled:cursor-not-allowed"
							>
								{q}
							</button>
						{/each}
					</div>
				{/if}
			</div>

		{:else}
			{#each workspace.messages as msg (msg.id)}
				<div class="flex {msg.role === 'user' ? 'justify-end' : 'justify-start'}">
					<div class="max-w-[85%] space-y-1">
						<!-- Selection context badge -->
						{#if msg.selectionContext}
							<div class="flex {msg.role === 'user' ? 'justify-end' : 'justify-start'}">
								<span class="text-[10px] px-2 py-0.5 rounded-full bg-blue-100 dark:bg-blue-900/40 border border-blue-300 dark:border-blue-800 text-blue-700 dark:text-blue-400">
									Re: {msg.selectionContext.label}
								</span>
							</div>
						{/if}

						<!-- Message bubble. When a deterministic chart is attached we split
						     the content on CHART_SLOT and render header → chart → body. -->
						{#if msg.role === 'assistant' && msg.chartSpec}
							{@const parts = splitChartContent(msg.content)}
							<div class="px-4 py-2.5 rounded-2xl text-sm leading-relaxed
								bg-gray-100 text-gray-800 border border-gray-200 dark:bg-slate-800 dark:text-gray-200 rounded-bl-sm dark:border-slate-700 space-y-3">
								{#if parts.header.trim()}
									<div class="whitespace-pre-wrap">{parts.header.trim()}</div>
								{/if}
								<div class="rounded-lg bg-white/60 dark:bg-slate-900/40 p-2">
									<VegaChart spec={msg.chartSpec} label="Column analysis chart" />
								</div>
								{#if parts.body.trim()}
									<div class="whitespace-pre-wrap">{parts.body.trim()}</div>
								{/if}
							</div>
						{:else}
							<div class="px-4 py-2.5 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap
								{msg.role === 'user'
									? 'bg-blue-700 text-white rounded-br-sm'
									: 'bg-gray-100 text-gray-800 rounded-bl-sm border border-gray-200 dark:bg-slate-800 dark:text-gray-200 dark:border-slate-700'}">
								{msg.content.split(CHART_SLOT).join('\n')}
							</div>
						{/if}

						<!-- Timestamp -->
						<div class="flex {msg.role === 'user' ? 'justify-end' : 'justify-start'}">
							<span class="text-[10px] text-gray-400 dark:text-gray-700">{formatTime(msg.timestamp)}</span>
						</div>
					</div>
				</div>
			{/each}

			<!-- Loading indicator -->
			{#if workspace.isLoading}
				<div class="flex justify-start">
					<div class="px-4 py-3 rounded-2xl rounded-bl-sm bg-gray-100 border border-gray-200 dark:bg-slate-800 dark:border-slate-700 space-y-2 min-w-[200px]">
						{#if progressStep}
							<div class="flex items-center gap-2">
								<div class="w-3 h-3 rounded-full border border-blue-500 border-t-transparent animate-spin flex-shrink-0"></div>
								<span class="text-xs text-gray-700 dark:text-gray-300">{progressStep}</span>
							</div>
							{#if progressPct > 0}
								<div class="w-full h-1 bg-gray-300 dark:bg-slate-700 rounded-full overflow-hidden">
									<div class="h-full bg-blue-600 rounded-full transition-all duration-300" style="width: {progressPct}%"></div>
								</div>
								<div class="flex justify-between text-[10px] text-gray-400 dark:text-gray-600">
									<span>{progressPct}%</span>
									{#if modelPct > 0 && modelPct < 100}
										<span>Model: {modelPct}%</span>
									{/if}
								</div>
							{/if}
						{:else}
							<LoadingSpinner size="sm" />
						{/if}
					</div>
				</div>
			{/if}
		{/if}
	</div>

	<!-- Input area -->
	<div class="flex-shrink-0 border-t border-gray-200 dark:border-slate-800 p-3 space-y-2">

		<!-- Selection chip -->
		{#if workspace.selection}
			<div class="flex items-center gap-2">
				<span class="text-[10px] text-gray-500 uppercase tracking-wide">Context:</span>
				<span class="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-blue-100 dark:bg-blue-900/40 border border-blue-300 dark:border-blue-800 text-blue-700 dark:text-blue-300 text-xs">
					{workspace.selection.label}
					<button
						onclick={() => workspace.clearSelection()}
						class="text-blue-500 hover:text-blue-700 dark:hover:text-blue-300 transition-colors"
						aria-label="Clear selection"
					>✕</button>
				</span>
			</div>
		{/if}

		<!-- Input row -->
		<div class="flex items-end gap-2">
			{#if isTabular}
				<button
					type="button"
					onclick={() => (showGuide = true)}
					class="flex-shrink-0 w-9 h-9 rounded-xl bg-gray-100 hover:bg-gray-200 border border-gray-200 dark:bg-slate-800 dark:hover:bg-slate-700 dark:border-slate-700
						text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 flex items-center justify-center transition-colors"
					aria-label="How to query this data"
					title="How to query this data"
				>
					<span class="text-sm font-semibold">?</span>
				</button>
			{/if}
			<textarea
				bind:this={inputEl}

				bind:value={inputText}
				onkeydown={handleKeyDown}
				onfocus={consumeChatPrefill}
				{placeholder}

				disabled={!workspace.hasFile}
				rows={1}

				class="flex-1 resize-none rounded-xl bg-gray-100 border border-gray-200 text-sm text-gray-800
					placeholder-gray-400 dark:bg-slate-800 dark:border-slate-700 dark:text-gray-200 dark:placeholder-gray-600
					px-3 py-2.5 focus:outline-none focus:border-blue-600 focus:ring-1
					focus:ring-blue-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed
					max-h-32 overflow-y-auto"
				style="field-sizing: content"
			></textarea>
			<button
				onclick={sendMessage}
				disabled={!inputText.trim() || workspace.isLoading || !workspace.hasFile}
				class="flex-shrink-0 w-9 h-9 rounded-xl bg-blue-700 hover:bg-blue-600 disabled:opacity-40
					disabled:cursor-not-allowed text-white flex items-center justify-center transition-colors"
				aria-label="Send message"
			>
				<svg class="w-4 h-4" viewBox="0 0 16 16" fill="currentColor">
					<path d="M1.5 1.5l13 6.5-13 6.5V9.5l9-3-9-3V1.5z"/>
				</svg>
			</button>
		</div>

		<!-- Model size warning (shown when model not yet loaded) -->
		{#if workspace.hasFile && !workspace.isLoading && workspace.messages.length === 0}
			<p class="text-[10px] text-gray-400 dark:text-gray-600 text-center">
			<!--	First message downloads the AI model (~500MB). Subsequent messages use cache.!-->
			</p>
			<!-- Persistent AI-mistakes disclaimer. Visible alongside every chat
			     surface so the caveat stays anchored to AI output, not just to
			     the one-time bandwidth hint above. role="note" + aria-label let
			     screen readers announce it consistently. -->
			<p
				class="text-[10px] text-gray-500 text-center mt-1"
				role="note"
				aria-label="AI disclaimer"
			>
				First message downloads the model of your choice. Subsequent messages use cache. AI-generated. Verify important information — AI makes frequent mistakes.
			</p>
		{/if}
	</div>
</div>

<!-- ============================================================ -->
<!-- CSV/Excel query guide — overlay popup opened from the "?" button -->
<!-- ============================================================ -->
<Modal open={showGuide} title="Querying your data" onclose={() => (showGuide = false)}>

		<div class="space-y-4 text-sm text-gray-700 dark:text-gray-300">
			<p class="text-gray-500 dark:text-gray-400">
				Ask questions about your spreadsheet in plain English. The chat runs real
				counts, filters and aggregates over your rows, then the AI explains the result —
				your data never leaves the browser.
			</p>

			<div>
				<h3 class="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-1.5">Ask anything</h3>
				<ul class="space-y-1">
					<li>• <span class="text-gray-800 dark:text-gray-200">How many rows where Status is Active?</span></li>
					<li>• <span class="text-gray-800 dark:text-gray-200">Average Revenue by Region</span></li>
					<li>• <span class="text-gray-800 dark:text-gray-200">Top 5 customers by total spend</span></li>
				</ul>
			</div>

			<div>
				<h3 class="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-1.5">Filter &amp; sort</h3>
				<ul class="space-y-1">
					<li>• <span class="text-gray-800 dark:text-gray-200">Show rows where Amount &gt; 1000</span></li>
					<li>• <span class="text-gray-800 dark:text-gray-200">Sort by Date descending</span></li>
					<li>• Type <span class="text-gray-800 dark:text-gray-200">clear filter</span> or <span class="text-gray-800 dark:text-gray-200">show all</span> to reset the view</li>
				</ul>
			</div>

			<div>
				<h3 class="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-1.5">Use a selection</h3>
				<p>
					Click a column, row or cell in the sheet first, then ask
					<span class="text-gray-800 dark:text-gray-200">"summarize this"</span> — your selection becomes the
					context for the question.
				</p>
			</div>

			<div>
				<h3 class="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-1.5">Tips</h3>
				<ul class="space-y-1">
					<li>• Use exact column names as they appear in the sheet.</li>
					<li>• The first message downloads the AI model (~500MB, one-time); later messages use the cache.</li>
					<li>• Type <span class="text-gray-800 dark:text-gray-200">clear</span> to wipe the chat history.</li>
				</ul>
			</div>
		</div>
	</Modal>



