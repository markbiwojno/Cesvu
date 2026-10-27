/**
 * src/lib/stores/workspace.svelte.ts — Shared workspace state
 *
 * This store is the ONLY communication channel between DocumentPane and ChatPane.
 * The panes never import each other. The store is the contract.
 *
 * Uses Svelte 5 runes ($state, $derived) — module-level reactive state.
 */

import type { ParsedFile, CompressedSummary, Template } from '$lib/types.js';
import type { Workbook, Sheet, WorkbookProfile } from '$lib/data/workbook.js';
import { profileWorkbook } from '$lib/pipeline/pipeline.js';
import { TEMPLATES, getTemplate } from '$lib/templates/index.js';
import type { Lens } from '$lib/lenses/detect-lens.js';
import type { ContractProfile } from '$lib/lenses/contract/types.js';
import {
	createDocument,
	getDocument,
	updateDocument
} from '$lib/stores/contract-store.svelte.js';
// Sibling per-document stores. closeDocument() (the ✕ / new-document path, aka
// the `reset` alias) is the single owner of "start over", so it must also unbind
// these — they hold their own internal document bindings that clearing workspace
// state alone won't touch.
// Safe import: neither store imports workspace (no dependency cycle).

import { clauseStore } from '$lib/stores/clauseStore.svelte.js';
import { notesStore } from '$lib/stores/notesStore.svelte.js';
import { sessionKeyStore } from '$lib/stores/sessionKey.svelte.js';

import type { SourceType, SplitMode, DocumentSplits } from '$lib/schema.js';
export type { SplitMode };







// ============================================================
// Types
// ============================================================

export type WorkspaceStep = 'upload' | 'template-select' | 'analyzing' | 'results';
export type ActiveTab = 'chat' | 'notes';

export interface WorkspaceSelection {
	type: 'text' | 'column' | 'cell' | 'row' | 'dataset';
	/** Human-readable label e.g. "Revenue column", "Row 42", "Selected text" */
	label: string;
	/** The actual data — column name, row index, text string, etc. */
	data: unknown;
}

export interface ChatMessage {
	id: string;
	role: 'user' | 'assistant';
	content: string;
	timestamp: string;
	/** Selection context attached when message was sent */
	selectionContext?: WorkspaceSelection;
	/**
	 * Optional deterministic chart (Vega-Lite spec) for assistant messages —
	 * e.g. the "Analyze this column" output. Rendered between the header stats
	 * and the text body. null/undefined → no chart. Narrow by design.
	 */
	chartSpec?: import('vega-lite').TopLevelSpec | null;
}


export interface AnalysisResult {
	/** Keyed by template section ID */
	sections: Record<string, unknown>;
	templateId: string;
	createdAt: string;
	error: string | null;
}

export interface ModelConfig {
	id: 'default' | 'standard' | 'expert';
	name: string;
	size: string;
	tier: 'free' | 'pro';
	description: string;
}

export const DEFAULT_MODELS: ModelConfig[] = [
	{
		id: 'default',
		name: 'Fast',
		size: '~900MB',
		tier: 'free',
		description: 'SmolLM2 1.7B — quick answers, WebGPU q4f16 or CPU q4'
	},
	{
		id: 'standard',
		name: 'Balanced',
		size: '~1.8GB',
		tier: 'free',
		description: 'SmolLM3 3B — better reasoning, still free, WebGPU q4f16 or CPU q4'
	},
	{
		id: 'expert',
		name: 'Expert',
		size: '~4.5GB',
		tier: 'free',
		description: 'OLMo-3 7B — top quality, requires discrete GPU (WebGPU)'
	}
];

// ============================================================
// State (module-level Svelte 5 runes)
// ============================================================

let file = $state<ParsedFile | null>(null);
let summary = $state<CompressedSummary | null>(null);
let analysis = $state<AnalysisResult | null>(null);
// Restore persisted template preference from localStorage (falls back to 'general')
const TEMPLATE_PREF_KEY = 'cesvu_preferred_template';
function loadPersistedTemplate(): Template {
	if (typeof localStorage !== 'undefined') {
		const saved = localStorage.getItem(TEMPLATE_PREF_KEY);
		if (saved) {
			const match = getTemplate(saved);
			if (match) return match;
		}
	}
	// Default: General analysis
	return TEMPLATES.find(t => t.id === 'general') ?? TEMPLATES[0];
}
let selectedTemplate = $state<Template>(loadPersistedTemplate());
// Restore persisted model preference from localStorage (falls back to Smart/1.7B)
const PREF_KEY = 'cesvu_preferred_model';
function loadPersistedModel(): ModelConfig {
	if (typeof localStorage === 'undefined') return DEFAULT_MODELS[1];
	const saved = localStorage.getItem(PREF_KEY);
	if (saved) {
		const match = DEFAULT_MODELS.find(m => m.id === saved);
		if (match) return match;
	}
	return DEFAULT_MODELS[1]; // Smart (1.7B) is the default
}
let selectedModel = $state<ModelConfig>(loadPersistedModel());
let activeTab = $state<ActiveTab>('chat');
let selection = $state<WorkspaceSelection | null>(null);
let messages = $state<ChatMessage[]>([]);
let isLoading = $state(false);
let error = $state<string | null>(null);
let step = $state<WorkspaceStep>('upload');
let parseProgress = $state<{ stage: string; rowsRead?: number } | null>(null);
let streamingDone = $state(true);
let streamingTotal = $state(0);
/** Live CSV row buffer — reassigned on each chunk to trigger Svelte reactivity */
let csvRows = $state<Record<string, unknown>[]>([]);

