<!--
  src/lib/components/lenses/ClauseSplitter.svelte — Manual clause-splitting UI

  THE DEFAULT contract experience. When a contract is uploaded and its text is
  extracted, the user sees the document with a tappable dashed divider between
  every paragraph. The automatic splitter does NOT run unless the user asks for
  it ("auto-detect") or clicks Done with nothing marked.

  Flow (per the build instructions):
    1. Render paragraphs with a dashed divider before each (except the first).
    2. Tapping a divider promotes that paragraph boundary to a clause boundary
       (solid line + clause number). Tapping an active divider removes it.
    3. Live counter ("N clauses marked") turns green at >= 3.
    4. "Done" appears at >= 3 marks → calls onComplete(clausesFromOffsets(...)).
    5. "Auto-detect" link runs splitClauses() and converts its boundaries back
       into divider marks the user can still edit. "Undo auto-detect" restores
       the manual marks that were present beforehand.
    6. Done with zero marks → fall back to auto-split.
    7. Single-paragraph contract → "single clause" confirm/auto-detect prompt.

  PERSISTENCE: this component is presentational. It reports split changes via
  the `onSplitsChange` callback (offsets, mode) on EVERY edit so the parent can
  persist them (persistSplits) — meaning a tab close mid-split loses nothing.

  Props:
    text            full extracted contract text (offsets index into THIS string)
    initialSplits   restore previously-saved manual split offsets (re-open)
    onComplete      (clauses) => void — fired when the user confirms a split
    onSplitsChange  (offsets, mode) => void — fired on every edit (for persistence)
