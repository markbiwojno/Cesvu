/**
 * src/lib/schema.ts — The .cesvu document schema (the contract)
 *
 * This is the SINGLE source of truth for the shape of a persisted Cesvu
 * document. It is named for the .cesvu file format it serializes to. At
 * runtime a record lives in an in-memory Map for the browser session (see
 * src/lib/stores/contract-store.svelte.ts — in-memory by design); the ONLY
 * durable, portable form is the encrypted .cesvu export. Every field declared
 * here therefore travels inside that envelope and must round-trip through
 * JSON.stringify / JSON.parse intact (no Map/Set, no class instances).

 *
 * DESIGN PRINCIPLE — "the schema is the contract":
 *   The full shape is declared up front. Fields that are USED today are
 *   populated by the persistence layer; fields reserved for future features
 *   (chat messages) are present in the type and initialized to empty arrays.
 *   The store is schemaless at runtime, so adding behavior for a reserved
 *   field later needs NO migration — we just start writing it.
 *
 * ⚠️  SECURITY NOTE — PLAINTEXT IN MEMORY (intentional, scoped):
 *   The product spec mandates encryption as the substrate. While a record lives
 *   in the in-memory store it is plaintext. Encryption is applied ONLY at the
 *   .cesvu export boundary (AES-256-GCM via the crypto module). There is no
 *   plaintext-at-rest path — a refresh wipes memory; the encrypted export is the
 *   only durable form.
 */

import type { ContractProfile } from '$lib/lenses/contract/types.js';

/**
 * Schema version.
 *   v2 added {@link CesvuDocument.rawContent} so a .cesvu export round-trips
 *      the FULL original file (binary PDF, XLSX workbook, CSV rows) instead of
 *      only the lossy extracted text.
 *   v3 added {@link CesvuDocument.clauses} so the user's highlighted clause
 *      marks (label, risk, color, confidence) travel inside the export and are
 *      restored exactly on import — previously they lived only in sessionStorage
 *      for the browser session and were lost on export/import.
 * The store is schemaless so no migration is needed: older records simply have
 * the newer fields absent, which the importer coerces to their empty defaults
 * (null rawContent / [] clauses — see normalizeCesvuDocument).
 */
export const CESVU_SCHEMA_VERSION = 4 as const;



/**
 * How the source document was provided. Drives the parser + viewer.
 *
 * v2: widened from the original 4 prose types to all SIX workspace file
 * types. `csv` and `excel` were previously absent here, so a tabular
 * document could never be persisted or re-imported faithfully — the importer
 * rejected it and the viewer had no rows to show.
 */
export type SourceType = 'csv' | 'excel' | 'pdf' | 'docx' | 'txt' | 'md';



/** Which clause-split set the user last viewed. Restored on re-open. */
export type SplitMode = 'manual' | 'auto';

/**
 * Clause-boundary offsets for both split strategies. Each array holds character
 * offsets into {@link CesvuDocument.text} where a clause BEGINS — exactly what
 * the manual ClauseSplitter UI collects and what clausesFromOffsets() consumes.
 * Stored separately so switching modes (and "undo auto-detect") is lossless.
 */
export interface DocumentSplits {
	/** User-marked clause-start offsets. Empty until the user marks any. */
	manual: number[];
	/** Auto-detected clause-start offsets (from splitClauses → offsets). */
	auto: number[];
	/** The split set last active. Restored when the document re-opens. */
	mode: SplitMode;
}

/**
 * A paragraph segment of the source text. Cached at extraction time so the
 * manual splitter can render tappable dividers without re-segmenting on every
 * open. Mirrors the `Paragraph` shape from the clause splitter.
 */
export interface DocumentParagraph {
	/** Character offset into {@link CesvuDocument.text} where this paragraph starts. */
	offset: number;
	/** The paragraph's display text (trimmed). */
	text: string;
}

/**
 * RESERVED (v1.5+): an immutable, per-annotation encrypted blob. Stored here as
 * a forward-declared shape; v1 always initializes `annotations: []` and never
 * writes entries. See .clinerules annotation architecture.
 */
