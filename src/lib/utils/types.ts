// ============================================================
// Core Data Types
// ============================================================

export type FileType = 'csv' | 'excel' | 'pdf' | 'docx' | 'txt' | 'md' | 'unknown';


// Workbook data model lives in src/lib/data/workbook.ts. Re-exported here so
// `ParsedData` can reference it without a circular import.
import type { Workbook } from '../data/workbook.js';
export type { Workbook, Sheet, WorkbookProfile, SheetProfile } from '../data/workbook.js';

export interface ParsedData {
	type: FileType;
	/**
	 * Unified workbook for tabular sources (CSV is a single-sheet workbook,
	 * Excel maps each tab onto a sheet). Present for `csv` and `excel` types.
	 */
	workbook?: Workbook;
	/** Plain text representation of the document (pdf/docx/txt/md). */
	text?: string;
	/** Original filename */
	fileName: string;
	// ── Legacy fields (kept optional for backward compatibility) ──────────────
	/** @deprecated Use `workbook` instead. Structured rows for CSV/tabular data */
	rows?: Record<string, unknown>[];
	/** @deprecated Use `workbook` instead. Column headers for CSV */
	headers?: string[];
	/** @deprecated Use `fileName`. Original filename */
	filename?: string;
	/** @deprecated File size in bytes */
	size?: number;
	/** @deprecated Parse timestamp */
	parsedAt?: string;
}

// ============================================================
// Pipeline Types
// ============================================================

export interface NumericProfile {
	kind: 'numeric';
	key: string;
	count: number;
	mean: number;
	min: number;
	max: number;
	stdDev: number;
	nullCount: number;
}

export interface CategoricalProfile {
	kind: 'categorical';
	key: string;
	count: number;
	uniqueCount: number;
	topValues: Array<{ value: string; freq: number }>;
	nullCount: number;
}

export type ColumnProfile = NumericProfile | CategoricalProfile;

export type TrendDirection = 'upward' | 'downward' | 'flat';

export interface SignalResult {
	key: string;
	mean: number;
	stdDev: number;
	trend: TrendDirection;
	/** Row indices where value > 2σ from mean */
	spikeRows: number[];
	/** Slope of linear regression */
	slope: number;
}

// ============================================================
// Template Types
// ============================================================

export type SectionType =
	| 'summary'
	| 'insights'
	| 'chart'
	| 'table'
	| 'anomalies'
	| 'markdown'
	| 'key_metrics'
	| 'recommendations'
	| 'risks'
	| 'parties'
	| 'timeline';

export interface TemplateSection {
	id: string;
	type: SectionType;
	title: string;
	description?: string;
	/** Default chart type if section is 'chart' */
	chartType?: 'bar' | 'line' | 'pie' | 'scatter';
	required: boolean;
}

export type TemplateTier = 'free' | 'pro';

export interface Template {
	id: string;
	name: string;
	description: string;
	icon: string;
	tier: TemplateTier;
	sections: TemplateSection[];
	systemPrompt: string;
	/** File types this template is optimized for */
	bestFor: FileType[];
}

// ============================================================
// Analysis Types
// ============================================================

export type AnalysisStatus = 'idle' | 'parsing' | 'profiling' | 'compressing' | 'analyzing' | 'done' | 'error';

export interface AnalysisResult {
	templateId: string;
	/** Map of section_id → content (string or structured data) */
	sections: Record<string, unknown>;
	/** Raw LLM output for debugging */
	rawOutput?: string;
	/** Compressed summary sent to LLM */
	compressedInput: string;
	createdAt: string;
}

// ============================================================
// Workspace / Chat Types
// ============================================================

export interface SelectionRange {
	start: number;
	end: number;
}

export interface DocumentSelection {
	text: string;
	range: SelectionRange;
	context: string;
}

export type CsvSelectionType = 'column' | 'row' | 'cells' | 'dataset';

export interface CsvSelection {
	type: CsvSelectionType;
	column?: string;
	rows?: number[];
	cellRange?: { column: string; rowStart: number; rowEnd: number };
	context: string;
}

export interface ChatMessage {
	id: string;
	role: 'user' | 'assistant';
	content: string;
	selectionContext?: {
		text: string;
		range: SelectionRange;
	};
	timestamp: string;
}

export interface InsightTargetDocument {
	mode: 'document';
	range: SelectionRange;
}

export interface InsightTargetCsv {
	mode: 'csv';
	column?: string;
	rows?: number[];
	cellRange?: { column: string; rowStart: number; rowEnd: number };
}

export type InsightTarget = InsightTargetDocument | InsightTargetCsv;

export type InsightType =
	| 'explanation'
	| 'anomaly'
	| 'suggestion'
	| 'summary'
	| 'rewrite'
	| 'correlation'
	| 'trend'
	| 'outlier'
	| 'segment';

export type InsightSeverity = 'info' | 'warning' | 'critical';

export interface Insight {
	id: string;
	type: InsightType;
	target: InsightTarget;
	content: string;
	severity?: InsightSeverity;
}

export interface WorkspaceState {
	document: ParsedData | null;
	selection: DocumentSelection | null;
	csvSelection: CsvSelection | null;
	messages: ChatMessage[];
	isProcessing: boolean;
	insights: Insight[];
	analysisStatus: AnalysisStatus;
	analysisResult: AnalysisResult | null;
	activeTemplate: Template | null;
	error: string | null;
}

// ============================================================
// Crypto / Sharing Types
// ============================================================

export interface SharePayload {
	analysisResult: AnalysisResult;
	parsedData: Omit<ParsedData, 'rows'> & { rowCount?: number };
	template: Template;
	sharedAt: string;
}

export interface EncryptedShare {
	ciphertext: string;
	iv: string;
	/** AES key wrapped with PBKDF2-derived key, base64 */
	wrappedKey: string;
	/** PBKDF2 salt, base64 */
	salt: string;
}

export interface ShareRecord {
	id: string;
	encryptedPayload: string;
	iv: string;
	wrappedKey: string;
	salt: string;
	expiresAt: string;
	createdAt: string;
	/** Plaintext annotation count (server can count without decrypting) */
	annotationCount: number;
}

export interface AnnotationBlob {
	id: string;
	shareId: string;
	ciphertext: string;
	iv: string;
	/** Plaintext — self-reported, no auth */
	author: string;
	/** Plaintext ISO timestamp */
	timestamp: string;
}

export interface DecryptedAnnotation {
	id: string;
	author: string;
	timestamp: string;
	text: string;
	range?: SelectionRange;
}

// ============================================================
// Monetization Types
// ============================================================

export type UserTier = 'free' | 'pro' | 'team';

export type ModelTier = 'default' | 'advanced' | 'expert';

export interface ModelConfig {
	id: ModelTier;
	name: string;
	paramCount: string;
	quantization: string;
	/** URL to ONNX model on ai.cesvu.com */
	modelUrl: string;
	requiredTier: UserTier;
	/** Monthly limit, null = unlimited */
	monthlyLimit: number | null;
}

export interface UsageRecord {
	deviceId: string;
	sharesThisMonth: number;
	lastReset: string;
}

// ============================================================
// LLM Response Types
// ============================================================

export interface LLMResponse {
	response: string;
	insights?: Array<{
		type: InsightType;
		target: InsightTarget;
		content: string;
		severity?: InsightSeverity;
	}>;
}
