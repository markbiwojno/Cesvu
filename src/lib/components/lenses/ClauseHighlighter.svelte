<script lang="ts">
	/**
	 * ClauseHighlighter.svelte — highlight-to-mark contract reading surface.
	 *
	 * Renders the full contract text as selectable prose. The user highlights any
	 * span and a floating "Mark as Clause" toolbar appears (after a deliberate
	 * 300ms dwell — see below); confirming adds the span to the clauseStore, which
	 * classifies it locally and resolves it in place. Marked spans render as
	 * numbered, color-tinted highlights over the text.
	 *
	 * Selection → offsets:
	 *   The text is rendered as a flat sequence of segments (plain runs + marked
	 *   runs). To turn a DOM Selection into document character offsets, every
	 *   rendered text node carries a data-base attribute = the document offset of
	 *   its first character. offsetOf(node, offsetInNode) = base + offsetInNode.
	 *
	 * 300ms intentional-selection delay:
	 *   On mouseup with a non-empty selection we DON'T show the toolbar
	 *   immediately. We arm a 300ms timer; if the user deselects or clicks
	 *   elsewhere within that window, the timer is cancelled and the toolbar never
	 *   appears. Only selections the user holds for ≥300ms are treated as
	 *   intentional. This kills the flicker of accidental drags / double-clicks.
	 *
	 * The component is presentational w.r.t. classification: it only adds spans to
	 * the store and forwards scroll requests. The store owns clause lifecycle.
	 */
	import { onMount, tick } from 'svelte';
	import { clauseStore } from '$lib/stores/clauseStore.svelte.js';
	import type { ClauseConfidence } from '$lib/stores/clauseStore.svelte.js';
	import { workspace } from '$lib/stores/workspace.svelte.js';
	import { notesStore } from '$lib/stores/notesStore.svelte.js';

	import { detectGlossaryTerms } from '$lib/lenses/contract/glossary-detector.js';
	import { getPerspective, setPerspective } from '$lib/lenses/contract/glossary-loader.js';
	import type { GlossaryEntry, GlossaryMatch, Perspective } from '$lib/lenses/contract/types.js';

	import GlossaryTooltip from './GlossaryTooltip.svelte';
	import RedFlagBadge from './RedFlagBadge.svelte';


	interface Props {
		/** Full document text to display + mark over. */
		text: string;
	}

	let { text }: Props = $props();

	/** The scroll/selection container. Selection offsets are computed relative to it. */
	let containerEl = $state<HTMLDivElement | null>(null);

	// ── Floating toolbar state ────────────────────────────────────────────────
	let toolbar = $state<{
		x: number;
		y: number;
		start: number;
		end: number;
		selText: string;
		overlap: boolean;
	} | null>(null);

	/** Pending 300ms "intentional selection" timer. */
	let dwellTimer: ReturnType<typeof setTimeout> | null = null;

	// ── Per-clause highlight scroll/flash ─────────────────────────────────────
	let highlightedId = $state<string | null>(null);

	// ── Adjustment mode ───────────────────────────────────────────────────────
	/**
	 * `adjusting` flips on when the user clicks "Let me adjust" OR interacts with a
	 * marked clause (merge/split/remove). It hides the review banner and unlocks
	 * the per-clause adjustment affordances. Auto-detect populates the store; this
	 * just governs UI affordance visibility.
	 */
	let adjusting = $state(false);
	/** First clause picked for a MERGE (awaiting a shift-click on an adjacent clause). */
	let mergeAnchorId = $state<string | null>(null);
	/** Context menu for a right-clicked clause (Remove / Split-here). */
	let clauseMenu = $state<{ x: number; y: number; id: string } | null>(null);

	const clauses = $derived(clauseStore.clauses);

	/**
	 * Auto-detect has run AND the user hasn't yet finished the initial review.
	 * `reviewed` (set by "Looks good" / "Let me adjust") is what dismisses the
	 * banner — previously this depended on the local `adjusting` flag, which
	 * "Looks good" set to false, so the banner never actually hid (the bug).
	 */
	const showReviewBanner = $derived(
		clauseStore.autoDetected && !clauseStore.reviewed && clauseStore.count > 0
	);

	/**
	 * Once the user has finished reviewing (banner dismissed), offer a way back in
	 * to revise clause boundaries later — the "Re-edit clauses" affordance.
	 */
	const showReEditButton = $derived(
		clauseStore.autoDetected && clauseStore.reviewed && clauseStore.count > 0
	);


	/**
	 * Per-confidence highlight styling: green solid / yellow dashed / red dotted /
	 * blue (edited). Returned as an inline style string layered over the clause's
	 * own tint so the boundary confidence reads at a glance.
	 */
	function confidenceBorder(confidence: ClauseConfidence): string {
		switch (confidence) {
			case 'high':
				return 'border: 1px solid #34d399;'; // emerald-400, solid
			case 'medium':
				return 'border: 1px dashed #fbbf24;'; // amber-400, dashed
			case 'low':
				return 'border: 1px dotted #f87171;'; // red-400, dotted
			case 'edited':
				return 'border: 1px solid #60a5fa;'; // blue-400, solid
		}
	}

	/**
	 * Build the flat render segments from the document text + marked clauses.
	 * Each segment is either plain text or a marked clause span. `base` is the
	 * document offset of the segment's first char (used to map selection back).
	 * Marked clauses are non-overlapping and sorted by startOffset (store
	 * guarantees this), so we can walk them in order filling the gaps.
	 */
	const segments = $derived.by(() => {
		const segs: Array<
			| { kind: 'plain'; base: number; text: string; key: string }
			| {
					kind: 'mark';
					base: number;
					text: string;
					id: string;
					color: string;
					index: number;
					confidence: ClauseConfidence;
					key: string;
			  }
		> = [];
		let cursor = 0;
		clauses.forEach((c, i) => {
			// Defensive clamp in case offsets drifted (e.g. text changed).
			const start = Math.max(cursor, Math.min(c.startOffset, text.length));
			const end = Math.max(start, Math.min(c.endOffset, text.length));
			if (start > cursor) {
				// Plain runs are keyed by the clause that FOLLOWS them, so a plain
				// gap keeps a stable identity even as offsets shift after a merge.
				segs.push({ kind: 'plain', base: cursor, text: text.slice(cursor, start), key: `p:${c.id}` });
			}
			segs.push({
				kind: 'mark',
				base: start,
				text: text.slice(start, end),
				id: c.id,
				color: c.color,
				index: i + 1,
				confidence: c.confidence,
				// Keyed by the STABLE clause id (not base offset). When two clauses
				// merge, every following segment's base shifts — keying on base would
				// force Svelte to tear down + rebuild all of them (the flicker/redraw
				// lag). Keying on the clause id lets Svelte patch in place instantly.
				key: `m:${c.id}`
			});
			cursor = end;
		});
		if (cursor < text.length) {
			segs.push({ kind: 'plain', base: cursor, text: text.slice(cursor), key: 'p:tail' });
		}
		return segs;
	});


	/** Number of paragraphs (double-newline runs) — drives the single-clause hint. */
	const paragraphCount = $derived(text.split(/\n{2,}/).filter((p) => p.trim().length > 0).length);

	// ── Glossary / red-flag overlay (additive, contract-only) ─────────────────
	//
	// The glossary overlay is layered INTO the plain runs only — marked clause
	// spans are never touched, so clause selection/merge/split behaviour and the
	// data-base offset mapping are unchanged. A show/hide checkbox (default on)
	// toggles whether glossary terms render as interactive underlines or as plain
	// text. The detector runs over the whole document once per text change.

	/** Whether the red-flag/glossary underlines are shown. User-toggleable. */
	let showRedFlags = $state(true);

	/** Whether the note pins are shown on the document. User-toggleable, on by default. */
	let showNotePins = $state(true);

	// ── Perspective (employee ↔ investor) ─────────────────────────────────────
	//
	// The same glossary terms carry opposite polarity depending on who's reading:
	// an employee/tenant sees risks (red flags), an investor/landlord sees
	// leverage (green flags). The loader owns the active perspective + invalidates
	// the detector's trie cache on change; this local $state mirrors it so the
	// reactive `glossaryMatches` below re-runs the scan when the user flips it.

	/** Local mirror of the loader's active perspective — drives re-detection. */
	let perspective = $state<Perspective>(getPerspective());

	/** Flip the lens. Updates the loader (rebuilds the trie) then re-mirrors. */
	function togglePerspective() {
		const next: Perspective = perspective === 'employee' ? 'investor' : 'employee';
		setPerspective(next);
		perspective = next;
	}

	/** All glossary matches in the document (flags + plain definitions). */
	const glossaryMatches = $derived.by<GlossaryMatch[]>(() => {
		// `perspective` is read so flipping the lens re-runs the scan against the
		// rebuilt trie (the term set is identical; only flag polarity changes).
		void perspective;
		if (!text) return [];
		return detectGlossaryTerms(text);
	});


	/**
	 * A plain run, broken into alternating text + glossary sub-spans. Each
	 * sub-span carries its OWN document offset (`base`) so selection→offset
	 * mapping stays exact even through the GlossaryTooltip wrapper. Glossary
	 * matches that straddle a marked-clause boundary are simply not present here
	 * (they live only where the plain run covers them), so clause marks win.
	 */
	function plainSubsegments(
		base: number,
		runText: string
	): Array<{ kind: 'text'; base: number; text: string } | { kind: 'term'; base: number; text: string; entry: GlossaryEntry }> {
		const runStart = base;
		const runEnd = base + runText.length;
		// Matches fully contained within this plain run.
		const within = glossaryMatches.filter(
			(m) => m.startIndex >= runStart && m.endIndex <= runEnd
		);
		if (within.length === 0) {
			return [{ kind: 'text', base, text: runText }];
		}
		const out: Array<
			| { kind: 'text'; base: number; text: string }
			| { kind: 'term'; base: number; text: string; entry: GlossaryEntry }
		> = [];
		let cursor = runStart;
		for (const m of within) {
			if (m.startIndex < cursor) continue; // overlap guard (dedup already ran)
			if (m.startIndex > cursor) {
				out.push({ kind: 'text', base: cursor, text: text.slice(cursor, m.startIndex) });
			}
			out.push({
				kind: 'term',
				base: m.startIndex,
				text: text.slice(m.startIndex, m.endIndex),
				entry: m.entry
			});
			cursor = m.endIndex;
		}
		if (cursor < runEnd) {
			out.push({ kind: 'text', base: cursor, text: text.slice(cursor, runEnd) });
		}
		return out;
	}

	/** Scroll the reading surface to a red-flag match (from the badge). */
	function jumpToMatch(match: GlossaryMatch) {
		if (!containerEl) return;
		const el = containerEl.querySelector(
			`[data-term-base="${match.startIndex}"]`
		) as HTMLElement | null;
		if (el) {
			el.scrollIntoView({ behavior: 'smooth', block: 'center' });
			el.classList.add('term-flash');
			setTimeout(() => el.classList.remove('term-flash'), 1600);
		}
	}


	// ── Selection → document offset mapping ───────────────────────────────────

	/**
	 * Map a (text node, offsetInNode) pair to a document character offset using
	 * the nearest ancestor carrying data-base. Returns null if the node isn't
	 * inside a base-tagged segment (e.g. selection strayed outside the text).
	 */
	function offsetOf(node: Node, offsetInNode: number): number | null {
		let el: Node | null = node;
		// Text nodes don't carry attributes — climb to the element wrapper.
		if (el.nodeType === Node.TEXT_NODE) el = el.parentElement;
		while (el && el instanceof HTMLElement) {
			const base = el.getAttribute('data-base');
			if (base !== null) return parseInt(base, 10) + offsetInNode;
			el = el.parentElement;
		}
		return null;
	}

	/** Read the current DOM selection as document offsets, or null if empty/invalid. */
	function readSelection(): { start: number; end: number; text: string } | null {
		const sel = window.getSelection();
		if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
		const range = sel.getRangeAt(0);
		if (!containerEl || !containerEl.contains(range.commonAncestorContainer)) return null;

		const a = offsetOf(range.startContainer, range.startOffset);
		const b = offsetOf(range.endContainer, range.endOffset);
		if (a === null || b === null) return null;
		const start = Math.min(a, b);
		const end = Math.max(a, b);
		if (end <= start) return null;
		return { start, end, text: text.slice(start, end) };
	}

	// ── Intentional-selection (300ms dwell) flow ──────────────────────────────

	function clearDwell() {
		if (dwellTimer) {
			clearTimeout(dwellTimer);
			dwellTimer = null;
		}
	}

	function handleMouseUp() {
		clearDwell();
		const picked = readSelection();
		if (!picked) {
			toolbar = null;
			return;
		}
		// Arm the 300ms intentional-selection timer. If the user deselects or
		// clicks elsewhere before it fires, showToolbar never runs.
		dwellTimer = setTimeout(() => {
			dwellTimer = null;
			showToolbar();
		}, 300);
	}

	/** Materialize the toolbar at the selection rect IF the selection still holds. */
	function showToolbar() {
		const picked = readSelection();
		if (!picked || !containerEl) {
			toolbar = null;
			return;
		}
		const sel = window.getSelection();
		if (!sel || sel.rangeCount === 0) return;
		const rect = sel.getRangeAt(0).getBoundingClientRect();
		const cRect = containerEl.getBoundingClientRect();
		toolbar = {
			// Position relative to the container (which is the offsetParent here).
			x: rect.left - cRect.left + rect.width / 2 + containerEl.scrollLeft,
			y: rect.top - cRect.top + containerEl.scrollTop,
			start: picked.start,
			end: picked.end,
			selText: picked.text,
			overlap: clauseStore.overlaps(picked.start, picked.end)
		};
	}

	/** Confirm the current toolbar selection as a clause. */
	function confirmMark() {
		if (!toolbar || toolbar.overlap) return;
		clauseStore.addClause({
			startOffset: toolbar.start,
			endOffset: toolbar.end,
			text: toolbar.selText
		});
		dismissToolbar();
	}

	/** Mark the WHOLE document as a single clause (single-paragraph escape hatch). */
	function markAll() {
		const trimmed = text.trim();
		if (trimmed.length === 0) return;
		const start = text.indexOf(trimmed[0]);
		clauseStore.addClause({
			startOffset: 0,
			endOffset: text.length,
			text: trimmed
		});
		void start;
		dismissToolbar();
	}

	function dismissToolbar() {
		clearDwell();
		toolbar = null;
		window.getSelection()?.removeAllRanges();
	}

	// Dismiss on outside click / Escape. Any click that isn't on the toolbar or a
	// fresh selection collapses it; pressing Escape cancels an armed dwell too.
	function handleDocPointerDown(e: PointerEvent) {
		const t = e.target as HTMLElement | null;
		if (t && t.closest('[data-clause-toolbar]')) return;
		clearDwell();
		toolbar = null;
	}
	function handleKeyDown(e: KeyboardEvent) {
		if (e.key === 'Escape') dismissToolbar();
	}

	onMount(() => {
		document.addEventListener('pointerdown', handleDocPointerDown, true);
		document.addEventListener('keydown', handleKeyDown);
		return () => {
			document.removeEventListener('pointerdown', handleDocPointerDown, true);
			document.removeEventListener('keydown', handleKeyDown);
			clearDwell();
		};
	});

	// ── Clause interactions (merge / split / remove) ──────────────────────────

	/**
	 * Click a marked clause. Behavior depends on modifiers + adjustment mode:
	 *   - Shift-click while a merge anchor is set → MERGE the two (if adjacent).
	 *   - Plain click while adjusting, no anchor   → set this as the merge anchor.
	 *   - Plain click while NOT adjusting          → scroll the sidebar to it
	 *     (the original "push" behavior) and reveal the per-clause toolbar so the
	 *     user can begin adjusting.
	 * Entering any clause interaction flips `adjusting` on (hides the banner).
	 */
	function onMarkClick(e: MouseEvent, id: string, at: number) {
		e.stopPropagation();
		// While a merge is armed, a click on ANY OTHER clause completes the merge.
		// (Previously this required holding Shift — undiscoverable, so users
		// plain-clicked the second clause and "nothing happened" because it just
		// re-opened that clause's toolbar.) Shift is no longer required; the armed
		// anchor IS the merge intent. Adjacent → merge; non-adjacent → tell them.
		if (mergeAnchorId && mergeAnchorId !== id) {
			const before = clauseStore.count;
			clauseStore.mergeClauses(mergeAnchorId, id, text);
			mergeAnchorId = null;
			adjusting = true;
			clauseMenu = null;
			// mergeClauses no-ops when the two clauses aren't adjacent (count is
			// unchanged). Surface that instead of failing silently.
			if (clauseStore.count === before) {
				workspace.showToast('Pick an adjacent clause to merge.');
			}
			return;
		}
		// Clicking the SAME armed clause again cancels the pending merge.
		if (mergeAnchorId && mergeAnchorId === id) {
			mergeAnchorId = null;
			return;
		}
		// Notes mode wins: a plain click on a marked clause drops a note at the
		// clicked offset rather than opening the clause-adjustment toolbar. (The
		// clause span calls stopPropagation, so without this branch the click
		// would never reach the surface handler and no note would be created.)
		if (notesMode && !e.shiftKey) {
			dropNoteAt(at);
			return;
		}
		adjusting = true;
		// Plain click selects this clause's adjustment toolbar.
		openClauseToolbar(id, at);
	}


	/**
	 * Show the per-clause adjustment toolbar (Merge anchor / Split here / Remove)
	 * anchored to the clicked clause. `at` is the document offset of the click —
	 * used as the split point for "Split here".
	 */
	function openClauseToolbar(id: string, at: number) {
		const clause = clauses.find((c) => c.id === id);
		if (!clause || !containerEl) return;
		const el = containerEl.querySelector(`[data-mark-id="${CSS.escape(id)}"]`) as HTMLElement | null;
		if (!el) return;
		const rect = el.getBoundingClientRect();
		const cRect = containerEl.getBoundingClientRect();
		clauseMenu = {
			x: rect.left - cRect.left + Math.min(rect.width / 2, 80) + containerEl.scrollLeft,
			y: rect.top - cRect.top + containerEl.scrollTop,
			id
		};
		// Stash the split point on the menu via a module field.
		splitPoint = at;
	}

	/** Document offset of the last clause click — the candidate split position. */
	let splitPoint = $state(0);

	/** Begin a merge: mark this clause as the anchor; user shift-clicks the neighbour. */
	function startMerge(id: string) {
		mergeAnchorId = id;
		clauseMenu = null;
		adjusting = true;
	}

	/** Split the menu's clause at the recorded click offset. */
	function doSplit() {
		if (!clauseMenu) return;
		clauseStore.splitClause(clauseMenu.id, splitPoint, text);
		clauseMenu = null;
		adjusting = true;
	}

	/** Remove the menu's clause (text reverts to unmarked). */
	function doRemove(id: string) {
		clauseStore.removeClause(id);
		clauseMenu = null;
		if (mergeAnchorId === id) mergeAnchorId = null;
		adjusting = true;
	}

	/** Right-click a clause → adjustment toolbar at the cursor. */
	function onMarkContextMenu(e: MouseEvent, id: string, at: number) {
		e.preventDefault();
		e.stopPropagation();
		adjusting = true;
		if (!containerEl) return;
		const cRect = containerEl.getBoundingClientRect();
		clauseMenu = {
			x: e.clientX - cRect.left + containerEl.scrollLeft,
			y: e.clientY - cRect.top + containerEl.scrollTop,
			id
		};
		splitPoint = at;
	}

	/** Map a click event inside a mark to its document offset (for split point). */
	function clickOffset(e: MouseEvent, fallbackBase: number): number {
		const sel = window.getSelection();
		// caretRangeFromPoint is the most precise; fall back to the segment base.
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
		void sel;
		return fallbackBase;
	}

	/** "Looks good" — accept all auto-detected clauses, hide the banner. */
	function acceptAll() {
		clauseStore.acceptAll();
		adjusting = false;
	}

	/**
	 * "Let me adjust" — enter adjustment mode (hides banner, same clauses).
	 * Marks the review as done in the store so the banner dismisses; the local
	 * `adjusting` flag keeps the per-clause affordances unlocked.
	 */
	function startAdjusting() {
		adjusting = true;
		clauseStore.acceptAll();
	}

	/**
	 * "Re-edit clauses" — re-open the review later. Brings the banner + adjustment
	 * affordances back without touching the existing marked clauses.
	 */
	function reEditClauses() {
		clauseStore.reopenReview();
		adjusting = false;
	}


	// ── Consume the PULL scroll-to-clause signal (sidebar card → document). ───
	$effect(() => {
		const id = workspace.scrollToClauseId;
		if (!id || !containerEl) return;
		(async () => {
			await tick();
			const el = containerEl?.querySelector(`[data-mark-id="${CSS.escape(id)}"]`) as HTMLElement | null;
			if (el) {
				el.scrollIntoView({ behavior: 'smooth', block: 'center' });
				highlightedId = id;
				setTimeout(() => {
					if (highlightedId === id) highlightedId = null;
				}, 1600);
			}
			workspace.clearScrollToClause();
		})();
	});

	// ── Note-taking ───────────────────────────────────────────────────────────
	//
	// When notesMode is on (toggled from the toolbar / mirrored in the workspace
	// store), a plain click anywhere in the reading surface drops a note pin at
	// the clicked character offset. The note is created in notesStore (empty
	// body) and the Insights pane is asked to focus its editor so the user can
	// type immediately. Pins render as an absolutely-positioned overlay whose
	// coordinates are derived from a DOM Range at each note's offset.

	const notesMode = $derived(workspace.notesMode);

	/** Just-dropped/flashed pin id — drives the pin pulse animation. */
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
	 * Locate the rendered text node + in-node offset for a document character
	 * offset by scanning the base-tagged spans. Returns null if the offset can't
	 * be resolved (e.g. text not yet rendered).
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
		// Filter to prose-only notes. Cell notes have no character offset to
		// anchor on; their pins live in the tabular viewers (SpreadsheetViewer /
		// DocumentPane) and would render at offset 0 — which is the document
		// start, not where the user expects. The contract viewer is for prose.
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

	/**
	 * Click handler on the reading surface. In notesMode, a click that ISN'T a
	 * text selection drops a pin at the clicked offset. We ignore clicks that
	 * land on a marked clause (those have their own click behavior) and clicks
	 * that are actually the tail of a drag-select (handled by mouseup).
	 */
	function handleSurfaceClick(e: MouseEvent) {
		if (!notesMode) return;
		// A real text selection means the user is highlighting, not pinning.
		const sel = window.getSelection();
		if (sel && !sel.isCollapsed) return;
		const target = e.target as HTMLElement | null;
		if (target && target.closest('[data-clause-toolbar]')) return;

		const offset = clickOffset(e, -1);
		if (offset < 0) return;
		dropNoteAt(offset);
	}

	/**
	 * Create a note at a document offset, flash its pin, and focus its editor.
	 * Shared by the surface click handler (clicks on plain text) and the clause
	 * click handler (clicks on a marked clause span, which stops propagation and
	 * so never reaches the surface handler).
	 */
	function dropNoteAt(offset: number) {
		if (offset < 0) return;
		// Stamp 'contract' — this surface pins at an EXACT DOM offset (see the
		// module docstring). Used to warn/checkmark when a PDF note is later
		// viewed in the document lens, where PdfViewer's pin is only
		// approximate.
		const note = notesStore.addNote(offset, '', 'contract');
		flashedNoteId = note.id;
		setTimeout(() => {
			if (flashedNoteId === note.id) flashedNoteId = null;
		}, 1200);
		// Reposition after the DOM settles, then ask the Insights pane to focus
		// the new note's editor so the user can type right away.
		tick().then(() => {
			recomputePins();
			workspace.requestFocusNote(note.id);
		});
	}


	// Recompute pin positions whenever the note list, text, or red-flag layout
	// changes (each can shift where offsets land on screen). Reads the reactive
	// deps explicitly so the effect re-runs.
	$effect(() => {
		// Touch reactive deps so this re-runs on change.
		void notesStore.notes.length;
		void text;
		void showRedFlags;
		void clauses.length;
		tick().then(recomputePins);
	});

	// Reposition pins on container scroll/resize (positions are scroll-relative,
	// so they stay attached as the user scrolls).
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

	/** Clicking a pin asks the Insights pane to focus that note's editor. */
	function onPinClick(e: MouseEvent, id: string) {
		e.stopPropagation();
		workspace.requestFocusNote(id);
	}

	/**
	 * Scroll `containerEl` so `range` lands a fixed distance from the TOP of
	 * the reading pane, instead of relying on the browser's native
	 * `scrollIntoView({ block: 'center' })`.
	 *
	 * Why a Range (not a parentElement/node): a note's anchor offset is a
	 * single character position inside a text run that can span many wrapped
	 * lines (a whole paragraph, a whole plain-text segment between clause
	 * marks). Climbing up to `.parentElement` and measuring THAT element's
	 * bounding rect gives you the box around the entire run — whose `.top`
	 * is the top of the run's FIRST line, not the line the note is actually
	 * on. That mismatch is exactly why the old scroll target drifted further
	 * off the more text preceded the note within its enclosing span.
	 *
	 * A collapsed Range at the exact offset (from `rangeForOffset`) resolves
	 * to the precise visual caret position — the same measurement the pin
	 * overlay already uses via `recomputePins()`'s `range.getBoundingClientRect()`.
	 * Reusing that exact calculation here guarantees the scroll target and
	 * the rendered pin always agree, line for line.
	 *
	 * Why not scrollIntoView: `block: 'center'` measures against the nearest
	 * scrollable ancestor's viewport and is notoriously inconsistent once
	 * nested scroll containers, sticky headers, or short documents are
	 * involved. Computing the delta ourselves and driving
	 * `containerEl.scrollTop` directly is deterministic: the target range
	 * always ends up `offsetPx` below the container's own top edge,
	 * regardless of viewport size, browser, or where the note was before
	 * the jump.
	 */
	function scrollRangeToTop(range: Range, offsetPx = 8) {
		if (!containerEl) return;
		const cRect = containerEl.getBoundingClientRect();
		const rRect = range.getBoundingClientRect();
		const delta = rRect.top - cRect.top - offsetPx;
		const maxTop = containerEl.scrollHeight - containerEl.clientHeight;
		const target = Math.max(0, Math.min(containerEl.scrollTop + delta, maxTop));
		containerEl.scrollTo({ top: target, behavior: 'smooth' });
	}

	// ── Consume the PULL scroll-to-note signal (Insights bubble → document). ──
	$effect(() => {
		const id = workspace.scrollToNoteId;
		if (!id || !containerEl) return;
		(async () => {
			await tick();
			recomputePins();
			const pin = pinPositions.find((p) => p.id === id);
			const note = notesStore.notes.find((n) => n.id === id);
			if (note && note.anchor.kind === 'prose') {
				const range = rangeForOffset(note.anchor.offset);
				if (range) scrollRangeToTop(range);
				flashedNoteId = id;
				setTimeout(() => {
					if (flashedNoteId === id) flashedNoteId = null;
				}, 1600);
			}
			void pin;
			workspace.clearScrollToNote();
		})();
	});