export interface DocumentAnnotation {
	id: string;
	/** Clause id (or text anchor) this annotation is attached to.
	 *  v1: numeric char-offset for prose. v1.5+: optional structured
	 *  `anchor` field carries the kind-specific payload. Kept for
	 *  back-compat with notes written before `anchor` was introduced. */
	anchorId: string;
	/**
	 * Structured anchor (v1.5+). When present, consumers should prefer
	 * this over the opaque `anchorId` string. Two anchor kinds are
	 * supported in v1.5:
	 *   - 'prose': a character offset in the document text.
	 *               Replaces the legacy `anchorId: <offset>` form.
	 *   - 'cell':  a stable cell coordinate in a tabular sheet.
	 *               Used by the CSV/Excel workbench. `rowIndex = -1`
	 *               means "the whole column".
	 */
	anchor?:
		| { kind: 'prose'; offset: number }
		| { kind: 'cell'; sheet: string; column: string; rowIndex: number };
	/**
	 * (v4.1, additive/optional — no schema version bump) Which lens the note's
	 * pin was originally dropped in: 'contract' (ClauseHighlighter's exact
	 * DOM-offset pin) or 'document' (PdfViewer's approximate proportional
	 * pin, PDF-only). Lets the UI flag when a PDF note is being viewed in a
	 * lens OTHER than the one it was created in, where its pin position may
	 * not exactly match. Absent on notes created before this field existed,
	 * or on non-PDF documents where both lenses render text identically and
	 * no positional drift is possible.
	 */
	createdInLens?: 'contract' | 'document';
	/** Plaintext author (self-reported; no auth in v1). */
	author: string;
	/** Annotation body. (Will be ciphertext once encryption lands.) */
	body: string;
	/** ms epoch. */
	createdAt: number;
}

/**
 * A persisted highlighted clause mark (v3+). Mirrors the live `MarkedClause`
 * from clauseStore.svelte.ts, narrowed to JSON-serializable primitives so it
 * round-trips through the .cesvu export cleanly. Each mark is a span of the
 * contract text the user highlighted in the contract lens, plus its local
 * classifier result (label / risk) and its display styling.
 *
 * Offsets index into {@link CesvuDocument.text} — the SAME string the
 * highlighter slices — so a restored mark lands on exactly the same characters.
 * `color` is persisted (not re-generated on import) so the visual layout is
 * stable: a re-opened or shared document shows the highlights in the same tints
 * the author saw.
 */
export interface PersistedClause {
	/** Stable mark id (e.g. "mark-3"). Keys the highlight + sidebar card. */
	id: string;
	/** Inclusive start offset into {@link CesvuDocument.text}. Drives order. */
	startOffset: number;
	/** Exclusive end offset into {@link CesvuDocument.text}. */
	endOffset: number;
	/** The clause text (sliced from the document at mark time). */
	text: string;
	/** Highlight tint (CSS color). Persisted so the layout is stable on import. */
	color: string;
	/** Classifier display label once resolved (e.g. "Indemnification"), or null. */
	heading: string | null;
	/** Raw snake_case model label (e.g. "indemnification"), or null. */
	label: string | null;
	/** Risk level once classified, or null while unresolved. */
	risk: 'high' | 'medium' | 'low' | null;
	/** Lifecycle state — drives the provisional → resolved UI. */
	status: 'pending' | 'analyzing' | 'analyzed' | 'error';
	/** Boundary confidence, or 'edited' once the user adjusted the mark. */
	confidence: 'high' | 'medium' | 'low' | 'edited';
}

/**
 * RESERVED (future): a persisted chat turn for the document's conversation.
 * Forward-declared; v1 initializes `messages: []` and never writes entries.
 */
export interface DocumentMessage {

	id: string;
	role: 'user' | 'assistant';
	content: string;
	/** ms epoch. */
	createdAt: number;
}

/**
 * The full persisted Cesvu document. ALL fields are declared; the persistence
 * layer populates the active ones and reserves the rest.
 *
 * Active in v1:
 *   - Identity:   id, version, name, sourceType, createdAt, updatedAt
 *   - Content:    text, paragraphs
 *   - Splits:     splits (manual + auto + mode)
 *   - Analysis:   profile
 * Reserved in v1 (declared, initialized empty, not written):
 *   - annotations, messages
 */
export interface CesvuDocument {
	// ── Identity ──────────────────────────────────────────────────────────
	/** Stable unique id (generated at create time). IndexedDB primary key. */
	id: string;
	/** Schema version this record was written with. */
	version: number;
	/** Original file name, e.g. "lease.pdf". */
	name: string;
	/** How the source was provided (parser/viewer hint). */
	sourceType: SourceType;
	/** ms epoch — record creation. */
	createdAt: number;
	/** ms epoch — last write. Sorts the resume list (newest first). */
	updatedAt: number;

