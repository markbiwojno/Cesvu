/**
 * src/lib/stores/notesStore.svelte.ts — user note-taking on contracts.
 *
 * A note is a free-text comment the user pins to a stable anchor. Two anchor
 * kinds are supported:
 *   - 'prose':  a character offset in the contract text (the original case)
 *   - 'cell':   a { sheet, column, rowIndex } coordinate in a tabular sheet
 *               (the CSV/Excel workbench)
 *
 * Notes render as numbered pins over the document/table (left pane) and as
 * editable chat-style bubbles in the Notes pane (right pane). Both anchor
 * kinds share the same `NotesPane` UI; the only difference is the anchor
 * chip in the bubble and the scroll/highlight target on click.
 *
 * Persistence:
 *   Notes are stored as {@link DocumentAnnotation} records in the active
 *   document's `annotations` array (see schema.ts — the field was reserved for
 *   exactly this). They are written to IndexedDB via updateDocument(), survive
 *   reload/re-open, and will be carried into the encrypted `.cesvu` export when
 *   that lands (annotations travel inside the payload, ContentType 0x02).
 *
 *   This is a module-level runes store (not a component) so the note list
 *   survives component unmount/remount while the user toggles panes. It is bound
 *   to a single active document at a time via bindDocument(); switching docs
 *   flushes nothing (each mutation persists eagerly) and reloads the new list.
 *
 * Author:
 *   v1 has no authentication, so every note is authored as "You". The author
 *   field exists for forward-compatibility with multi-party annotations.
 */

import type { DocumentAnnotation } from '$lib/schema.js';
import { getDocument, updateDocument } from '$lib/stores/contract-store.svelte.js';
import { newId } from '$lib/utils/id.js';


/** Cell-anchor payload. `rowIndex = -1` means the whole column. */
export type CellAnchor = { kind: 'cell'; sheet: string; column: string; rowIndex: number };
/** Prose-anchor payload. `offset` is a character offset into the document text. */
export type ProseAnchor = { kind: 'prose'; offset: number };
/** Discriminated union over both kinds. */
export type NoteAnchor = ProseAnchor | CellAnchor;

/** A note as used by the UI. The structured `anchor` carries the location
 *  (prose offset or cell coordinate) regardless of which surface rendered
 *  the note. */
export interface Note {
	id: string;
	/** Structured location. Prose = char offset, cell = grid coordinate. */
	anchor: NoteAnchor;
	/**
	 * Which lens this note's pin was originally dropped in — 'contract'
	 * (ClauseHighlighter, exact) or 'document' (PdfViewer, approximate —
	 * PDF only). Undefined for notes created before this field existed, or
	 * for cell notes (spreadsheet lenses have no positional-drift issue).
	 * Used to warn the user when a PDF note is being viewed in the OTHER
	 * lens from the one it was created in, where the pin is only an
	 * approximate proportional-offset placement (see PdfViewer.svelte).
	 */
	createdInLens?: 'contract' | 'document';
	/** Self-reported author (always "You" in v1). */
	author: string;
	/** The note body. */
	body: string;
	/** ms epoch — creation. */
	createdAt: number;
}

/** Default author for v1 (no auth). */
const DEFAULT_AUTHOR = 'You';

/** localStorage key for the user's self-set display name (v1.6+). */
const AUTHOR_NAME_KEY = 'cesvu:authorName';

/**
 * Read the user's stored display name, falling back to {@link DEFAULT_AUTHOR}
 * when unset or when localStorage is unavailable (e.g. SSR, privacy mode).
 * This is the name stamped onto NEW notes going forward — it does NOT
 * retroactively change any already-created note's `author` field.
 */
function getStoredAuthorName(): string {
	try {
		const stored = localStorage.getItem(AUTHOR_NAME_KEY);
		return stored && stored.trim() ? stored : DEFAULT_AUTHOR;
	} catch {
		return DEFAULT_AUTHOR;
	}
}

/**
 * Persist the user's display name for future notes. Empty/whitespace-only
 * input clears the override (falls back to {@link DEFAULT_AUTHOR} again).
 */
