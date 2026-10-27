<script lang="ts">
	/**
	 * PdfViewer.svelte — pixel-perfect PDF display with selectable text.
	 *
	 * Architecture (matches the "render as canvas + invisible text layer" plan):
	 *   - One container div per page. Each gets a <canvas> (visual) + a pdf.js
	 *     text layer (invisible, selectable) rendered by pdf-render.ts.
	 *   - VIRTUAL SCROLLING: page slots are always present (so scroll height is
	 *     correct), but only the visible page ± BUFFER pages actually render their
	 *     canvas/text-layer. Pages scrolled away are torn down to free memory.
	 *   - SELECTION → CONTEXT: when the user selects text inside a page, a floating
	 *     "+ Add to context" button appears; clicking it emits the selected text
	 *     plus the page number to the parent.
	 *
	 * The visual pipeline is fully independent of the AI-text pipeline (pdf.ts).
	 * This component only needs the raw PDF bytes.
	 */
	import { onMount, onDestroy, tick } from 'svelte';
	import {
		loadPdfForRender,
		renderPageInto,
		type LoadedPdf,
		type RenderedPage
	} from '$lib/parsers/pdf-render.js';
	import LoadingSpinner from '$lib/components/common/LoadingSpinner.svelte';
	import ErrorBanner from '$lib/components/common/ErrorBanner.svelte';
	import { workspace } from '$lib/stores/workspace.svelte.js';
	import { notesStore } from '$lib/stores/notesStore.svelte.js';

	interface Props {
		/** Raw PDF bytes (the display pipeline never touches extracted text). */
		bytes: ArrayBuffer;
		/** Render scale. 1.0 ≈ 96dpi. */
		scale?: number;
		/** Pages to keep rendered on each side of the visible one. */
		buffer?: number;
		/** Called when the user adds a text selection to the AI context. */
		onAddToContext?: (payload: { text: string; pageNumber: number }) => void;
		/**
		 * Length of the document's normalized text (documentText.length). Enables
		 * APPROXIMATE note pinning on the visual PDF: a prose note's character
		 * offset maps to a vertical position by proportion (offset / docTextLength
		 * → fraction of total scroll height), and a click in Notes mode maps back
		 * the same way. This is intentionally coarse — the contract/text lens owns
		 * exact placement; here a pin lands in roughly the right region of the
		 * page, which is all that's needed for a visual PDF. Notes are SHARED with
		 * every other lens (same notesStore, same offsets), so a pin dropped here
		 * shows up in the text/contract views and vice-versa.
		 */
		docTextLength?: number;
		/**
		 * Called whenever the page currently scrolled into view changes (1-based).
		 * Drives DocumentPane.svelte's "Page [n] / numPages" jump control so the
		 * displayed value stays in sync while the user scrolls manually, not just
		 * after a goToPage() jump. Fired from the SAME updateVisiblePages() pass
		 * that already recomputes note-pin positions on scroll — no extra work.
		 */
		onPageChange?: (page: number) => void;
		/** Called once the page count is known (right after the PDF loads), so
		 *  DocumentPane.svelte's jump control can show "/ numPages" and clamp
		 *  input. */
		onNumPagesKnown?: (numPages: number) => void;
	}

	let {
		bytes,
		scale = 1.3,
		buffer = 1,
		onAddToContext,
		docTextLength = 0,
		onPageChange,
		onNumPagesKnown
	}: Props = $props();

	const notesMode = $derived(workspace.notesMode);


	let status = $state<'loading' | 'ready' | 'error'>('loading');
	let errorMsg = $state('');
	let numPages = $state(0);
	let loaded: LoadedPdf | null = null;

	// One slot per page; slots hold their measured size + render handle.
	interface Slot {
		el: HTMLElement | null;
		rendered: RenderedPage | null;
		width: number;
		height: number;
		visible: boolean;
	}
	let slots = $state<Slot[]>([]);

	let scrollEl = $state<HTMLElement | null>(null);

	// Floating "add to context" button state.
	let selection = $state<{ text: string; pageNumber: number; x: number; y: number } | null>(null);

	onMount(async () => {
		try {
			loaded = await loadPdfForRender(bytes);
			numPages = loaded.numPages;
			onNumPagesKnown?.(numPages);

			// Estimate each page's size up front (page 1's viewport) so the scroll
			// container has a realistic height before anything renders.
			const first = await loaded.doc.getPage(1);
			const vp = first.getViewport({ scale });
			slots = Array.from({ length: numPages }, () => ({
				el: null,
				rendered: null,
				width: vp.width,
				height: vp.height,
				visible: false
			}));
			status = 'ready';

			// Wait a tick for the slot DOM to mount, then do an initial visibility pass.
			requestAnimationFrame(() => updateVisiblePages());
		} catch (err) {
			errorMsg = err instanceof Error ? err.message : String(err);
			status = 'error';
		}
	});

	onDestroy(() => {
		for (const s of slots) s.rendered?.destroy();
		// `destroy` is no longer in the public pdfjs-dist `PDFDocumentProxy`
		// type (the runtime still ships it for back-compat). Type-assert so
		// the call survives a future type-strict bump while remaining a no-op
		// on builds that omit the method.
		(loaded?.doc as unknown as { destroy?: () => void })?.destroy?.();
	});

	/** Decide which pages should be rendered (visible ± buffer) and sync the DOM. */
	function updateVisiblePages() {
		if (!scrollEl || !loaded) return;
		const viewTop = scrollEl.scrollTop;
		const viewBottom = viewTop + scrollEl.clientHeight;

		// Find the first page whose slot intersects the viewport by walking
		// cumulative heights (cheap; page count is bounded in practice).
		let offset = 0;
		let firstVisible = 0;
		let lastVisible = 0;
		for (let i = 0; i < slots.length; i++) {
			const top = offset;
			const bottom = offset + slots[i].height + PAGE_GAP;
			if (bottom > viewTop && top < viewBottom) {
				if (firstVisible === 0 && lastVisible === 0) firstVisible = i;
				lastVisible = i;
			}
			offset = bottom;
		}

		const from = Math.max(0, firstVisible - buffer);
		const to = Math.min(slots.length - 1, lastVisible + buffer);

		for (let i = 0; i < slots.length; i++) {
			const shouldRender = i >= from && i <= to;
			if (shouldRender && !slots[i].rendered && slots[i].el) {
				void renderSlot(i);
			} else if (!shouldRender && slots[i].rendered) {
				slots[i].rendered!.destroy();
				slots[i].rendered = null;
			}
		}
		// Slot heights may have been measured during this pass → scroll height
		// changed → reposition the proportional note pins.
		recomputePins();

		// Report the current (1-based) page to the parent's "Page [n] / numPages"
		// jump control, whenever it actually changes — avoids firing the
		// callback on every scroll tick for no visible reason.
		const page = firstVisible + 1;
		if (page !== lastReportedPage) {
			lastReportedPage = page;
			onPageChange?.(page);
		}
	}

	/** Last page number reported via onPageChange — dedupes redundant callbacks. */
	let lastReportedPage = 0;

	/**
	 * Public handle for DocumentPane.svelte's page-jump input — see
	 * `bind:this` on the <PdfViewer> mount site. Clamps to [1, numPages],
	 * computes the target page's cumulative top offset the same way
	 * updateVisiblePages() walks slot heights, and smooth-scrolls there.
	 */
	export function goToPage(n: number) {
		if (!scrollEl || slots.length === 0) return;
		const target = Math.max(1, Math.min(Math.round(n), slots.length));
		let top = 0;
		for (let i = 0; i < target - 1; i++) {
			top += slots[i].height + PAGE_GAP;
		}
		scrollEl.scrollTo({ top, behavior: 'smooth' });
	}


	const PAGE_GAP = 16; // px gap between pages (keep in sync with CSS margin)

	async function renderSlot(i: number) {
		if (!loaded || !slots[i].el) return;
		try {
			const page = await loaded.doc.getPage(i + 1);
			const rendered = await renderPageInto(page, slots[i].el!, scale);
			slots[i].rendered = rendered;
			slots[i].width = rendered.width;
			slots[i].height = rendered.height;
		} catch (err) {
			// Non-fatal: leave the slot blank.
			console.warn(`PdfViewer: failed to render page ${i + 1}`, err);
		}
	}

	let scrollRaf = 0;
	function handleScroll() {
		if (scrollRaf) return;
		scrollRaf = requestAnimationFrame(() => {
			scrollRaf = 0;
			updateVisiblePages();
		});
	}

	/** On selection end, figure out which page it belongs to and show the button. */
	function handleMouseUp() {
		const sel = window.getSelection();
		const text = sel?.toString().trim() ?? '';
		if (!text || !sel || sel.rangeCount === 0) {
			selection = null;
			return;
		}
		const range = sel.getRangeAt(0);
		// Walk up from the selection's container to find the owning page slot.
		let node: Node | null = range.commonAncestorContainer;
		let pageNumber = 0;
		while (node && node !== scrollEl) {
			if (node instanceof HTMLElement && node.dataset.pageNumber) {
				pageNumber = Number(node.dataset.pageNumber);
				break;
			}
			node = node.parentNode;
		}
		if (!pageNumber) {
			selection = null;
			return;
		}
		const rect = range.getBoundingClientRect();
		const hostRect = scrollEl!.getBoundingClientRect();
		// The button is absolutely positioned inside scrollEl (the scroll container),
		// so its coordinate space is the scrolled content — we must ADD scrollTop/Left
		// to the viewport-relative offset, otherwise the button lands in the wrong
		// place (or off-screen) whenever the page is scrolled.
		selection = {
			text,
			pageNumber,
			x: rect.left - hostRect.left + scrollEl!.scrollLeft + rect.width / 2,
			y: rect.top - hostRect.top + scrollEl!.scrollTop - 8
		};
	}


	function addToContext() {
		if (selection) {
			onAddToContext?.({ text: selection.text, pageNumber: selection.pageNumber });
			// Hide the floating button (prevents a double-add) but DO NOT clear the
			// browser selection — keeping the range alive leaves the pdf.js text
			// layer's ::selection highlight visible, so the user can see exactly
			// what they just added to context. The highlight clears naturally when
			// they click elsewhere or make a new selection.
			selection = null;
		}
	}


	// Re-bind slot elements → trigger an initial render pass when they mount.
	function bindSlot(node: HTMLElement, i: number) {
		slots[i].el = node;
		requestAnimationFrame(() => updateVisiblePages());
		return {
			destroy() {
				slots[i].rendered?.destroy();
				slots[i].rendered = null;
				slots[i].el = null;
			}
		};
	}

	// ── Approximate note pinning ──────────────────────────────────────────────
	// A prose note's character offset maps to a vertical position on the rendered
	// PDF by proportion: y = (offset / docTextLength) * totalScrollHeight. This is
	// coarse (assumes roughly uniform text density across pages) but the user only
	// needs a pin in the right region — exact placement lives in the text/contract
	// lens, which shares the SAME notesStore + offsets, so a pin here round-trips
	// to those lenses.

	/** Just-dropped / focused pin id — drives the pulse animation. */
	let flashedNoteId = $state<string | null>(null);

	/** Pins positioned in CONTENT coordinates (they live inside the scrolled
	 *  container, so they scroll with the pages — no per-scroll recompute of y).
	 *  x is the left edge of the rendered page (pages are mx-auto-centered, so a
	 *  fixed container-edge x would land in the empty margin beside the PDF). */
	let pinPositions = $state<{ id: string; index: number; x: number; y: number }[]>([]);

	function recomputePins() {
		if (!scrollEl || docTextLength <= 0) {
			pinPositions = [];
			return;
		}
		const h = scrollEl.scrollHeight;
		// Anchor pins to the left edge of the (centered) page column. offsetLeft is
		// relative to the scroll content, so it stays correct as the user scrolls.
		const slotEl = scrollEl.querySelector('.pdf-page-slot') as HTMLElement | null;
		const pageLeft = slotEl ? slotEl.offsetLeft : 16;
		const pinX = Math.max(2, pageLeft - 14); // sit just outside the page's left margin
		const prose = notesStore.notes.filter((n) => n.anchor.kind === 'prose');
		pinPositions = prose.map((n, i) => {
			const offset = n.anchor.kind === 'prose' ? n.anchor.offset : 0;
			const frac = docTextLength > 0 ? offset / docTextLength : 0;
			return {
				id: n.id,
				index: i + 1,
				x: pinX,
				y: Math.max(0, Math.min(frac * h, h))
			};
		});
	}


	/** In Notes mode, a click that ISN'T a text selection drops a pin at the
	 *  proportional offset for that vertical position. */
	function handleSurfaceClick(e: MouseEvent) {
		if (!notesMode || !scrollEl || docTextLength <= 0) return;
		const sel = window.getSelection();
		if (sel && !sel.isCollapsed) return; // a selection → "+ Add to context" path
		const target = e.target as HTMLElement | null;
		if (target && target.closest('[data-note-pin]')) return;
		const rect = scrollEl.getBoundingClientRect();
		const yContent = e.clientY - rect.top + scrollEl.scrollTop;
		const h = scrollEl.scrollHeight;
		if (h <= 0) return;
		const frac = Math.max(0, Math.min(yContent / h, 1));
		const offset = Math.round(frac * docTextLength);
		// Stamp 'document' — this surface pins via the APPROXIMATE proportional
		// mapping (see the docstring on the docTextLength prop above). Used to
		// warn/checkmark when this note is later viewed in the contract lens
		// (or vice-versa), where the two lenses' pin placement precision differs.
		const note = notesStore.addNote(offset, '', 'document');
		flashedNoteId = note.id;
		setTimeout(() => {
			if (flashedNoteId === note.id) flashedNoteId = null;
		}, 1200);
		// Open the Notes pane so the new note's editor is visible, then focus it.
		if (workspace.openPane?.kind !== 'notes') workspace.openNotesPane();
		tick().then(() => {
			recomputePins();
			workspace.requestFocusNote(note.id);
		});
	}

	/** Clicking a pin opens the Notes pane (if needed) and focuses its editor. */
	function onPinClick(e: MouseEvent, id: string) {
		e.stopPropagation();
		if (workspace.openPane?.kind !== 'notes') workspace.openNotesPane();
		workspace.requestFocusNote(id);
	}


	// Recompute pins whenever the note list, the text length, or the page count
	// (scroll height grows as slots get their measured sizes) changes.
	$effect(() => {
		void notesStore.notes.length;
		void docTextLength;
		void numPages;
		tick().then(recomputePins);
	});

	// ── Consume the PULL scroll-to-note signal (Notes pane click → PDF). ──
	// Mirrors DocumentHighlighter.svelte's/ClauseHighlighter.svelte's effect of
	// the same name — NotesPane.svelte's onBubbleClick() fires
	// workspace.requestScrollToNote(id) the same way regardless of which
	// viewer is active, but until this effect existed PdfViewer never
	// consumed it, so clicking a note bubble while viewing a PDF in the
	// document lens silently did nothing (the contract lens and the
	// DOCX/TXT/MD document lens both already had their own copy of this
	// effect). Uses the SAME approximate proportional-offset math as
	// recomputePins()/handleSurfaceClick() above, so the scroll target
	// always lands exactly on the rendered pin.
	$effect(() => {
		const id = workspace.scrollToNoteId;
		if (!id || !scrollEl || docTextLength <= 0) return;
		(async () => {
			await tick();
			recomputePins();
			const note = notesStore.notes.find((n) => n.id === id);
			if (note && note.anchor.kind === 'prose' && scrollEl) {
				const frac = note.anchor.offset / docTextLength;
				const h = scrollEl.scrollHeight;
				const target = Math.max(0, Math.min(frac * h, h)) - scrollEl.clientHeight / 2;
				const maxTop = scrollEl.scrollHeight - scrollEl.clientHeight;
				scrollEl.scrollTo({ top: Math.max(0, Math.min(target, maxTop)), behavior: 'smooth' });
				flashedNoteId = id;
				setTimeout(() => {
					if (flashedNoteId === id) flashedNoteId = null;
				}, 1600);
			}
			workspace.clearScrollToNote();
		})();
	});
