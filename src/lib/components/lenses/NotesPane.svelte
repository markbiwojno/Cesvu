<script lang="ts">
	/**
	 * NotesPane.svelte — the right-hand pane for the contract lens, AND the
	 * right-hand pane for the CSV/XLSX workbench when a cell-level note
	 * exists.
	 *
	 * Renders the user's notes as a list of editable, chat-style bubbles. Each
	 * bubble shows the author + timestamp, the note body, and edit/delete
	 * actions. Notes are anchored to either:
	 *   - a character offset in the contract text (prose) — created from a
	 *     pin drop in ClauseHighlighter
	 *   - a { sheet, column, rowIndex } cell coordinate (cell) — created from
	 *     the right-click "Add note" in the spreadsheet viewers
	 *
	 * The bubble UI is identical for both anchor kinds — only the chip
	 * rendered in the header differs (prose: a short text excerpt; cell:
	 * "Sheet1 · LicenseNo · row 42" with column-tinted color). Clicking a
	 * bubble asks the right viewer to scroll/flash the matching pin: prose
	 * uses `workspace.requestScrollToNote(id)` (consumed by the contract
	 * viewer), cell uses `workspace.requestScrollToCell(sheet, column,
	 * rowIndex)` (consumed by the active tabular viewer).
	 *
	 * Cross-pane coordination (via the workspace store, never direct imports):
	 *   - workspace.focusNoteId  → when set, scroll to that note's bubble and
	 *     focus its textarea (a pin was just dropped or clicked). Consumed here.
	 *
	 * No LLM. No model download. Pure local note-taking.
	 */
	import { workspace } from '$lib/stores/workspace.svelte.js';
	import { notesStore, type Note } from '$lib/stores/notesStore.svelte.js';

	/**
	 * True when the active file is a PDF — the only file type where the
	 * contract and document lenses place a prose note's pin with different
	 * precision (ClauseHighlighter: exact DOM offset; PdfViewer: approximate
	 * proportional offset). Drives the accuracy indicator below.
	 */
	const isPdf = $derived(workspace.file?.type === 'pdf');

	/** id → textarea, so focusNoteId can focus the right editor. */
	let editors = $state<Record<string, HTMLTextAreaElement>>({});
	let listEl = $state<HTMLDivElement | null>(null);

	/** Whether the header "Notes as: ___" name chip is in edit mode. */
	let editingAuthorName = $state(false);
	/** Draft value while editing the header name chip. */
	let authorNameDraft = $state('');

	function startEditAuthorName() {
		authorNameDraft = notesStore.getStoredAuthorName();
		editingAuthorName = true;
	}

	function commitAuthorName() {
		notesStore.setStoredAuthorName(authorNameDraft);
		editingAuthorName = false;
	}


	function formatTime(ms: number): string {
		const d = new Date(ms);
		const today = new Date();
		const sameDay =
			d.getFullYear() === today.getFullYear() &&
			d.getMonth() === today.getMonth() &&
			d.getDate() === today.getDate();
		const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
		return sameDay ? time : `${d.toLocaleDateString()} ${time}`;
	}

	/** Edit the note body (persists on every keystroke — cheap, IDB is async). */
	function onInput(id: string, value: string) {
		notesStore.updateNote(id, value);
	}

	function onDelete(id: string) {
		notesStore.removeNote(id);
	}

	/**
	 * Render the anchor chip for a note. The same NotesPane bubble hosts
	 * both prose and cell notes; the chip is the ONLY visual difference.
	 *
	 *   prose: "Clause 3: Termination…" (text excerpt, fallback to a 32-char
	 *          slice of the document around the offset)
	 *   cell:  "Sheet1 · LicenseNo · row 42" (column-tinted chip)
	 *   column-level (rowIndex = -1): "Sheet1 · LicenseNo" (the whole column)
	 */
	function anchorChip(note: Note): { kind: 'prose' | 'cell'; text: string; column: string | null } {
		if (note.anchor.kind === 'cell') {
			const col = note.anchor.column;
			const row = note.anchor.rowIndex;
			return {
				kind: 'cell',
				text:
					row === -1
						? `${note.anchor.sheet || '(no sheet)'} · ${col}`
						: `${note.anchor.sheet || '(no sheet)'} · ${col} · row ${row + 1}`,
				column: col
			};
		}
		// prose — produce a short text excerpt. The contract viewer's pin
		// rendering already knows the surrounding text; here we just show
		// "Clause N" as a positional hint. The user can click the bubble
		// to scroll to it and read the actual text in the document.
		return { kind: 'prose', text: `Clause at offset ${note.anchor.offset}`, column: null };
	}

	/**
	 * Clicking a bubble asks the active viewer to scroll/flash the matching
	 * pin. The dispatch is anchor-aware:
	 *
	 *   - cell → workspace.requestScrollToCell(sheet, column, rowIndex)
	 *   - prose → workspace.requestScrollToNote(id) (the contract viewer
	 *     resolves id → offset internally)
	 */
	function onBubbleClick(note: Note) {
		if (note.anchor.kind === 'cell') {
			workspace.requestScrollToCell(
				note.anchor.sheet,
				note.anchor.column,
				note.anchor.rowIndex
			);
		} else {
			workspace.requestScrollToNote(note.id);
		}
	}

	/**
	 * Consume the focus-note signal: scroll the matching bubble into view and
	 * focus its textarea so the user can type immediately after dropping a pin.
	 * PULL pattern — cleared right after consuming so it never re-fires.
	 */
	$effect(() => {
		const id = workspace.focusNoteId;
		if (!id) return;
		// Defer one tick so the bubble is in the DOM (note was just added).
		queueMicrotask(() => {
			const ta = editors[id];
			if (ta) {
				ta.scrollIntoView({ behavior: 'smooth', block: 'center' });
				ta.focus();
			}
			workspace.clearFocusNote();
		});
	});