// ── Non-streaming Workbook path (parseCsv / parseExcel) ────────────────────
// This path coexists with the streaming csvRows buffer above. The streaming
// path remains the source of truth for large CSV files parsed incrementally;
// the workbook path is used for fully-materialized multi-sheet workbooks
// (e.g. .xlsx) and small CSVs parsed in one shot. UI components consume
// whichever is active.
/** Fully-parsed workbook (multi-sheet). null when using the streaming path. */
let workbook = $state<Workbook | null>(null);
/** Name of the active sheet within {@link workbook}. Defaults to the first sheet. */
let activeSheet = $state<string>('');

/**
 * One-shot chat input prefill (PULL pattern). A producer (e.g. the spreadsheet
 * context menu's "Analyze this column") calls setChatPrefill(text); ChatPane
 * CONSUMES it inside its own action handler — NOT reactively — and immediately
 * calls clearChatPrefill() so the same text can't be re-applied on a later
 * render. null = nothing pending.
 */
let chatPrefill = $state<{ text: string; skipQueryEngine: boolean } | null>(null);

/**
 * One-shot .cesvu import request (PULL pattern, mirrors chatPrefill). The
 * workspace-level drag-and-drop zone (Workspace.svelte) sets it via
 * requestImport(file); DocumentPane CONSUMES it in a $effect — opening its
 * unlock modal — and immediately calls clearImport() so the same file can't be
 * re-opened on a later render. null = nothing pending. Kept here (not in
 * DocumentPane) because the drop target is the whole workspace shell, which
 * doesn't own the import UI.
 */
let pendingImportFile = $state<File | null>(null);

/**
 * One-shot "vault" requests (PULL pattern, same shape as pendingImportFile):
 *   - pendingVaultEncryptFile: a dropped file whose type the in-app viewer
 *     doesn't support (see crypto/vault-constants.ts's isVaultCandidate).
 *     DocumentPane opens SecureSaveModal to encrypt it straight to disk.
 *   - pendingVaultDecryptFile: a dropped .cesvu file OVER
 *     VAULT_IMPORT_STREAM_THRESHOLD_BYTES. DocumentPane opens SecureOpenModal
 *     to decrypt it straight to disk instead of the normal in-memory unlock +
 *     viewer flow.
 * Both are set by the workspace-level drag-and-drop zone (Workspace.svelte)
 * and consumed (+cleared) by DocumentPane, mirroring pendingImportFile.
 */
let pendingVaultEncryptFile = $state<File | null>(null);
let pendingVaultDecryptFile = $state<File | null>(null);

/**
 * True while ANY export/vault modal (ExportModal, SecureSaveModal,
 * SecureOpenModal) is actively streaming/encrypting/decrypting — i.e. its
 * own `phase` is in the "generating"/"unlocking" state where the Modal
 * component's `dismissible` prop is also false (see Modal.svelte's doc
 * comment). Closing the tab/refreshing mid-operation would silently
 * abandon a partial write with no way to resume it, so
 * `onBeforeUnload` (Workspace.svelte) checks this flag to warn the user —
 * on top of the in-modal backdrop/Escape/✕ guards, which only protect
 * against accidental in-page dismissal, not a full navigation/reload.
 * A simple counter (not a boolean) so nested/overlapping calls from
 * multiple modals can never clobber each other's "done" transition.
 */
let activeVaultOperations = $state(0);

/** Called by an export/vault modal when it enters its non-dismissible
 *  "actively writing" phase. Must be paired with a later
 *  `endVaultOperation()` call (e.g. in a try/finally). */
function beginVaultOperation() {
	activeVaultOperations += 1;
}

/** Pair for `beginVaultOperation()`. Clamped at 0 so a stray extra call
 *  (e.g. from a retry path) can't underflow into a negative count. */
function endVaultOperation() {
	activeVaultOperations = Math.max(0, activeVaultOperations - 1);
}




/**
 * Transient toast message (e.g. "Copied"). Rendered by a Toast component and

 * auto-cleared after a short delay. null = no toast visible.
 */
let toast = $state<{ id: number; message: string } | null>(null);
let toastTimer: ReturnType<typeof setTimeout> | null = null;

/** Model download / load progress (0–100) */
let modelLoadProgress = $state<number>(0);

/** Analysis step progress e.g. { step: 'Loading model…', percent: 45 } */
let analysisProgress = $state<{ step: string; percent: number } | null>(null);
/**
 * Active row filter set by the chat query engine.
 * DocumentPane reads this and filters the displayed rows.
 * null = no filter (show all rows).
 */
let activeSort = $state<{ column: string; direction: 'asc' | 'desc' } | null>(null);

/** Comparison operator for a value (text/numeric) filter. */
export type ValueOperator = 'contains' | 'eq' | 'not_contains' | 'neq';