-->
<script lang="ts">
	import {
		splitParagraphOffsets,
		clausesFromOffsets,
		splitClauses,
		cleanClauseText,
		type Clause,
		type Paragraph
	} from '$lib/lenses/contract/clause-splitter.js';

	import type { SplitMode } from '$lib/schema.js';

	interface Props {
		text: string;
		initialSplits?: number[];
		onComplete: (clauses: Clause[]) => void;
		onSplitsChange?: (offsets: number[], mode: SplitMode) => void;
	}

	let { text, initialSplits = [], onComplete, onSplitsChange }: Props = $props();

	// Paragraph segmentation is deterministic and derived from `text`. Each entry
	// carries the character offset where the paragraph begins — exactly the
	// boundary value clausesFromOffsets() expects.
	const paragraphs = $derived<Paragraph[]>(splitParagraphOffsets(text));

	/**
	 * The set of paragraph-start offsets the user has promoted to clause
	 * boundaries. Stored as a Set for O(1) toggle; rendered/exported sorted.
	 * Seeded from initialSplits (re-open) but filtered to valid paragraph
	 * boundaries so a stale offset can never desync the divider state.
	 */
	let splitSet = $state<Set<number>>(new Set());

	/** Snapshot of manual marks taken right before "auto-detect" (for undo). */
	let preAutoSplits = $state<number[] | null>(null);

	// Seed splitSet once paragraphs are known. $effect keyed on `text` so a new
	// document re-seeds from its own initialSplits.
	let seededFor = $state<string | null>(null);
	$effect(() => {
		if (seededFor === text) return;
		seededFor = text;
		const valid = new Set(paragraphs.map((p) => p.offset));
		splitSet = new Set(initialSplits.filter((o) => valid.has(o)));
		preAutoSplits = null;
	});

	/** Sorted array of active boundary offsets. */
	const sortedSplits = $derived<number[]>([...splitSet].sort((a, b) => a - b));

	const enoughMarked = $derived(sortedSplits.length >= 2); // >=2 boundaries → >=3 clauses

	const isSingleParagraph = $derived(paragraphs.length <= 1);

	/** Live preview: how many clauses Done would produce with the current marks. */
	const previewClauseCount = $derived(
		clausesFromOffsets(text, sortedSplits).length
	);

	function emitChange(mode: SplitMode) {
		onSplitsChange?.(sortedSplits, mode);
	}

	/** Toggle a paragraph boundary on/off. Persists on every change. */
	function toggleSplit(offset: number) {
		// Editing manual marks invalidates the "undo auto-detect" snapshot only if
		// the user is diverging from a just-applied auto split — keep it simple:
		// any manual toggle clears the undo affordance once they start editing.
		const next = new Set(splitSet);
		if (next.has(offset)) next.delete(offset);
		else next.add(offset);
		splitSet = next;
		emitChange('manual');
	}

	/**
	 * Normalized fingerprint of a clause/paragraph's OPENING text. Used to match
	 * auto-detected clauses to the paragraph dividers the user edits.
	 *
	 * splitClauses() returns CLEANED clause text (tags/markdown/escapes stripped,
	 * whitespace collapsed via cleanClauseText), so raw paragraph text and clause
	 * text never match byte-for-byte — locating one inside the other fails and
	 * nothing gets marked (the "auto-detect does nothing" bug). Cleaning BOTH
	 * sides, lower-casing, and stripping non-alphanumerics makes the leading-run
	 * comparison robust to those cleaning differences.
	 */
	function fingerprint(s: string): string {
		return cleanClauseText(s).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 32);
	}

	/** Run the automatic splitter and convert its clause boundaries to marks. */
	function autoDetect() {
		// Snapshot current manual marks so the user can undo back to them.
		preAutoSplits = sortedSplits;

		const autoClauses = splitClauses(text);

		// Fingerprint each paragraph head, in document order.
		const paraPrints = paragraphs.map((p) => ({ offset: p.offset, print: fingerprint(p.text) }));

		// For each auto clause (skipping the preamble), find the FIRST not-yet-used
		// paragraph whose head fingerprint overlaps the clause's head fingerprint,
		// scanning forward so clause order is preserved. Offset 0 is never a
		// boundary — it's the leading run before clause 1.
		const offsets = new Set<number>();
		let scanFrom = 0;
		for (const c of autoClauses) {
			if (c.number === 0) continue; // preamble → leading unmarked run
			const cp = fingerprint(c.text);
			if (cp.length < 8) continue;
			for (let i = scanFrom; i < paraPrints.length; i++) {
				const a = paraPrints[i].print;
				if (a.length >= 8 && (a.startsWith(cp.slice(0, 8)) || cp.startsWith(a.slice(0, 8)))) {
					if (paraPrints[i].offset > 0) offsets.add(paraPrints[i].offset);
					scanFrom = i + 1; // ordered clauses → never rematch earlier paras
					break;
				}
			}
		}

		// Fallback: if fingerprint matching found nothing (paragraph and clause
		// segmentation diverge completely), distribute boundaries evenly by
		// paragraph count so the user still gets editable marks instead of an
		// empty result.
		if (offsets.size === 0 && autoClauses.length > 1 && paragraphs.length > 1) {
			const wanted = Math.min(autoClauses.length - 1, paragraphs.length - 1);
			const step = Math.max(1, Math.floor(paragraphs.length / (wanted + 1)));
			for (let k = 1; k <= wanted; k++) {
				const idx = Math.min(paragraphs.length - 1, k * step);
				if (paragraphs[idx].offset > 0) offsets.add(paragraphs[idx].offset);
			}
		}

		splitSet = offsets;
		emitChange('auto');
	}


	/** Restore the manual marks captured before auto-detect. */
	function undoAutoDetect() {
		if (!preAutoSplits) return;
		splitSet = new Set(preAutoSplits);
		preAutoSplits = null;
		emitChange('manual');
	}

	/** Snap an arbitrary character offset to the nearest paragraph start ≤ it. */
	function snapToParagraph(loc: number): number {
		let best = 0;
		for (const p of paragraphs) {
			if (p.offset <= loc) best = p.offset;
			else break;
		}
		return best;
	}

	/** Confirm the current split → build clauses and hand them to the parent. */
	function done() {
		// Done with nothing marked → fall back to auto-split (spec rule 7).
		const clauses =
			sortedSplits.length === 0 ? splitClauses(text) : clausesFromOffsets(text, sortedSplits);
		emitChange(sortedSplits.length === 0 ? 'auto' : 'manual');
		onComplete(clauses);
	}

	/** Single-paragraph: treat the whole thing as one clause. */
	function confirmSingle() {
		onComplete(clausesFromOffsets(text, []));
	}

	/** Which sequential clause number a paragraph belongs to (for the active badge). */
	function clauseNumberForOffset(offset: number): number {
		// Number of boundaries at or before this offset = this clause's index.
		let n = 1;
		for (const s of sortedSplits) {
			if (s <= offset) n++;
		}
		return n;
	}
</script>

