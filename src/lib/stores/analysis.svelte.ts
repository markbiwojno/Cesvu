/**
 * analysis.svelte.ts — Analysis pipeline state store
 *
 * Manages the full analysis pipeline state:
 * parse → profile → compress → analyze → render
 */

import type { AnalysisStatus, AnalysisResult, ParsedData, Template } from '$lib/utils/types.js';
import type { ColumnProfile, SignalResult } from '$lib/utils/types.js';

// ============================================================
// State
// ============================================================

let status = $state<AnalysisStatus>('idle');
let progress = $state(0);
let progressStage = $state('');
let result = $state<AnalysisResult | null>(null);
let error = $state<string | null>(null);

// Intermediate pipeline data (for debugging / display)
let parsedData = $state<ParsedData | null>(null);
let columnProfiles = $state<ColumnProfile[]>([]);
let signals = $state<SignalResult[]>([]);
let compressedSummary = $state<string>('');

// ============================================================
// Derived
// ============================================================

let isIdle = $derived(status === 'idle');
let isRunning = $derived(
	status === 'parsing' ||
	status === 'profiling' ||
	status === 'compressing' ||
	status === 'analyzing'
);
let isDone = $derived(status === 'done');
let hasError = $derived(status === 'error');

// ============================================================
// Actions
// ============================================================

function setStatus(s: AnalysisStatus) {
	status = s;
}

function setProgress(p: number, stage: string) {
	progress = p;
	progressStage = stage;
}

function setResult(r: AnalysisResult) {
	result = r;
	status = 'done';
	progress = 100;
	progressStage = 'Complete';
}

function setError(err: string) {
	error = err;
	status = 'error';
}

function setParsedData(data: ParsedData) {
	parsedData = data;
}

function setColumnProfiles(profiles: ColumnProfile[]) {
	columnProfiles = profiles;
}

function setSignals(sigs: SignalResult[]) {
	signals = sigs;
}

function setCompressedSummary(summary: string) {
	compressedSummary = summary;
}

function reset() {
	status = 'idle';
	progress = 0;
	progressStage = '';
	result = null;
	error = null;
	parsedData = null;
	columnProfiles = [];
	signals = [];
	compressedSummary = '';
}

// ============================================================
// Full pipeline runner
// ============================================================

export async function runFullPipeline(
	file: File,
	template: Template,
	modelTier: 'default' | 'advanced' | 'expert' = 'default'
): Promise<AnalysisResult> {
	reset();

	try {
		// 1. Parse
		setStatus('parsing');
		setProgress(5, 'Parsing file...');
		const { parseFile } = await import('$lib/parsers/index.js');

		// The canonical router returns a `ParsedFile` (type/name/parsedData/workbook).
		// This legacy pipeline operates on the older `ParsedData` shape (rows/text/
		// fileName), so adapt the result here. CSV/Excel rows come from the unified
		// workbook's active sheet; document text comes from the StructuredText/string
		// payload.
		const parsedFile = await parseFile(file);
		const wb = (parsedFile as { workbook?: import('$lib/data/workbook.js').Workbook }).workbook;
		const activeSheet = wb?.sheets.find((s) => s.name === wb.activeSheet) ?? wb?.sheets[0];
		const docText =
			typeof parsedFile.parsedData === 'string'
				? parsedFile.parsedData
				: ((parsedFile.parsedData as { text?: string })?.text ?? '');

		const parsed: ParsedData = {
			type: parsedFile.type as ParsedData['type'],
			fileName: parsedFile.name,
			filename: parsedFile.name,
			workbook: wb,
			rows: activeSheet?.rows,
			headers: activeSheet?.headers,
			text: docText
		};
		setParsedData(parsed);
		setProgress(20, 'File parsed');


		// 2. Profile
		setStatus('profiling');
		setProgress(30, 'Profiling data...');
		const { profileColumns, extractSignals, smartSample } = await import('$lib/utils/pipeline.js');

		let profiles: ColumnProfile[] = [];
		let sigs: SignalResult[] = [];
		let sample: Record<string, unknown>[] = [];

		if (parsed.type === 'csv' && parsed.rows?.length) {
			profiles = profileColumns(parsed.rows);
			setColumnProfiles(profiles);

			// Extract signals for numeric columns
			const numericCols = profiles
				.filter((p) => p.kind === 'numeric')
				.map((p) => p.key);

			for (const col of numericCols.slice(0, 5)) {
				sigs.push(extractSignals(parsed.rows, col));
			}
			setSignals(sigs);

			// Smart sample
			const allSpikes = sigs.flatMap((s) => s.spikeRows);
			sample = smartSample(parsed.rows, 20, allSpikes);
		}

		setProgress(50, 'Data profiled');

		// 3. Compress
		setStatus('compressing');
		setProgress(60, 'Compressing summary...');
		const { compress, compressDocument, trimToTokenBudget } = await import('$lib/utils/pipeline.js');

		let compressed: string;
		if (parsed.type === 'csv' && parsed.rows?.length) {
			compressed = compress(profiles, sigs, sample, parsed.rows.length, parsed.filename);
		} else {
			compressed = compressDocument(parsed.text ?? '', parsed.fileName ?? parsed.filename);
		}
		compressed = trimToTokenBudget(compressed, 2000);
		setCompressedSummary(compressed);
		setProgress(70, 'Summary ready');

		// 4. Analyze
		setStatus('analyzing');
		setProgress(75, 'Loading AI model...');
		const { runAnalysis } = await import('$lib/utils/analysis.js');

		const analysisResult = await runAnalysis(
			compressed,
			template,
			modelTier,
			(p, stage) => setProgress(75 + Math.round(p * 0.25), stage)
		);

		setResult(analysisResult);
		return analysisResult;
	} catch (err) {
		const msg = err instanceof Error ? err.message : 'Analysis failed. Please try again.';
		setError(msg);
		throw err;
	}
}

// ============================================================
// Export
// ============================================================

export const analysisStore = {
	get status() { return status; },
	get progress() { return progress; },
	get progressStage() { return progressStage; },
	get result() { return result; },
	get error() { return error; },
	get parsedData() { return parsedData; },
	get columnProfiles() { return columnProfiles; },
	get signals() { return signals; },
	get compressedSummary() { return compressedSummary; },
	get isIdle() { return isIdle; },
	get isRunning() { return isRunning; },
	get isDone() { return isDone; },
	get hasError() { return hasError; },
	setStatus,
	setProgress,
	setResult,
	setError,
	reset,
	runFullPipeline
};