let activeFilter = $state<{
	/** Substring pattern for text filters (empty string for date-only filters) */
	pattern: string;
	column?: string;
	matchCount: number;
	/**
	 * Comparison operator for the value/text filter. Defaults to 'contains'
	 * when omitted (preserves the chat-driven behavior). Set by the interactive
	 * filter bar so the user can pick equals / not equal / not contains.
	 */
	valueOp?: ValueOperator;

	/** Date comparison filter — set for filter_date intent */
	dateFilter?: {
		/** Store as timestamp (ms) to avoid Svelte 5 proxy issues with Date objects */
		dateMs: number;
		dateOp: import('$lib/pipeline/query.js').DateOperator;
		/** Semantic hint to narrow which date columns to check */
		semanticDateHint?: 'update' | 'expiry' | 'issue' | 'any';
	};
	/**
	 * Recursive boolean filter tree (AND / OR / NOT / leaf).
	 * When present, DocumentPane uses evaluate() from filter.ts instead of
	 * the legacy pattern/column fields. Supports arbitrarily nested expressions.
	 */
	filterTree?: import('$lib/pipeline/filter.js').Filter;

	/**
	 * Cell-level "show duplicates of this value" marker (no LLM). This rides on
	 * top of an ordinary column == value filterTree (set by showDuplicates()) —
	 * it changes NOTHING about evaluation; it only tells DocumentPane to render a
	 * different banner: "Showing X rows where [column] = [value]".
	 */
	duplicatesOf?: { column: string; value: string };
} | null>(null);


// ── Lens (document-type) state ─────────────────────────────────────────────
/** Auto-detected lens for the current file (from detectLens). null until opened. */
let detectedLens = $state<Lens | null>(null);
/** Manual lens override for the current session. Wins over detectedLens. */
let lensOverride = $state<Lens | null>(null);
/** Built contract profile (when the effective lens is 'contract'). */
let contractProfile = $state<ContractProfile | null>(null);
/** True while buildContractProfile is running (drives the loading state). */
let contractProfileLoading = $state(false);
/**
 * One-shot "scroll the viewer to this clause" signal (PULL pattern, mirrors
 * chatPrefill). ContractSidebar sets it via requestScrollToClause(id); the
 * contract viewer CONSUMES it (scrolls + highlights) and immediately calls
 * clearScrollToClause(). null = nothing pending.
 */
let scrollToClauseId = $state<string | null>(null);

/**
 * Note-taking signals (contract lens).
 *
 *  - notesMode:      when true, clicking the contract text drops a note pin.
 *  - scrollToNoteId: PUSH from the Insights pane → the document scrolls/flashes
 *                    the matching pin, then clears it (mirrors scrollToClauseId).
 *  - focusNoteId:    PUSH from the document (pin just dropped / clicked) → the
 *                    Insights pane scrolls to that note's bubble and focuses its
 *                    editor, then clears it.
 */
let notesMode = $state(false);
let scrollToNoteId = $state<string | null>(null);
let focusNoteId = $state<string | null>(null);


// ── Contract persistence (IndexedDB) ───────────────────────────────────────
/**
 * Id of the contract record this session is bound to (from contract-store).
 * null until a contract is uploaded/opened. All saveSplits/saveProfile calls
 * target this id. Persistence is best-effort and never blocks the UI.
 *
 * INVARIANT — single-owner binding (do NOT add other writers):
 *   • SET only by beginContract() (fresh upload) and resumeContract() (import).
 *   • CLEARED only by closeDocument() (the ✕ / start-over path).
 *   setFile() must NEVER touch it: it runs on every document load, so clearing
 *   there raced resumeContract(), producing an old→null→new flip that left the
 *   viewer stuck loading. Exactly one setter-path and one clearer-path is what
 *   prevents BOTH that race AND the "Export targets the wrong document" bug.
 */
let activeContractId = $state<string | null>(null);

/** The split set the user is currently viewing. Mirrors the stored splitMode. */
let splitMode = $state<SplitMode>('manual');

/**
 * True when the active session was opened by unlocking a .cesvu file (vs a
 * direct upload of a plain document). Drives the "Download Source File" affordance
 * in ExportModal: a recovered source file is only offered when the original was
 * delivered as a protected .cesvu (a directly-uploaded file already lives on the
 * user's disk). Session-only — reset on every new upload / workspace reset.
 */
let openedFromCesvu = $state<boolean>(false);

/**
 * True when the session was opened from a .cesvu whose sender EXCLUDED the
 * original source file (the recipient has the extracted text + analysis but not
 * the original PDF/DOCX bytes). Drives a one-line banner in DocumentPane so the
 * recipient understands why "download original" isn't available. Set by the
 * import flow; cleared on reset and on any direct upload.
 */
let sourceOmitted = $state<boolean>(false);





// ============================================================
// Derived
// ============================================================



let hasFile = $derived(file !== null);
let isParsing = $derived(parseProgress !== null);
let isCSV = $derived(file?.type === 'csv');
let hasAnalysis = $derived(analysis !== null && analysis.error === null);
let hasSelection = $derived(selection !== null);
let messageCount = $derived(messages.length);

/** Effective lens: manual override wins over auto-detection. null until a file opens. */
let effectiveLens = $derived<Lens | null>(lensOverride ?? detectedLens);


