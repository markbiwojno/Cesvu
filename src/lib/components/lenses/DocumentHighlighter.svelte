<script lang="ts">
	/**
	 * DocumentHighlighter.svelte — note-capable plain-text reading surface for the
	 * DOCUMENT lens (txt / md / docx).
	 *
	 * This is a deliberately slimmed-down sibling of ClauseHighlighter: it shares
	 * the EXACT same note-taking UX (Notes mode toggle → click drops an amber pin
	 * at a character offset, pins render as a scroll-aware overlay, clicking a pin
	 * focuses its bubble in the Notes pane) but drops everything clause-specific
	 * (marking, merge/split, glossary, red flags, perspective).
	 *
	 * Why notes cross both lenses automatically:
	 *   Both this component and ClauseHighlighter render the SAME normalized
	 *   `documentText` string and read/write the SAME notesStore (bound to the
	 *   active document). A note pinned at offset 1450 in the contract lens is at
	 *   offset 1450 here — identical text, identical char offsets, identical
	 *   persisted format (DocumentAnnotation with a prose anchor). Switching lenses
	 *   only changes which surface paints the pins.
	 *
	 * Offset mapping:
	 *   The whole document is rendered inside ONE `<span data-base="0">` text node.
	 *   A click → caretRange → (text node, offsetInNode) maps to a document offset
	 *   by reading the nearest data-base ancestor (always 0 here) + offsetInNode.
	 *   rangeForOffset() does the reverse for pin placement. One span keeps this
	 *   exact and trivial; contracts/documents are tens of KB, well within a single
	 *   text node's comfort zone.
	 */
	import { tick } from 'svelte';
	import { workspace } from '$lib/stores/workspace.svelte.js';
	import { notesStore } from '$lib/stores/notesStore.svelte.js';

	interface Props {
		/** Full document text to display + pin notes over. */
		text: string;
		/** Selection → AI context (mirrors the old txt/docx "+ Add to context"). */
		onAddToContext?: (text: string) => void;
	}

	let { text, onAddToContext }: Props = $props();

	/** The scroll/selection container. Pin coords are computed relative to it. */
	let containerEl = $state<HTMLDivElement | null>(null);

	/** Whether note pins are shown on the document. User-toggleable, on by default. */
	let showNotePins = $state(true);

	const notesMode = $derived(workspace.notesMode);

	// ── Selection → document offset mapping ───────────────────────────────────

	/**
	 * Map a (text node, offsetInNode) pair to a document character offset using
	 * the nearest ancestor carrying data-base. Returns null if the node isn't
	 * inside the base-tagged span (e.g. selection strayed outside the text).
	 */
	function offsetOf(node: Node, offsetInNode: number): number | null {
		let el: Node | null = node;
		if (el.nodeType === Node.TEXT_NODE) el = el.parentElement;
		while (el && el instanceof HTMLElement) {
			const base = el.getAttribute('data-base');
			if (base !== null) return parseInt(base, 10) + offsetInNode;
			el = el.parentElement;
		}
		return null;
	}

	/** Map a click event to its document offset, or `fallback` if unresolved. */
	function clickOffset(e: MouseEvent, fallback: number): number {
		const doc = document as Document & {
			caretRangeFromPoint?: (x: number, y: number) => Range | null;
		};
		if (doc.caretRangeFromPoint) {
			const range = doc.caretRangeFromPoint(e.clientX, e.clientY);
			if (range) {
				const off = offsetOf(range.startContainer, range.startOffset);
				if (off !== null) return off;
			}
		}
		return fallback;
	}

	// ── Selection → context (preserve the document lens's old behavior) ───────

	function handleMouseUp() {
		const sel = window.getSelection();
		if (!sel || sel.isCollapsed) return;
		const selected = sel.toString().trim();
		if (selected.length < 3) return;
		onAddToContext?.(selected);
	}

	// ── Note-taking ───────────────────────────────────────────────────────────

	/** Just-dropped/focused pin id — drives the pin pulse animation. */
	let flashedNoteId = $state<string | null>(null);

	/** A note pin positioned for rendering (container-relative px). */
	interface PinPos {
		id: string;
		index: number;
		x: number;
		y: number;
	}
	let pinPositions = $state<PinPos[]>([]);

	/**
	 * In notesMode, a click that ISN'T a text selection drops a pin at the
	 * clicked offset. A real selection means the user is highlighting to add to
	 * context (handled by mouseup), so we bail in that case.
	 */
	function handleSurfaceClick(e: MouseEvent) {
		if (!notesMode) return;
		const sel = window.getSelection();
		if (sel && !sel.isCollapsed) return;
		const target = e.target as HTMLElement | null;
		if (target && target.closest('[data-note-pin]')) return;
		const offset = clickOffset(e, -1);
		if (offset < 0) return;
		dropNoteAt(offset);
	}

	/** Create a note at a document offset, flash its pin, and focus its editor. */
	function dropNoteAt(offset: number) {
		if (offset < 0) return;
		const note = notesStore.addNote(offset);
		flashedNoteId = note.id;
		setTimeout(() => {
			if (flashedNoteId === note.id) flashedNoteId = null;
		}, 1200);
		tick().then(() => {
			recomputePins();
			// The Notes pane is a popover only MOUNTED while
			// workspace.openPane.kind === 'notes' — must open it before focusing,
			// otherwise requestFocusNote() fires into an unmounted pane and the
			// newly-created note appears to do nothing. Mirrors onPinClick below.
			if (workspace.openPane?.kind !== 'notes') workspace.openNotesPane();
			workspace.requestFocusNote(note.id);
		});
	}


	/**
	 * Locate the rendered text node + in-node offset for a document character
	 * offset by scanning the base-tagged span(s). Returns null if unresolvable.
	 */
	function rangeForOffset(offset: number): Range | null {
		if (!containerEl) return null;
		const spans = containerEl.querySelectorAll('[data-base]');
		let best: { node: Node; inNode: number } | null = null;
		for (const el of spans) {
			const base = parseInt(el.getAttribute('data-base') ?? '', 10);
			if (Number.isNaN(base)) continue;
			const node = el.firstChild;
			if (!node || node.nodeType !== Node.TEXT_NODE) continue;
			const len = node.textContent?.length ?? 0;
			if (offset >= base && offset <= base + len) {
				best = { node, inNode: offset - base };
				break;
			}
		}
		if (!best) return null;
		const range = document.createRange();
		try {
			range.setStart(best.node, best.inNode);
			range.setEnd(best.node, best.inNode);
		} catch {
			return null;
		}
		return range;
	}

	/** Recompute every pin's container-relative position from its offset. */
	function recomputePins() {
		if (!containerEl) {
			pinPositions = [];
			return;
		}
		const cRect = containerEl.getBoundingClientRect();
		const out: PinPos[] = [];
		// Prose-only: cell notes live in the tabular viewers and have no char
		// offset to anchor on here.
		const proseNotes = notesStore.notes.filter((n) => n.anchor.kind === 'prose');
		proseNotes.forEach((n, i) => {
			const range = rangeForOffset(n.anchor.kind === 'prose' ? n.anchor.offset : 0);
			if (!range) return;
			const rect = range.getBoundingClientRect();
			out.push({
				id: n.id,
				index: i + 1,
				x: rect.left - cRect.left + containerEl!.scrollLeft,
				y: rect.top - cRect.top + containerEl!.scrollTop
			});
		});
		pinPositions = out;
	}

	// Recompute pin positions whenever the note list or text changes.
	$effect(() => {
		void notesStore.notes.length;
		void text;
		tick().then(recomputePins);
	});

	// Reposition pins on container scroll/resize (positions are scroll-relative).
	$effect(() => {
		const el = containerEl;
		if (!el) return;
		const onScroll = () => recomputePins();
		el.addEventListener('scroll', onScroll, { passive: true });
		window.addEventListener('resize', onScroll);
		return () => {
			el.removeEventListener('scroll', onScroll);
			window.removeEventListener('resize', onScroll);
		};
	});

	/**
	 * Clicking a pin focuses that note's editor in the Notes pane. For the
	 * document lens the Notes pane is a popover that is only MOUNTED while
	 * workspace.openPane.kind === 'notes' (see Workspace.svelte) — so we must
	 * open it FIRST, otherwise requestFocusNote() fires into an unmounted pane
	 * and nothing happens. Mirrors the CSV path's onPinClick in DocumentPane.
	 */
	function onPinClick(e: MouseEvent, id: string) {
		e.stopPropagation();
		if (workspace.openPane?.kind !== 'notes') workspace.openNotesPane();
		workspace.requestFocusNote(id);
	}


	// ── Consume the PULL scroll-to-note signal (Insights bubble → document). ──
	$effect(() => {
		const id = workspace.scrollToNoteId;
		if (!id || !containerEl) return;
		(async () => {
			await tick();
			recomputePins();
			const note = notesStore.notes.find((n) => n.id === id);
			if (note && note.anchor.kind === 'prose') {
				// The ENTIRE document is one <span data-base="0">, so the range's
				// parentElement is that whole-document span — calling scrollIntoView
				// on it centers the document's midpoint, not the note (the overshoot
				// bug). Scroll by the range's own geometry instead, exactly like
				// recomputePins() positions the pins, so we land on the offset.
				const range = rangeForOffset(note.anchor.offset);
				if (range && containerEl) {
					const rect = range.getBoundingClientRect();
					const cRect = containerEl.getBoundingClientRect();
					const target =
						rect.top - cRect.top + containerEl.scrollTop - containerEl.clientHeight / 2;
					const maxTop = containerEl.scrollHeight - containerEl.clientHeight;
					containerEl.scrollTo({
						top: Math.max(0, Math.min(target, maxTop)),
						behavior: 'smooth'
					});
				}
				flashedNoteId = id;
				setTimeout(() => {
					if (flashedNoteId === id) flashedNoteId = null;
				}, 1600);
			}

			workspace.clearScrollToNote();
		})();
	});
