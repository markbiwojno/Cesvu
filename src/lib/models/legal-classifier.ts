/**
 * src/lib/models/legal-classifier.ts — Legal clause classifier (Transformers.js)
 *
 * Wraps the ONNX BERT model in a `text-classification` pipeline, following the
 * same client-side Transformers.js pattern as src/lib/llm/inference.ts (lazy import,
 * env config, module-level cache, WebGPU→WASM fallback). Runs entirely in the
 * browser — no clause text ever leaves the device.
 *
 * ── Notes on the model (verified against the HF repo, NOT the task brief) ──
 *  • Labels: 28 clause types (the brief said 41 — the repo defines 28).
 *  • Label strings are snake_case (e.g. "indemnification"), so we keep the raw
 *    label AND derive a prettified display label.
 *  • Risk level + a plain-English description are bundled IN the model repo
 *    (label_config.json → labelInfo). We inline that map below (CLAUSE_INFO) so
 *    risk/description resolution is deterministic and works fully offline — no
 *    extra network fetch of label_config.json at runtime.
 *  • Quantization: the repo ships ONLY fp32 (`model.onnx` + `model.onnx.data`,
 *    ~280MB total). There is NO q8 build (the brief's "~22MB at q8" is not
 *    achievable). We therefore load fp32 — one-time download, then served from
 *    the browser Cache API / service worker on subsequent visits.
 *
 * HOSTING: per .clinerules, the model id is the R2 key (simplified stem
 * "legal-clause-classifier"), not the full HF path. transformers.js substitutes
 * {model} and {revision} from the remotePathTemplate; the filename is appended
 * separately. The "revision" is passed to pipeline() as 'v1' to match the R2
 * manifest version (legal-clause-classifier-v1.json).
 */

// ============================================================
// Public types
// ============================================================

export type ClauseRisk = 'high' | 'medium' | 'low';

/** Result of classifying a single clause. */
export interface ClauseClassification {
	/** Prettified, human-readable label for the UI (e.g. "Indemnification"). */
	label: string;
	/** Raw model label (snake_case, e.g. "indemnification") — for debugging. */
	rawLabel: string;
	/** Confidence of the top label, 0–1. */
	score: number;
	/** Risk level driving dashboard colors. */
	risk: ClauseRisk;
	/** Plain-English description (feeds the LLM prompt for explanations). */
	description: string;
}

export interface LoadProgress {
	status: 'loading' | 'ready' | 'error';
	percent: number; // 0–100
	message: string;
}

// Transformers.js pipeline type (loosely typed to avoid deep type imports).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TextClassificationPipeline = any;

// ============================================================
// CORS-aware error handling (mirrors src/lib/llm/inference.ts)
// ============================================================

/** Match the typical browser CORS / cross-origin error messages. */
const CORS_ERROR_PATTERNS = [
	/access-control-allow-origin/i,
	/cors policy/i,
	/cross-origin request blocked/i,
	/no 'access-control-allow-origin'/i,
	/failed to fetch/i,
	/networkerror when attempting/i,
	/load failed/i
];

/** True if the error looks like a browser-level CORS / cross-origin block. */
function looksLikeCorsError(err: unknown): boolean {
	const msg = err instanceof Error ? err.message : String(err);
	return CORS_ERROR_PATTERNS.some((re) => re.test(msg));
}

/** User-facing CORS error message that points at MODELS.md → CORS. */
function corsErrorMessage(): string {
	const origin = typeof window !== 'undefined' ? window.location.origin : 'this app';
	return (
		`Model load failed: the model bucket blocked a cross-origin request from ${origin}. ` +
		`The bucket must send CORS headers (Access-Control-Allow-Origin: ${origin}) ` +
		`for model files to load. See MODELS.md → "CORS" for the exact bucket config.`
	);
}

// ============================================================
// Model id + clause metadata (inlined from the repo's label_config.json)
// ============================================================

/**
 * Model identifier = R2 key (simplified stem). transformers.js substitutes
 * {model} and {revision}; the filename is appended separately. The full URL
 * pattern produced at runtime is:
 *   https://ai.cesvu.com/{model}/{revision}/<file>
 * e.g. https://ai.cesvu.com/legal-clause-classifier/v1/model.onnx
 */
export const LEGAL_CLASSIFIER_MODEL_ID = 'legal-clause-classifier';

interface ClauseMeta {
	risk: ClauseRisk;
	description: string;
}