// ── Non-streaming Workbook path derived state ──────────────────────────────
/** The currently-active sheet within the workbook, or null. */
let currentSheet = $derived<Sheet | null>(
	workbook ? (workbook.sheets.find((s) => s.name === activeSheet) ?? workbook.sheets[0] ?? null) : null
);
/** Rows of the active sheet (empty array when no workbook is loaded). */
let currentRows = $derived<Record<string, string>[]>(currentSheet?.rows ?? []);
/**
 * WorkbookProfile-based compressed summary for the workbook path.
 * Produced by profileWorkbook() over the whole workbook (all sheets).
 * null when no workbook is loaded (streaming path uses `summary` instead).
 *
 * DEFERRED, NOT $derived: profileWorkbook() re-scans every row of every sheet.
 * As a synchronous $derived it ran the instant `workbook` was assigned — before
 * the browser could paint a single frame — freezing the tab on large (100K-row)
 * .xlsx workbooks. We now compute it as plain $state, scheduled off the main
 * thread's critical path via requestIdleCallback (see scheduleWorkbookProfile).
 * The table renders immediately; the per-column stat badges fill in a moment
 * later when the idle callback fires.
 */
let workbookProfile = $state<WorkbookProfile | null>(null);

/** Cancellation handle for an in-flight deferred profile computation. */
let profileIdleHandle: number | null = null;
/**
 * Monotonic token identifying the most recent scheduled profile run. Each call
 * to scheduleWorkbookProfile bumps it; the deferred callback only commits its
 * result if its captured token still matches. Using a token (not the workbook
 * object) avoids comparing a reactive $state proxy against a raw value, which
 * triggers Svelte's state_proxy_equality_mismatch warning.
 */
let profileGeneration = 0;


/**
 * Schedule profileWorkbook() to run when the main thread is idle, so it never
 * blocks first paint of the spreadsheet. Uses requestIdleCallback with a 2s
 * timeout (purpose-built for exactly this "do it soon, but yield to the UI
 * first" scenario); falls back to setTimeout where rIC is unavailable
 * (Safari/Firefox). Any previously-scheduled computation is cancelled first so
 * rapid sheet/file swaps don't stack up stale work.
 */
function scheduleWorkbookProfile(wb: Workbook | null) {
	// Cancel any pending computation from a prior workbook.
	if (profileIdleHandle !== null) {
		if (typeof cancelIdleCallback !== 'undefined') cancelIdleCallback(profileIdleHandle);
		else clearTimeout(profileIdleHandle);
		profileIdleHandle = null;
	}

	// No workbook → clear the profile synchronously (cheap) and stop.
	if (!wb) {
		workbookProfile = null;
		return;
	}

	// Clear stale profile immediately so the UI doesn't show the previous
	// workbook's badges while the new one is being computed.
	workbookProfile = null;

	// Capture this run's token. If a newer schedule supersedes us before the
	// idle callback fires, our token won't match and we bail without committing.
	const myGeneration = ++profileGeneration;

	const run = () => {
		profileIdleHandle = null;
		// Guard: only commit if we are still the most recently scheduled run.
		// (Token comparison — NOT `workbook !== wb`, which would compare a
		// reactive $state proxy against a raw object and warn.)
		if (myGeneration !== profileGeneration) return;
		workbookProfile = profileWorkbook(wb);
	};


	if (typeof requestIdleCallback !== 'undefined') {
		profileIdleHandle = requestIdleCallback(run, { timeout: 2000 });
	} else {
		// Fallback: yield once to let the table paint, then compute.
		profileIdleHandle = setTimeout(run, 0) as unknown as number;
	}
}



// ============================================================
// Actions
// ============================================================

function setFile(f: ParsedFile) {
	file = f;
	summary = null;
	analysis = null;
	selection = null;
	messages = [];
	error = null;
	// Clear any stuck loading state from a prior (possibly aborted) inference so
	// the chat input is immediately usable for the new document.
	isLoading = false;
	analysisProgress = null;
	step = 'template-select';

	// NOTE: contract binding (activeContractId / splitMode) is deliberately NOT
	// cleared here. setFile() runs on EVERY document load, including the .cesvu
	// import path, which binds via resumeContract() immediately afterwards —
	// clearing here created an old→null→new id flip that raced that rebind (the
	// "new document endlessly loads after closing one" bug). Binding has exactly
	// two owners: reset() clears it (the ✕ / new-document path) and
	// resumeContract() sets it (import). A fresh direct upload only ever reaches
	// setFile() AFTER reset() has already cleared the binding (the upload
	// dropzone only exists once no document is open), so Export still targets the
	// correct record.

	// Seed csvRows from the initial parsed rows so the table renders immediately


	if (f.type === 'csv') {
		const data = f.parsedData as { rows: Record<string, unknown>[] };
		csvRows = data.rows ?? [];
	} else {
		csvRows = [];
	}

	// Non-streaming workbook path: if the ParsedFile carries a materialized
	// Workbook (e.g. .xlsx via parseExcel), wire it into the workbook store so
	// SpreadsheetViewer renders instead of sitting on "No workbook loaded."
	// CSV/text/PDF/DOCX carry no workbook → clear it so the streaming/text
	// viewers take over.
	const wb = (f as ParsedFile & { workbook?: Workbook }).workbook ?? null;
	workbook = wb;
	activeSheet = wb?.activeSheet ?? wb?.sheets[0]?.name ?? '';
	// Compute the column-profile badges off the critical path so the table can
	// paint first (large .xlsx workbooks would otherwise freeze the tab here).
	scheduleWorkbookProfile(wb);
}

/**
 * openDocument — canonical entry point for "a freshly parsed document is now
 * active". Currently a thin wrapper over setFile() so call sites can adopt the
 * open/close vocabulary that pairs with closeDocument(). Binding
 * (activeContractId) is established separately by beginContract()/resumeContract()
 * — see the INVARIANT on activeContractId.
 */