</script>

<div class="relative h-full min-w-0 flex flex-col overflow-hidden">

	<!-- Toolbar: Notes mode toggle + show/hide pins (mirrors ClauseHighlighter's
	     notes controls so the document lens has the same affordances). -->
	<div class="flex flex-wrap items-center gap-2 px-4 py-2 border-b border-gray-200 dark:border-slate-800 bg-gray-50 dark:bg-slate-900/60 flex-shrink-0">
		<svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor" class="w-3.5 h-3.5 text-amber-500 dark:text-amber-400 flex-shrink-0">
			<path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z"/>
		</svg>
		<p class="text-xs text-gray-500 dark:text-gray-400 flex-1 min-w-[10rem]">

			Turn on <strong class="text-gray-700 dark:text-gray-200">Notes</strong>, then click anywhere in the document to
			pin a note.
		</p>

		<div class="ml-auto flex flex-wrap items-center justify-end gap-2.5 min-w-0">
			<!-- Label is "Add Note" (not "Notes") with a pin-shaped icon matching the
			     actual note-pin marker, and a blue (not amber) active state — mirrors
			     the same fix in ClauseHighlighter.svelte for consistency across the
			     contract and document lenses. -->
			<button
				type="button"
				onclick={() => workspace.setNotesMode(!notesMode)}
				class="inline-flex items-center gap-1.5 text-[11px] px-2 py-1 rounded border transition-colors
					{notesMode
						? 'bg-blue-600 text-white border-blue-500 font-semibold'
						: 'border-gray-300 text-gray-600 hover:text-gray-900 hover:border-gray-500 dark:border-gray-600 dark:text-gray-300 dark:hover:text-white dark:hover:border-gray-400'}"
				title={notesMode
					? 'Add Note mode on — click the document to drop a note. Click to turn off.'
					: 'Turn on Add Note mode, then click anywhere in the document to pin a note.'}
				aria-pressed={notesMode}
			>
				<svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor" class="w-3 h-3">
					<path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z"/>
				</svg>
				Add Note
			</button>


			<label
				class="inline-flex items-center gap-1.5 text-[11px] text-gray-500 dark:text-gray-400 cursor-pointer select-none"
				title="Show or hide note pins on the document"
			>
				<input type="checkbox" bind:checked={showNotePins} class="accent-amber-500 h-3 w-3" />
				Notes
			</label>
		</div>
	</div>

	<!-- Reading surface -->
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
	<div
		bind:this={containerEl}
		class="relative flex-1 overflow-auto p-6"
		class:notes-cursor={notesMode}
		role="region"
		aria-label="Document text — turn on Notes to pin a note"
		onmouseup={handleMouseUp}
		onclick={handleSurfaceClick}
	>
		<div class="mx-auto w-full max-w-3xl min-w-0">
			<p class="document-body text-sm text-gray-900 dark:text-gray-300 font-sans"><span data-base={0}>{text}</span></p>
		</div>

		<!-- Note pins overlay (container-relative, scroll-aware). -->
		{#each showNotePins ? pinPositions : [] as pin (pin.id)}
			<button
				type="button"
				data-note-pin
				class="note-pin absolute z-30 flex flex-col items-center -translate-x-1/2 -translate-y-full
					text-amber-400 hover:text-amber-300 transition-colors"
				class:pin-flash={flashedNoteId === pin.id}
				style="left: {pin.x}px; top: {pin.y}px;"
				title="Note {pin.index} — click to edit in the Notes pane"
				aria-label="Note {pin.index}"
				onclick={(e) => onPinClick(e, pin.id)}
			>
				<span
					class="leading-none text-[10px] font-bold text-amber-300 bg-slate-950/80 rounded px-1 -mb-0.5"
				>{pin.index}</span>
				<svg
					class="block drop-shadow-[0_1px_1.5px_rgba(0,0,0,0.7)]"
					width="18"
					height="16"
					viewBox="0 0 18 16"
					fill="none"
					aria-hidden="true"
				>
					<path
						d="M1 1 H17 L9 15 Z"
						fill="currentColor"
						stroke="#78350f"
						stroke-width="1"
						stroke-linejoin="round"
					/>
				</svg>
			</button>
		{/each}
	</div>
</div>

<style>
	/* Plain document reading surface. `pre-wrap` preserves the source whitespace
	   faithfully (and, crucially, keeps the rendered text node length equal to the
	   source string length so character-offset anchors stay exact). */
	.document-body {
		white-space: pre-wrap;
		line-height: 1.85;
		overflow-wrap: anywhere;
		word-break: break-word;
		max-width: 100%;
		min-width: 0;
	}
	/* Notes mode: a crosshair cursor signals that a click drops a note pin. */
	.notes-cursor {
		cursor: crosshair;
	}
	/* Just-dropped / focused note pin — a brief pulse so the eye finds it. */
	.pin-flash {
		animation: pin-pulse 1.2s ease-out;
	}
	@keyframes pin-pulse {
		0%,
		100% {
			box-shadow: 0 0 0 0 rgba(245, 158, 11, 0);
		}
		30% {
			box-shadow: 0 0 0 5px rgba(245, 158, 11, 0.55);
		}
	}
</style>