/**
 * Risk level + description per raw label, mirrored verbatim from the model
 * repo's label_config.json (`labelInfo`). Inlined so risk resolution is
 * deterministic and offline — we never need to fetch label_config.json.
 * 28 entries — matches the model's numLabels.
 */
const CLAUSE_INFO: Record<string, ClauseMeta> = {
	indemnification: { risk: 'high', description: 'You must pay for their legal problems' },
	liability_limitation: { risk: 'high', description: 'They limit how much you can sue them for' },
	liability_uncapped: { risk: 'high', description: 'You could face unlimited financial liability' },
	non_compete: { risk: 'high', description: 'You cannot work with their competitors' },
	exclusivity: { risk: 'high', description: 'You can only work with them, no one else' },
	ip_assignment: { risk: 'high', description: 'You give up ownership of your work/ideas' },
	binding_arbitration: { risk: 'high', description: 'You cannot sue them in court' },
	class_action_waiver: { risk: 'high', description: 'You cannot join group lawsuits against them' },
	data_rights: { risk: 'high', description: 'They can use your data however they want' },
	termination_convenience: { risk: 'medium', description: 'They can cancel anytime without reason' },
	auto_renewal: { risk: 'medium', description: 'Contract renews automatically' },
	non_solicit: { risk: 'medium', description: 'You cannot hire their employees or contact their customers' },
	liquidated_damages: { risk: 'medium', description: 'Pre-set penalty amounts if contract is broken' },
	covenant_not_sue: { risk: 'medium', description: 'You agree not to sue them' },
	change_of_control: { risk: 'medium', description: 'Contract changes if company ownership changes' },
	unilateral_amendment: { risk: 'medium', description: 'They can change terms without your consent' },
	non_disparagement: { risk: 'medium', description: 'You cannot say negative things about them' },
	perpetual_license: { risk: 'medium', description: 'They get permanent rights to use something' },
	confidentiality: { risk: 'low', description: 'You must keep certain information secret' },
	governing_law: { risk: 'low', description: 'Disputes handled under specific jurisdiction' },
	assignment_restriction: { risk: 'low', description: 'You cannot transfer this contract' },
	audit_rights: { risk: 'low', description: 'They can inspect your records' },
	insurance_requirement: { risk: 'low', description: 'You must maintain insurance coverage' },
	minimum_commitment: { risk: 'low', description: 'You must buy or use a minimum amount' },
	price_restriction: { risk: 'low', description: 'Limitations on pricing' },
	warranty: { risk: 'low', description: 'Guarantees about product/service quality' },
	force_majeure: { risk: 'low', description: 'Excuses for unforeseeable events' },
	notice_requirements: { risk: 'low', description: 'How to communicate formally' }
};

/**
 * Index → real clause name.
 *
 * WHY THIS ARRAY EXISTS: the model's config.json uses placeholder LABEL_N
 * values for id2label ("0":"LABEL_0", … "27":"LABEL_27"), so Transformers.js
 * emits "LABEL_20" etc. instead of real names. The real names are in the repo's
 * separate label_config.json (which Transformers.js does NOT read). This array
 * maps the model's output index → the real snake_case clause name.
 *
 * ORDER IS LOAD-BEARING: entry 0 = label_config.json index 0, entry 1 = index
 * 1, and so on. It is a verbatim, in-order copy of label_config.json. If this
 * order drifts from the file, every clause is mislabeled. 28 entries =
 * model numLabels. Keep in sync with CLAUSE_INFO above.
 */
const ID2LABEL: readonly string[] = [
	'indemnification', // 0
	'liability_limitation', // 1
	'liability_uncapped', // 2
	'non_compete', // 3
	'exclusivity', // 4
	'ip_assignment', // 5
	'binding_arbitration', // 6
	'class_action_waiver', // 7
	'data_rights', // 8

	'termination_convenience', // 9
	'auto_renewal', // 10
	'non_solicit', // 11
	'liquidated_damages', // 12
	'covenant_not_sue', // 13
	'change_of_control', // 14
	'unilateral_amendment', // 15
	'non_disparagement', // 16
	'perpetual_license', // 17
	'confidentiality', // 18
	'governing_law', // 19
	'assignment_restriction', // 20
	'audit_rights', // 21
	'insurance_requirement', // 22
	'minimum_commitment', // 23
	'price_restriction', // 24
	'warranty', // 25
	'force_majeure', // 26
	'notice_requirements' // 27
];

