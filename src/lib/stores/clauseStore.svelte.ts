/**
 * src/lib/stores/clauseStore.svelte.ts — Live highlight-based clause marking
 *
 * Backs the highlight-to-mark contract experience (ClauseHighlighter +
 * ClauseSidebar). The user highlights arbitrary spans of the contract text and
 * "Marks as Clause"; each marked span is classified locally (legal-classifier)
 * and resolves from a provisional "analyzing" state to a real label + risk in
 * place — the per-clause "satisfying" flow.
 *
 * This is a LIVE working store: positions are character offsets into the
 * document text. Color is a presentation-only attribute that lives here (it is
 * never persisted into ContractProfile). When the user runs the full analysis,
 * DocumentPane funnels these spans into buildProfileFromClauses() to enrich the
 * sidebar with parties/dates/missing-clause warnings.
 *
 * Svelte 5 runes, module-level reactive state — same pattern as
 * workspace.svelte.ts. The store is the only channel between the highlighter
 * and the sidebar; neither imports the other.
 */

import type { ClauseRisk } from '$lib/models/legal-classifier.js';
import type { PersistedClause } from '$lib/schema.js';
import { getDocument, updateDocument } from '$lib/stores/contract-store.svelte.js';
import { workspace } from '$lib/stores/workspace.svelte.js';



// ============================================================
// Types
// ============================================================

/** Lifecycle of a single marked clause. */
export type ClauseStatus = 'pending' | 'analyzing' | 'analyzed' | 'error';

/**
 * Confidence of a clause BOUNDARY (how sure the auto-splitter is that this is a
 * real clause). Drives the green/yellow/red highlight styling + sidebar badge:
 *   - 'high'   → split at a heading + paragraph boundary (green, solid border)
 *   - 'medium' → split at a paragraph boundary without a heading (yellow, dashed)
 *   - 'low'    → split mid-paragraph or at an unusual position (red, dotted)
 *   - 'edited' → the user merged/split/adjusted/added this clause (blue). Once a
 *                clause is user-modified its original auto-confidence is moot, so
 *                we surface that it is now human-authored, not machine-guessed.
 */
export type ClauseConfidence = 'high' | 'medium' | 'low' | 'edited';

/** A text selection captured by the highlighter, in document char offsets. */
export interface ClauseSelection {
	/** Inclusive start offset into the document text. */
	startOffset: number;
	/** Exclusive end offset into the document text. */
	endOffset: number;
	/** The exact selected text (already sliced from the document). */
	text: string;
}

/** A marked clause — a highlighted span plus its (eventual) classification. */
export interface MarkedClause {
	/** Stable, unique id (assigned at mark time). Keys the UI + scroll target. */
	id: string;
	/** Inclusive start offset into the document text. Drives display order. */
	startOffset: number;
	/** Exclusive end offset into the document text. */
	endOffset: number;
	/** The clause text (sliced from the document at mark time). */
	text: string;
	/** Highlight tint (CSS color) — presentation only, never persisted. */
	color: string;
	/** Classifier display label once resolved (e.g. "Indemnification"). */
	heading: string | null;
	/** Raw snake_case model label (e.g. "indemnification"). */
	label: string | null;
	/** Risk level once classified. */
	risk: ClauseRisk | null;
	/** Lifecycle state — drives the provisional → resolved UI. */
	status: ClauseStatus;
	/**
	 * Boundary confidence (auto-detect) or 'edited' once the user modifies it.
	 * Drives the green/yellow/red/blue highlight styling + sidebar badge. Marks
	 * added by the user's own highlight are 'edited' (human-authored).
	 */
	confidence: ClauseConfidence;
}

// ============================================================
// Palette — accessible pastel tints (dark text reads on all)
// ============================================================

/**
 * Cycled by mark index so adjacent clauses are visually distinct. Soft, low-
 * saturation tints chosen to keep the underlying dark-text contract text legible
 * when the span is laid over it (the highlighter uses these at ~30% alpha).
 */