function openDocument(f: ParsedFile) {
	setFile(f);
}



function setSummary(s: CompressedSummary) {

	summary = s;
}

// ── Non-streaming Workbook path actions ────────────────────────────────────

/**
 * Set the fully-parsed workbook (parseCsv / parseExcel result) and point the
 * active sheet at the first sheet. Does NOT touch the streaming csvRows buffer
 * or its consumers — both paths coexist.
 */
function setWorkbook(wb: Workbook | null) {
	workbook = wb;
	activeSheet = wb?.activeSheet ?? wb?.sheets[0]?.name ?? '';
	scheduleWorkbookProfile(wb);
}


/** Switch the active sheet by name. No-op if the name is not in the workbook. */
function setActiveSheet(name: string) {
	if (workbook && workbook.sheets.some((s) => s.name === name)) {
		activeSheet = name;
	}
}


function setTemplate(t: Template) {
	selectedTemplate = t;
	// Persist preference so it survives tab close / browser restart
	if (typeof localStorage !== 'undefined') {
		localStorage.setItem(TEMPLATE_PREF_KEY, t.id);
	}
}

function setModel(m: ModelConfig) {
	selectedModel = m;
	// Persist preference so it survives tab close / browser restart
	if (typeof localStorage !== 'undefined') {
		localStorage.setItem(PREF_KEY, m.id);
	}
}

function setSelection(sel: WorkspaceSelection | null) {
	selection = sel;
}

function clearSelection() {
	selection = null;
}

function startAnalysis() {
	isLoading = true;
	error = null;
	step = 'analyzing';
}

function setAnalysis(result: AnalysisResult) {
	analysis = result;
	isLoading = false;
	step = 'results';
}

/**
 * Store analysis result WITHOUT changing step or activeTab.
 * Used by ChatPane so the chat UI stays visible after inference.
 */
function storeAnalysisResult(result: AnalysisResult) {
	analysis = result;
	isLoading = false;
}

function setLoading(loading: boolean) {
	isLoading = loading;
}

function setError(err: string) {
	error = err;
	isLoading = false;
	if (step === 'analyzing') step = 'template-select';
}

function addMessage(msg: ChatMessage) {
	messages = [...messages, msg];
}

function clearMessages() {
	messages = [];
}

function setActiveTab(tab: ActiveTab) {
	activeTab = tab;
}

function setParseProgress(progress: { stage: string; rowsRead?: number } | null) {
	parseProgress = progress;
}

function setStreamingState(done: boolean, total: number, rows?: Record<string, unknown>[]) {
	streamingDone = done;
	streamingTotal = total;
	// Reassign array reference so $derived values re-run
	if (rows !== undefined) csvRows = rows;
}

function setModelLoadProgress(pct: number) {
	modelLoadProgress = pct;
}

function setAnalysisProgress(progress: { step: string; percent: number } | null) {
	analysisProgress = progress;
}

/**
 * Called once on app mount. Reads cesvu_pending_model from sessionStorage
 * (set by loadModel before a model-switch reload) and applies it to the store.
 * Clears the key after reading so it doesn't persist across unrelated reloads.
 */
function initFromSession() {
	if (typeof sessionStorage === 'undefined') return;
	// sessionStorage pending model (set before a model-switch reload) takes priority
	const pendingModelId = sessionStorage.getItem('cesvu_pending_model');
	if (pendingModelId) {
		sessionStorage.removeItem('cesvu_pending_model');
		const match = DEFAULT_MODELS.find(m => m.id === pendingModelId);
		if (match) {
			selectedModel = match;
			// Also persist this as the new preference
			if (typeof localStorage !== 'undefined') localStorage.setItem(PREF_KEY, match.id);
			console.log('[workspace] Restored pending model from session:', match.name);
		}
	}
	// localStorage preference is already applied at module init via loadPersistedModel()
}

/**
 * Queue a one-shot chat input prefill. Consumed (and cleared) by ChatPane.
 * `opts.skipQueryEngine` marks the prefill as a narrative analysis request
 * that must go straight to the LLM (bypassing filter/intent detection) — set
 * by the "Analyze this column" context-menu action.
 */
function setChatPrefill(text: string, opts?: { skipQueryEngine?: boolean }) {
	chatPrefill = { text, skipQueryEngine: opts?.skipQueryEngine ?? false };
}

/** Clear the pending prefill. Called by ChatPane right after it consumes it. */
function clearChatPrefill() {
	chatPrefill = null;
}

/**
 * Queue a .cesvu file for the unlock flow. Set by the workspace-level
 * drag-and-drop zone; consumed (and cleared) by DocumentPane, which owns the
 * unlock modal.
 */
function requestImport(f: File) {
	pendingImportFile = f;
}

/** Clear the pending import file. Called by DocumentPane after it consumes it. */
function clearImport() {
	pendingImportFile = null;
}

/**
 * Queue a non-viewer-supported file for the "encrypt to vault" flow. Set by
 * the workspace-level drag-and-drop zone (and the landing FileDropzone);
 * consumed (and cleared) by DocumentPane, which owns SecureSaveModal.
 */
function requestVaultEncrypt(f: File) {
	pendingVaultEncryptFile = f;
}

/** Clear the pending vault-encrypt file. Called by DocumentPane after consuming it. */
function clearVaultEncrypt() {
	pendingVaultEncryptFile = null;
}