	// ── Content ───────────────────────────────────────────────────────────
	/** Extracted plain text — the source of truth all splits index into. */
	text: string;
	/** Cached paragraph segmentation for the manual splitter. */
	paragraphs: DocumentParagraph[];
	/**
	 * The ORIGINAL file bytes (v2+). Carried so a .cesvu export can
	 * reconstruct the source exactly — the recipient re-runs the SAME parser the
	 * uploader did (PDF.js, mammoth, Papa Parse, the XLSX reader), so binary
	 * PDFs render, DOCX keeps its styling, and CSV/XLSX keep their rows.
	 *
	 * Null for `txt`/`md`, where `text` already IS the complete file content and
	 * no binary round-trip is needed. Absent on legacy v1 records → the importer
	 * coerces that to null and falls back to the text-only path.
	 *
	 * MEMORY: this is `string | Uint8Array | null` — NOT just a base64 string —
	 * because base64-encoding a large file into ONE JS string can itself
	 * exceed the JS engine's max string length ("RangeError: Invalid string
	 * length"), independent of any available memory. `Uint8Array` is the
	 * preferred in-memory representation for anything that rode in on a File
	 * (see Workspace.svelte's export prep and contract-store.svelte.ts's
	 * importFromCesvu, which now stores the decrypted raw section directly
	 * as bytes instead of re-encoding it to base64). A base64 `string` is
	 * still accepted for backward-compatibility with any code path that only
	 * has a string (e.g. tests, or a value that already arrived pre-encoded).
	 * This field is NEVER serialized directly — .cesvu export always frames
	 * the source as raw bytes (see CFP1 framing in contract-store.svelte.ts),
	 * so the on-disk format is unaffected either way.
	 */
	rawContent: string | Uint8Array | null;




	// ── Splits ────────────────────────────────────────────────────────────
	/** Manual + auto clause-boundary offsets and the active mode. */
	splits: DocumentSplits;

	// ── Analysis ──────────────────────────────────────────────────────────
	/** Last-built classifier profile, or null if not analyzed yet. */
	profile: ContractProfile | null;

	// ── Clause marks ────────────────────────────────────────────────────────
	/**
	 * The user's highlighted clause marks from the contract lens (v3+). Each
	 * carries its character offsets, classifier label/risk, display color, and
	 * boundary confidence. Initialized to [] and written by clauseStore via
	 * updateDocument(). Travels inside the .cesvu export so highlights are
	 * restored exactly on re-open / import. See {@link PersistedClause}.
	 */
	clauses: PersistedClause[];

	// ── Reserved (declared now, populated later) ────────────────────────────

	/** RESERVED (v1.5+): annotations. Initialized to [] in v1. */
	annotations: DocumentAnnotation[];
	/** RESERVED (future): persisted chat. Initialized to [] in v1. */
	messages: DocumentMessage[];
}


/** Lightweight row for the "resume" list — name + date without loading content. */
export interface DocumentSummary {
	id: string;
	name: string;
	sourceType: SourceType;
	updatedAt: number;
	/** Number of clauses in the active split set (0 if none marked yet). */
	clauseCount: number;
	/** Whether a profile has been built. */
	analyzed: boolean;
	/** The active split mode. */
	splitMode: SplitMode;
}

/**
 * Build a new CesvuDocument with all required fields, active ones from the
 * caller and reserved ones initialized empty. Centralizing construction here
 * guarantees no field is ever forgotten when a record is created.
 */
export function createCesvuDocument(init: {
	id: string;
	name: string;
	sourceType: SourceType;
	text: string;
	paragraphs?: DocumentParagraph[];
	/** Original file bytes (csv | excel | pdf | docx). Null for txt/md. */
	rawContent?: string | Uint8Array | null;
}): CesvuDocument {

	const now = Date.now();
	return {
		id: init.id,
		version: CESVU_SCHEMA_VERSION,
		name: init.name,
		sourceType: init.sourceType,
		createdAt: now,
		updatedAt: now,
		text: init.text,
		paragraphs: init.paragraphs ?? [],
		rawContent: init.rawContent ?? null,
		splits: { manual: [], auto: [], mode: 'manual' },

		profile: null,
		clauses: [],
		annotations: [],
		messages: []
	};


}
