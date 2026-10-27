/**
 * src/lib/llm/worker-client.ts — Main-thread client for the LLM Web Worker
 *
 * Singleton: one worker instance shared across all calls.
 * The worker persists for the lifetime of the page — model stays loaded
 * in worker memory between requests (no reload cost on second question).
 *
 * Usage:
 *   const client = getLLMWorkerClient();
 *   await client.load('default', true, onProgress);
 *   const text = await client.infer(prompt, 256, onToken, onProgress);
 */

import { newId } from '$lib/utils/id.js';

export interface WorkerProgress {
	percent: number;
	message: string;
	device: string;
}

export interface WorkerInferResult {
	text: string;
	durationMs: number;
	error: string | null;
}

type ProgressCallback = (progress: WorkerProgress) => void;
type TokenCallback = (token: string) => void;

// ============================================================
// Pending request tracking
// ============================================================

interface PendingInfer {
	resolve: (result: WorkerInferResult) => void;
	reject: (err: Error) => void;
	onToken?: TokenCallback;
	accumulated: string;
}

interface PendingLoad {
	resolve: () => void;
	reject: (err: Error) => void;
	onProgress?: ProgressCallback;
}

// ============================================================
// Worker client class
// ============================================================

class LLMWorkerClient {
	private worker: Worker | null = null;
	private pendingInfer: Map<string, PendingInfer> = new Map();
	private pendingLoad: PendingLoad | null = null;
	private loadedModelKey = '';
	private isLoaded = false;

	private getWorker(): Worker {
		if (!this.worker) {
			// Vite ?worker suffix creates a module worker bundled separately
			this.worker = new Worker(
				new URL('./worker.ts', import.meta.url),
				{ type: 'module' }
			);
			this.worker.onmessage = this.handleMessage.bind(this);
			this.worker.onerror = this.handleError.bind(this);
		}
		return this.worker;
	}

	private handleMessage(event: MessageEvent): void {
		const msg = event.data;

		switch (msg.type) {
			case 'progress':
				this.pendingLoad?.onProgress?.({
					percent: msg.percent,
					message: msg.message,
					device: msg.device
				});
				break;

			case 'ready':
				this.isLoaded = true;
				if (this.pendingLoad) {
					this.pendingLoad.resolve();
					this.pendingLoad = null;
				}
				break;

			case 'token': {
				const pending = this.pendingInfer.get(msg.id);
				if (pending) {
					pending.accumulated += msg.token;
					pending.onToken?.(msg.token);
				}
				break;
			}

			case 'done': {
				const pending = this.pendingInfer.get(msg.id);
				if (pending) {
					this.pendingInfer.delete(msg.id);
					// Prefer worker's finalText; fall back to client-side accumulated tokens
					const text = (msg.text && msg.text.trim())
						? msg.text.trim()
						: pending.accumulated.trim();
					pending.resolve({
						text,
						durationMs: msg.durationMs ?? 0,
						error: null
					});
				}
				break;
			}

			case 'error': {
				const id = msg.id ?? '';
				if (id && this.pendingInfer.has(id)) {
					const pending = this.pendingInfer.get(id)!;
					this.pendingInfer.delete(id);
					pending.resolve({ text: '', durationMs: 0, error: msg.message });
				} else if (this.pendingLoad) {
					this.pendingLoad.reject(new Error(msg.message));
					this.pendingLoad = null;
				}
				break;
			}
		}
	}

	private handleError(event: ErrorEvent): void {
		const errMsg = event.message ?? 'Worker error';
		console.error('[worker-client] Worker error:', errMsg);

		// Reject all pending
		if (this.pendingLoad) {
			this.pendingLoad.reject(new Error(errMsg));
			this.pendingLoad = null;
		}
		for (const [id, pending] of this.pendingInfer) {
			pending.resolve({ text: '', durationMs: 0, error: errMsg });
			this.pendingInfer.delete(id);
		}

		// Recreate worker on next call
		this.worker = null;
		this.isLoaded = false;
		this.loadedModelKey = '';
	}

	/**
	 * Load the model in the worker. No-op if already loaded with same key.
	 */
	async load(
		modelKey: string,
		useWebGPU: boolean,
		onProgress?: ProgressCallback
	): Promise<void> {
		const worker = this.getWorker();

		// Already loaded — just report ready
		if (this.isLoaded && this.loadedModelKey === modelKey) {
			onProgress?.({ percent: 100, message: 'Model ready ✓', device: 'cached' });
			return;
		}

		return new Promise<void>((resolve, reject) => {
			this.pendingLoad = { resolve, reject, onProgress };
			this.loadedModelKey = modelKey;
			worker.postMessage({ type: 'load', modelId: modelKey, useWebGPU });
		});
	}

	/**
	 * Run inference in the worker. Streams tokens via onToken callback.
	 * Returns the full text when done.
	 */
	async infer(
		prompt: string,
		maxNewTokens: number,
		onToken?: TokenCallback,
		onProgress?: ProgressCallback
	): Promise<WorkerInferResult> {
		const worker = this.getWorker();
		const id = newId('infer');

		onProgress?.({ percent: 75, message: 'Thinking…', device: '' });

		return new Promise<WorkerInferResult>((resolve, reject) => {
			this.pendingInfer.set(id, { resolve, reject, onToken, accumulated: '' });
			worker.postMessage({ type: 'infer', prompt, maxNewTokens, id });
		});
	}

	/**
	 * Terminate the worker and reset state.
	 * Call this if you need to free GPU/WASM memory.
	 */
	terminate(): void {
		this.worker?.terminate();
		this.worker = null;
		this.isLoaded = false;
		this.loadedModelKey = '';
		this.pendingInfer.clear();
		this.pendingLoad = null;
	}
}

// ============================================================
// Singleton
// ============================================================

let _client: LLMWorkerClient | null = null;

export function getLLMWorkerClient(): LLMWorkerClient {
	if (!_client) {
		_client = new LLMWorkerClient();
	}
	return _client;
}