/**
 * Resolve the model's raw label to a real clause name. If it's a placeholder
 * "LABEL_<n>", map it through ID2LABEL; otherwise pass the label through
 * unchanged (so a future model that ships real names still works).
 */
function resolveModelLabel(rawLabel: string): string {
	const m = /^LABEL_(\d+)$/i.exec(rawLabel.trim());
	if (m) {
		const idx = Number(m[1]);
		return ID2LABEL[idx] ?? rawLabel; // out-of-range → leave as-is for visibility
	}
	return rawLabel;
}

/** Special-case acronyms so prettify renders them correctly (not "Ip"). */
const ACRONYMS: Record<string, string> = { ip: 'IP' };


/** snake_case → Title Case display label (e.g. "ip_assignment" → "IP Assignment"). */
function prettifyLabel(raw: string): string {
	return raw
		.split('_')
		.map((w) => ACRONYMS[w] ?? w.charAt(0).toUpperCase() + w.slice(1))
		.join(' ');
}

/**
 * Normalize a model label to the snake_case key form used in CLAUSE_INFO.
 * The model may emit labels in varied casing/spacing ("Governing Law",
 * "GOVERNING_LAW", "governing-law"); CLAUSE_INFO is keyed in snake_case
 * ("governing_law"). Normalizing both sides before lookup makes risk/description
 * resolution robust to label-format drift (root cause of "everything is low").
 */
export function normalizeLabel(raw: string): string {
	return raw
		.trim()
		.toLowerCase()
		.replace(/[\s-]+/g, '_') // spaces / hyphens → underscore
		.replace(/[^a-z0-9_]/g, ''); // strip anything else
}

/** Resolve risk + description for a raw label, with a safe default. */
function metaFor(raw: string): ClauseMeta {
	return (
		CLAUSE_INFO[raw] ??
		CLAUSE_INFO[normalizeLabel(raw)] ?? { risk: 'low', description: 'Unrecognized clause type.' }
	);
}


// ============================================================
// Pipeline cache — load once, reuse across calls
// ============================================================

let _pipe: TextClassificationPipeline | null = null;
/** In-flight load promise, so concurrent callers share one download. */
let _loadingPromise: Promise<TextClassificationPipeline> | null = null;

/**
 * Load (or return the cached) legal-clause-classifier pipeline.
 *
 * The model loads once: the first call downloads + initializes it, every
 * subsequent call returns the same cached pipeline instantly. Concurrent first
 * calls share a single in-flight promise (no double download / double session).
 *
 * Tries WebGPU first (Chrome/Edge), falling back to WASM (Firefox/Safari and
 * any browser without WebGPU). Mirrors src/lib/llm/inference.ts device strategy.
 *
 * @throws if the model fails to load on both WebGPU and WASM.
 */