/**
 * Queue an oversized .cesvu file for the "decrypt straight to disk" flow.
 * Set by the workspace-level drag-and-drop zone; consumed (and cleared) by
 * DocumentPane, which owns SecureOpenModal.
 */
function requestVaultDecrypt(f: File) {
	pendingVaultDecryptFile = f;
}

/** Clear the pending vault-decrypt file. Called by DocumentPane after consuming it. */
function clearVaultDecrypt() {
	pendingVaultDecryptFile = null;
}



/**
 * Show a transient toast message (e.g. "Copied"). Replaces any visible toast
 * and auto-clears after `durationMs`. A fresh `id` each call lets the Toast
 * component re-trigger its enter animation even for identical messages.
 */
function showToast(message: string, durationMs = 1500) {
	if (toastTimer) clearTimeout(toastTimer);
	toast = { id: (toast?.id ?? 0) + 1, message };
	toastTimer = setTimeout(() => { toast = null; toastTimer = null; }, durationMs);
}

function setActiveSort(s: { column: string; direction: 'asc' | 'desc' } | null) {
	activeSort = s;
}


function clearActiveSort() {
	activeSort = null;
}

function setActiveFilter(f: {
	pattern: string;
	column?: string;
	matchCount: number;
	valueOp?: ValueOperator;
	dateFilter?: { dateMs: number; dateOp: import('$lib/pipeline/query.js').DateOperator; semanticDateHint?: 'update' | 'expiry' | 'issue' | 'any' };

	/**
	 * Recursive boolean filter tree (AND / OR / NOT / leaf).
	 * When present, DocumentPane uses evaluate() from filter.ts instead of
	 * the legacy pattern/column fields. Supports arbitrarily nested expressions.
	 */
	filterTree?: import('$lib/pipeline/filter.js').Filter;

	/** Cell-level "show duplicates of this value" banner marker. See activeFilter type. */
	duplicatesOf?: { column: string; value: string };
} | null) {
	activeFilter = f;
}



function clearActiveFilter() {
	activeFilter = null;
}

// ── Lens actions ───────────────────────────────────────────────────────────

/** Set the auto-detected lens (called from the file-open flow after detectLens). */
function setLens(lens: Lens | null) {
	detectedLens = lens;
}

/** Set / clear the manual lens override for this session (wins over detection). */
function setLensOverride(lens: Lens | null) {
	lensOverride = lens;
}

/** Store the built contract profile (or null to clear). */
function setContractProfile(profile: ContractProfile | null) {
	contractProfile = profile;
}

/** Toggle the contract-profile loading state. */
function setContractProfileLoading(loading: boolean) {
	contractProfileLoading = loading;
}

/** Request the contract viewer scroll to a clause (PULL signal; viewer consumes). */
function requestScrollToClause(clauseId: string) {
	scrollToClauseId = clauseId;
}

/** Clear the pending scroll-to-clause signal. Called by the viewer after consuming. */
function clearScrollToClause() {
	scrollToClauseId = null;
}

// ── Note-taking actions ─────────────────────────────────────────────────────

/** Turn note-pin placement on/off (the document toolbar toggle). */
function setNotesMode(on: boolean) {
	notesMode = on;
}

	/**
	 * PUSH: ask the active tabular viewer (CSV or XLSX) to scroll a cell into
	 * view and briefly highlight it. Mirrors `requestScrollToNote` for the
	 * contract pane. The viewer consumes the signal in a $effect and clears
	 * it via `clearScrollToCell`.
	 *
	 * Used by NotesPane when the user clicks a bubble anchored to a cell:
	 * the pane reads the note's anchor, calls this, and the viewer's
	 * `focusNoteId` effect runs the scroll-and-highlight.
	 */
	let scrollToCell = $state<{ sheet: string; column: string; rowIndex: number } | null>(null);
	function requestScrollToCell(sheet: string, column: string, rowIndex: number) {
		scrollToCell = { sheet, column, rowIndex };
	}
	function clearScrollToCell() {
		scrollToCell = null;
	}
	function getScrollToCell() { return scrollToCell; }

	// ── Lazy popover state ───────────────────────────────────────────────────
	// The right rail (NotesPane) is gone for tabular files by default. The
	// user opens it as a popover when they want it — click the Notes button
	// in the sheet info bar or the header's Chat/Notes tab.

	/**
	 * The currently-open right-edge popover. null = no popover. The popover
	 * is mounted via `{#if}` in Workspace.svelte; closing it unmounts the
	 * popover's component.
	 */
	export type OpenPane = { kind: 'notes' };
	let openPane = $state<OpenPane | null>(null);

	/**
	 * Open the notes popover. Replaces any other open popover.
	 */
	function openNotesPane() {
		openPane = { kind: 'notes' };
	}

	/** Close whichever popover is open. */
	function closeOpenPane() {
		openPane = null;
	}

/** PUSH: ask the document to scroll/flash a note pin. Document consumes + clears. */
function requestScrollToNote(noteId: string) {
	scrollToNoteId = noteId;
}

/** Clear the pending scroll-to-note signal (called by the document after consuming). */
function clearScrollToNote() {
	scrollToNoteId = null;
}

/** PUSH: ask the Insights pane to scroll to + focus a note's editor. Pane clears it. */
function requestFocusNote(noteId: string) {
	focusNoteId = noteId;
}

/** Clear the pending focus-note signal (called by the Insights pane after consuming). */
function clearFocusNote() {
	focusNoteId = null;
}


