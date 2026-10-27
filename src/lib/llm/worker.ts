/**
 * src/lib/llm/worker.ts — Web Worker for LLM inference
 *
 * Runs in a dedicated thread so the main thread never blocks.
 * The browser's "page unresponsive" dialog fires when the main thread
 * is blocked for >5s — moving inference here eliminates that entirely.
 *
 * Message protocol (main → worker):
 *   { type: 'load',    modelId: string, useWebGPU: boolean }
 *   { type: 'infer',   prompt: string, maxNewTokens: number, id: string }
 *   { type: 'cancel' }
 *
 * Message protocol (worker → main):
 *   { type: 'progress', percent: number, message: string, device: string }
 *   { type: 'token',    token: string, id: string }
 *   { type: 'done',     text: string, durationMs: number, id: string }
 *   { type: 'error',    message: string, id: string }
 *   { type: 'ready',    device: string }
 */

// Workers run in a module context — standard ES imports work fine.
// Vite bundles this as a separate chunk via ?worker import.

import { pipeline, TextStreamer, env } from '@huggingface/transformers';

// ============================================================
// Model ID mapping (mirrors inference.ts)
// ============================================================

const MODEL_IDS: Record<string, string> = {
	default:  'HuggingFaceTB/SmolLM2-1.7B-Instruct',
	standard: 'HuggingFaceTB/SmolLM3-3B-ONNX',
	expert:   'onnx-community/Olmo-3-7B-Instruct-ONNX'
};

/**
 * Models that use chain-of-thought reasoning and support /no_think to disable it.
 * Prepending a system message with "/no_think" tells these models to skip the
 * <think>...</think> block and respond directly — same quality, no reasoning overhead.
 * Reference: https://huggingface.co/HuggingFaceTB/SmolLM3-3B
 */
const REASONING_MODEL_IDS = new Set([
	'HuggingFaceTB/SmolLM3-3B-ONNX'
]);

// ============================================================
// State
// ============================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pipe: any = null;
let loadedModelId = '';
let loadedDevice = '';

env.allowRemoteModels = true;
env.allowLocalModels = false;

// ============================================================
// WebGPU detection (workers have navigator.gpu in Chrome/Edge)
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

// ============================================================
// Load model
// ============================================================

async function loadModel(modelKey: string, useWebGPU: boolean): Promise<void> {
	const modelId = MODEL_IDS[modelKey] ?? MODEL_IDS.default;

	// Already loaded the right model
	if (pipe && loadedModelId === modelId) {
		self.postMessage({ type: 'ready', device: loadedDevice });
		return;
	}

	const gpuAvailable = useWebGPU && await isWebGPUAvailable();
	const isCOI = typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated;
	const tryWebGPU = gpuAvailable && isCOI;

	// Workers don't have sessionStorage — use a local flag instead
	let webgpuFailed = false;

	const fileProgress: Record<string, number> = {};

	 
	function makeProgressCallback(device: string) {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		return (progress: any) => {
			if (progress.status === 'progress' || progress.status === 'downloading') {
				const file = progress.file ?? 'unknown';
				const pct = progress.progress != null
					? Math.round(progress.progress)
					: progress.loaded != null && progress.total != null && progress.total > 0
						? Math.round((progress.loaded / progress.total) * 100)
						: 0;
				fileProgress[file] = pct;
				const values = Object.values(fileProgress);
				const avg = values.length > 0
					? Math.round(values.reduce((a: number, b: number) => a + b, 0) / values.length)
					: pct;
				self.postMessage({
					type: 'progress',
					percent: avg,
					message: `Downloading model… ${avg}%`,
					device
				});
			} else if (progress.status === 'done') {
				const file = progress.file ?? 'unknown';
				fileProgress[file] = 100;
				const values = Object.values(fileProgress);
				const avg = values.length > 0
					? Math.round(values.reduce((a: number, b: number) => a + b, 0) / values.length)
					: 100;
				self.postMessage({
					type: 'progress',
					percent: avg,
					message: `Loading model… ${avg}%`,
					device
				});
			}
		};
	}

	if (tryWebGPU && !webgpuFailed) {
		try {
			self.postMessage({ type: 'progress', percent: 5, message: 'Loading model (WebGPU fp16)…', device: 'webgpu' });
			pipe = await pipeline('text-generation', modelId, {
				dtype: 'fp16',
				device: 'webgpu',
				progress_callback: makeProgressCallback('webgpu')
			});

			// Sanity check
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const testResult: any = await pipe(
				[{ role: 'user', content: 'Say "ok".' }],
				{ max_new_tokens: 4, do_sample: false, return_full_text: false }
			);
			const testText = extractText(testResult);
			const nonLetterRatio = testText.replace(/[a-zA-Z\s]/g, '').length / Math.max(testText.length, 1);

			if (testText.length === 0 || nonLetterRatio > 0.5) {
				console.warn('[worker] WebGPU sanity check FAILED — falling back to WASM');
				pipe = null;
				webgpuFailed = true;
			} else {
			loadedModelId = modelId;
				loadedDevice = 'webgpu';
				console.log('[worker] chat_template (webgpu):', pipe.tokenizer.chat_template);
				self.postMessage({ type: 'ready', device: 'webgpu' });
				return;
			}
		} catch (err) {
			console.warn('[worker] WebGPU load failed:', err);
			pipe = null;
			webgpuFailed = true;
		}
	}

	// WASM fallback
	self.postMessage({ type: 'progress', percent: 5, message: 'Loading model (CPU mode)…', device: 'wasm' });
	try {
		pipe = await pipeline('text-generation', modelId, {
			dtype: 'q4',
			device: 'wasm',
			progress_callback: makeProgressCallback('wasm')
		});
		loadedModelId = modelId;
		loadedDevice = 'wasm';
		console.log('[worker] chat_template (wasm):', pipe.tokenizer.chat_template);
		self.postMessage({ type: 'ready', device: 'wasm' });
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		self.postMessage({ type: 'error', message: `Model load failed: ${msg}`, id: '' });
	}
}