</script>

<div class="flex flex-col h-full bg-surface dark:bg-slate-950">
	<!-- Header -->
	<div class="flex-shrink-0 flex items-center justify-between px-4 py-2.5 border-b border-gray-200 dark:border-slate-800">
		<div class="flex items-center gap-2">
			<span class="text-sm">📝</span>
			<h2 class="text-sm font-semibold text-gray-800 dark:text-gray-200">Notes</h2>
			{#if notesStore.count > 0}
				<span class="text-[10px] px-1.5 py-0.5 rounded-full bg-gray-200 dark:bg-slate-800 text-gray-600 dark:text-gray-400">
					{notesStore.count}
				</span>
			{/if}
		</div>
		{#if editingAuthorName}
			<input
				value={authorNameDraft}
				oninput={(e) => (authorNameDraft = e.currentTarget.value)}
				onblur={commitAuthorName}
				onkeydown={(e) => {
					if (e.key === 'Enter') { e.currentTarget.blur(); }
					else if (e.key === 'Escape') { editingAuthorName = false; }
				}}
				autofocus
				maxlength={64}
				placeholder="Your name"
				class="text-[10px] w-24 bg-white dark:bg-slate-900 border border-gray-300 dark:border-slate-700 rounded px-1.5 py-0.5
					text-gray-700 dark:text-gray-300 placeholder-gray-400 dark:placeholder-gray-600 focus:outline-none focus:border-blue-600"
			/>
		{:else}
			<button
				onclick={startEditAuthorName}
				class="text-[10px] text-gray-400 hover:text-gray-600 dark:text-gray-600 dark:hover:text-gray-400 transition-colors"
				title="Set the name shown on your new notes"
			>
				Notes as: <span class="text-gray-600 dark:text-gray-400 font-medium">{notesStore.getStoredAuthorName()}</span> ✎
			</button>
		{/if}
	</div>

	<!-- Body -->
	<div bind:this={listEl} class="flex-1 overflow-y-auto p-4 space-y-3 min-h-0">
		{#if notesStore.count === 0}
			<!-- Empty state -->
			<div class="h-full flex flex-col items-center justify-center text-center py-8">
				<div class="text-3xl mb-3">📌</div>
				<p class="text-sm font-medium text-gray-500 dark:text-gray-400">No notes yet</p>
				<p class="text-xs text-gray-400 dark:text-gray-600 mt-1 max-w-xs">
					Turn on <span class="text-gray-600 dark:text-gray-400 font-medium">Notes</span> in the document toolbar,
					then click anywhere in the contract to pin a note here.
					<br />
					Or right-click a cell in the spreadsheet to add a cell-anchored note.
				</p>
			</div>
		{:else}
			{#each notesStore.notes as note, i (note.id)}
				{@const chip = anchorChip(note)}
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<div
					class="rounded-xl border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800/60 p-3 space-y-2 cursor-pointer
						hover:border-blue-400 dark:hover:border-blue-700/70 transition-colors"
					onclick={() => onBubbleClick(note)}
				>
					<!-- Bubble header -->
					<div class="flex items-center justify-between gap-2">
						<div class="flex items-center gap-2 min-w-0">
							<span
								class="flex-shrink-0 w-5 h-5 rounded-full bg-amber-500/90 text-gray-900 text-[10px]
									font-bold flex items-center justify-center"
							>
								{i + 1}
							</span>
							<input
								value={note.author}
								oninput={(e) => notesStore.updateAuthor(note.id, e.currentTarget.value)}
								onclick={(e) => e.stopPropagation()}
								maxlength={64}
								placeholder="Author"
								class="text-xs font-medium text-gray-700 dark:text-gray-300 truncate bg-transparent border-none
									focus:outline-none focus:ring-1 focus:ring-blue-600 rounded px-0.5 -mx-0.5
									min-w-0 max-w-[7rem]"
							/>
							<span class="text-[10px] text-gray-400 dark:text-gray-600 flex-shrink-0">{formatTime(note.createdAt)}</span>
						</div>
						<button
							onclick={(e) => { e.stopPropagation(); onDelete(note.id); }}
							class="flex-shrink-0 text-gray-400 hover:text-red-600 dark:text-gray-600 dark:hover:text-red-400 transition-colors text-xs"
							aria-label="Delete note"
							title="Delete note"
						>
							✕
						</button>
					</div>

					<!-- Anchor chip (the visual differentiator between prose and cell notes).
					     Both bubbles still live in the same NotesPane — only this row
					     changes per anchor kind. Click the bubble (above) to jump to the
					     matching location. -->
				<div class="flex items-center gap-1.5 text-[10px] min-w-0">
						{#if chip.kind === 'cell'}
							<!-- Cell-anchored: "Sheet · column · row N" with the column name
							     tinted (sky-300, matching the column-badge color used in the
							     table viewers' profile badges). `min-w-0 max-w-full` lets the
							     flex chip shrink so the inner `truncate` can ellipsize a long
							     column name (e.g. a header-less CSV) instead of running off. -->
							<span
								class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded
									bg-sky-100 dark:bg-sky-950/60 border border-sky-300 dark:border-sky-900 text-sky-700 dark:text-sky-300
									font-mono tabular-nums min-w-0 max-w-full"
								title={chip.text}
							>
								<span class="text-sky-600 dark:text-sky-500 flex-shrink-0">▦</span>
								<span class="truncate">{chip.text}</span>
							</span>
						{:else}
							<!-- Prose-anchored: short "Clause at offset N" hint. The exact
							     clause text is rendered by the document pin itself. -->
							<span
								class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded
									bg-gray-100 dark:bg-slate-900 border border-gray-200 dark:border-slate-700 text-gray-500 dark:text-gray-400 font-mono tabular-nums
									min-w-0 max-w-full"
								title={chip.text}
							>
								<span class="text-gray-400 dark:text-gray-500 flex-shrink-0">¶</span>
								<span class="truncate">{chip.text}</span>
							</span>

							<!-- PDF pin-accuracy indicator — same horizontal row as the chip
							     above. PDFs are the ONLY file type where the contract lens
							     (exact DOM offset) and document lens (approximate
							     proportional offset, see PdfViewer.svelte) can disagree on
							     where a note's pin actually lands. Green check = this note
							     was created in the lens you're currently viewing, so its
							     pin here is accurate. Amber ≈ = it was created in the OTHER
							     lens, so the pin here is only approximate. Neither renders
							     for notes created before this field existed (unknown). -->
							{#if isPdf && note.createdInLens}
								{#if note.createdInLens === workspace.effectiveLens}
									<span
										class="text-green-500 dark:text-green-400 flex-shrink-0 text-xs leading-none"
										title="Created in this lens — position is accurate."
										aria-label="Position accurate in this lens"
									>✓</span>
								{:else}
									<span
										class="text-amber-500 dark:text-amber-400 flex-shrink-0 text-xs leading-none"
										title="Approximate — it was placed in the other lens. Switch to the other lens for the exact position."
										aria-label="Position approximate in this lens"
									>≈</span>
								{/if}
							{/if}
						{/if}
					</div>


					<!-- Editor -->
					<!-- svelte-ignore a11y_click_events_have_key_events -->
					<textarea
						bind:this={editors[note.id]}
						value={note.body}
						oninput={(e) => onInput(note.id, e.currentTarget.value)}
						onclick={(e) => e.stopPropagation()}
						placeholder="Write your note…"
						rows={2}
						class="w-full resize-none rounded-lg bg-gray-50 dark:bg-slate-900 border border-gray-200 dark:border-slate-700 text-sm text-gray-800 dark:text-gray-200
							placeholder-gray-400 dark:placeholder-gray-600 px-2.5 py-2 focus:outline-none focus:border-blue-600
							focus:ring-1 focus:ring-blue-600 transition-colors max-h-40 overflow-y-auto"
						style="field-sizing: content"
					></textarea>
				</div>
			{/each}
		{/if}
	</div>

	<!-- Footer hint -->
	<div class="flex-shrink-0 border-t border-gray-200 dark:border-slate-800 px-4 py-2">
		<p class="text-[10px] text-gray-400 dark:text-gray-600 text-center">
			Notes stay on your device and travel inside the encrypted export.
		</p>
	</div>
</div>