function setStoredAuthorName(name: string): void {
	try {
		const trimmed = name.trim();
		if (trimmed) localStorage.setItem(AUTHOR_NAME_KEY, trimmed);
		else localStorage.removeItem(AUTHOR_NAME_KEY);
	} catch {
		// localStorage unavailable — silently no-op, same fallback behavior
		// as getStoredAuthorName().
	}
}

// ── State ────────────────────────────────────────────────────────────────────

let notes = $state<Note[]>([]);
/** The document id these notes belong to. null = unbound (in-memory only). */
let activeDocId = $state<string | null>(null);

// ── Persistence (IndexedDB, best-effort) ─────────────────────────────────────

/**
 * Encode a UI Note as the persisted DocumentAnnotation. We store BOTH
 * forms so old readers that only know `anchorId` still work, and new
 * readers can use the structured `anchor` for kind-aware rendering.
 *
 *   - prose note: anchorId = "<offset>" (legacy), anchor = { kind: 'prose', offset }
 *   - cell note:  anchorId = "cell://<sheet>/<column>/<rowIndex>", anchor = structured
 */
function toAnnotation(n: Note): DocumentAnnotation {
	let anchorId: string;
	if (n.anchor.kind === 'prose') {
		anchorId = String(n.anchor.offset);
	} else {
		const { sheet, column, rowIndex } = n.anchor;
		anchorId = `cell://${encodeURIComponent(sheet)}/${encodeURIComponent(column)}/${rowIndex}`;
	}
	return {
		id: n.id,
		anchorId,
		anchor: n.anchor,
		createdInLens: n.createdInLens,
		author: n.author,
		body: n.body,
		createdAt: n.createdAt
	};
}

/** Decode a persisted DocumentAnnotation back into a UI Note. The new
 *  `anchor` field wins; we fall back to the legacy `anchorId` string
 *  for notes written before v1.5. */
function fromAnnotation(a: DocumentAnnotation): Note {
	if (a.anchor) return noteFromAnchor(a.id, a.anchor, a);
	return noteFromAnchorId(a.id, a.anchorId, a);
}

/** Build a Note from a structured anchor. */
function noteFromAnchor(
	id: string,
	anchor: NoteAnchor,
	a: DocumentAnnotation
): Note {
	return {
		id,
		anchor,
		createdInLens: a.createdInLens,
		author: a.author || DEFAULT_AUTHOR,
		body: a.body,
		createdAt: a.createdAt
	};
}

/** Build a Note from a legacy anchorId string. Two prefixes are recognized:
 *  "cell://" → cell anchor (sheet/column/rowIndex URL-encoded), anything
 *  else → numeric char offset (prose). */
function noteFromAnchorId(
	id: string,
	anchorId: string,
	a: DocumentAnnotation
): Note {
	if (anchorId.startsWith('cell://')) {
		const rest = anchorId.slice('cell://'.length);
		const parts = rest.split('/');
		if (parts.length === 3) {
			const sheet = decodeURIComponent(parts[0]);
			const column = decodeURIComponent(parts[1]);
			const rowIndex = Number.parseInt(parts[2], 10);
			return {
				id,
				anchor: { kind: 'cell', sheet, column, rowIndex: Number.isFinite(rowIndex) ? rowIndex : 0 },
				author: a.author || DEFAULT_AUTHOR,
				body: a.body,
				createdAt: a.createdAt
			};
		}
	}
	const offset = Number.parseInt(anchorId, 10);
	return {
		id,
		anchor: { kind: 'prose', offset: Number.isFinite(offset) ? offset : 0 },
		author: a.author || DEFAULT_AUTHOR,
		body: a.body,
		createdAt: a.createdAt
	};
}

