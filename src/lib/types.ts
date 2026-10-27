/**
 * src/lib/types.ts — Canonical TypeScript interfaces for Cesvu
 *
 * All application-wide types live here. Import from '$lib/types.js'.
 * The types in src/lib/utils/types.ts are the workspace/pipeline types
 * and are re-exported here for convenience.
 */

// Re-export workspace/pipeline types (excluding names redeclared below)
export type {
	FileType,
	ParsedData,
	NumericProfile,
	CategoricalProfile,
	TrendDirection,
	SignalResult,
	SectionType,
	TemplateSection,
	TemplateTier,
	Template,
	AnalysisStatus,
	AnalysisResult,
	SelectionRange,
	DocumentSelection,
	CsvSelectionType,
	CsvSelection,
	ChatMessage,
	InsightTargetDocument,
	InsightTargetCsv,
	InsightTarget,
	InsightType,
	InsightSeverity,
	Insight,
	SharePayload,
	EncryptedShare,
	ShareRecord,
	AnnotationBlob,
	DecryptedAnnotation,
	UserTier,
	ModelTier,
	UsageRecord,
	LLMResponse
} from './utils/types.js';

// ============================================================
// Encryption / .cesvu format types
// ============================================================

/**
 * Parameters used for key derivation (PBKDF2 or Argon2id).
 * Stored in the .cesvu file header so decryption can reproduce them.
 */
export interface EncryptionParams {
	/** Base64-encoded 16-byte random salt */
	salt: string;
	/** Base64-encoded 12-byte random IV */
	iv: string;
	/** Memory cost in KiB (Argon2id) or unused for PBKDF2 */
	memory: number;
	/** Iteration count */
	iterations: number;
	/** Parallelism factor */
	parallelism: number;
}

/**
 * Parsed representation of the OLD 51-byte .cesvu binary header (crypto.ts v1).
 * Version stored as ASCII string "1.0.0".
 * @deprecated Use CesvuHeaderV2 for new files.
 */
export interface CesvuHeader {
	magic: string;       // ".CESVU" — 6 bytes
	version: string;     // "1.0.0"  — 5 bytes (ASCII)
	salt: Uint8Array;    // 16 bytes — key derivation salt
	iv: Uint8Array;      // 12 bytes — AES-GCM IV
	memory: number;      // uint32   — Argon2id memory KiB
	iterations: number;  // uint16   — Argon2id iterations
	parallelism: number; // uint16   — Argon2id parallelism
	flags: number;       // uint8    — bit 0: enterprise recovery key present
	recKeyLen: number;   // uint16   — recovery block length (0 in v1)
	reserved: number;    // uint8    — reserved, must be 0
}

/**
 * Parsed representation of the NEW 51-byte .cesvu v1.0 binary header (crypto.v2.ts).
 * Version stored as uint16 big-endian (0x0001).
 *
 * Layout:
 *   0–5:   Magic ".CESVU"
 *   6–7:   Version uint16 big-endian (0x0001)
 *   8:     Flags uint8 (bit0=HasRecoveryBlock, bit1=HybridWrapping, bit2=Encrypted)
 *   9–10:  RecKeyLen uint16 big-endian
 *   11–26: Salt (16 bytes)
 *   27–30: KDF Memory uint32 big-endian (KiB)
 *   31–32: KDF Iterations uint16 big-endian
 *   33–34: KDF Parallelism uint16 big-endian
 *   35–46: IV (12 bytes)
 *   47:    KDFAlgorithm uint8 (0x00=Argon2id, 0x01=PBKDF2-SHA256)
 *   48:    ContentType uint8 (0x00=single, 0x01=zip)
 *   49–50: Reserved (2 bytes, must be 0)
 */
export interface CesvuHeaderV2 {
	magic: string;           // ".CESVU"
	version: number;         // uint16 — 0x0001
	flags: number;           // uint8
	recKeyLen: number;       // uint16 — recovery block length in bytes
	salt: Uint8Array;        // 16 bytes
	memory: number;          // uint32 — Argon2id memory KiB
	iterations: number;      // uint16 — KDF iterations
	parallelism: number;     // uint16 — KDF parallelism
	iv: Uint8Array;          // 12 bytes — AES-GCM IV
	kdfAlgorithm: number;    // uint8 — 0x00=Argon2id, 0x01=PBKDF2-SHA256
	contentType: number;     // uint8 — 0x00=single, 0x01=zip
	// Derived from flags
	hasRecoveryBlock: boolean;
	isEncrypted: boolean;
}

