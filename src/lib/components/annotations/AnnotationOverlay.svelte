<!--
  AnnotationOverlay.svelte — Renders annotation highlights over document text.

  Reads from annotationStore. Emits click events so the parent can open
  the annotation popover. Does NOT import AnnotationInput.

  Props:
    text        — The full document text (used to compute highlight positions)
    documentId  — Which document_id to filter annotations for
    userTier    — 'free' | 'pro' (controls whether "Annotate" button appears)
    onAnnotate  — Called when user clicks "Annotate" on a text selection
    onSelect    — Called when user clicks an existing annotation highlight
-->
<script lang="ts">
	import { annotationStore } from '$lib/stores/annotations.svelte.js';
	import type { Annotation, AnnotationSelection } from '$lib/types.js';

	interface Props {
		text: string;
		documentId?: string;
		userTier?: 'free' | 'pro';
		onAnnotate?: (sel: AnnotationSelection) => void;
		onSelect?: (annotation: Annotation) => void;
	}

	let {
		text,
		documentId = 'default',
		userTier = 'free',
		onAnnotate,
		onSelect
	}: Props = $props();

	// ── Floating "Annotate" button state ──────────────────────────────────────
	let floatingBtn = $state<{
		visible: boolean;
		x: number;
		y: number;
		selection: AnnotationSelection | null;
	}>({ visible: false, x: 0, y: 0, selection: null });

	// ── Build highlight spans from annotations ────────────────────────────────
	interface Span {
		text: string;
		annotations: Annotation[];
		isHighlight: boolean;
	}

	let spans = $derived.by(() => {
		const docAnnotations = annotationStore.getAnnotationsForDocument(documentId);
		if (!docAnnotations.length || !text) {
			return [{ text, annotations: [], isHighlight: false }] as Span[];
		}

		// Build a sorted list of all start/end events
		type Event = { offset: number; type: 'start' | 'end'; annotation: Annotation };
		const events: Event[] = [];
		for (const ann of docAnnotations) {
			events.push({ offset: ann.selection.start_offset, type: 'start', annotation: ann });
			events.push({ offset: ann.selection.end_offset, type: 'end', annotation: ann });
		}
		events.sort((a, b) => a.offset - b.offset || (a.type === 'end' ? -1 : 1));

		const result: Span[] = [];
		let pos = 0;
		const active = new Set<Annotation>();

		for (const event of events) {
			const offset = Math.min(event.offset, text.length);
			if (offset > pos) {
				result.push({
					text: text.slice(pos, offset),
					annotations: [...active],
					isHighlight: active.size > 0
				});
			}
			if (event.type === 'start') active.add(event.annotation);
			else active.delete(event.annotation);
			pos = offset;
		}

		if (pos < text.length) {
			result.push({ text: text.slice(pos), annotations: [], isHighlight: false });
		}

		return result;
	});

	// ── Text selection handler ────────────────────────────────────────────────
	function handleMouseUp(e: MouseEvent) {
		if (userTier !== 'pro') return;
		const sel = window.getSelection();
		if (!sel || sel.isCollapsed || !sel.toString().trim()) {
			floatingBtn = { ...floatingBtn, visible: false };
			return;
		}

		const selectedText = sel.toString();
		const range = sel.getRangeAt(0);

		// Find character offsets within the text
		const container = (e.currentTarget as HTMLElement);
		const fullText = container.textContent ?? '';
		const preRange = document.createRange();
		preRange.setStart(container, 0);
		preRange.setEnd(range.startContainer, range.startOffset);
		const startOffset = preRange.toString().length;
		const endOffset = startOffset + selectedText.length;

		const rect = range.getBoundingClientRect();
		const containerRect = container.getBoundingClientRect();

		floatingBtn = {
			visible: true,
			x: rect.left - containerRect.left + rect.width / 2,
			y: rect.top - containerRect.top - 8,
			selection: {
				document_id: documentId,
				start_offset: startOffset,
				end_offset: endOffset,
				quote: selectedText
			}
		};
	}

	function handleAnnotateClick() {
		if (floatingBtn.selection && onAnnotate) {
			onAnnotate(floatingBtn.selection);
		}
		floatingBtn = { ...floatingBtn, visible: false };
		window.getSelection()?.removeAllRanges();
	}

	function handleHighlightClick(annotations: Annotation[], e: Event) {
		e.stopPropagation();
		if (annotations.length > 0 && onSelect) {
			onSelect(annotations[0]);
		}
	}

	function dismissFloating() {
		floatingBtn = { ...floatingBtn, visible: false };
	}

	// ── Highlight color with opacity ──────────────────────────────────────────
	function highlightStyle(annotations: Annotation[]): string {
		if (!annotations.length) return '';
		const ann = annotations[0];
		const isSelected = annotationStore.selectedAnnotationId === ann.id;
		const color = ann.color || '#FFD700';
		// Convert hex to rgba for opacity
		const r = parseInt(color.slice(1, 3), 16);
		const g = parseInt(color.slice(3, 5), 16);
		const b = parseInt(color.slice(5, 7), 16);
		const opacity = isSelected ? 0.5 : ann.resolved ? 0.15 : 0.3;
		return `background-color: rgba(${r},${g},${b},${opacity}); border-bottom: 2px solid ${color};`;
	}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="relative"
	onmouseup={handleMouseUp}
	onclick={dismissFloating}
	role="region"
	aria-label="Document text with annotations"