const PALETTE: string[] = [
	'#fde68a', // amber-200
	'#a7f3d0', // emerald-200
	'#bfdbfe', // blue-200
	'#ddd6fe', // violet-200
	'#fbcfe8', // pink-200
	'#fed7aa', // orange-200
	'#bbf7d0', // green-200
	'#c7d2fe', // indigo-200
	'#fecaca', // red-200
	'#99f6e4' // teal-200
];

/** Pick a palette color for the Nth-ever mark (monotonic, cycles). */
function colorForIndex(i: number): string {
	return PALETTE[i % PALETTE.length];
}

// ============================================================
// State
// ============================================================

let clauses = $state<MarkedClause[]>([]);
/** Monotonic counter so colors stay stable even as clauses are removed. */
let markCounter = 0;
let idCounter = 0;
/**
 * True once we've already surfaced a "classifier unavailable" toast for the
 * CURRENT document binding. Prevents spamming one toast per failed clause when
 * the root cause (e.g. a CORS-blocked model bucket) makes EVERY classification
 * fail identically — the user only needs to be told once. Reset on reset()/
 * unbind() so a new document (or a reload after fixing the root cause) can warn
 * again if it's still broken.
 */
let classifierUnavailableWarned = false;


// ============================================================
// Per-document persistence (CesvuDocument.clauses)
//
// Marks are stored on the active document's `clauses` field (see
// src/lib/schema.ts — PersistedClause), written via the contract-store's
// updateDocument(). This is the SAME durable channel notes use, so marks:
//   • survive a lens toggle (contract ⇄ document — bindDocument is a no-op
//     while the bound document is unchanged);
//   • are restored when the same document re-opens in the session;
//   • travel inside the encrypted .cesvu export and come back on import.
//
// Two identifiers are tracked: the document TEXT (used to detect a genuinely
// new document so auto-detect re-runs) and the contract ID (the persistence
// target). The contract ID can arrive AFTER marks already exist — a freshly
// uploaded file has no persisted CesvuDocument until the user exports, at
// which point bindDocument is re-invoked with a real id; in that case the
// in-memory marks are flushed (migrated) into the newly-created record rather
// than overwritten by its empty `clauses`.
// ============================================================

/** Document text the store is currently bound to (null = unbound). */
let activeText: string | null = null;
/** Contract id the marks persist to (null = no persisted record yet). */
let activeDocId: string | null = null;

/** MarkedClause → PersistedClause (JSON-safe; fields are 1:1). */
function toPersisted(c: MarkedClause): PersistedClause {
	return {
		id: c.id,
		startOffset: c.startOffset,
		endOffset: c.endOffset,
		text: c.text,
		color: c.color,
		heading: c.heading,
		label: c.label,
		risk: c.risk,
		status: c.status,
		confidence: c.confidence
	};
}

/** PersistedClause → MarkedClause (the live working shape). */
function fromPersisted(p: PersistedClause): MarkedClause {
	return {
		id: p.id,
		startOffset: p.startOffset,
		endOffset: p.endOffset,
		text: p.text,
		color: p.color,
		heading: p.heading,
		label: p.label,
		risk: p.risk,
		status: p.status,
		confidence: p.confidence
	};
}

/** Advance the id/mark counters past a restored set so new marks don't collide. */
function advanceCountersPast(restored: MarkedClause[]) {
	idCounter = restored.reduce((m, c) => {
		const n = Number(c.id.replace(/\D/g, ''));
		return Number.isFinite(n) ? Math.max(m, n + 1) : m;
	}, 0);
	markCounter = restored.length;
}

/**
 * Write the current marks to the bound document's `clauses` field. Fire-and-
 * forget; no-op when there is no persisted record yet (activeDocId === null),
 * in which case the marks live in memory until a record is created and
 * bindDocument migrates them.
 */
function persist() {
	if (activeDocId === null) return;
	const payload = clauses.map(toPersisted);
	updateDocument(activeDocId, { clauses: payload }).catch((err: unknown) =>
		console.warn('[clauseStore] persist failed:', err)
	);
}

