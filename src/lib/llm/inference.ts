/**
 * src/lib/llm/inference.ts — Transformers.js v4 client-side LLM inference
 *
 * Architecture:
 * - Uses @huggingface/transformers v4 pipeline API (text-generation)
 * - WebGPU acceleration (Chrome/Edge) with WASM CPU fallback (Firefox/Safari)
 * - Model files fetched from first-party R2 mirror (cached in browser Cache API)
 * - WebGPU: dtype 'q4f16' (4-bit weights, fp16 activations — correct for GPU)
 * - WASM:   dtype 'q4'    (4-bit quantized — works on CPU in all browsers)
 * - v4 automatically fetches the correct WASM from /static/ per browser:
 *     Safari  → ort-wasm-simd-threaded.mjs + .wasm (regular, non-JSEP)
 *     Firefox → ort-wasm-simd-threaded.asyncify.mjs (regular, non-JSEP)
 *     Chrome  → ort-wasm-simd-threaded.jsep.mjs (JSEP, WebGPU-capable)
 *
 * Model lineup (paths aligned with R2 layout from scripts/r2-uploads/manifests/):
 * - default  (free): SmolLM2-1.7B-Instruct  — ~900MB,  WebGPU q4f16 / WASM q4
 * - standard (free): SmolLM3-3B             — ~1.8GB,  WebGPU q4f16 / WASM q4
 * - expert   (pro):  OLMo-3-7B-Instruct     — ~4.5GB,  WebGPU q4f16 only (needs discrete GPU)
 */

import type { ModelConfig } from '$lib/stores/workspace.svelte.js';

// ============================================================
// Types
// ============================================================

export interface ModelLoadProgress {
	status: 'loading' | 'ready' | 'error';
	percent: number;       // 0–100
	message: string;
	device: 'webgpu' | 'wasm';
}

export interface InferenceResult {
	text: string;
	durationMs: number;
	error: string | null;
}

// Transformers.js pipeline type (loosely typed to avoid deep imports)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type LLMPipeline = any;

// ============================================================
// CORS-aware error handling
// ============================================================

/**
 * Match the typical browser error messages for cross-origin request failures.
 * Different browsers report CORS errors differently — we match the common
 * substrings so a single regex covers Chrome, Firefox, and Safari.
 */
const CORS_ERROR_PATTERNS = [
	/access-control-allow-origin/i,
	/cors policy/i,
	/cross-origin request blocked/i,
	/no 'access-control-allow-origin'/i,
	/failed to fetch/i,
	/networkerror when attempting/i,
	/load failed/i
];

/** True if the error message looks like a browser-level CORS / cross-origin block. */
function looksLikeCorsError(err: unknown): boolean {
	const msg = err instanceof Error ? err.message : String(err);
	return CORS_ERROR_PATTERNS.some((re) => re.test(msg));
}

/**
 * User-facing message for a CORS error. Surfaces the app origin so the user
 * can plug it into the bucket CORS config without having to dig for it.
 */
function corsErrorMessage(): string {
	const origin = typeof window !== 'undefined' ? window.location.origin : 'this app';
	return (
		`Model load failed: the model bucket blocked a cross-origin request from ${origin}. ` +
		`The bucket must send CORS headers (Access-Control-Allow-Origin: ${origin}) ` +
		`for model files to load. See MODELS.md → "CORS" for the exact bucket config.`
	);
}

// ============================================================
// Reasoning model detection + prompt builder (pre-fill trick)
// ============================================================

/**
 * Models whose ONNX tokenizer_config.json lacks the updated chat template
 * that handles /no_think. For these models we bypass the template entirely
 * and construct the raw ChatML prompt manually.
 */
const REASONING_MODEL_IDS = new Set([
	'smollm3-3b'
]);

/**
 * Build a raw ChatML prompt for reasoning models, pre-filling a closed
 * <think></think> block so the model skips chain-of-thought entirely.
 *
 * WHY: The ONNX export's tokenizer doesn't have the /no_think chat template.
 * Every approach that relies on the template (system message, enable_thinking)
 * is silently ignored. Pre-filling an empty think block is the only reliable fix.
 */