</script>


{#if status === 'loading'}
	<div class="flex h-full items-center justify-center">
		<LoadingSpinner label="Loading PDF…" />
	</div>
{:else if status === 'error'}
	<div class="p-4">
		<ErrorBanner message={`Could not display PDF: ${errorMsg}`} />
	</div>
{:else}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		bind:this={scrollEl}
		class="relative h-full overflow-auto bg-surface p-4 dark:bg-slate-900"
		class:notes-cursor={notesMode}
		onscroll={handleScroll}
		onmouseup={handleMouseUp}
		onclick={handleSurfaceClick}
	>
		{#each slots as slot, i (i)}
			<div
				class="pdf-page-slot mx-auto mb-4 bg-white shadow dark:bg-slate-950"
				style="width:{slot.width}px;height:{slot.height}px;"
				data-page-number={i + 1}
				use:bindSlot={i}
			></div>
		{/each}

		{#if selection}
			<button
				class="absolute z-20 -translate-x-1/2 -translate-y-full rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white shadow-lg hover:bg-indigo-700"
				style="left:{selection.x}px;top:{selection.y}px;"
				onmousedown={(e) => e.preventDefault()}
				onclick={addToContext}
			>
				+ Add to context (p.{selection.pageNumber})
			</button>
		{/if}

		<!-- Approximate note pins. Positioned in the left margin at the proportional
		     vertical offset; they live inside the scrolled container so they track
		     the pages on scroll. Shared with the text/contract lenses. -->
		{#each pinPositions as pin (pin.id)}
			<button
				type="button"
				data-note-pin
				class="note-pin absolute z-20 flex -translate-y-1/2 items-center gap-1
					text-amber-500 hover:text-amber-400"
				class:pin-flash={flashedNoteId === pin.id}
				style="left:{pin.x}px;top:{pin.y}px;"

				title="Note {pin.index} — click to edit in the Notes pane (approximate position — switch to the Contract lens for the exact position)"
				aria-label="Note {pin.index}"
				onclick={(e) => onPinClick(e, pin.id)}
			>
				<svg width="16" height="20" viewBox="0 0 16 20" fill="none" aria-hidden="true"
					class="drop-shadow-[0_1px_2px_rgba(0,0,0,0.5)]">
					<path d="M8 0 C3.6 0 0 3.6 0 8 C0 13 8 20 8 20 C8 20 16 13 16 8 C16 3.6 12.4 0 8 0 Z"
						fill="currentColor" stroke="#78350f" stroke-width="1" />
				</svg>
				<span class="text-[10px] font-bold leading-none text-amber-300 bg-slate-950/80 rounded px-1">
					{pin.index}
				</span>
			</button>
		{/each}
	</div>
{/if}


<style>
	/* The text layer is positioned by pdf.js's stylesheet (injected at runtime by
	   pdf-render.ts). These are backstops in case that import path changes. */
	:global(.textLayer) {
		opacity: 1;
		line-height: 1;
	}
	/* Chromium (Edge/Chrome/Brave) skips the ::selection background when text
	   color is exactly `transparent`. pdf.js sets the glyph spans transparent by
	   design (the visible text comes from the canvas underneath), so dragging a
	   selection showed NO highlight. Using rgba(...,0.01) keeps the text
	   invisible to the eye but is no longer the `transparent` keyword, so Edge
	   renders the live drag highlight correctly. !important locks this in over
	   the runtime-injected pdf_viewer.css <link>. */
	:global(.textLayer span),
	:global(.textLayer br) {
		color: rgba(0, 0, 0, 0.01) !important;
		position: absolute;
		white-space: pre;
		transform-origin: 0% 0%;
		cursor: text;
	}
	:global(.textLayer ::selection) {
		background: rgba(99, 102, 241, 0.55) !important;
	}

	/* Notes mode: crosshair signals a click drops an (approximate) note pin. */
	.notes-cursor {
		cursor: crosshair;
	}
	/* Just-dropped / focused pin — brief pulse so the eye finds it. */
	.pin-flash {
		animation: pin-pulse 1.2s ease-out;
	}
	@keyframes pin-pulse {
		0%,
		100% {
			filter: drop-shadow(0 0 0 rgba(245, 158, 11, 0));
			transform: translateY(-50%) scale(1);
		}
		30% {
			filter: drop-shadow(0 0 6px rgba(245, 158, 11, 0.9));
			transform: translateY(-50%) scale(1.25);
		}
	}
</style>


