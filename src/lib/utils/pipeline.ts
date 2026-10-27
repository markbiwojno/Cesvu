/**
 * pipeline.ts — Data processing pipeline for Cesvu
 *
 * Transforms parsed document data into a compressed summary
 * suitable for LLM consumption (~2000 chars / ~500-800 tokens).
 * The LLM never sees raw data — only this compressed summary.
 */

import type { ColumnProfile, NumericProfile, CategoricalProfile, SignalResult, TrendDirection } from './types.js';

// ============================================================
// Column Profiling
// ============================================================

/**
 * Profile all columns in a tabular dataset.
 * Classifies each column as numeric or categorical.
 */
export function profileColumns(rows: Record<string, unknown>[]): ColumnProfile[] {
	if (!rows.length) return [];

	const keys = Object.keys(rows[0]);
	const profiles: ColumnProfile[] = [];

	for (const key of keys) {
		const values = rows.map((r) => r[key]);
		const nonNull = values.filter((v) => v !== null && v !== undefined && v !== '');
		const nullCount = values.length - nonNull.length;

		// Try to classify as numeric
		const numericValues = nonNull
			.map((v) => (typeof v === 'number' ? v : parseFloat(String(v))))
			.filter((v) => !isNaN(v));

		const numericRatio = numericValues.length / Math.max(nonNull.length, 1);

		if (numericRatio >= 0.8 && numericValues.length >= 2) {
			// Numeric column
			const mean = numericValues.reduce((a, b) => a + b, 0) / numericValues.length;
			const min = Math.min(...numericValues);
			const max = Math.max(...numericValues);
			const variance =
				numericValues.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) /
				numericValues.length;
			const stdDev = Math.sqrt(variance);

			profiles.push({
				kind: 'numeric',
				key,
				count: numericValues.length,
				mean: round(mean, 4),
				min: round(min, 4),
				max: round(max, 4),
				stdDev: round(stdDev, 4),
				nullCount
			} satisfies NumericProfile);
		} else {
			// Categorical column
			const strValues = nonNull.map((v) => String(v));
			const freq: Record<string, number> = {};
			for (const v of strValues) {
				freq[v] = (freq[v] ?? 0) + 1;
			}
			const topValues = Object.entries(freq)
				.sort((a, b) => b[1] - a[1])
				.slice(0, 5)
				.map(([value, count]) => ({ value, freq: count }));

			profiles.push({
				kind: 'categorical',
				key,
				count: strValues.length,
				uniqueCount: Object.keys(freq).length,
				topValues,
				nullCount
			} satisfies CategoricalProfile);
		}
	}

	return profiles;
}

// ============================================================
// Signal Extraction
// ============================================================

/**
 * Extract statistical signals from a numeric column.
 * Detects trend direction via linear regression and spike rows (>2σ).
 */
export function extractSignals(
	rows: Record<string, unknown>[],
	numericKey: string
): SignalResult {
	const values = rows
		.map((r, i) => ({ i, v: parseFloat(String(r[numericKey] ?? '')) }))
		.filter(({ v }) => !isNaN(v));

	if (!values.length) {
		return { key: numericKey, mean: 0, stdDev: 0, trend: 'flat', spikeRows: [], slope: 0 };
	}

	const nums = values.map((x) => x.v);
	const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
	const variance = nums.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / nums.length;
	const stdDev = Math.sqrt(variance);

	// Spike rows: value > 2σ from mean
	const spikeRows = values
		.filter(({ v }) => Math.abs(v - mean) > 2 * stdDev)
		.map(({ i }) => i);

	// Linear regression for trend
	const n = values.length;
	const xMean = (n - 1) / 2;
	const slope =
		values.reduce((sum, { i, v }) => sum + (i - xMean) * (v - mean), 0) /
		Math.max(values.reduce((sum, { i }) => sum + Math.pow(i - xMean, 2), 0), 1);

	const trendThreshold = stdDev * 0.05;
	let trend: TrendDirection = 'flat';
	if (slope > trendThreshold) trend = 'upward';
	else if (slope < -trendThreshold) trend = 'downward';

	return {
		key: numericKey,
		mean: round(mean, 4),
		stdDev: round(stdDev, 4),
		trend,
		spikeRows,
		slope: round(slope, 6)
	};
}

// ============================================================
// Smart Sampling
// ============================================================

/**
 * Deterministic, reproducible row sampling.
 * Includes: evenly spaced rows + extremes + spike rows + boundary rows.
 * NOT random — same input always produces same output.
 */
export function smartSample(
	rows: Record<string, unknown>[],
	limit = 20,
	spikeRows: number[] = []
): Record<string, unknown>[] {
	if (rows.length <= limit) return rows;

	const selected = new Set<number>();

	// Always include first and last rows
	selected.add(0);
	selected.add(rows.length - 1);

	// Include spike rows (anomalies)
	for (const i of spikeRows.slice(0, 5)) {
		if (i >= 0 && i < rows.length) selected.add(i);
	}

	// Evenly spaced samples to fill remaining budget
	const remaining = limit - selected.size;
	if (remaining > 0) {
		const step = Math.floor(rows.length / (remaining + 1));
		for (let i = 1; i <= remaining; i++) {
			selected.add(Math.min(i * step, rows.length - 1));
		}
	}

	return Array.from(selected)
		.sort((a, b) => a - b)
		.map((i) => ({ _row: i, ...rows[i] }));
}