function buildReasoningModelPrompt(userPrompt: string): string {
	const today = new Date().toLocaleDateString('en-GB', {
		day: '2-digit', month: 'long', year: 'numeric'
	});
	return [
		'<|im_start|>system',
		'## Metadata',
		'',
		'Knowledge Cutoff Date: June 2025',
		`Today Date: ${today}`,
		'Reasoning Mode: /no_think',
		'',
		'## Custom Instructions',
		'',
		'You are a helpful AI assistant named SmolLM, trained by Hugging Face.',
		'<|im_end|>',
		'<|im_start|>user',
		userPrompt,
		'<|im_end|>',
		'<|im_start|>assistant',
		'<think>',
		'',
		'</think>',
		''
	].join('\n');
}

// ============================================================
// Model ID mapping — aligned with R2 layout in scripts/r2-uploads/manifests/
// ============================================================

/**
 * Model identifiers are the R2 keys (simplified stems), NOT full Hugging Face
 * repo paths. transformers.js substitutes {model} from remotePathTemplate and
 * appends the filename itself, so the full URL pattern produced at runtime is:
 *   https://ai.cesvu.com/{model}/v1/<file>
 * e.g. https://ai.cesvu.com/smollm3-3b/v1/config.json
 *
 * v1 is hardcoded in the template (not from a revision option) because
 * transformers.js defaults to 'main' for non-HF custom hosts and ignores
 * pipeline({ revision: 'v1' }) when downloading from a non-HF remoteHost.
 * The R2 layout (smollm3-3b-v1.json etc.) uses v1; if we ever upload a v2
 * we'll need to update this template and the model ids together.
 */
const MODEL_IDS: Record<string, string> = {
	// Free tier — SmolLM2 1.7B (q4f16 ~900MB WebGPU, q4 ~900MB WASM)
	// Original model: HuggingFaceTB/SmolLM2-1.7B-Instruct
	default:  'smollm2-1.7b-instruct',
	// Free tier — SmolLM3 3B (q4f16 ~1.8GB WebGPU, q4 ~1.8GB WASM)
	// Original model: HuggingFaceTB/SmolLM3-3B-ONNX
	standard: 'smollm3-3b',
	// Pro tier — OLMo-3 7B (q4f16 ~4.5GB WebGPU, requires discrete GPU)
	// Original model: onnx-community/Olmo-3-7B-Instruct-ONNX
	expert:   'olmo-3-7b-instruct'
};

// ============================================================
// WebGPU detection
// ============================================================

export async function isWebGPUAvailable(): Promise<boolean> {
	try {
		if (!('gpu' in navigator)) return false;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const adapter = await (navigator as any).gpu.requestAdapter();
		return adapter !== null;
	} catch {
		return false;
	}
}

// ============================================================
// Pipeline cache — one session per model ID, reused across calls
// ============================================================

interface CachedPipeline {
	pipe: LLMPipeline;
	modelId: string;
}

let _pipelineCache: CachedPipeline | null = null;

// Tracks the modelConfig.id ('default' | 'standard' | 'expert') of the loaded pipeline.
// Used by runInference() to decide whether to use the pre-fill prompt trick.
// We can't introspect pipe.model.config.name_or_path in this version of Transformers.js —
// it's always undefined. Tracking at load time is the reliable alternative.
let _currentModelType: string | null = null;

/**
 * Return the cached pipeline if it matches the requested model ID.
 * Prevents creating a second ONNX session (which causes bad_alloc on WebGPU).
 */
function getCachedPipeline(modelId: string): LLMPipeline | null {
	if (_pipelineCache && _pipelineCache.modelId === modelId) {
		return _pipelineCache.pipe;
	}
	return null;
}

/**
 * Synchronously return the currently-loaded pipeline (any model) or null.
 *
 * Unlike loadModel(), this NEVER triggers a download or model load — it only
 * reports whether a pipeline is already resident in the session cache. Callers
 * that want to OPPORTUNISTICALLY use the LLM (e.g. contract party-name
 * refinement) use this so they degrade gracefully to deterministic output when
 * no model has been loaded yet, rather than forcing a ~900MB download.
 */
export function getLoadedPipe(): LLMPipeline | null {
	return _pipelineCache?.pipe ?? null;
}

