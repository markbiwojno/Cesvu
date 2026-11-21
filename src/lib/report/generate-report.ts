/**
 * src/lib/report/generate-report.ts — main-thread helper that spawns
 * report-worker.ts, sends it a build request, and resolves with the
 * finished PDF bytes. Mirrors parseExcelInWorker()'s protocol shape in
 * excel.ts.
 */

import { newId } from '$lib/utils/id.js';
import type {
	ReportBuildRequest,
	ReportProgress,
	ColumnVisualBuildRequest,
	CellCommentaryBuildRequest
} from './report-worker.js';
export type { ReportProgress } from './report-worker.js';
export type { ColumnVisualBuildRequest, CellCommentaryBuildRequest } from './report-worker.js';
export type { ColumnVisualInput, ReportTableSection } from './pdf-writer.js';

export interface GenerateReportResult {
	pdfBytes: Uint8Array;
	replacedCharacterCount: number;
	landscape: boolean;
	groupCount: number;
	warnings: string[];
	sha256Full: string;
}

export interface GenerateReportHandle {
	promise: Promise<GenerateReportResult>;
	/** Terminates the worker immediately; the promise never resolves/rejects after this. */
	cancel: () => void;
}

/**
 * Run a Summary Report build in a Web Worker. Returns immediately with a
 * `{ promise, cancel }` handle so the caller (the modal) can show live
 * progress via `onProgress` and let the user abort a long build on a big
 * sheet instead of being stuck looking at a spinner with no way out.
 *
 * `request.fileBytes` is copied (`slice(0)`) before being transferred — we
 * transfer the COPY, never the caller's own buffer, so the caller's
 * `workspace.file.rawContent` is never neutered by the transfer (req. #4's
 * "send rawContent.slice(0), never transfer the original buffer").
 */
export function generateReport(
	request: ReportBuildRequest,
	onProgress?: (progress: ReportProgress) => void
): GenerateReportHandle {
	let worker: Worker;
	try {
		worker = new Worker(new URL('./report-worker.ts', import.meta.url), { type: 'module' });
	} catch (err) {
		// Surface a spawn failure as a rejected promise instead of leaving the
		// caller's 'generating' UI hanging forever with no feedback.
		return {
			promise: Promise.reject(
				err instanceof Error ? err : new Error('Failed to start the report worker')
			),
			cancel: () => {}
		};
	}

	const id = newId('report');
	let cancelled = false;
	const cleanup = () => worker.terminate();

	const promise = new Promise<GenerateReportResult>((resolve, reject) => {
		worker.onmessage = (event: MessageEvent) => {
			const msg = event.data;
			if (!msg || msg.id !== id || cancelled) return;
			switch (msg.type) {
				case 'progress':
					onProgress?.({ stage: msg.stage, processed: msg.processed, total: msg.total });
					break;
				case 'done':
					cleanup();
					resolve({
						pdfBytes: msg.pdfBytes,
						replacedCharacterCount: msg.replacedCharacterCount,
						landscape: msg.landscape,
						groupCount: msg.groupCount,
						warnings: msg.warnings,
						sha256Full: msg.sha256Full
					});
					break;
				case 'error':
					cleanup();
					reject(new Error(msg.message ?? 'Report generation failed'));
					break;
			}
		};
		worker.onerror = (e) => {
			if (cancelled) return;
			cleanup();
			reject(new Error(e.message ?? 'Report worker crashed'));
		};

		// Copy the bytes (slice(0)) before transferring — the ORIGINAL
		// ArrayBuffer backing workspace.file.rawContent must stay usable by
		// the rest of the app (export, re-share, etc.) after this call.
		const copy = request.fileBytes.slice(0);
		worker.postMessage({ type: 'build', id, request: { ...request, fileBytes: copy } }, [copy]);
	});

	return {
		promise,
		cancel: () => {
			cancelled = true;
			cleanup();
		}
	};
}

export interface GenerateColumnVisualResult {
	pdfBytes: Uint8Array;
	replacedCharacterCount: number;
	sha256Full: string;
}

export interface GenerateColumnVisualHandle {
	promise: Promise<GenerateColumnVisualResult>;
	cancel: () => void;
}

/**
 * Run a "Column Visual Analysis" PDF build in a Web Worker. The chart PNGs
 * in `request.columns` must already be rendered (column-chart-renderer.ts,
 * main-thread only — vega-embed needs a DOM) before calling this; the
 * worker here only lays out, draws, and saves the PDF, same `{ promise,
 * cancel }` + progress-callback shape as {@link generateReport}.
 */