<div class="flex flex-col h-full overflow-hidden">
	<!-- BANNER -->
	<div class="flex-shrink-0 px-6 py-3 border-b border-slate-800 bg-slate-900/80 backdrop-blur-sm">
		{#if isSingleParagraph}
			<p class="text-sm text-gray-200">
				This contract appears to be a single clause.
			</p>
			<div class="mt-2 flex items-center gap-3">
				<button
					onclick={confirmSingle}
					class="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold transition-colors"
				>Confirm</button>
				<button
					onclick={autoDetect}
					class="text-xs text-gray-400 hover:text-gray-200 underline underline-offset-2 transition-colors"
				>Or auto-detect clauses</button>
			</div>
		{:else}
			<p class="text-sm text-gray-200 leading-snug">
				Tap between paragraphs to mark where each clause begins. This takes
				~30 seconds and dramatically improves your results.
			</p>
			<div class="mt-1.5 flex items-center gap-3 flex-wrap">
				<button
					onclick={autoDetect}
					class="text-xs text-gray-400 hover:text-gray-200 underline underline-offset-2 transition-colors"
				>Or auto-detect clauses — faster but less accurate</button>

				{#if preAutoSplits !== null}
					<button
						onclick={undoAutoDetect}
						class="text-xs text-amber-400 hover:text-amber-200 underline underline-offset-2 transition-colors"
					>Undo auto-detect</button>
				{/if}

				<!-- Live counter -->
				<span
					class="ml-auto text-xs font-medium tabular-nums px-2 py-0.5 rounded-full border transition-colors
						{enoughMarked
							? 'text-emerald-300 border-emerald-700 bg-emerald-950/40'
							: 'text-gray-400 border-slate-700 bg-slate-800/60'}"
					aria-live="polite"
				>
					{previewClauseCount} {previewClauseCount === 1 ? 'clause' : 'clauses'} marked
				</span>

				<!-- Done — visible once >= 3 clauses (>= 2 boundaries) are marked -->
				{#if enoughMarked}
					<button
						onclick={done}
						class="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold transition-colors"
					>Analyze these {previewClauseCount} clauses</button>
				{/if}
			</div>
		{/if}
	</div>

	<!-- PARAGRAPHS + DIVIDERS -->
	<div class="flex-1 overflow-auto p-6">
		<div class="mx-auto max-w-3xl">
			{#each paragraphs as para, i (para.offset)}
				{#if i > 0}
					{@const active = splitSet.has(para.offset)}
					<!-- Divider before this paragraph -->
					<div class="my-1.5 flex items-center justify-center">
						<button
							type="button"
							onclick={() => toggleSplit(para.offset)}
							class="group relative w-full flex items-center gap-2 py-1 transition-colors"
							aria-label={active
								? `Remove clause boundary (currently clause ${clauseNumberForOffset(para.offset)})`
								: 'Mark a clause boundary here'}
							aria-pressed={active}
						>
							{#if active}
								<!-- Active: solid line + clause number badge -->
								<span class="flex-1 h-px bg-blue-500"></span>
								<span class="flex-shrink-0 px-2 py-0.5 rounded-full bg-blue-600 text-white text-[10px] font-bold tabular-nums">
									Clause {clauseNumberForOffset(para.offset)}
								</span>
								<span class="flex-1 h-px bg-blue-500"></span>
							{:else}
								<!-- Inactive: subtle dashed line, "+" on hover -->
								<span class="flex-1 border-t border-dashed border-slate-700 group-hover:border-gray-500 transition-colors"></span>
								<span class="flex-shrink-0 w-5 h-5 flex items-center justify-center rounded-full border border-slate-700 text-gray-600 text-xs leading-none opacity-0 group-hover:opacity-100 group-hover:border-gray-500 group-hover:text-gray-300 transition-all">
									+
								</span>
								<span class="flex-1 border-t border-dashed border-slate-700 group-hover:border-gray-500 transition-colors"></span>
							{/if}
						</button>
					</div>
				{/if}

				<!-- Paragraph text. Highlighted when it opens a marked clause. -->
				<div
					class="rounded-md px-3 py-2 transition-colors
						{splitSet.has(para.offset) ? 'bg-blue-950/20' : ''}"
				>
					<pre class="text-sm text-gray-300 leading-relaxed whitespace-pre-wrap font-sans">{para.text}</pre>
				</div>
			{/each}
		</div>
	</div>
</div>