/** Write the current note list to the bound document. Fire-and-forget. */
function persist() {
	if (activeDocId === null) return;
	const annotations = notes.map(toAnnotation);
	updateDocument(activeDocId, { annotations }).catch((err: unknown) =>
		console.warn('[notesStore] persist failed:', err)
	);
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Bind to a document and load its persisted notes. Called when a contract
 * opens or resumes. A null id unbinds (notes stay in-memory only — e.g. when
 * IndexedDB was unavailable so beginContract never set an id).
 *
 * Returns `true` ONLY when notes were actually RESTORED from a persisted
 * record (the `saved.length > 0` branch below) — i.e. this call represents a
 * genuine "the user is (re)opening an existing annotated document" event.
 * Returns `false` for every other case: unbinding (`id === null`), a
 * same-id no-op, the MIGRATE branch (a brand-new record that just received
 * its id for the FIRST time via beginContract() — see that branch's comment),
 * and a genuinely new/empty document.
 *
 * WHY THIS DISTINCTION MATTERS (consumed by Workspace.svelte's
 * autoOpenNotesIfAny — see its doc comment for the full story): `id` going
 * from null to non-null does NOT always mean "a document was (re)opened."
 * It ALSO happens the very first time a user clicks Share/Export on a
 * document they've been working on all session — beginContract() persists
 * it for the first time right then, with whatever in-memory notes already
 * exist, in whatever lens the user happens to currently be in. Without this
 * return value, a caller watching `activeContractId` alone can't tell "the
 * user just reopened an annotated file" apart from "the user just exported
 * a file they were already actively editing" — and reacting to the latter
 * as though it were the former (e.g. forcing a lens switch) would yank the
 * user out of whatever they were doing, right as they click Share.
 */
async function bindDocument(id: string | null): Promise<boolean> {
	// Idempotent: binding to the SAME document is a no-op. Notes are bound to
	// the DOCUMENT, not the active lens, so toggling contract ⇄ document (which
	// re-fires the binding effect with an unchanged id) must NOT clear the
	// in-memory list and reload from the store. Wiping here was what made notes
	// vanish on a lens switch.
	if (id === activeDocId) return false;

	const prevId = activeDocId;
	const hadNotes = notes.length > 0;
	activeDocId = id;

	if (id === null) {
		notes = [];
		return false;
	}

	try {
		const rec = await getDocument(id);
		const saved = rec && Array.isArray(rec.annotations) ? rec.annotations : [];
		if (saved.length > 0) {
			// Restore the document's persisted notes. This is the ONLY branch
			// that represents a genuine "reopened an existing annotated
			// document" event — see this function's doc comment.
			notes = saved.map(fromAnnotation).sort(sortByAnchor);
			return true;
		} else if (prevId === null && hadNotes) {
			// MIGRATE: a freshly-uploaded file took notes BEFORE it had a persisted
			// record (activeDocId was null, so persist() no-oped). It just acquired
			// a real id (the first Export creates the record). Flush the in-memory
			// notes into the new record rather than clearing them — otherwise the
			// notes never make it into the .cesvu export. `notes` stays as-is.
			// NOT a "reopen" — this document was never closed, so returns false.
			persist();
			return false;
		} else {
			// New document with no saved notes → start clean.
			notes = [];
			return false;
		}
	} catch (err) {
		console.warn('[notesStore] load failed:', err);
		return false;
	}
}



/** Sort comparator: CREATION ORDER (oldest first).
 *
 *  Notes — prose AND cell — are ordered by `createdAt`, so the numbered pins
 *  and NotesPane bubbles count in the order the user CREATED them, not by where
 *  they sit in the document/sheet. This is what the user expects: "note 1" is
 *  the first note you made, "note 2" the second, regardless of which row/cell
 *  each lands on. (An earlier version sorted by reading position — sheet, then
 *  rowIndex, then column — which made the numbers jump around relative to the
 *  order the notes were actually added.)
 *
 *  Ties on createdAt (same-millisecond creation) fall back to the note id so the
 *  order stays stable and deterministic across reloads. */
function sortByAnchor(a: Note, b: Note): number {
	if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
	return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}


/** Insert a note into the list keeping it ordered by the sortByAnchor
 *  comparator. The notes array isn't a priority structure, but keeping it
 *  sorted makes the NotesPane rendering deterministic and helps the
 *  scroll-to-note lookup in O(log n). */
function insertSorted(note: Note) {
	const idx = notes.findIndex((n) => sortByAnchor(n, note) > 0);
	if (idx === -1) notes = [...notes, note];
	else notes = [...notes.slice(0, idx), note, ...notes.slice(idx)];
}

/**
 * Add a new prose note pinned at `offset`. Returns the created note so the
 * caller (the document pane) can immediately request the composer to focus
 * it. The body starts empty; the user types it in the Insights composer.
 *
 * `createdInLens` records which reading surface dropped the pin
 * ('contract' from ClauseHighlighter, 'document' from PdfViewer). It's only
 * meaningful for PDFs — PdfViewer's pin is an approximate proportional
 * placement, while ClauseHighlighter's is an exact DOM-offset placement, so
 * a PDF note viewed in the OTHER lens from the one it was created in may
 * show its pin in a visibly different spot. Callers for non-PDF surfaces
 * (DocumentHighlighter) omit this — both lenses render identical text
 * there, so there's no positional drift to flag.
 */
function addNote(offset: number, body = '', createdInLens?: 'contract' | 'document'): Note {
	const note: Note = {
		id: newId('note'),
		anchor: { kind: 'prose', offset },
		createdInLens,
		author: getStoredAuthorName(),
		body,
		createdAt: Date.now()
	};
	insertSorted(note);
	persist();
	return note;
}

/**
 * Add a new cell note pinned to a { sheet, column, rowIndex } coordinate.
 * Used by the CSV/Excel workbench. `rowIndex = -1` produces a column-level
 * note (no specific row). The body starts empty; the user types it in the
 * Notes pane.
 */
function addNoteForCell(
	sheet: string,
	column: string,
	rowIndex: number,
	body = ''
): Note {
	const note: Note = {
		id: newId('note'),
		anchor: { kind: 'cell', sheet, column, rowIndex },
		author: getStoredAuthorName(),
		body,
		createdAt: Date.now()
	};
	insertSorted(note);
	persist();
	return note;
}

/**
 * Lookup: all notes anchored to a specific cell. Returns the array (possibly
 * empty) — the table viewer uses this to decide whether to render a pin in
 * the cell's top-right corner. The lookup is O(n) over the note list, but
 * the per-file note count is small (users mark dozens, not millions).
 */
function notesForCell(sheet: string, column: string, rowIndex: number): Note[] {
	return notes.filter(
		(n) =>
			n.anchor.kind === 'cell' &&
			n.anchor.sheet === sheet &&
			n.anchor.column === column &&
			n.anchor.rowIndex === rowIndex
	);
}

/** Lookup: all notes anchored to a specific column (including column-level
 *  notes where rowIndex = -1). The table viewer calls this per column to
 *  decide whether to render a pin next to the column header. */
function notesForColumn(sheet: string, column: string): Note[] {
	return notes.filter(
		(n) => n.anchor.kind === 'cell' && n.anchor.sheet === sheet && n.anchor.column === column
	);
}

/** Replace a note's body (edit). No-op if the id is unknown. */
function updateNote(id: string, body: string) {
	notes = notes.map((n) => (n.id === id ? { ...n, body } : n));
	persist();
}

/**
 * Replace a note's author (relabel). No-op if the id is unknown. This edits
 * ONLY the one note — it does not change {@link getStoredAuthorName}'s
 * value or affect any other note.
 */
function updateAuthor(id: string, author: string) {
	notes = notes.map((n) => (n.id === id ? { ...n, author } : n));
	persist();
}

/** Delete a note by id. */
function removeNote(id: string) {
	notes = notes.filter((n) => n.id !== id);
	persist();
}

/** Drop all notes (e.g. on workspace reset). Does NOT persist by default. */
function clear() {
	notes = [];
	activeDocId = null;
}

export const notesStore = {
	get notes() {
		return notes;
	},
	get count() {
		return notes.length;
	},
	get activeDocId() {
		return activeDocId;
	},
	bindDocument,
	addNote,
	addNoteForCell,
	notesForCell,
	notesForColumn,
	updateNote,
	updateAuthor,
	removeNote,
	clear,
	getStoredAuthorName,
	setStoredAuthorName
};