async function setCachedPipeline(modelId: string, pipe: LLMPipeline): Promise<void> {

	// Dispose the old pipeline before storing the new one.
	// This releases the ONNX session and frees GPU/WASM memory so the new
	// session can be created without bad_alloc.
	if (_pipelineCache && _pipelineCache.modelId !== modelId) {
		try {
			console.log('[inference] Disposing old pipeline for', _pipelineCache.modelId);
			await _pipelineCache.pipe.dispose?.();
		} catch (e) {
			console.warn('[inference] dispose() failed (non-fatal):', e);
		}
		_pipelineCache = null;
	}
	_pipelineCache = { pipe, modelId };
}

// ============================================================
// loadModel
// ============================================================

/**
 * Load a Transformers.js v4 text-generation pipeline.
 *
 * Device strategy:
 * - WebGPU available + crossOriginIsolated → device: 'webgpu', dtype: 'q4f16' (fast)
 * - Otherwise → device: 'wasm', dtype: 'q8' (works in Firefox, Safari, Chrome without COI)
 *
 * WASM bundles are loaded from /static/ (first-party, SRI-covered). transformers.js
 * automatically picks the right variant per browser.
 *
 * @param modelConfig  The model to load (from workspace store)
 * @param onProgress   Called with progress updates (0–100%)
 * @returns            The loaded pipeline
 */