/**
 * A single entry in the recovery key block.
 */
export interface RecoveryBlockEntry {
	keyType: number;    // uint16 — 0x0001=RSA-OAEP, 0x0002=AES-KW/PRF, 0x0003=AES-KW/PBKDF2
	keyId: number;      // uint16 — unique per entry
	data: Uint8Array;   // WrappedKeyData (DataLen bytes)
}

/**
 * Encryption parameters for the new v1.0 format.
 */
export interface EncryptionParamsV2 {
	/** Base64-encoded 16-byte random salt */
	salt: string;
	/** Base64-encoded 12-byte random IV */
	iv: string;
	/** Memory cost in KiB (Argon2id) */
	memory: number;
	/** Iteration count */
	iterations: number;
	/** Parallelism factor */
	parallelism: number;
	/** KDF algorithm byte (0x00=Argon2id, 0x01=PBKDF2-SHA256) */
	kdfAlgorithm: number;
	/** Content type byte (0x00=single, 0x01=zip) */
	contentType: number;
	/** Whether a recovery block is present */
	hasRecoveryBlock: boolean;
}

// ============================================================
// Parsed file types
// ============================================================

/**
 * Structured data extracted from a CSV file.
 * @deprecated Prefer the unified `Workbook` model (src/lib/data/workbook.ts).
 * A CSV is a single-sheet workbook. Use `workbookToCsvData()` to bridge when
 * legacy code still needs this `{ columns, rows }` shape.
 */
export interface CsvData {
	columns: string[];
	rows: Record<string, unknown>[];
}

/**
 * Flat text for a single PDF page, in reading order.
 * No paragraph/heading reconstruction — just the words sorted top→bottom,
 * left→right. The visual rendering is handled separately by the viewer
 * (canvas + invisible selectable text layer).
 */
export interface PdfPageText {
	/** 1-based page number */
	pageNumber: number;
	/** Flat extracted text for this page (reading order) */
	text: string;
}

/** Structured text extracted from a PDF or DOCX */
export interface StructuredText {
	/** Full plain text */

	text: string;
	/** Page count (PDF) or section count (DOCX) */
	pageCount?: number;
	/**
	 * Display HTML (DOCX only). Produced by mammoth.convertToHtml — headings,
	 * bold, lists, and tables render natively in the DOM. Selection works without
	 * any text layer because it's just DOM text.
	 *
	 * NOTE: For DOCX, `text` (above) holds the MARKDOWN that feeds the AI pipeline
	 * (mammoth.convertToMarkdown). There is intentionally no separate `markdown`
	 * field — `text` IS the markdown for DOCX. `html` is purely for display.
	 */
	html?: string;
	/**
	 * Legacy heading/section breakdown. No longer produced for DOCX (we now use
	 * native HTML structure). Kept optional for backward compatibility.
	 */
	sections?: Array<{ heading: string; content: string }>;

	/**
	 * Per-page flat text for PDFs. The AI context (`text`) is these joined with
	 * "Page N:" headers so the model can cite page numbers.
	 */
	pages?: PdfPageText[];
}



/**
 * Unified parsed file representation.
 * parsedData is typed based on file type:
 * - csv: CsvData
 * - pdf/docx: StructuredText
 * - txt/md: string
 */
export interface ParsedFile {
	type: 'csv' | 'excel' | 'pdf' | 'docx' | 'txt' | 'md';
	name: string;
	size: number;
	/** Raw file bytes (before parsing). */
	rawContent: ArrayBuffer;
	/** Parsed content — type depends on file type */
	parsedData: CsvData | StructuredText | string;
	/**
	 * Unified workbook for tabular sources. Present for `csv` and `excel`.
	 * CSV is a single-sheet workbook; Excel maps each tab onto a sheet.
	 */
	workbook?: import('./data/workbook.js').Workbook;
}


// ============================================================
// Column profile (richer than pipeline ColumnProfile)
// ============================================================