>
	<!-- Rendered text with highlight spans -->
	<div class="whitespace-pre-wrap text-sm text-gray-200 leading-relaxed font-mono select-text">
		{#each spans as span}
			{#if span.isHighlight}
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<mark
					class="cursor-pointer rounded-sm transition-all duration-150 hover:opacity-80"
					style={highlightStyle(span.annotations)}
					onclick={(e) => handleHighlightClick(span.annotations, e)}
					title={span.annotations[0]?.body?.slice(0, 80) ?? 'Annotation'}
					role="button"
					tabindex="0"
					aria-label="Annotation: {span.annotations[0]?.body?.slice(0, 60) ?? ''}"
					onkeydown={(e) => {
						if (e.key === 'Enter' || e.key === ' ') {
							e.preventDefault();
							handleHighlightClick(span.annotations, e);
						}
					}}
				>{span.text}</mark>
			{:else}
				<span>{span.text}</span>
			{/if}
		{/each}
	</div>

	<!-- Floating "Annotate" button (Pro only) -->
	{#if floatingBtn.visible && userTier === 'pro'}
		<div
			class="absolute z-50 -translate-x-1/2 -translate-y-full pointer-events-auto"
			style="left: {floatingBtn.x}px; top: {floatingBtn.y}px;"
		>
			<button
				onclick={handleAnnotateClick}
				class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-500 hover:bg-yellow-400
					   text-gray-900 text-xs font-semibold shadow-lg shadow-black/40
					   transition-colors duration-150 whitespace-nowrap"
				aria-label="Add annotation to selected text"
			>
				✏️ Annotate
			</button>
			<!-- Arrow -->
			<div class="absolute left-1/2 -translate-x-1/2 top-full w-0 h-0
						border-l-4 border-r-4 border-t-4
						border-l-transparent border-r-transparent border-t-yellow-500">
			</div>
		</div>
	{/if}

	<!-- Free tier: disabled annotate hint -->
	{#if floatingBtn.visible && userTier === 'free'}
		<div
			class="absolute z-50 -translate-x-1/2 -translate-y-full pointer-events-auto"
			style="left: {floatingBtn.x}px; top: {floatingBtn.y}px;"
		>
			<div class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-700 border border-gray-600
						text-gray-400 text-xs font-medium shadow-lg shadow-black/40 whitespace-nowrap">
				✏️ Annotate
				<span class="px-1.5 py-0.5 rounded bg-amber-900/60 border border-amber-700 text-amber-300 text-[10px] font-semibold">Pro</span>
			</div>
			<div class="absolute left-1/2 -translate-x-1/2 top-full w-0 h-0
						border-l-4 border-r-4 border-t-4
						border-l-transparent border-r-transparent border-t-gray-700">
			</div>
		</div>
	{/if}
</div>