export async function loadModel(
	modelConfig: ModelConfig,
	onProgress?: (progress: ModelLoadProgress) => void
): Promise<LLMPipeline> {
	const modelId = MODEL_IDS[modelConfig.id] ?? MODEL_IDS.default;

	// Return cached pipeline immediately — avoids creating a second ONNX session
	// which causes bad_alloc on WebGPU (GPU memory is still held by the first session)
	const cached = getCachedPipeline(modelId);
	if (cached) {
		console.log('[inference] Returning cached pipeline for', modelId);
		onProgress?.({ status: 'ready', percent: 100, message: 'Model ready ✓', device: 'webgpu' });
		return cached;
	}

	// ONNX sessions hold native GPU/WASM memory that is NOT released by JS GC or dispose().
	// The only reliable way to free an ONNX session is to reload the page (fresh JS heap).
	// Strategy: store the target model ID in sessionStorage, reload, then load it fresh.
	if (_pipelineCache) {
		console.log('[inference] Model switch detected — reloading page to free ONNX session memory');
		console.log('[inference] Switching from', _pipelineCache.modelId, 'to', modelId);
		// Store target model so we load the right one after reload
		sessionStorage.setItem('cesvu_pending_model', modelConfig.id);
		// Clear the WebGPU-failed flag — it was set for the OLD model, not the new one.
		// Each model gets a fresh WebGPU attempt after a clean reload.
		sessionStorage.removeItem('cesvu_webgpu_failed');
		onProgress?.({
			status: 'loading',
			percent: 5,
			message: 'Switching model — reloading for clean memory…',
			device: 'webgpu'
		});
		await new Promise(r => setTimeout(r, 800));
		window.location.reload();
		// Never reached — reload happens above
		throw new Error('Reloading for model switch');
	}

	const gpuAvailable = await isWebGPUAvailable();
	const isCOI = typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated;

	// Device/dtype selection:
	// - All models: WebGPU q4f16 (4-bit weights, fp16 activations)
	// - expert (7B): WebGPU only — too large for WASM on most devices
	// - default/standard/advanced: fall back to WASM q4 if WebGPU fails
	const useWebGPU = gpuAvailable && isCOI;
	const webgpuDtype = 'q4f16'; // all models use q4f16 on WebGPU

	console.log(`[inference] v4 | model=${modelConfig.id}, gpuAvailable=${gpuAvailable}, crossOriginIsolated=${isCOI}, attempting=${useWebGPU ? 'webgpu/q4f16' : 'wasm/q4'}`);

	onProgress?.({
		status: 'loading',
		percent: 0,
		message: useWebGPU ? 'Initializing WebGPU…' : 'Loading model (CPU mode)…',
		device: useWebGPU ? 'webgpu' : 'wasm'
	});

	// Dynamic import to avoid bundling the full library at startup
	const { pipeline, env } = await import('@huggingface/transformers');

	// Allow remote model downloads from our first-party R2 mirror.
	// All weights live at https://ai.cesvu.com/<model-stem>/v1/<file>.
	// transformers.js substitutes {model} from the template below; the filename is
	// appended separately. v1 is hardcoded in the template to match the R2
	// manifest version naming convention (smollm3-3b-v1.json etc.).
	env.allowRemoteModels = true;
	env.allowLocalModels = false;
	env.remoteHost = 'https://ai.cesvu.com';
	// '{model}/v1' resolves e.g. smollm3-3b / v1 → the file is appended
	// automatically by transformers.js, yielding
	// https://ai.cesvu.com/smollm3-3b/v1/<file>.
	env.remotePathTemplate = '{model}/v1';

	// ONNX Runtime WASM blobs (all 4 variants) are bundled in /static/ —
	// first-party, SRI-covered, no runtime CDN fetch. The browser picks:
	//   Chrome  → ort-wasm-simd-threaded.jsep.mjs/.wasm    (WebGPU-capable)
	//   Safari  → ort-wasm-simd-threaded.mjs/.wasm          (regular, non-JSEP)
	//   Firefox → ort-wasm-simd-threaded.asyncify.mjs/.wasm (regular, asyncify)
	// All served from the static root, so wasmPaths = '/' (empty base path).
	// transformers.js v4 types `env.backends.onnx.wasm` as readonly AND possibly
	// undefined, so we cast through `unknown` to perform the in-place mutation.
	// At runtime the object is always present; the readonly is just a type-level
	// signal that transformers.js doesn't expect direct consumer writes.
	(env.backends.onnx as unknown as { wasm: { wasmPaths?: string } }).wasm = {
		...env.backends.onnx.wasm,
		wasmPaths: '/'
	};

	// Track per-file progress to compute overall percentage
	const fileProgress: Record<string, number> = {};

	function makeProgressCallback(dev: 'webgpu' | 'wasm') {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		return (progress: any) => {
			if (progress.status === 'initiate') {
				fileProgress[progress.file ?? 'unknown'] = 0;
				onProgress?.({
					status: 'loading',
					percent: 0,
					message: `Loading ${progress.file ?? 'model files'}…`,
					device: dev
				});
			} else if (progress.status === 'progress' || progress.status === 'downloading') {
				const file = progress.file ?? 'unknown';
				const pct = progress.progress != null
					? Math.round(progress.progress)
					: progress.loaded != null && progress.total != null && progress.total > 0
						? Math.round((progress.loaded / progress.total) * 100)
						: 0;
				fileProgress[file] = pct;
				const values = Object.values(fileProgress);
				const avg = values.length > 0
					? Math.round(values.reduce((a, b) => a + b, 0) / values.length)
					: pct;
				onProgress?.({
					status: 'loading',
					percent: avg,
					message: `Downloading model… ${avg}%`,
					device: dev
				});
			} else if (progress.status === 'done') {
				const file = progress.file ?? 'unknown';
				fileProgress[file] = 100;
				const values = Object.values(fileProgress);
				const avg = values.length > 0
					? Math.round(values.reduce((a, b) => a + b, 0) / values.length)
					: 100;
				onProgress?.({
					status: 'loading',
					percent: avg,
					message: `Model files loaded… ${avg}%`,
					device: dev
				});
			} else if (progress.status === 'ready') {
				onProgress?.({
					status: 'ready',
					percent: 100,
					message: 'Model ready ✓',
					device: dev
				});
			}
		};
	}

	// Attempt WebGPU first, fall back to WASM on any error.
	// IMPORTANT: If WebGPU fails or produces garbage, we must reload the page
	// before loading WASM — the failed WebGPU session holds GPU/WASM memory
	// that causes bad_alloc when loading a second model in the same tab.
	// Strategy: store WebGPU failure in sessionStorage, reload, then load WASM.
	//
	// dtype: 'fp16' — full fp16 precision, no quantization dequantization shaders.
	// Intel Arc 140V driver 32.0.101.8508 has broken q4f16 dequant shaders but fp16 works.
	// fp16 model is ~3GB download but runs correctly on WebGPU.
	const WEBGPU_FAILED_KEY = 'cesvu_webgpu_failed';
	const webgpuPreviouslyFailed = sessionStorage.getItem(WEBGPU_FAILED_KEY) === '1';

	if (useWebGPU && !webgpuPreviouslyFailed) {
		try {
			onProgress?.({
				status: 'loading',
				percent: 5,
				message: `Loading model (WebGPU q4f16)…`,
				device: 'webgpu'
			});
			const gpuPipe = await pipeline('text-generation', modelId, {
				dtype: webgpuDtype,
				device: 'webgpu',
				progress_callback: makeProgressCallback('webgpu')
			});
			console.log(`[inference] WebGPU ${webgpuDtype} session created, running sanity check…`);

			// Sanity check: run a tiny inference to detect degenerate output.
			// Some GPU drivers load the model fine but produce garbage tokens (all '!').
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const testResult: any = await gpuPipe(
				[{ role: 'user', content: 'Say the word "hello".' }],
				{ max_new_tokens: 8, do_sample: false, return_full_text: false }
			);
			const testText: string = (() => {
				if (!Array.isArray(testResult) || testResult.length === 0) return '';
				const first = testResult[0];
				if (Array.isArray(first?.generated_text)) {
					const msgs = first.generated_text as Array<{ role: string; content: string }>;
					const asst = [...msgs].reverse().find((m: { role: string }) => m.role === 'assistant');
					return asst?.content ?? msgs[msgs.length - 1]?.content ?? '';
				}
				return typeof first?.generated_text === 'string' ? first.generated_text : '';
			})();

			console.log('[inference] WebGPU sanity check output:', JSON.stringify(testText));

			// Degenerate output: >50% non-ASCII-letter characters → garbage
			const nonLetterRatio = (testText.replace(/[a-zA-Z\s]/g, '').length) / Math.max(testText.length, 1);
			if (testText.length === 0 || nonLetterRatio > 0.5) {
				console.warn('[inference] WebGPU sanity check FAILED — reloading to WASM on clean heap');
				try { await gpuPipe.dispose?.(); } catch { /* ignore */ }
				// Even after dispose(), the ONNX Runtime allocator may be in a bad state.
				// Reload to WASM on a clean heap to avoid bad_alloc on the WASM load.
				sessionStorage.setItem(WEBGPU_FAILED_KEY, '1');
				onProgress?.({
					status: 'loading',
					percent: 5,
					message: 'GPU output invalid — switching to CPU mode (reloading)…',
					device: 'wasm'
				});
				await new Promise(r => setTimeout(r, 1200));
				window.location.reload();
				throw new Error('Reloading for WASM fallback after sanity check failure');
			} else {
			console.log('[inference] WebGPU sanity check PASSED');
				await setCachedPipeline(modelId, gpuPipe);
				_currentModelType = modelConfig.id;
				onProgress?.({ status: 'ready', percent: 100, message: 'Ready (WebGPU)', device: 'webgpu' });
				return gpuPipe;
			}
		} catch (gpuErr) {
			const errMsg = gpuErr instanceof Error ? gpuErr.message : String(gpuErr);
			console.warn(`[inference] WebGPU ${webgpuDtype} failed: ${errMsg}`);

			// CORS error: the model bucket is blocking the cross-origin request.
			// Don't fall back to WASM (will fail with the same CORS error) and don't
			// trigger a page reload (CORS won't fix itself). Surface a clear,
			// actionable error pointing at MODELS.md → CORS.
			if (looksLikeCorsError(gpuErr)) {
				console.warn('[inference] CORS error detected — not falling back.');
				onProgress?.({ status: 'error', percent: 0, message: 'CORS error — see MODELS.md', device: 'webgpu' });
				throw new Error(corsErrorMessage());
			}

			// bad_alloc (ERROR_CODE: 6) during session creation means the ONNX Runtime
			// allocator is in a broken state — it cannot be recovered in the same JS heap.
			// Loading WASM in the same tab will also fail with bad_alloc.
			// Fix: mark WebGPU as failed, reload the page, and load WASM on a clean heap.
			if (errMsg.includes('bad_alloc') || errMsg.includes('ERROR_CODE: 6') || errMsg.includes('OrtRun')) {
				console.warn('[inference] bad_alloc detected — reloading to WASM on clean heap');
				sessionStorage.setItem(WEBGPU_FAILED_KEY, '1');
				onProgress?.({
					status: 'loading',
					percent: 5,
					message: 'GPU out of memory — switching to CPU mode (reloading)…',
					device: 'wasm'
				});
				await new Promise(r => setTimeout(r, 1200));
				window.location.reload();
				throw new Error('Reloading for WASM fallback after bad_alloc');
			}

			// Other WebGPU errors (unsupported op, driver crash, etc.) — these don't
			// corrupt the allocator, so in-process WASM fallback is safe.
			console.warn('[inference] Non-alloc WebGPU error — falling back to WASM q4 in-process');
		}
	}

	// WASM path — either WebGPU previously failed (clean reload) or GPU not available
	if (webgpuPreviouslyFailed) {
		console.log('[inference] WebGPU previously failed — using WASM q4 (clean session)');
	}

	// WASM path — try progressively smaller dtypes if bad_alloc occurs.
	// q4 (~700MB) → int8 (~900MB, sometimes more compatible) → uint8 (~900MB)
	// bad_alloc on WASM means the browser's WASM heap limit was hit.
	// This can happen on 32-bit processes, low-RAM devices, or when other tabs
	// are consuming memory. Smaller dtype = smaller allocation = more likely to succeed.
	const wasmDtypes = ['q4', 'int8', 'uint8'] as const;
	const wasmMsg = webgpuPreviouslyFailed
		? 'Loading CPU model (WebGPU not supported on this GPU)…'
		: 'Loading model (CPU/WASM mode)…';

	onProgress?.({ status: 'loading', percent: 5, message: wasmMsg, device: 'wasm' });

	let lastWasmErr = '';
	for (const dtype of wasmDtypes) {
		try {
			console.log(`[inference] WASM: trying dtype=${dtype}`);
			const pipe = await pipeline('text-generation', modelId, {
				dtype,
				device: 'wasm',
				progress_callback: makeProgressCallback('wasm')
			});
			console.log(`[inference] WASM ${dtype} session created successfully`);
			await setCachedPipeline(modelId, pipe);
			_currentModelType = modelConfig.id;
			onProgress?.({ status: 'ready', percent: 100, message: `Ready (CPU / ${dtype})`, device: 'wasm' });
			return pipe;
		} catch (wasmErr) {
			lastWasmErr = wasmErr instanceof Error ? wasmErr.message : String(wasmErr);
			console.warn(`[inference] WASM dtype=${dtype} failed: ${lastWasmErr}`);

			// CORS error: don't try other dtypes (will fail the same way) and don't
			// report "not enough memory" which is misleading. Surface a CORS-specific
			// error and bail out.
			if (looksLikeCorsError(wasmErr)) {
				console.warn('[inference] CORS error detected on WASM — bailing out.');
				onProgress?.({ status: 'error', percent: 0, message: 'CORS error — see MODELS.md', device: 'wasm' });
				throw new Error(corsErrorMessage());
			}

			if (!lastWasmErr.includes('bad_alloc') && !lastWasmErr.includes('ERROR_CODE: 6')) {
				// Non-memory error — no point trying smaller dtypes
				break;
			}
			// bad_alloc — try next smaller dtype
			onProgress?.({
				status: 'loading',
				percent: 5,
				message: `Not enough memory for ${dtype} — trying smaller quantization…`,
				device: 'wasm'
			});
		}
	}

	// All WASM dtypes exhausted — surface a clear, actionable error
	throw new Error(
		`Not enough memory to load the model. ` +
		`Try closing other browser tabs, restarting your browser, or using a device with more RAM. ` +
		`(${lastWasmErr})`
	);
}