export async function loadLegalClassifier(
	onProgress?: (p: LoadProgress) => void
): Promise<TextClassificationPipeline> {
	if (_pipe) return _pipe;
	if (_loadingPromise) return _loadingPromise;

	_loadingPromise = (async () => {
		const { pipeline, env } = await import('@huggingface/transformers');

		// Point at the first-party R2 mirror. The runtime URL pattern is:
		//   https://ai.cesvu.com/{model}/{revision}/<file>
		// where {model} and {revision} are substituted from the template below,
		// and <file> is appended separately by transformers.js. {file} is NOT
		// a supported template variable — omitting it avoids the {file}-literal-
		// in-URL bug we just fixed.
		env.allowRemoteModels = true;
		env.allowLocalModels = false;
		env.remoteHost = 'https://ai.cesvu.com';
		env.remotePathTemplate = '{model}/{revision}';

		const makeProgressCallback = (device: 'webgpu' | 'wasm') => (progress: {
			status?: string;
			file?: string;
			progress?: number;
		}) => {
			const pct = typeof progress.progress === 'number' ? Math.round(progress.progress) : 0;
			onProgress?.({
				status: 'loading',
				percent: pct,
				message: `Loading clause classifier (${device})… ${progress.file ?? ''}`.trim()
			});
		};

		// ── WebGPU first ───────────────────────────────────────────────────────
		const webgpuOk = await isWebGPUAvailable();
		if (webgpuOk) {
			try {
				onProgress?.({ status: 'loading', percent: 5, message: 'Initializing WebGPU…' });
				const pipe = await pipeline('text-classification', LEGAL_CLASSIFIER_MODEL_ID, {
					// Only fp32 is published for this model; no q8 build exists.
					dtype: 'fp32',
					device: 'webgpu',
					revision: 'v1',
					progress_callback: makeProgressCallback('webgpu')
				});
				_pipe = pipe;
				onProgress?.({ status: 'ready', percent: 100, message: 'Clause classifier ready ✓' });
				return pipe;
			} catch (err) {
				console.warn('[legal-classifier] WebGPU load failed, falling back to WASM:', err);
			}
		}

		// ── WASM fallback ────────────────────────────────────────────────────────
		try {
			onProgress?.({ status: 'loading', percent: 5, message: 'Loading clause classifier (CPU)…' });
			const pipe = await pipeline('text-classification', LEGAL_CLASSIFIER_MODEL_ID, {
				dtype: 'fp32',
				device: 'wasm',
				revision: 'v1',
				progress_callback: makeProgressCallback('wasm')
			});
			_pipe = pipe;
			onProgress?.({ status: 'ready', percent: 100, message: 'Clause classifier ready ✓' });
			return pipe;
		} catch (err) {
			// CORS error: the model bucket is blocking the cross-origin request.
			// Surface a clear, actionable error pointing at MODELS.md → CORS
			// instead of the generic "failed to load" message.
			if (looksLikeCorsError(err)) {
				const corsMsg = corsErrorMessage();
				onProgress?.({ status: 'error', percent: 0, message: 'CORS error — see MODELS.md' });
				throw new Error(corsMsg);
			}
			const msg = err instanceof Error ? err.message : String(err);
			onProgress?.({ status: 'error', percent: 0, message: `Failed to load classifier: ${msg}` });
			throw new Error(`Legal classifier failed to load: ${msg}`);
		}
	})();

	try {
		return await _loadingPromise;
	} finally {
		// Clear the in-flight handle. On success _pipe is set (cached); on failure
		// the next call retries cleanly.
		_loadingPromise = null;
	}
}

/**
 * Classify a single clause of contract text.
 *
 * Lazily loads the model on first use (then reuses the cached pipeline). Returns
 * the single top label with its prettified display name, raw label, confidence,
 * risk level, and plain-English description.
 *
 * @param text  The clause text to classify. Empty/whitespace input throws.
 * @throws if `text` is empty or the model fails to load.
 */
export async function classifyClause(text: string): Promise<ClauseClassification> {
	const clause = text?.trim();
	if (!clause) {
		throw new Error('classifyClause: text must be a non-empty string.');
	}

	const pipe = await loadLegalClassifier();

	// top_k: 1 → single best label. Output shape: [{ label, score }].
	const output = (await pipe(clause, { top_k: 1 })) as
		| Array<{ label: string; score: number }>
		| { label: string; score: number };

	const top = Array.isArray(output) ? output[0] : output;
	if (!top || typeof top.label !== 'string') {
		throw new Error('classifyClause: unexpected model output shape.');
	}

	// STEP 1: translate the model's placeholder "LABEL_<n>" output to the real
	// clause name via ID2LABEL. The model's config.json never had real id2label
	// names, so without this every clause stayed "label_N" → defaulted to 'low'
	// → broke risk totals, missing-clause detection, and obligation matching.
	const resolved = resolveModelLabel(top.label);

	// STEP 2: normalize to snake_case so the rawLabel we expose ALWAYS matches
	// the CLAUSE_INFO keys + downstream sets (OBLIGATION_LABELS, STANDARD_CLAUSES).
	const rawLabel = normalizeLabel(resolved);
	const meta = metaFor(rawLabel);

	// Diagnostic: surface the model's raw label, the resolved real name, and the
	// resolved risk so any label mapping drift is immediately visible.
	console.debug(
		`[legal-classifier] "${top.label}" → ${rawLabel} (risk=${meta.risk}, score=${top.score.toFixed(2)})`
	);


	return {
		label: prettifyLabel(rawLabel),
		rawLabel,
		score: top.score,
		risk: meta.risk,
		description: meta.description
	};
}


/**
 * Whether the classifier pipeline is already loaded (cached in memory).
 * Useful for UI to decide between "Analyze" and "Loading model…".
 */
export function isLegalClassifierLoaded(): boolean {
	return _pipe !== null;
}

// ============================================================
// WebGPU detection (local copy — keeps this module self-contained)
// ============================================================

async function isWebGPUAvailable(): Promise<boolean> {
	try {
		if (!('gpu' in navigator)) return false;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const adapter = await (navigator as any).gpu.requestAdapter();
		return adapter !== null;
	} catch {
		return false;
	}
}