</script>


<div class="relative h-full min-w-0 flex flex-col overflow-hidden">

	<!-- Hint banner. `flex-wrap` lets the control group drop to its own line on
	     narrow panes instead of pushing the trailing buttons off the right edge. -->
	<div class="flex flex-wrap items-center gap-2 px-4 py-2 border-b border-gray-200 dark:border-slate-800 bg-gray-50 dark:bg-slate-900/60 flex-shrink-0">
		<span aria-hidden="true">✏️</span>
		<!-- The hint text is allowed to shrink (min-w-0) so it yields space to the
		     controls rather than squeezing them past the edge. -->
		<p class="text-xs text-gray-500 dark:text-gray-400 flex-1 min-w-[10rem]">
			Highlight any clause, then <strong class="text-gray-700 dark:text-gray-200">Mark as Clause</strong>. It's analyzed
			instantly and added to your sidebar.
		</p>

		<!-- Red-flag controls: show/hide toggle + summary badge. Pushed right.
		     The badge cycles focus through each detected red flag on click. -->
		<!-- Control group. Allowed to WRAP (and only `ml-auto` when it fits on one
		     line) so the trailing "Re-edit clauses" button never gets pushed past
		     the header's right edge and clipped. min-w-0 lets it shrink/wrap
		     instead of overflowing the flex row. -->
		<div class="ml-auto flex flex-wrap items-center justify-end gap-2.5 min-w-0">

			<!-- Perspective toggle: flips the glossary lens between the protective
			     reading (employee/tenant → red flags + "soften it" scripts) and the
			     leverage reading (investor/landlord → green flags + "push for it"
			     scripts). Rebuilds the detector trie and re-scans the document. -->
			<button
				type="button"
				onclick={togglePerspective}
				class="inline-flex items-center gap-1.5 text-[11px] px-2 py-1 rounded border transition-colors
					{perspective === 'investor'
						? 'bg-emerald-500/90 text-gray-900 border-emerald-400 font-semibold'
						: 'bg-red-500/90 text-gray-900 border-red-400 font-semibold'}"
				title={perspective === 'employee'
					? 'Reading as the employee/tenant — risks flagged red. Click to switch to the investor/landlord view.'
					: 'Reading as the investor/landlord — leverage flagged green. Click to switch to the employee/tenant view.'}
				aria-pressed={perspective === 'investor'}
			>
				<span aria-hidden="true">{perspective === 'investor' ? '📈' : '🛡️'}</span>
				{perspective === 'investor' ? 'Investor view' : 'Employee view'}
			</button>
			<!-- Notes mode toggle — REMOVED from here. It now lives in
			     DocumentPane.svelte's file-info bar (the "Add Note" button in the
			     top bar), shown uniformly for every contract-lens file type
			     (txt/md/docx/pdf), so having a second copy here was pure
			     duplication. handleSurfaceClick below still reads the derived
			     `notesMode` var regardless of which control flips it. -->

			<label class="inline-flex items-center gap-1.5 text-[11px] text-gray-500 dark:text-gray-400 cursor-pointer select-none" title="Show or hide flag underlines on the document">

				<input
					type="checkbox"
					bind:checked={showRedFlags}
					class="{perspective === 'investor' ? 'accent-emerald-500' : 'accent-red-500'} h-3 w-3"
				/>
				{perspective === 'investor' ? 'Green flags' : 'Red flags'}
			</label>
			{#if showRedFlags}
				<RedFlagBadge {text} {perspective} onJump={jumpToMatch} />
			{/if}


			<!-- Notes show/hide: hides all note pins on the document (default on),
			     mirroring the Red flags toggle. Doesn't delete notes — just visibility. -->
			<label class="inline-flex items-center gap-1.5 text-[11px] text-gray-500 dark:text-gray-400 cursor-pointer select-none" title="Show or hide note pins on the document">
				<input
					type="checkbox"
					bind:checked={showNotePins}
					class="accent-amber-500 h-3 w-3"
				/>
				Notes
			</label>


			{#if paragraphCount <= 1 && clauseStore.count === 0}
				<button
					type="button"
					onclick={markAll}
					class="text-[11px] px-2 py-1 rounded bg-blue-600 text-white hover:bg-blue-500 transition-colors"
				>
					Mark whole document
				</button>
			{:else if showReEditButton}
				<!-- Re-open the review/adjust flow after the user accepted. Lets them
				     revise clause boundaries (merge/split/remove/add) at any time. -->
				<button
					type="button"
					onclick={reEditClauses}
					class="flex items-center gap-1 text-[11px] px-2 py-1 rounded border border-gray-300 text-gray-600 hover:text-gray-900 hover:border-gray-500 dark:border-gray-600 dark:text-gray-300 dark:hover:text-white dark:hover:border-gray-400 transition-colors"
					title="Re-open clause review to merge, split, remove, or add clauses"
				>
					<span aria-hidden="true">✎</span> Re-edit clauses
				</button>
			{/if}
		</div>
	</div>



	<!-- Review banner — shown right after auto-detect, before the user accepts or
	     starts adjusting. Calls out the yellow/red (medium/low) clauses to review. -->
	{#if showReviewBanner}
		<div
			class="flex flex-wrap items-center gap-2 px-4 py-2.5 border-b border-blue-300 dark:border-blue-800/60 bg-blue-50 dark:bg-blue-950/40 flex-shrink-0"
		>
			<span aria-hidden="true">✨</span>
			<p class="text-xs text-blue-800 dark:text-blue-200 flex-1 min-w-[12rem]">
				<strong>Clauses auto-detected.</strong> Review the
				<span class="text-amber-700 dark:text-amber-300">yellow</span> and <span class="text-red-700 dark:text-red-300">red</span> ones —
				they may need adjustment.
			</p>
			<div class="flex items-center gap-2">
				<button
					type="button"
					onclick={acceptAll}
					class="px-2.5 py-1 rounded text-xs font-medium text-white bg-emerald-600 hover:bg-emerald-500 transition-colors"
				>
					Looks good
				</button>
				<button
					type="button"
					onclick={startAdjusting}
					class="px-2.5 py-1 rounded text-xs font-medium text-blue-700 hover:bg-blue-100 dark:text-blue-200 border border-blue-400 dark:border-blue-700 dark:hover:bg-blue-900/50 transition-colors"
				>
					Let me adjust
				</button>
			</div>
		</div>
	{/if}

	<!-- Merge hint — while a merge anchor is armed. -->
	{#if mergeAnchorId}
		<div class="flex items-center gap-2 px-4 py-1.5 border-b border-gray-200 dark:border-slate-800 bg-gray-50 dark:bg-slate-900/80 flex-shrink-0">
			<span aria-hidden="true">🔗</span>
			<p class="text-[11px] text-gray-700 dark:text-gray-300">
				Now click an <strong>adjacent</strong> clause to merge it with this one.
			</p>

			<button
				type="button"
				onclick={() => (mergeAnchorId = null)}
				class="ml-auto text-[11px] px-2 py-0.5 rounded text-gray-500 hover:text-gray-800 hover:bg-gray-200 dark:text-gray-400 dark:hover:text-gray-200 dark:hover:bg-slate-800 transition-colors"
			>
				Cancel
			</button>
		</div>
	{/if}

	<!-- Reading surface -->
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->

	<div
		bind:this={containerEl}
		class="relative flex-1 overflow-auto p-6"
		class:notes-cursor={notesMode}
		role="region"
		aria-label="Contract text — highlight to mark clauses"
		onmouseup={handleMouseUp}
		onclick={handleSurfaceClick}
	>

		<div class="mx-auto w-full max-w-3xl min-w-0">
			<p class="contract-body text-sm text-gray-900 dark:text-gray-300 font-sans">{#each segments as seg (seg.base)}{#if seg.kind === 'plain'}{#if showRedFlags}{#each plainSubsegments(seg.base, seg.text) as sub (sub.base)}{#if sub.kind === 'term'}<GlossaryTooltip entry={sub.entry}>{#snippet children()}<span data-base={sub.base} data-term-base={sub.base}>{sub.text}</span>{/snippet}</GlossaryTooltip>{:else}<span data-base={sub.base}>{sub.text}</span>{/if}{/each}{:else}<span data-base={seg.base}>{seg.text}</span>{/if}{:else}<span


							data-base={seg.base}
							data-mark-id={seg.id}
							class="clause-mark rounded px-0.5 transition-shadow"
							class:flash={highlightedId === seg.id}
							class:merge-anchor={mergeAnchorId === seg.id}
							style="background-color: {seg.color}66; box-shadow: inset 0 -2px 0 {seg.color}; {confidenceBorder(seg.confidence)}"
							role="button"
							tabindex="0"
							title="Clause {seg.index} ({seg.confidence}) — click to adjust"

							onclick={(e) => onMarkClick(e, seg.id, clickOffset(e, seg.base))}
							oncontextmenu={(e) => onMarkContextMenu(e, seg.id, clickOffset(e, seg.base))}
							onkeydown={(e) => {
								if (e.key === 'Enter' || e.key === ' ') {
									e.preventDefault();
									onMarkClick(e as unknown as MouseEvent, seg.id, seg.base);
								}
							}}><sup class="clause-badge" style="color: {seg.color};">{seg.index}</sup>{#if showRedFlags}{#each plainSubsegments(seg.base, seg.text) as sub (sub.base)}{#if sub.kind === 'term'}<GlossaryTooltip entry={sub.entry}>{#snippet children()}<span data-base={sub.base} data-term-base={sub.base}>{sub.text}</span>{/snippet}</GlossaryTooltip>{:else}<span data-base={sub.base}>{sub.text}</span>{/if}{/each}{:else}{seg.text}{/if}</span>{/if}{/each}</p>


		</div>

		<!-- Note pins overlay. Absolutely positioned (container-relative, scroll-
		     aware) markers anchored at each note's character offset. Clicking a pin
		     focuses that note's editor in the Notes pane. Hidden when the "Notes"
		     show/hide checkbox is off (notes are preserved, just not displayed). -->
		{#each showNotePins ? pinPositions : [] as pin (pin.id)}
			<!-- A precise downward-facing yellow triangle whose bottom tip sits exactly
			     on the note's character offset (the wrapper is translated so its
			     bottom-center — the triangle's point — lands on pin.x/pin.y). The
			     numbered badge rides above the triangle. Larger than the prior marker. -->
			<button
				type="button"
				data-clause-toolbar
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
				<!-- Downward triangle: tip at bottom-center = the precise offset. -->
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



		<!-- Floating toolbar -->
		{#if toolbar}

			<div
				data-clause-toolbar
				class="absolute z-40 -translate-x-1/2 -translate-y-full -mt-2"
				style="left: {toolbar.x}px; top: {toolbar.y}px;"
			>
				<div class="flex items-center gap-1 rounded-lg bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 shadow-xl px-1 py-1">
					{#if toolbar.overlap}
						<span class="px-2 py-1 text-[11px] text-amber-700 dark:text-amber-300 whitespace-nowrap">
							⚠️ Overlaps an existing clause
						</span>
					{:else}
						<button
							type="button"
							onclick={confirmMark}
							class="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium text-white bg-blue-600 hover:bg-blue-500 transition-colors whitespace-nowrap"
						>
							<span aria-hidden="true">＋</span> Mark as Clause
						</button>
					{/if}
					<button
						type="button"
						onclick={dismissToolbar}
						class="px-1.5 py-1 rounded text-gray-500 hover:text-gray-800 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-200 dark:hover:bg-slate-700 transition-colors text-xs"
						aria-label="Cancel"
					>✕</button>
				</div>
			</div>
		{/if}

		<!-- Per-clause adjustment toolbar (Merge / Split here / Remove). Appears on
		     click or right-click of a marked clause once in adjustment mode. -->
		{#if clauseMenu}
			<div
				data-clause-toolbar
				class="absolute z-40 -translate-y-full -mt-2"
				style="left: {clauseMenu.x}px; top: {clauseMenu.y}px;"
			>
				<div class="flex items-center gap-1 rounded-lg bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 shadow-xl px-1 py-1">
					<button
						type="button"
						onclick={() => startMerge(clauseMenu!.id)}
						class="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-slate-700 transition-colors whitespace-nowrap"
						title="Then click an adjacent clause to merge it with this one"
					>
						<span aria-hidden="true">🔗</span> Merge

					</button>
					<button
						type="button"
						onclick={doSplit}
						class="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-slate-700 transition-colors whitespace-nowrap"
						title="Split this clause at the click point"
					>
						<span aria-hidden="true">✂️</span> Split here
					</button>
					<button
						type="button"
						onclick={() => doRemove(clauseMenu!.id)}
						class="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium text-red-600 hover:bg-red-50 dark:text-red-300 dark:hover:bg-red-950/60 transition-colors whitespace-nowrap"
						title="Unmark this clause"
					>
						<span aria-hidden="true">🗑️</span> Remove
					</button>
					<button
						type="button"
						onclick={() => (clauseMenu = null)}
						class="px-1.5 py-1 rounded text-gray-500 hover:text-gray-800 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-200 dark:hover:bg-slate-700 transition-colors text-xs"
						aria-label="Cancel"
					>✕</button>
				</div>
			</div>
		{/if}
	</div>
</div>


<style>
	/* Contract reading surface.
	   `pre-line` honors the normalized paragraph breaks (the only newlines left
	   in the text are real "\n\n" paragraph boundaries — soft line-wrap newlines
	   were collapsed upstream in DocumentPane.normalizeContractText) while
	   collapsing any incidental runs of whitespace. Justified text + a generous
	   line height give the even, block-like column the user asked for; paragraph
	   spacing comes from the blank line that `pre-line` renders. */
	.contract-body {
		white-space: pre-line;
		text-align: justify;
		text-justify: inter-word;
		line-height: 1.85;
		hyphens: auto;
		/* Never let a long unbroken run (signature underscores "______", long
		   URLs, account numbers, hashes) push the column wider than the viewport.
		   `overflow-wrap: anywhere` breaks such runs as needed; `word-break:
		   break-word` is the WebKit/Safari counterpart. max-width:100% + min-width:0
		   keep the paragraph from ever exceeding its container so the horizontal
		   scrollbar (and clipped right edge) never appear. */
		max-width: 100%;
		min-width: 0;
		overflow-wrap: anywhere;
		word-break: break-word;
	}
	/* Marked clause spans are inline children — keep the same aggressive wrapping
	   so a highlighted long token also breaks instead of overflowing. */
	.clause-mark {
		cursor: pointer;
		animation: mark-in 0.3s ease-out;
		overflow-wrap: anywhere;
		word-break: break-word;
	}

	.clause-mark:hover {
		filter: brightness(1.08);
	}
	/* Armed merge anchor — pulsing blue ring so the user sees which clause they
	   picked while they shift-click its neighbour. */
	.merge-anchor {
		outline: 2px solid #3b82f6;
		outline-offset: 1px;
		animation: anchor-pulse 1.1s ease-in-out infinite;
	}
	@keyframes anchor-pulse {
		0%,
		100% {
			outline-color: rgba(59, 130, 246, 0.9);
		}
		50% {
			outline-color: rgba(59, 130, 246, 0.35);
		}
	}

	.clause-badge {
		font-size: 0.6em;
		font-weight: 700;
		margin-right: 1px;
		vertical-align: super;
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

	.flash {
		animation: mark-flash 1.2s ease-out;
	}
	/* Transient highlight when the red-flag badge jumps focus to a term. Applied
	   imperatively to the matched glossary sub-span; uses :global because the
	   class is toggled on a DOM node rendered by the GlossaryTooltip child. */
	:global(.term-flash) {
		border-radius: 2px;
		animation: term-flash 1.6s ease-out;
	}
	@keyframes term-flash {
		0%,
		100% {
			background-color: transparent;
		}
		25% {
			background-color: rgba(239, 68, 68, 0.45);
		}
	}

	@keyframes mark-in {
		from {
			background-color: transparent;
			opacity: 0.4;
		}
	}
	@keyframes mark-flash {
		0%,
		100% {
			box-shadow: inset 0 -2px 0 currentColor;
		}
		30% {
			box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.6);
		}
	}
</style>