export function generateColumnVisualReport(
	request: ColumnVisualBuildRequest,
	onProgress?: (progress: ReportProgress) => void
): GenerateColumnVisualHandle {
	let worker: Worker;
	try {
		worker = new Worker(new URL('./report-worker.ts', import.meta.url), { type: 'module' });
	} catch (err) {
		return {
			promise: Promise.reject(
				err instanceof Error ? err : new Error('Failed to start the report worker')
			),
			cancel: () => {}
		};
	}

	const id = newId('report');
	let cancelled = false;
	const cleanup = () => worker.terminate();

	const promise = new Promise<GenerateColumnVisualResult>((resolve, reject) => {
		worker.onmessage = (event: MessageEvent) => {
			const msg = event.data;
			if (!msg || msg.id !== id || cancelled) return;
			switch (msg.type) {
				case 'progress':
					onProgress?.({ stage: msg.stage, processed: msg.processed, total: msg.total });
					break;
				case 'done':
					cleanup();
					resolve({
						pdfBytes: msg.pdfBytes,
						replacedCharacterCount: msg.replacedCharacterCount,
						sha256Full: msg.sha256Full
					});
					break;
				case 'error':
					cleanup();
					reject(new Error(msg.message ?? 'Report generation failed'));
					break;
			}
		};
		worker.onerror = (e) => {
			if (cancelled) return;
			cleanup();
			reject(new Error(e.message ?? 'Report worker crashed'));
		};

		// Same copy-before-transfer rule as generateReport() — fileBytes here
		// is only used for the footer's SHA-256 hash, but it's still the
		// caller's buffer, so we never transfer the original.
		const copy = request.fileBytes.slice(0);
		worker.postMessage(
			{ type: 'build-column-visual', id, request: { ...request, fileBytes: copy } },
			[copy]
		);
	});

	return {
		promise,
		cancel: () => {
			cancelled = true;
			cleanup();
		}
	};
}

export interface GenerateCellCommentaryResult {
	pdfBytes: Uint8Array;
	replacedCharacterCount: number;
	sha256Full: string;
}

export interface GenerateCellCommentaryHandle {
	promise: Promise<GenerateCellCommentaryResult>;
	cancel: () => void;
}

/**
 * Run "Your Cell Commentary Report" build in a Web Worker. The table
 * section (notes + cell content + row numbers, newest-first) is already
 * built by the caller via cell-commentary-report.ts's pure helpers — the
 * worker only lays out, draws, and saves the PDF. Same `{ promise, cancel }`
 * + progress-callback shape as the other two report types.
 */
export function generateCellCommentaryReport(
	request: CellCommentaryBuildRequest,
	onProgress?: (progress: ReportProgress) => void
): GenerateCellCommentaryHandle {
	let worker: Worker;
	try {
		worker = new Worker(new URL('./report-worker.ts', import.meta.url), { type: 'module' });
	} catch (err) {
		return {
			promise: Promise.reject(
				err instanceof Error ? err : new Error('Failed to start the report worker')
			),
			cancel: () => {}
		};
	}

	const id = newId('report');
	let cancelled = false;
	const cleanup = () => worker.terminate();

	const promise = new Promise<GenerateCellCommentaryResult>((resolve, reject) => {
		worker.onmessage = (event: MessageEvent) => {
			const msg = event.data;
			if (!msg || msg.id !== id || cancelled) return;
			switch (msg.type) {
				case 'progress':
					onProgress?.({ stage: msg.stage, processed: msg.processed, total: msg.total });
					break;
				case 'done':
					cleanup();
					resolve({
						pdfBytes: msg.pdfBytes,
						replacedCharacterCount: msg.replacedCharacterCount,
						sha256Full: msg.sha256Full
					});
					break;
				case 'error':
					cleanup();
					reject(new Error(msg.message ?? 'Report generation failed'));
					break;
			}
		};
		worker.onerror = (e) => {
			if (cancelled) return;
			cleanup();
			reject(new Error(e.message ?? 'Report worker crashed'));
		};

		const copy = request.fileBytes.slice(0);
		worker.postMessage(
			{ type: 'build-cell-commentary', id, request: { ...request, fileBytes: copy } },
			[copy]
		);
	});

	return {
		promise,
		cancel: () => {
			cancelled = true;
			cleanup();
		}
	};
}