export interface ColumnProfile {
	name: string;
	type: 'numeric' | 'categorical' | 'datetime' | 'text';
	count: number;
	uniqueCount: number;
	nullCount: number;
	/** Numeric only */
	min?: number;
	max?: number;
	mean?: number;
	median?: number;
	/** Categorical only — top N values by frequency */
	topValues?: Array<{ value: string; count: number }>;
	/**
	 * Text columns only — a handful of the most frequent distinct values with
	 * their counts. Distinct from `topValues` (which implies a small, bounded
	 * category set): a free-text column may have tens of thousands of unique
	 * values, so this is an illustrative SAMPLE, not an exhaustive distribution.
	 * Used to ground the LLM chat prompt in real values instead of guesses.
	 */
	sampleValues?: Array<{ value: string; count: number }>;
}


// ============================================================
// Compressed summary (what the LLM receives)
// ============================================================

/**
 * @deprecated The compressed summary shape will migrate to the `Workbook`/
 * `WorkbookProfile` model. Retained for the current pipeline + LLM prompt code.
 */
export interface CompressedSummary {
	fileType: 'csv' | 'excel' | 'pdf' | 'docx' | 'txt' | 'md';

	fileName: string;
	rowCount?: number;
	columnCount?: number;
	columnProfiles?: ColumnProfile[];
	/** Page count (PDF) or section count (DOCX) — populated for document files */
	pageCount?: number;
	/** Total word count of the document (PDF/DOCX/TXT/MD), computed at parse time */
	wordCount?: number;
	/** First 500 chars of text content */
	textPreview?: string;
	/** Notes about document structure */
	structureNotes?: string;
}

// ============================================================
// Analysis result (richer than pipeline AnalysisResult)
// ============================================================

export interface AnalysisResultFull {
	summary: string;
	insights: string[];
	anomalies: string[];
	chartData?: Array<{
		label: string;
		values: number[];
		type: 'bar' | 'line' | 'pie';
	}>;
	questions?: string[];
}

// ============================================================
// Share link
// ============================================================

export interface ShareLink {
	id: string;
	url: string;
	/** Diceware password — shown to sender, never stored on server */
	password: string;
	expiresAt: string;
	viewCount: number;
}

// ============================================================
// Annotation
// ============================================================

/** A text selection range within a document */
export interface AnnotationSelection {
	/** Which document in a multi-doc archive (use filename or 'default') */
	document_id: string;
	/** Character offset in the extracted text (start, inclusive) */
	start_offset: number;
	/** Character offset in the extracted text (end, exclusive) */
	end_offset: number;
	/** The selected text — for display and verification */
	quote: string;
}

/**
 * A single annotation stored inside the .cesvu encrypted payload.
 * Annotations travel with the document — no separate server storage.
 */
export interface Annotation {
	id: string;
	created_at: string;
	updated_at: string;
	/** Display name or anonymous ID */
	author: string;
	selection: AnnotationSelection;
	/** Annotation text (markdown) */
	body: string;
	/** Hex highlight color (default #FFD700) */
	color: string;
	/** For review workflows — default false */
	resolved: boolean;
}

/** Legacy server-side annotation blob (kept for backward compat) */
export interface AnnotationBlobLegacy {
	id: string;
	shareId: string;
	/** AES-256-GCM encrypted annotation blob (base64) */
	encryptedBlob: string;
	/** Plaintext — server can count without decrypting */
	createdAt: string;
}

// ============================================================
// Model config
// ============================================================

export interface ModelConfig {
	id: 'default' | 'advanced' | 'expert';
	name: string;
	/** Path on ai.cesvu.com */
	path: string;
	/** Approximate size string e.g. "~500MB" */
	size: string;
	tier: 'free' | 'pro';
	description: string;
}

// ============================================================
// Workspace state
// ============================================================

export interface WorkspaceState {
	file: ParsedFile | null;
	summary: CompressedSummary | null;
	analysis: AnalysisResultFull | null;
	selectedTemplate: string | null;
	selectedModel: 'default' | 'advanced' | 'expert';
	activeTab: 'document' | 'analysis' | 'chat';
	selection: {
		text: string;
		start: number;
		end: number;
	} | null;
}