/**
 * Bind the store to a document (called by DocumentPane whenever a document is
 * open). Idempotent: binding to the SAME text AND id is a NO-OP, so toggling
 * the lens (contract ⇄ document) preserves the live marks. Resolves to true
 * when marks were restored from the document's persisted `clauses`.
 *
 * Transitions handled:
 *   • text changed                → new document: reset review flags and load
 *                                   the new document's saved marks (or clear).
 *   • text same, id null → real   → freshly-uploaded file just got persisted
 *                                   (first export): MIGRATE the in-memory marks
 *                                   into the new record instead of clearing.
 */
async function bindDocument(text: string, contractId: string | null = null): Promise<boolean> {
	if (!text) return false;
	// Same document AND same persistence target → keep live marks untouched.
	if (text === activeText && contractId === activeDocId) return false;

	const textChanged = text !== activeText;
	const hadClauses = clauses.length > 0;

	activeText = text;
	activeDocId = contractId;

	// A genuinely different document gets a fresh auto-detect pass + review banner.
	if (textChanged) {
		autoDetected = false;
		reviewed = false;
	}

	// Load this document's persisted marks (if a record exists).
	let saved: PersistedClause[] = [];
	if (contractId) {
		const doc = await getDocument(contractId);
		if (doc && Array.isArray(doc.clauses)) saved = doc.clauses;
	}

	if (saved.length > 0) {
		// Restore exactly (labels/risk/color preserved).
		clauses = saved.map(fromPersisted);
		advanceCountersPast(clauses);
		return true;
	}

	// No saved marks on the target document.
	if (!textChanged && hadClauses && contractId) {
		// Same document, but it only just acquired a persisted record (the
		// fresh-upload → first-export path). Flush the in-memory marks into it
		// rather than dropping them.
		persist();
		return false;
	}

	if (textChanged) {
		// New document with nothing saved → start clean.
		clauses = [];
		markCounter = 0;
		idCounter = 0;
	}
	return false;
}



// ============================================================
// Derived
// ============================================================

/** Count of marked clauses (drives the honest "N clauses marked" counter). */
let count = $derived(clauses.length);
/** True once enough clauses exist to make full analysis worthwhile. */
let canAnalyze = $derived(clauses.length >= 3);
/** All clauses still resolving (pending or analyzing). */
let analyzingCount = $derived(
	clauses.filter((c) => c.status === 'pending' || c.status === 'analyzing').length
);

// ============================================================
// Helpers
// ============================================================

/**
 * Does [start, end) overlap any EXISTING clause span? Used by the highlighter to
 * refuse overlapping marks (a character can belong to at most one clause).
 */
function overlaps(start: number, end: number): boolean {
	return clauses.some((c) => start < c.endOffset && end > c.startOffset);
}

/** Insert keeping the array sorted ascending by startOffset (document order). */
function insertSorted(clause: MarkedClause) {
	const next = [...clauses, clause].sort((a, b) => a.startOffset - b.startOffset);
	clauses = next;
}

// ============================================================
// Actions
// ============================================================

/**
 * Mark a new clause from a selection. Inserts it immediately in a provisional
 * 'pending' state (so the highlight + sidebar card appear at once), then kicks
 * off async classification which transitions it to 'analyzing' → 'analyzed'
 * (or 'error', degrading gracefully). Returns the new clause id, or null if the
 * selection overlapped an existing clause (caller should have prevented this).
 */
function addClause(sel: ClauseSelection, confidence: ClauseConfidence = 'edited'): string | null {
	if (sel.endOffset <= sel.startOffset) return null;
	if (overlaps(sel.startOffset, sel.endOffset)) return null;

	const id = `mark-${idCounter++}`;
	const color = colorForIndex(markCounter++);
	const clause: MarkedClause = {
		id,
		startOffset: sel.startOffset,
		endOffset: sel.endOffset,
		text: sel.text,
		color,
		heading: null,
		label: null,
		risk: null,
		status: 'pending',
		// A clause the USER highlights is human-authored → 'edited'. The
		// auto-detector passes its own per-clause confidence ('high'|'medium'|'low').
		confidence
	};
	insertSorted(clause);
	persist();
	void classify(id, sel.text);
	return id;
}