// ============================================================
// Compression
// ============================================================

/**
 * Combine profile + signals + samples into a tight structured text summary.
 * This is what the LLM receives. Target: ~2000 chars (~500-800 tokens).
 */
export function compress(
	profile: ColumnProfile[],
	signals: SignalResult[],
	sample: Record<string, unknown>[],
	rowCount: number,
	filename?: string
): string {
	const parts: string[] = [];

	// Header
	if (filename) parts.push(`FILE: ${filename}`);
	parts.push(`ROWS: ${rowCount} | COLUMNS: ${profile.length}`);
	parts.push('');

	// Column profiles
	parts.push('=== COLUMN PROFILES ===');
	for (const col of profile) {
		if (col.kind === 'numeric') {
			parts.push(
				`[${col.key}] numeric | mean=${col.mean} min=${col.min} max=${col.max} σ=${col.stdDev} nulls=${col.nullCount}`
			);
		} else {
			const topStr = col.topValues
				.slice(0, 3)
				.map((t) => `"${t.value}"(${t.freq})`)
				.join(', ');
			parts.push(
				`[${col.key}] categorical | unique=${col.uniqueCount} top=[${topStr}] nulls=${col.nullCount}`
			);
		}
	}
	parts.push('');

	// Signals
	if (signals.length) {
		parts.push('=== SIGNALS ===');
		for (const sig of signals) {
			const spikes = sig.spikeRows.length ? ` spikes@rows=[${sig.spikeRows.slice(0, 5).join(',')}]` : '';
			parts.push(
				`[${sig.key}] trend=${sig.trend} slope=${sig.slope}${spikes}`
			);
		}
		parts.push('');
	}

	// Sample rows
	if (sample.length) {
		parts.push('=== SAMPLE ROWS ===');
		// Header row
		const keys = Object.keys(sample[0]).filter((k) => k !== '_row');
		parts.push(keys.join('\t'));
		for (const row of sample) {
			parts.push(keys.map((k) => String(row[k] ?? '')).join('\t'));
		}
	}

	return parts.join('\n');
}

/**
 * Compress a document (non-tabular) into a structured summary.
 */
export function compressDocument(text: string, filename?: string): string {
	const words = text.split(/\s+/).filter(Boolean);
	const wordCount = words.length;
	const readingTime = Math.ceil(wordCount / 200); // ~200 wpm

	// Extract headings (lines that look like headings)
	const lines = text.split('\n');
	const headings = lines
		.filter((l) => l.match(/^#{1,3}\s/) || (l.length < 80 && l.match(/^[A-Z][^.!?]*:?\s*$/)))
		.slice(0, 10);

	// Extract first paragraph
	const firstPara = text.slice(0, 500).trim();

	// Extract last paragraph
	const lastPara = text.slice(-300).trim();

	const parts: string[] = [];
	if (filename) parts.push(`FILE: ${filename}`);
	parts.push(`WORDS: ${wordCount} | READING TIME: ~${readingTime} min`);
	parts.push('');

	if (headings.length) {
		parts.push('=== STRUCTURE ===');
		parts.push(headings.join('\n'));
		parts.push('');
	}

	parts.push('=== OPENING ===');
	parts.push(firstPara);
	parts.push('');

	if (text.length > 800) {
		parts.push('=== CLOSING ===');
		parts.push(lastPara);
	}

	return parts.join('\n');
}

// ============================================================
// Token Budget
// ============================================================

/**
 * Cap compressed output to maxChars.
 * Trims from sample rows first, then signal detail, then profile stats.
 * Preserves structure markers.
 */
export function trimToTokenBudget(text: string, maxChars = 2000): string {
	if (text.length <= maxChars) return text;

	const lines = text.split('\n');
	let result = lines;

	// Strategy 1: Remove sample rows beyond first 5
	const sampleStart = lines.findIndex((l) => l.startsWith('=== SAMPLE ROWS ==='));
	if (sampleStart !== -1) {
		const headerLine = sampleStart + 1;
		const dataLines = lines.slice(headerLine + 1);
		const trimmedData = dataLines.slice(0, 5);
		result = [
			...lines.slice(0, headerLine + 1),
			...trimmedData,
			dataLines.length > 5 ? `... (${dataLines.length - 5} more rows omitted)` : ''
		].filter((l) => l !== '');

		if (result.join('\n').length <= maxChars) return result.join('\n');
	}

	// Strategy 2: Remove spike row details from signals
	result = result.map((l) => l.replace(/ spikes@rows=\[[^\]]*\]/, ''));
	if (result.join('\n').length <= maxChars) return result.join('\n');

	// Strategy 3: Hard truncate with ellipsis
	const joined = result.join('\n');
	return joined.slice(0, maxChars - 20) + '\n... [truncated]';
}

// ============================================================
// Helpers
// ============================================================

function round(n: number, decimals: number): number {
	const factor = Math.pow(10, decimals);
	return Math.round(n * factor) / factor;
}