// ============================================================
// Prompt builder for reasoning models (pre-fill trick)
// ============================================================

/**
 * Build a raw prompt string for SmolLM3 and other reasoning models that use
 * the ChatML token format (<|im_start|> / <|im_end|>).
 *
 * WHY: The SmolLM3-3B-ONNX export's tokenizer_config.json does not include
 * the updated chat template that handles /no_think or enable_thinking. Every
 * approach that relies on the template (system message, enable_thinking option)
 * is silently ignored — the model always receives a bare assistant turn and
 * starts thinking.
 *
 * FIX: Bypass the chat template entirely. Construct the exact token sequence
 * manually and pre-fill a closed <think></think> block. The model sees that
 * thinking is "already done" and proceeds directly to the response.
 *
 * The critical part is the last 3 lines:
 *   <|im_start|>assistant
 *   <think>
 *
 *   </think>
 *
 * This pre-fills an empty, already-closed thinking block. The model continues
 * from the line after </think> directly into the actual response.
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
// Run inference with streaming
// ============================================================

async function runInference(prompt: string, maxNewTokens: number, id: string): Promise<void> {
	if (!pipe) {
		self.postMessage({ type: 'error', message: 'Model not loaded', id });
		return;
	}

	const t0 = performance.now();
	let streamedText = '';

	try {
		const streamer = new TextStreamer(pipe.tokenizer, {
			skip_prompt: true,
			skip_special_tokens: true,  // suppress <|im_end|> etc. from raw-prompt path
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			callback_function: (token: any) => {
				const tokenStr = typeof token === 'string' ? token : String(token);
				streamedText += tokenStr;
				self.postMessage({ type: 'token', token: tokenStr, id });
			}
		});

		// Reasoning models (SmolLM3, etc.): bypass the chat template entirely.
		// The ONNX export's tokenizer_config.json lacks the updated template that
		// handles /no_think, so system messages and enable_thinking are ignored.
		// Instead, construct the raw ChatML prompt manually and pre-fill a closed
		// <think></think> block — the model sees thinking as "done" and responds directly.
		// Non-reasoning models use the standard messages array (template handles formatting).
		const isReasoningModel = REASONING_MODEL_IDS.has(loadedModelId);
		const input = isReasoningModel
			? buildReasoningModelPrompt(prompt)   // raw string, bypasses template
			: [{ role: 'user', content: prompt }]; // messages array, uses template
		console.log('[worker] isReasoningModel:', isReasoningModel, '| input type:', typeof input);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const pipeResult: any = await pipe(input, {
			max_new_tokens: maxNewTokens,
			// Greedy decoding (do_sample: false) gives precise, deterministic answers
			// for data analysis questions. repetition_penalty prevents loops without
			// introducing the hallucination risk that temperature sampling causes.
			do_sample: false,
			repetition_penalty: 1.3,
			return_full_text: false,
			streamer
		});

		// Primary: use streamed text. Fallback: extract from pipeline return value.
		let finalText = streamedText.trim();
		if (!finalText) {
			finalText = extractText(pipeResult).trim();
			// If we got text from the pipeline but not from streaming, send it as tokens now
			if (finalText) {
				self.postMessage({ type: 'token', token: finalText, id });
			}
		}

		// Post-process: detect and truncate repetition loops
		finalText = truncateRepetition(finalText);

		const durationMs = Math.round(performance.now() - t0);
		self.postMessage({ type: 'done', text: finalText, durationMs, id });
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		self.postMessage({ type: 'error', message: msg, id });
	}
}

// ============================================================
// Repetition loop detection
// ============================================================

/**
 * Detect and truncate repetition loops and gibberish in LLM output.
 *
 * Handles:
 * 1. Phrase repetition: "tree service companies that have tree service companies..."
 * 2. All-caps gibberish: "COMPUTATIONALIZEDEDURATION THEY ARE NOT THERE"
 * 3. Single-char repetition: "YY YY YY YY YY"
 * 4. High non-ASCII / symbol density
 */