/**
 * Run the local clause classifier for `id` and fold the result back in. Lazily
 * imports legal-classifier (so the ~280MB model only loads when the user marks
 * their first clause). Any failure degrades gracefully to a neutral 'error'
 * state — the clause is kept, never dropped.
 */
async function classify(id: string, text: string) {
	patch(id, { status: 'analyzing' });
	try {
		const { classifyClause } = await import('$lib/models/legal-classifier.js');
		const cls = await classifyClause(text);
		patch(id, {
			heading: cls.label,
			label: cls.rawLabel,
			risk: cls.risk,
			status: 'analyzed'
		});
	} catch (err) {
		console.warn('[clauseStore] classify failed:', err);
		// Surface this to the user ONCE per document binding. Without this, a
		// systemic failure (e.g. the model bucket blocking CORS, or the model
		// failing to load on both WebGPU and WASM) silently degrades EVERY clause
		// to "Unclassified" with zero indication anything is wrong — the user is
		// left thinking the classifier just doesn't know these clause types.
		if (!classifierUnavailableWarned) {
			classifierUnavailableWarned = true;
			const msg = err instanceof Error ? err.message : String(err);
			workspace.showToast(`Clause classifier unavailable: ${msg}`, 6000);
		}
		patch(id, {
			heading: 'Unclassified',
			label: 'unclassified',
			risk: 'low',
			status: 'error'
		});
	}
}


/** Shallow-merge a patch into the clause with `id` (no-op if it's gone). */
function patch(id: string, fields: Partial<MarkedClause>) {
	clauses = clauses.map((c) => (c.id === id ? { ...c, ...fields } : c));
	// Persist resolved classification (label/risk/status) so a restored mark
	// comes back fully resolved instead of re-running the model.
	persist();
}

/** Remove a clause by id. Remaining clauses renumber implicitly (order-derived). */
function removeClause(id: string) {
	clauses = clauses.filter((c) => c.id !== id);
	persist();
}


/**
 * Re-seed the store from saved start offsets when a contract is re-opened.
 * `text` is the full document text; `offsets` are the saved manual split
 * boundaries (start offsets). Each consecutive pair becomes a clause span, and
 * each is re-classified. Used by DocumentPane to restore highlights.
 */
function seedFromOffsets(text: string, offsets: number[]) {
	reset();
	const sorted = [...new Set(offsets)].filter((o) => o >= 0 && o < text.length).sort((a, b) => a - b);
	for (let i = 0; i < sorted.length; i++) {
		const start = sorted[i];
		const end = i + 1 < sorted.length ? sorted[i + 1] : text.length;
		const slice = text.slice(start, end).trim();
		if (slice.length === 0) continue;
		addClause({ startOffset: start, endOffset: end, text: slice });
	}
}

// ============================================================
// Auto-detect (hybrid clause selection)
//
// On upload we run a deterministic, OFFSET-PRESERVING paragraph detector over
// the SAME documentText the highlighter renders (so offsets line up exactly),
// and assign each detected clause a boundary confidence:
//   • high   — the clause STARTS with a heading (numbered / ALL-CAPS / markdown)
//              AND sits on a paragraph boundary
//   • medium — clean paragraph boundary, no heading
//   • low    — unusual position (very short, or only one paragraph found)
// The user reviews these, then accepts ("Looks good") or adjusts (merge / split
// / boundary / remove / add). Adjusted clauses flip to 'edited'.
// ============================================================

/** True once auto-detect has run for the bound document (drives the banner). */
let autoDetected = $state(false);
/**
 * True once the user has explicitly accepted ("Looks good") or chosen to adjust
 * the auto-detected clauses — i.e. they're done with the initial review. This is
 * what HIDES the review banner. Distinct from `autoDetected` (which only says the
 * pass ran). Re-opening review (the "Re-edit clauses" button) flips this back to
 * false so the banner + review affordances return.
 */