// ── Contract persistence actions (IndexedDB, best-effort) ───────────────────

/**
 * Persist a freshly-uploaded contract and bind this session to its record.
 * Called from the contract-upload flow once text is extracted. Fire-and-forget:
 * a persistence failure (e.g. no IndexedDB) must never block analysis, so it is
 * caught and logged, leaving activeContractId null (the app works in-memory).
 */
async function beginContract(
	text: string,
	meta: { name: string; sourceType: SourceType; rawContent?: string | Uint8Array | null }
) {
	splitMode = 'manual';
	try {
		const doc = await createDocument({
			name: meta.name,
			sourceType: meta.sourceType,
			text,
			// Original file bytes (raw Uint8Array, or a base64 string for
			// backward compatibility) — carried so a later .cesvu export
			// round-trips the FULL source (binary PDF, XLSX workbook, CSV
			// rows), not just the lossy extracted text. Null for txt/md.
			rawContent: meta.rawContent ?? null
		});

		activeContractId = doc.id;
	} catch (err) {
		console.warn('[workspace] createDocument failed (continuing in-memory):', err);
		activeContractId = null;
	}
}


/**
 * Resume a previously-saved contract: bind this session to `id` and restore its
 * last-used split mode. The caller (DocumentPane) loads the record's text into
 * the file/lens state separately; here we only re-establish persistence binding
 * and the active split mode. Returns the record so the caller can hydrate.
 */
async function resumeContract(id: string) {
	const rec = await getDocument(id);
	if (!rec) return null;
	activeContractId = rec.id;
	splitMode = rec.splits.mode;
	return rec;
}

/**
 * Persist split offsets for the active contract. `mode`, when given, also
 * updates the in-memory splitMode so the sidebar toggle and the next re-open
 * agree. No-op (silent) when there's no active contract id. Best-effort.
 */
function persistSplits(splits: Partial<DocumentSplits>) {
	if (splits.mode) splitMode = splits.mode;
	if (!activeContractId) return;
	// updateDocument shallow-merges the nested `splits` object, so passing only
	// the changed sub-fields preserves the other split set.
	updateDocument(activeContractId, { splits }).catch((err: unknown) =>
		console.warn('[workspace] persistSplits failed:', err)
	);
}


/** Persist the analysis profile for the active contract. Best-effort. */
function persistProfile(profile: ContractProfile | null) {
	if (!activeContractId) return;
	updateDocument(activeContractId, { profile }).catch((err: unknown) =>
		console.warn('[workspace] persistProfile failed:', err)
	);
}


/** Set the active split mode (sidebar toggle) and persist it. */
function setSplitMode(mode: SplitMode) {
	splitMode = mode;
	persistSplits({ mode });
}

/**
 * Mark whether this session was opened by unlocking a .cesvu file. Set true by
 * the import flow (DocumentPane.handleImported), false on a direct upload. Read
 * by ExportModal to decide whether to offer "Download Source File".
 */
function setOpenedFromCesvu(v: boolean) {
	openedFromCesvu = v;
}

/**
 * Mark whether the .cesvu this session was opened from had its original source
 * file excluded by the sender. Set by the import flow; read by DocumentPane to
 * show the "original source file wasn't included" banner.
 */
function setSourceOmitted(v: boolean) {
	sourceOmitted = v;
}



/**
 * Registry of per-document sibling stores torn down on every document close.
 * Each entry FULLY unbinds its store (drops its document binding + clears its
 * data). Adding a new per-document RUNTIME store? Add one line here —
 * closeDocument() loops this list, so a new store can't be silently forgotten
 * (the leak that let a new document inherit the previous one's clauses/notes).
 * See .clinerules/schema_rules.txt → "Per-document RUNTIME state".
 */
const perDocumentTeardowns: Array<() => void> = [
	() => clauseStore.unbind(),
	() => notesStore.clear(),
	// The "Send Back" passphrase (see sessionKey.svelte.ts) is far more
	// sensitive than the document body — it MUST be zeroized/dropped the
	// instant the document closes, exactly like clauseStore/notesStore.
	() => sessionKeyStore.clear()
];

/**
 * closeDocument — the SINGLE authoritative teardown for "the document was closed
 * / start over". The ✕ button and every reset path go through here. Exported as
 * both `closeDocument` (canonical) and `reset` (legacy alias). A page refresh
 * wipes all in-memory module state; this mirrors that for an in-session close.
 */