// ============================================================
// runInference
// ============================================================

const INFERENCE_TIMEOUT_MS = 300_000; // 5 minutes

/**
 * Run text-generation inference on a loaded pipeline.
 * Uses chat message format for Instruct models.
 */
/**
 * Optional generation tuning. Defaults preserve the previous behavior
 * (greedy, no penalties) so the structured-JSON report path is unaffected.
 *
 * The conversational chat path opts into mild anti-repetition penalties:
 * small instruct models given a low-information prompt will otherwise loop
 * greedily (e.g. "the most recent update was on 05/01/2026" repeated forever).
 * These penalties are scoped to chat ONLY — the report path benefits from
 * deterministic greedy decoding and must NOT get them.
 */
export interface InferenceTuning {
	/** >1 discourages reusing tokens. ~1.2 is conservative. Omit = no penalty. */
	repetitionPenalty?: number;
	/** Forbids repeating any n-gram of this size. 4 is conservative; 3 is stronger. */
	noRepeatNgramSize?: number;
}

export async function runInference(
	pipe: LLMPipeline,
	prompt: string,
	maxNewTokens = 512,
	tuning: InferenceTuning = {}
): Promise<InferenceResult> {
	const t0 = performance.now();


	const timeoutPromise = new Promise<never>((_, reject) =>
		setTimeout(() => reject(new Error('Inference timed out after 5 minutes')), INFERENCE_TIMEOUT_MS)
	);

	try {
		// Reasoning models (SmolLM3, etc.): bypass the chat template entirely.
		// The ONNX export's tokenizer_config.json lacks the updated template that
		// handles /no_think, so system messages and enable_thinking are ignored.
		// Instead, construct the raw ChatML prompt manually and pre-fill a closed
		// <think></think> block — the model sees thinking as "done" and responds directly.
		//
		// NOTE: pipe.model.config.name_or_path is always undefined in this version of
		// Transformers.js. We track the model type at load time via _currentModelType instead.
		const isReasoningModel = _currentModelType === 'standard';
		const input = isReasoningModel
			? buildReasoningModelPrompt(prompt)    // raw string, bypasses template
			: [{ role: 'user', content: prompt }]; // messages array, uses template
		console.log('[inference] isReasoningModel:', isReasoningModel, '| modelType:', _currentModelType, '| input type:', typeof input);

		// Generation options. Greedy by default (best for structured JSON). The
		// conversational path opts into mild anti-repetition penalties via `tuning`
		// to break the small-model greedy loop (e.g. one sentence repeated forever).
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const genOptions: Record<string, any> = {
			max_new_tokens: maxNewTokens,
			do_sample: false,   // greedy decoding — most reliable for structured output
			return_full_text: false
		};
		if (tuning.repetitionPenalty != null) genOptions.repetition_penalty = tuning.repetitionPenalty;
		if (tuning.noRepeatNgramSize != null) genOptions.no_repeat_ngram_size = tuning.noRepeatNgramSize;

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const result: any = await Promise.race([
			pipe(input, genOptions),
			timeoutPromise
		]);


		const durationMs = Math.round(performance.now() - t0);

		// Log raw result for debugging
		console.log('[inference] raw result type:', typeof result);
		console.log('[inference] raw result (JSON):', JSON.stringify(result)?.slice(0, 500));

		// v4 returns: [{ generated_text: [{ role, content }] }] for chat models
		// or [{ generated_text: string }] for non-chat
		let text = '';
		if (Array.isArray(result) && result.length > 0) {
			const first = result[0];
			console.log('[inference] first item keys:', Object.keys(first ?? {}));
			console.log('[inference] generated_text type:', typeof first?.generated_text);
			if (Array.isArray(first?.generated_text)) {
				const msgs = first.generated_text as Array<{ role: string; content: string }>;
				console.log('[inference] chat messages:', JSON.stringify(msgs)?.slice(0, 300));
				const assistantMsg = [...msgs].reverse().find(m => m.role === 'assistant');
				text = assistantMsg?.content ?? msgs[msgs.length - 1]?.content ?? '';
			} else if (typeof first?.generated_text === 'string') {
				text = first.generated_text;
			} else if (typeof first === 'string') {
				text = first;
			}
		} else if (typeof result === 'string') {
			text = result;
		} else if (result?.generated_text) {
			text = typeof result.generated_text === 'string'
				? result.generated_text
				: JSON.stringify(result.generated_text);
		}

		console.log('[inference] extracted text (first 200):', text.slice(0, 200));
		return { text: text.trim(), durationMs, error: null };
	} catch (err) {
		const durationMs = Math.round(performance.now() - t0);
		return {
			text: '',
			durationMs,
			error: err instanceof Error ? err.message : String(err)
		};
	}
}

// ============================================================
// getCachedModel — check if model files are in Cache API
// ============================================================

export async function getCachedModel(modelId: string): Promise<boolean> {
	try {
		if (!('caches' in window)) return false;
		const cacheNames = await caches.keys();
		const transformersCaches = cacheNames.filter(
			(n) => n.includes('transformers') || n.includes('huggingface')
		);
		if (transformersCaches.length === 0) return false;

		const modelSlug = modelId.replace('/', '--').toLowerCase();
		for (const cacheName of transformersCaches) {
			const cache = await caches.open(cacheName);
			const keys = await cache.keys();
			const hasModel = keys.some((req) =>
				req.url.toLowerCase().includes(modelSlug) ||
				req.url.toLowerCase().includes(modelId.toLowerCase())
			);
			if (hasModel) return true;
		}
		return false;
	} catch {
		return false;
	}
}