let reviewed = $state(false);


/** Does this paragraph's first line look like a section HEADING? */
function looksLikeHeading(para: string): boolean {
	const first = para.split('\n')[0]?.trim() ?? '';
	if (!first) return false;
	if (/^#{1,6}\s+/.test(first)) return true; // markdown heading
	if (/^\d{1,2}[.)]\s+\S/.test(first)) return true; // "3. Title" / "3) Title"
	if (/^(ARTICLE|SECTION|SCHEDULE|EXHIBIT|APPENDIX|ANNEX)\b/i.test(first)) return true;
	// Short ALL-CAPS line → heading.
	if (first.length <= 60 && /^[A-Z][A-Z0-9 ,&/'’-]{3,}$/.test(first)) return true;
	return false;
}

/**
 * Run auto-detect for `text`. Splits on paragraph boundaries (offset-preserving
 * via the splitter's splitParagraphOffsets) and assigns a per-clause confidence.
 * No-op if the store already has marks for this document (restored session) or
 * auto-detect already ran. Each detected clause is classified asynchronously
 * (same pipeline as a manual mark). Async because the splitter is imported lazily.
 */
async function autoDetect(text: string): Promise<void> {
	if (!text || !text.trim()) return;
	if (autoDetected) return;
	// Respect a restored / non-empty working set — never clobber existing marks.
	if (clauses.length > 0) {
		autoDetected = true;
		return;
	}
	autoDetected = true;

	const { splitParagraphOffsets } = await import('$lib/lenses/contract/clause-splitter.js');
	const paras = splitParagraphOffsets(text);
	if (paras.length === 0) return;

	// Single-paragraph contract → one low-confidence clause spanning the doc.
	if (paras.length === 1) {
		const trimmed = text.trim();
		const start = text.indexOf(trimmed[0] ?? '');
		addClause(
			{ startOffset: Math.max(0, start), endOffset: text.length, text: trimmed },
			'low'
		);
		return;
	}

	for (let i = 0; i < paras.length; i++) {
		const start = paras[i].offset;
		const end = i + 1 < paras.length ? paras[i + 1].offset : text.length;
		const slice = text.slice(start, end).trim();
		if (slice.length === 0) continue;
		// Confidence heuristic (per the spec):
		//   heading + paragraph boundary → high
		//   paragraph boundary, no heading → medium
		//   very short fragment → low (unusual position)
		let confidence: ClauseConfidence;
		if (slice.length < 40) confidence = 'low';
		else if (looksLikeHeading(slice)) confidence = 'high';
		else confidence = 'medium';
		addClause({ startOffset: start, endOffset: end, text: slice }, confidence);
	}
}

/**
 * Accept all auto-detected clauses as-is ("Looks good"). Marks the review as
 * done, which hides the review banner. The clauses themselves are untouched.
 */
function acceptAll() {
	autoDetected = true;
	reviewed = true;
}

/**
 * Re-open the clause review ("Re-edit clauses"). Brings the review banner and
 * the adjustment affordances back so the user can revise boundaries later. The
 * existing marked clauses are preserved — this only flips the reviewed flag.
 */
function reopenReview() {
	reviewed = false;
}


/**
 * Merge two ADJACENT clauses into one. The result spans from the earlier start
 * to the later end, is marked 'edited', and is re-classified. No-op if the two
 * ids aren't adjacent in document order (the UI only offers merge for adjacent
 * selections). The merged clause keeps the FIRST clause's color.
 */
function mergeClauses(idA: string, idB: string, fullText: string): void {
	const sorted = [...clauses].sort((a, b) => a.startOffset - b.startOffset);
	const ia = sorted.findIndex((c) => c.id === idA);
	const ib = sorted.findIndex((c) => c.id === idB);
	if (ia === -1 || ib === -1) return;
	const lo = Math.min(ia, ib);
	const hi = Math.max(ia, ib);
	if (hi - lo !== 1) return; // must be adjacent
	const first = sorted[lo];
	const second = sorted[hi];
	const start = first.startOffset;
	const end = second.endOffset;
	const text = fullText.slice(start, end).trim();
	const id = `mark-${idCounter++}`;
	const merged: MarkedClause = {
		id,
		startOffset: start,
		endOffset: end,
		text,
		color: first.color,
		heading: null,
		label: null,
		risk: null,
		status: 'pending',
		confidence: 'edited'
	};
	clauses = [...clauses.filter((c) => c.id !== first.id && c.id !== second.id), merged].sort(
		(a, b) => a.startOffset - b.startOffset
	);
	persist();
	void classify(id, text);
}

/**
 * Split a clause at document offset `at` into two clauses. Both halves are
 * marked 'edited' and re-classified. No-op if `at` isn't strictly inside the
 * clause (so neither half is empty). The first half keeps the original color;
 * the second gets the next palette color.
 */
function splitClause(id: string, at: number, fullText: string): void {
	const c = clauses.find((x) => x.id === id);
	if (!c) return;
	if (at <= c.startOffset || at >= c.endOffset) return;
	const aText = fullText.slice(c.startOffset, at).trim();
	const bText = fullText.slice(at, c.endOffset).trim();
	if (!aText || !bText) return;
	const idA = `mark-${idCounter++}`;
	const idB = `mark-${idCounter++}`;
	const a: MarkedClause = {
		id: idA,
		startOffset: c.startOffset,
		endOffset: at,
		text: aText,
		color: c.color,
		heading: null,
		label: null,
		risk: null,
		status: 'pending',
		confidence: 'edited'
	};
	const b: MarkedClause = {
		id: idB,
		startOffset: at,
		endOffset: c.endOffset,
		text: bText,
		color: colorForIndex(markCounter++),
		heading: null,
		label: null,
		risk: null,
		status: 'pending',
		confidence: 'edited'
	};
	clauses = [...clauses.filter((x) => x.id !== id), a, b].sort(
		(x, y) => x.startOffset - y.startOffset
	);
	persist();
	void classify(idA, aText);
	void classify(idB, bText);
}

/** Clear all marks (new document / explicit reset). */
function reset(initial: MarkedClause[] = []) {
	clauses = initial;
	markCounter = initial.length;
	idCounter = initial.length;
	autoDetected = false;
	reviewed = false;
	classifierUnavailableWarned = false;
}


/**
 * Full teardown for the document-close lifecycle. Unlike reset() — which only
 * clears the working clause list + review flags and is reused by seedFromOffsets
 * mid-reopen — unbind() ALSO drops the document binding (activeText/activeDocId).
 * That binding is what lets a freshly-opened document be mistaken for "same
 * text / new id" and inherit or migrate the previous document's marks, so the
 * close path MUST clear it. Called only by workspace.closeDocument() (the single
 * teardown owner; see workspace.svelte.ts → perDocumentTeardowns).
 */
function unbind() {
	clauses = [];
	markCounter = 0;
	idCounter = 0;
	autoDetected = false;
	reviewed = false;
	classifierUnavailableWarned = false;
	activeText = null;
	activeDocId = null;
}




// ============================================================
// Export
// ============================================================

export const clauseStore = {
	// State / derived getters
	get clauses() {
		return clauses;
	},
	get count() {
		return count;
	},
	get canAnalyze() {
		return canAnalyze;
	},
	get analyzingCount() {
		return analyzingCount;
	},
	/** True once auto-detect has run for the bound document (drives the review banner). */
	get autoDetected() {
		return autoDetected;
	},
	/**
	 * True once the user finished the initial review ("Looks good" / "Let me
	 * adjust"). The review banner shows while this is false; "Re-edit clauses"
	 * flips it back to false. Drives both the banner and the sidebar re-edit CTA.
	 */
	get reviewed() {
		return reviewed;
	},

	// Queries
	overlaps,

	// Actions
	addClause,
	removeClause,
	seedFromOffsets,
	bindDocument,
	autoDetect,
	acceptAll,
	reopenReview,
	mergeClauses,
	splitClause,
	reset,
	unbind
};