function truncateRepetition(text: string): string {
	if (text.length < 20) return text;

	// Split into sentences for sentence-level analysis
	const sentences = text.split(/(?<=[.!?])\s+/);

	// 1. Detect all-caps gibberish: a sentence that is >60% uppercase letters
	//    (normal text is ~10-20% uppercase)
	for (let i = 0; i < sentences.length; i++) {
		const s = sentences[i];
		if (s.length < 10) continue;
		const letters = s.replace(/[^a-zA-Z]/g, '');
		if (letters.length === 0) continue;
		const upperRatio = (s.replace(/[^A-Z]/g, '').length) / letters.length;
		if (upperRatio > 0.6) {
			// Truncate before this sentence
			const truncated = sentences.slice(0, i).join(' ').trim();
			return truncated || text.slice(0, 100);
		}
	}

	// 2. Detect single-char or short-token repetition: "YY YY YY" or "YEAR YEAR YEAR"
	//    Look for any word that repeats 4+ times in a row
	const wordRepeat = text.match(/\b(\w{1,8})\b(?:\s+\1){3,}/i);
	if (wordRepeat) {
		const idx = text.indexOf(wordRepeat[0]);
		return text.slice(0, idx).trim() || text.slice(0, 100);
	}

	// 3. Phrase repetition: find any phrase (8-30 chars) that appears twice consecutively
	for (let phraseLen = 30; phraseLen >= 8; phraseLen--) {
		for (let i = 0; i < text.length - phraseLen * 2; i++) {
			const phrase = text.slice(i, i + phraseLen);
			if (phrase.trim().length < phraseLen * 0.5) continue;
			const next = text.slice(i + phraseLen, i + phraseLen * 2);
			if (next === phrase) {
				return text.slice(0, i + phraseLen).trim();
			}
		}
	}

	// 4. High symbol/non-word density in last 100 chars — model is degrading
	if (text.length > 100) {
		const tail = text.slice(-100);
		const nonWord = tail.replace(/[\w\s.,!?'-]/g, '').length;
		if (nonWord / tail.length > 0.3) {
			// Find the last clean sentence boundary before the garbage
			const lastClean = text.slice(0, -100).lastIndexOf('.');
			if (lastClean > 20) return text.slice(0, lastClean + 1).trim();
		}
	}

	return text;
}

// ============================================================
// Text extraction helper
// ============================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractText(result: any): string {
	if (!Array.isArray(result) || result.length === 0) return '';
	const first = result[0];
	if (Array.isArray(first?.generated_text)) {
		const msgs = first.generated_text as Array<{ role: string; content: string }>;
		const asst = [...msgs].reverse().find((m: { role: string }) => m.role === 'assistant');
		return asst?.content ?? msgs[msgs.length - 1]?.content ?? '';
	}
	return typeof first?.generated_text === 'string' ? first.generated_text : '';
}

// ============================================================
// Message handler
// ============================================================

self.onmessage = async (event: MessageEvent) => {
	const msg = event.data;

	switch (msg.type) {
		case 'load':
			await loadModel(msg.modelId ?? 'default', msg.useWebGPU ?? true);
			break;

		case 'infer':
			await runInference(msg.prompt, msg.maxNewTokens ?? 256, msg.id ?? '');
			break;

		default:
			console.warn('[worker] Unknown message type:', msg.type);
	}
};