function closeDocument() {
	file = null;

	summary = null;
	analysis = null;
	// Reset to persisted preferences (not hardcoded defaults)
	selectedTemplate = loadPersistedTemplate();
	selectedModel = loadPersistedModel();
	activeTab = 'chat';
	selection = null;
	messages = [];
	isLoading = false;
	error = null;
	step = 'upload';
	parseProgress = null;
	streamingDone = true;
	streamingTotal = 0;
	csvRows = [];
	workbook = null;
	activeSheet = '';
	modelLoadProgress = 0;
	analysisProgress = null;
	activeFilter = null;
	activeSort = null;
	// Contract binding — closeDocument() is the SINGLE owner of CLEARING it
	// (setFile no longer touches it; see the INVARIANT on activeContractId).
	// Clearing here stops a fresh session from inheriting a previous document's
	// record id, which would make Export serialize the wrong document. splitMode
	// returns to its default.

	activeContractId = null;
	splitMode = 'manual';

	// Lens state — clear so a fresh upload re-detects from scratch.

	detectedLens = null;
	lensOverride = null;
	contractProfile = null;
	contractProfileLoading = false;
	scrollToClauseId = null;
	notesMode = false;
	scrollToNoteId = null;
	focusNoteId = null;
	// A fresh upload / workspace reset is not opened from a .cesvu until the
	// import flow says so — clear the flag so a prior import doesn't leak into
	// the next session's Export dialog.
	openedFromCesvu = false;
	// Likewise, a fresh session has no "source omitted" context until an import
	// of a source-excluded .cesvu sets it.
	sourceOmitted = false;

	// Full clean slate: tear down every registered per-document sibling store.
	// Each entry fully unbinds its store (drops its document binding + clears its
	// data) so a freshly-opened document can't inherit the previous one's clauses
	// or notes — including notesStore's null→real "migration" that would flush
	// stale notes into the new record. One loop, one place to extend (see
	// perDocumentTeardowns) means you can't forget to reset a new store — the
	// regression this guards. A page refresh wipes all module state; this mirrors it.
	for (const teardown of perDocumentTeardowns) teardown();
}








// ============================================================
// Export
// ============================================================

export const workspace = {
	// State getters
	get file() { return file; },
	get summary() { return summary; },
	get analysis() { return analysis; },
	get selectedTemplate() { return selectedTemplate; },
	get selectedModel() { return selectedModel; },
	get activeTab() { return activeTab; },
	get selection() { return selection; },
	get messages() { return messages; },
	get isLoading() { return isLoading; },
	get error() { return error; },
	get step() { return step; },

	// Derived getters
	get hasFile() { return hasFile; },
	get isCSV() { return isCSV; },
	get hasAnalysis() { return hasAnalysis; },
	get hasSelection() { return hasSelection; },
	get messageCount() { return messageCount; },
	get isParsing() { return isParsing; },
	get parseProgress() { return parseProgress; },
	get streamingDone() { return streamingDone; },
	get streamingTotal() { return streamingTotal; },
	get csvRows() { return csvRows; },
	// Non-streaming Workbook path getters
	get workbook() { return workbook; },
	get activeSheet() { return activeSheet; },
	get currentSheet() { return currentSheet; },
	get currentRows() { return currentRows; },
	get workbookProfile() { return workbookProfile; },
	get modelLoadProgress() { return modelLoadProgress; },

	get analysisProgress() { return analysisProgress; },
	get activeFilter() { return activeFilter; },
	get activeSort() { return activeSort; },
	get chatPrefill() { return chatPrefill; },
	get pendingImportFile() { return pendingImportFile; },
	get pendingVaultEncryptFile() { return pendingVaultEncryptFile; },
	get pendingVaultDecryptFile() { return pendingVaultDecryptFile; },
	get activeVaultOperations() { return activeVaultOperations; },
	get hasActiveVaultOperation() { return activeVaultOperations > 0; },

	get toast() { return toast; },



	// Lens getters
	get detectedLens() { return detectedLens; },
	get lensOverride() { return lensOverride; },
	get effectiveLens() { return effectiveLens; },
	get contractProfile() { return contractProfile; },
	get contractProfileLoading() { return contractProfileLoading; },
	get scrollToClauseId() { return scrollToClauseId; },
	get notesMode() { return notesMode; },
	get scrollToNoteId() { return scrollToNoteId; },
	get focusNoteId() { return focusNoteId; },
	get scrollToCell() { return scrollToCell; },

	// Contract persistence getters

	get activeContractId() { return activeContractId; },
	get splitMode() { return splitMode; },
	get openedFromCesvu() { return openedFromCesvu; },
	get sourceOmitted() { return sourceOmitted; },




	// Actions
	setFile,
	setLens,
	setLensOverride,
	setContractProfile,
	setContractProfileLoading,
	requestScrollToClause,
	clearScrollToClause,
	setNotesMode,
	requestScrollToNote,
	clearScrollToNote,
	requestFocusNote,
	clearFocusNote,
	requestScrollToCell,
	clearScrollToCell,

	// Popover actions (lazy right-rail replacement)
	get openPane() { return openPane; },
	openNotesPane,
	closeOpenPane,

	// Contract persistence actions

	beginContract,
	resumeContract,
	persistSplits,
	persistProfile,
	setSplitMode,
	setOpenedFromCesvu,
	setSourceOmitted,




	setParseProgress,
	setStreamingState,
	setSummary,
	setWorkbook,
	setActiveSheet,
	setTemplate,

	setModel,
	setSelection,
	clearSelection,
	startAnalysis,
	setAnalysis,
	setError,
	addMessage,
	clearMessages,
	setActiveTab,
	setModelLoadProgress,
	setAnalysisProgress,
	storeAnalysisResult,
	setLoading,
	initFromSession,
	setActiveFilter,
	clearActiveFilter,
	setActiveSort,
	clearActiveSort,
	setChatPrefill,
	clearChatPrefill,
	requestImport,
	clearImport,
	requestVaultEncrypt,
	clearVaultEncrypt,
	requestVaultDecrypt,
	clearVaultDecrypt,
	beginVaultOperation,
	endVaultOperation,
	showToast,



	// Document lifecycle (canonical open/close vocabulary)
	openDocument,
	closeDocument,
	// `reset` is the legacy alias for closeDocument — existing call sites (the ✕
	// button) keep working. Prefer closeDocument() in new code.
	reset: closeDocument
};




