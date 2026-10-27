/**
 * src/lib/pipeline/analysis.ts — LLM prompt building and response parsing
 *
 * buildPrompt: combines template system prompt + compressed summary → single prompt string
 * parseLLMResponse: parses JSON from LLM output, handles markdown code blocks
 *
 * The LLM outputs structured JSON only. Never HTML, CSS, or JavaScript.
 */

import type { CompressedSummary, ColumnProfile, Template } from '$lib/types.js';
import type { ModelConfig } from '$lib/stores/workspace.svelte.js';
import type { AnalysisResult } from '$lib/stores/workspace.svelte.js';
import type { TopLevelSpec } from 'vega-lite';
import type { ChartData } from '$lib/visuals/chart-specs.js';

/**
 * Sentinel separating the header stats from the text body inside a single
 * `text` blob (deterministic column analysis). The chat renderer splits on
 * this to draw: header → chart → body. Stripped for any plain-text fallback.
 */
export const CHART_SLOT = '\u0000CHART\u0000';

/**
 * Result of parsing an LLM response.
 * sections: the parsed JSON object (keys match template section IDs)
 * raw: the original LLM output string
 * error: null on success, error message on failure
 */
export interface ParsedLLMResponse {
	sections: Record<string, unknown>;
	raw: string;
	error: string | null;
}

// ============================================================
// buildPrompt
// ============================================================

/**
 * Build the full prompt string to send to the LLM.
 *
 * Structure:
 *   [System prompt from template]
 *   [Data summary]
 *   [Output instructions]
 */
export function buildPrompt(summary: CompressedSummary, template: Template): string {
	const parts: string[] = [];

	// 1. System prompt
	parts.push(template.systemPrompt);
	parts.push('');

	// 2. Data summary
	parts.push('=== DATA SUMMARY ===');
	parts.push(`File: ${summary.fileName} (${summary.fileType.toUpperCase()})`);

	if (summary.fileType === 'csv') {
		parts.push(`Rows: ${summary.rowCount?.toLocaleString() ?? 'unknown'}`);
		parts.push(`Columns: ${summary.columnCount ?? 'unknown'}`);

		if (summary.columnProfiles?.length) {
			parts.push('');
			parts.push('Column Profiles:');
			// Cap at 12 columns to keep prompt under ~800 tokens for small models
			const profilesToShow = summary.columnProfiles.slice(0, 12);
			for (const col of profilesToShow) {
				parts.push(formatColumnProfile(col));
			}
			if (summary.columnProfiles.length > 12) {
				parts.push(`  ... and ${summary.columnProfiles.length - 12} more columns`);
			}
		}
	} else {
		if (summary.structureNotes) {
			parts.push(`Structure: ${summary.structureNotes}`);
		}
		if (summary.textPreview) {
			parts.push('');
			parts.push('Content Preview:');
			parts.push(summary.textPreview);
		}
	}

	parts.push('');
	parts.push('=== END DATA SUMMARY ===');
	parts.push('');

	// 3. Output instructions — show exact schema with example values
	// Small models (1.5B) need a concrete example to reliably output JSON.
	parts.push('You MUST respond with ONLY a valid JSON object. No prose, no markdown, no code fences.');
	parts.push('');
	parts.push('Output this exact JSON structure (fill in real values):');

	// Build a concrete example schema
	const exampleObj: Record<string, unknown> = {};
	for (const s of template.sections) {
		if (s.type === 'insights' || s.type === 'recommendations' || s.type === 'anomalies') {
			exampleObj[s.id] = ['First point here', 'Second point here', 'Third point here'];
		} else {
			exampleObj[s.id] = `Your ${s.title.toLowerCase()} here`;
		}
	}
	parts.push(JSON.stringify(exampleObj, null, 2));
	parts.push('');
	parts.push('Rules: arrays contain plain strings. No nested objects. No extra keys. Start with { and end with }.');

	const fullPrompt = parts.join('\n');

	// Hard cap: 2000 chars (~500 tokens) for CSV, 3000 chars (~750 tokens) for text.
	// Prevents OOM during OrtRun on WebGPU (KV-cache scales with prompt length).
	const charLimit = summary.fileType === 'csv' ? 2000 : 3000;
	if (fullPrompt.length > charLimit) {
		// Trim from the middle (data section), preserve system prompt + output instructions
		return fullPrompt.slice(0, charLimit);
	}

	return fullPrompt;
}

// ============================================================
// parseLLMResponse
// ============================================================

/**
 * Parse the LLM's JSON response into an AnalysisResult.
 *
 * Handles:
 * - Clean JSON: { "summary": "...", "key_findings": [...] }
 * - JSON wrapped in markdown code blocks: ```json { ... } ```
 * - Partial/malformed JSON: returns best-effort result with error flag
 */
export function parseLLMResponse(response: string): ParsedLLMResponse {
	const raw = response.trim();

	// Try to extract JSON from markdown code blocks first
	const jsonFromBlock = extractJsonFromCodeBlock(raw);
	const jsonStr = jsonFromBlock ?? raw;

	try {
		const parsed = JSON.parse(jsonStr);

		if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
			return makeErrorResult('LLM returned non-object JSON', raw);
		}

		return {
			sections: parsed,
			raw,
			error: null
		};
	} catch {
		// Try to find JSON object anywhere in the string
		const extracted = extractJsonObject(raw);
		if (extracted) {
			try {
				const parsed = JSON.parse(extracted);
				return { sections: parsed, raw, error: null };
			} catch {
				// fall through
			}
		}

		return makeErrorResult('Could not parse LLM response as JSON', raw);
	}
}

// ============================================================
// Helpers
// ============================================================

function formatColumnProfile(col: ColumnProfile): string {
	const parts = [`  ${col.name} (${col.type})`];
	parts.push(`count=${col.count}, unique=${col.uniqueCount}, nulls=${col.nullCount}`);

	if (col.type === 'numeric') {
		parts.push(`min=${col.min}, max=${col.max}, mean=${col.mean}, median=${col.median}`);
	} else if ((col.type === 'categorical' || col.type === 'datetime') && col.topValues?.length) {
		const top = col.topValues.slice(0, 5).map((v) => `${v.value}(${v.count})`).join(', ');
		parts.push(`top values: ${top}`);
	}

	return parts.join(' | ');
}

function extractJsonFromCodeBlock(text: string): string | null {
	// Match ```json ... ``` or ``` ... ```
	const match = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
	return match ? match[1].trim() : null;
}

function extractJsonObject(text: string): string | null {
	// Find the first { and last } and try that substring
	const start = text.indexOf('{');
	const end = text.lastIndexOf('}');
	if (start === -1 || end === -1 || end <= start) return null;
	return text.slice(start, end + 1);
}

/**
 * Last-resort fallback: the model returned natural language instead of JSON.
 * Extract useful content by splitting into sentences and mapping to sections.
 * This gives the user something readable rather than an error message.
 */
function extractNaturalLanguageFallback(raw: string): ParsedLLMResponse {
	// Split into sentences/paragraphs
	const lines = raw
		.split(/\n+/)
		.map(l => l.trim())
		.filter(l => l.length > 10);

	// Try to find a summary sentence (first substantial line)
	const summary = lines[0] ?? raw.slice(0, 300);

	// Remaining lines become key findings
	const findings = lines.slice(1, 6).filter(l => l.length > 0);

	return {
		sections: {
			summary,
			key_findings: findings.length > 0 ? findings : ['See raw output below'],
			patterns: [],
			anomalies: [],
			recommendations: []
		},
		raw,
		// Not a hard error — we extracted something useful
		error: null
	};
}

/**
 * Detect whether a question is conversational/general rather than a structured
 * data query. Conversational questions bypass the operation pipeline and go
 * directly to the conversational LLM prompt.
 *
 * Examples that return true:
 *   "tell me more about this document"
 *   "what is this file about?"
 *   "summarize this"
 *   "explain the data"
 *   "what does this mean?"
 *
 * Examples that return false (structured queries):
 *   "total revenue"
 *   "top 5 products by sales"
 *   "filter rows where status is active"
 *   "show me the distribution of age"
 */
// ============================================================
// tryDirectOperation — keyword + fuzzy column matching (no LLM)
// ============================================================

/**
 * Normalize a string for fuzzy column matching:
 * lowercase, strip spaces/underscores/hyphens/parens.
 */
function normForMatch(s: string): string {
	return s.toLowerCase().replace(/[\s_\-()]/g, '');
}

/**
 * Find the best-matching actual column name for a token from the question.
 * Returns the actual column name (original case) or null.
 *
 * Matching order:
 *   1. Exact case-insensitive match
 *   2. Normalized match (strip spaces/underscores/hyphens/parens)
 *   3. Actual column is a substring of the question token (or vice versa)
 */
function fuzzyMatchColumn(token: string, columns: string[]): string | null {
	const needle = normForMatch(token);
	if (!needle) return null;

	// 1. Exact case-insensitive
	for (const col of columns) {
		if (col.toLowerCase() === token.toLowerCase()) return col;
	}
	// 2. Normalized exact
	for (const col of columns) {
		if (normForMatch(col) === needle) return col;
	}
	// 3. Substring (longer match wins)
	let best: string | null = null;
	let bestScore = 0;
	for (const col of columns) {
		const cn = normForMatch(col);
		if (cn.includes(needle) || needle.includes(cn)) {
			const score = Math.min(cn.length, needle.length);
			if (score > bestScore) { best = col; bestScore = score; }
		}
	}
	return best;
}

/**
 * Scan the question for any column name from the dataset using fuzzy matching.
 * Tries multi-word substrings (longest first) then single tokens.
 * Returns the matched actual column name or null.
 */
function findColumnInQuestion(question: string, columns: string[]): string | null {
	const q = question.toLowerCase();
	const words = q.split(/\s+/);

	// Try multi-word substrings (up to 4 words) — longest first
	for (let len = Math.min(4, words.length); len >= 1; len--) {
		for (let i = 0; i <= words.length - len; i++) {
			const phrase = words.slice(i, i + len).join(' ');
			const match = fuzzyMatchColumn(phrase, columns);
			if (match) return match;
		}
	}
	return null;
}

/**
 * Try to build a DataOperation directly from the question using keyword + column matching.
 * Returns a DataOperation if confident, or null to fall through to LLM.
 *
 * Handles:
 *   sum / total of <col>
 *   average / avg / mean of <col>
 *   count / how many
 *   max / maximum / highest of <col>
 *   min / minimum / lowest of <col>
 *   median of <col>
 *   top N <col> / top N by <col>
 *   bottom N <col> / bottom N by <col>
 *   distribution of <col>
 *   describe <col> / describe all
 */
function tryDirectOperation(
	question: string,
	columns: string[]
): import('$lib/pipeline/operations.js').DataOperation | null {
	const q = question.toLowerCase().trim();

	// ── most common / most frequent → top_n ──────────────────────────────────
	// "what is the most common zipcode" → top_n(n=1, column=ZipCode)
	// "most frequent business type" → top_n(n=1, column=BusinessType)
	if (/\b(most common|most frequent|most popular|most used|most occurring)\b/.test(q)) {
		const col = findColumnInQuestion(question, columns);
		if (col) return { type: 'top_n', n: 1, column: col };
	}

	// ── least common / least frequent → bottom_n ─────────────────────────────
	if (/\b(least common|least frequent|least popular|rarest|least used)\b/.test(q)) {
		const col = findColumnInQuestion(question, columns);
		if (col) return { type: 'bottom_n', n: 1, column: col };
	}

	// ── top N / bottom N ──────────────────────────────────────────────────────
	const topMatch = q.match(/\btop\s+(\d+)\b/);
	const bottomMatch = q.match(/\bbottom\s+(\d+)\b/);
	if (topMatch || bottomMatch) {
		const n = parseInt((topMatch ?? bottomMatch)![1]);
		const col = findColumnInQuestion(question, columns);
		if (col) {
			// Look for a "by <groupCol>" pattern
			const byMatch = q.match(/\bby\s+(.+)$/);
			const byCol = byMatch ? findColumnInQuestion(byMatch[1], columns) : null;
			return topMatch
				? { type: 'top_n', n, column: col, by: byCol ?? undefined }
				: { type: 'bottom_n', n, column: col, by: byCol ?? undefined };
		}
	}

	// ── distribution ──────────────────────────────────────────────────────────
	if (/\bdistribution\b/.test(q)) {
		const col = findColumnInQuestion(question, columns);
		if (col) return { type: 'distribution', column: col };
	}

	// ── describe ──────────────────────────────────────────────────────────────
	if (/\bdescribe\b/.test(q)) {
		const col = findColumnInQuestion(question, columns);
		// describe with a specific column, or describe all
		return { type: 'describe', columns: col ? [col] : undefined };
	}

	// ── aggregate: sum / total ────────────────────────────────────────────────
	if (/\b(sum|total)\b/.test(q)) {
		const col = findColumnInQuestion(question, columns);
		if (col) return { type: 'aggregate', function: 'sum', column: col };
	}

	// ── aggregate: average / avg / mean ──────────────────────────────────────
	if (/\b(average|avg|mean)\b/.test(q)) {
		const col = findColumnInQuestion(question, columns);
		if (col) return { type: 'aggregate', function: 'avg', column: col };
	}

	// ── filtered count: "how many [col] say/are/equal/is [value]" ────────────
	// Detect: "how many BusinessType say Sole Owner"
	//         "how many rows have Status = Active"
	//         "count of BusinessType equal to Corporation"
	const filteredCountPatterns = [
		// "how many businesstype say sole owner"
		/\bhow many\s+(.+?)\s+(?:say|says|are|is|equal to|equals|=|that (?:is|are)|with value|have value)\s+(.+)$/,
		// "count businesstype = sole owner"
		/\bcount\s+(.+?)\s*(?:=|equal to|equals|is|are|say|says)\s*(.+)$/,
		// "number of businesstype that is sole owner"
		/\bnumber of\s+(.+?)\s+(?:that (?:is|are)|which (?:is|are)|equal to|equals|=|is|are|say|says)\s+(.+)$/,
	];

	for (const pattern of filteredCountPatterns) {
		const m = q.match(pattern);
		if (m) {
			const colPhrase = m[1].trim();
			const valuePhrase = m[2].trim().replace(/['"?!.]+$/, '');
			const col = fuzzyMatchColumn(colPhrase, columns) ?? findColumnInQuestion(colPhrase, columns);
			if (col && valuePhrase) {
				return {
					type: 'aggregate',
					function: 'count',
					column: col,
					filters: [{ column: col, op: 'eq', value: valuePhrase }]
				};
			}
		}
	}

	// ── aggregate: count ─────────────────────────────────────────────────────
	if (/\b(count|how many|number of rows|row count|total rows)\b/.test(q)) {
		// count with a column = count non-null; without = total row count
		const col = findColumnInQuestion(question, columns);
		return { type: 'aggregate', function: 'count', column: col ?? columns[0] };
	}

	// ── aggregate: max ────────────────────────────────────────────────────────
	if (/\b(max|maximum|highest|largest|biggest)\b/.test(q)) {
		const col = findColumnInQuestion(question, columns);
		if (col) return { type: 'aggregate', function: 'max', column: col };
	}

	// ── aggregate: min ────────────────────────────────────────────────────────
	if (/\b(min|minimum|lowest|smallest)\b/.test(q)) {
		const col = findColumnInQuestion(question, columns);
		if (col) return { type: 'aggregate', function: 'min', column: col };
	}

	// ── aggregate: median ─────────────────────────────────────────────────────
	if (/\bmedian\b/.test(q)) {
		const col = findColumnInQuestion(question, columns);
		if (col) return { type: 'aggregate', function: 'median', column: col };
	}

	// ── aggregate: stddev ─────────────────────────────────────────────────────
	if (/\b(std|stddev|standard deviation|variance)\b/.test(q)) {
		const col = findColumnInQuestion(question, columns);
		if (col) return { type: 'aggregate', function: 'stddev', column: col };
	}

	// ── filter: "show me / show all / list / find [col] [value]" ─────────────
	// Catches: "show me all businesses of zip code 90035"
	//          "show rows where city is Los Angeles"
	//          "find all entries with status active"
	//          "list businesses in zip 90210"
	//          "show zip code 90035"
	const showFilterPatterns = [
		// "show me all X of/in/with/where/for [col] [value]"
		/\b(?:show|list|find|display|get)\b.*?\b(?:of|in|with|where|for)\s+(?:zip(?:\s*code)?|postal(?:\s*code)?)\s+(\d{4,6})\b/,
		// "zip code 90035" / "zip 90035" anywhere in question
		/\bzip(?:\s*code)?\s+(\d{4,6})\b/,
		// "postal code 90035"
		/\bpostal(?:\s*code)?\s+(\d{4,6})\b/,
	];

	for (const pat of showFilterPatterns) {
		const m = q.match(pat);
		if (m) {
			// Find the zip/postal column
			const zipCol = columns.find(c => {
				const cn = c.toLowerCase().replace(/[\s_\-]/g, '');
				return cn.includes('zip') || cn.includes('postal') || cn === 'postcode';
			});
			if (zipCol) {
				return {
					type: 'filter',
					filters: [{ column: zipCol, op: 'eq', value: m[1] }]
				};
			}
		}
	}

	// Generic "show me [value] in [col]" / "show [col] = [value]"
	const showGenericMatch = q.match(/\b(?:show|list|find|display|get)\b.*?\b(?:where|with|having|that (?:is|are)|equal to|=)\s+(.+)$/);
	if (showGenericMatch) {
		const valuePhrase = showGenericMatch[1].trim().replace(/['"?!.]+$/, '');
		// Try to find a column that matches a word in the question before the value
		const col = findColumnInQuestion(question.slice(0, question.toLowerCase().indexOf(showGenericMatch[1])), columns);
		if (col && valuePhrase) {
			return {
				type: 'filter',
				filters: [{ column: col, op: 'contains', value: valuePhrase }]
			};
		}
	}

	// ── correlation ───────────────────────────────────────────────────────────
	if (/\bcorrelation\b/.test(q)) {
		// Need two columns — find both
		const remaining = columns.filter(c => true); // all columns
		const col_a = findColumnInQuestion(question, remaining);
		if (col_a) {
			// Remove col_a from candidates and search again
			const rest = columns.filter(c => c !== col_a);
			const col_b = findColumnInQuestion(question, rest);
			if (col_b) return { type: 'correlation', column_a: col_a, column_b: col_b };
		}
	}

	return null;
}

/**
 * Detect a "profile/analyze this column" request and, if it names a real
 * column, build a deterministic structured-markdown analysis straight from the
 * pre-computed ColumnProfile — NO LLM, so zero fabrication risk.
 *
 * This deliberately catches only a few common phrasings (kept as tight,
 * explicit patterns — not one giant regex). Anything that doesn't match falls
 * through to the query engine / conversational LLM with the usual safeguards.
 *
 * Examples it catches:
 *   "Give me an analysis of the City column …"
 *   "analyze the BusinessName column"
 *   "breakdown of MailingAddress"
 *   "profile the State column"
 *   "distribution / outliers / patterns of City"
 */
const COLUMN_ANALYSIS_PATTERNS: RegExp[] = [
	/\b(?:give me (?:an? )?)?analy[sz]e?(?:s|is)?\b/, // analyze / analysis / analyse
	/\bbreakdown\b/,
	/\bprofile\b/,
	/\b(?:distribution|outliers?|patterns?)\b/
];

function detectColumnAnalysis(
	question: string,
	profiles: ColumnProfile[]
): ColumnProfile | null {
	if (!profiles.length) return null;
	const q = question.toLowerCase();
	const matchesAnalysisIntent = COLUMN_ANALYSIS_PATTERNS.some((re) => re.test(q));
	if (!matchesAnalysisIntent) return null;
	const colName = findColumnInQuestion(question, profiles.map((c) => c.name));
	if (!colName) return null;
	return profiles.find((c) => c.name === colName) ?? null;
}

// ============================================================
// Deterministic column analysis helpers (NO LLM — pure arithmetic)
// ============================================================

/** Format n as a locale string with a "(x.y% of total)" suffix. */
function withPct(n: number, total: number): string {
	if (total <= 0) return n.toLocaleString();
	const pct = (n / total) * 100;
	return `${n.toLocaleString()} (${pct.toFixed(1)}%)`;
}

/** Build a frequency map (value → count) over a single column of the row buffer. */
function frequencyOf(
	rows: Record<string, unknown>[],
	column: string
): { freq: Map<string, number>; nonEmpty: number; empty: number } {
	const freq = new Map<string, number>();
	let nonEmpty = 0;
	let empty = 0;
	for (const row of rows) {
		const v = row[column];
		if (v === null || v === undefined || v === '') { empty++; continue; }
		const key = String(v);
		freq.set(key, (freq.get(key) ?? 0) + 1);
		nonEmpty++;
	}
	return { freq, nonEmpty, empty };
}

/** Sorted [value, count] descending. */
function sortedEntries(freq: Map<string, number>): Array<[string, number]> {
	return [...freq.entries()].sort((a, b) => b[1] - a[1]);
}

/**
 * Group values by a leading alphabetic prefix (e.g. "C10","C15" → "C").
 * Returns groups covering >= the threshold share, largest first.
 * Returns [] when no group clears the threshold (avoids noise like "S: 0.3%").
 */
function computePrefixGroups(
	entries: Array<[string, number]>,
	nonEmpty: number,
	minShare = 0.05
): Array<{ prefix: string; count: number; share: number; min?: string; max?: string }> {
	if (nonEmpty <= 0) return [];
	// Group by leading alpha run; values with no leading letter share the "#" bucket.
	const groups = new Map<string, { count: number; nums: number[]; hasDigits: boolean }>();
	for (const [value, count] of entries) {
		const m = value.match(/^([A-Za-z]+)/);
		const prefix = m ? m[1].toUpperCase() : '#';
		const g = groups.get(prefix) ?? { count: 0, nums: [], hasDigits: false };
		g.count += count;
		const numMatch = value.match(/^[A-Za-z]*(\d+)/);
		if (numMatch) { g.nums.push(parseInt(numMatch[1], 10)); g.hasDigits = true; }
		groups.set(prefix, g);
	}
	const out: Array<{ prefix: string; count: number; share: number; min?: string; max?: string }> = [];
	for (const [prefix, g] of groups) {
		const share = g.count / nonEmpty;
		if (share < minShare) continue;
		const entry: { prefix: string; count: number; share: number; min?: string; max?: string } =
			{ prefix, count: g.count, share };
		if (g.hasDigits && g.nums.length) {
			entry.min = `${prefix}${Math.min(...g.nums)}`;
			entry.max = `${prefix}${Math.max(...g.nums)}`;
		}
		out.push(entry);
	}
	return out.sort((a, b) => b.count - a.count);
}

/** Min / max / average string length over the distinct values. */
function computeLengthStats(values: string[]): { min: number; max: number; avg: number } {
	if (!values.length) return { min: 0, max: 0, avg: 0 };
	let min = Infinity, max = 0, sum = 0;
	for (const v of values) {
		const len = v.length;
		if (len < min) min = len;
		if (len > max) max = len;
		sum += len;
	}
	return { min: min === Infinity ? 0 : min, max, avg: sum / values.length };
}

/**
 * Detect the dominant structural pattern across a sample of values.
 * Returns a human label + the share of values matching it, or null if mixed.
 */
function detectStructure(values: string[]): { label: string; share: number } | null {
	if (!values.length) return null;
	const tests: Array<{ label: string; re: RegExp }> = [
		{ label: 'letter(s) + digits', re: /^[A-Za-z]+\d+$/ },
		{ label: 'digits only', re: /^\d+$/ },
		{ label: 'a single letter', re: /^[A-Za-z]$/ },
		{ label: 'an email address', re: /^[^@\s]+@[^@\s]+\.[^@\s]+$/ },
		{ label: 'UPPERCASE words', re: /^[A-Z0-9 .,&'-]+$/ }
	];
	let best: { label: string; share: number } | null = null;
	for (const { label, re } of tests) {
		let matches = 0;
		for (const v of values) if (re.test(v)) matches++;
		const share = matches / values.length;
		if (share >= 0.6 && (!best || share > best.share)) best = { label, share };
	}
	return best;
}

/**
 * Cardinality bucket label from the distinct ratio (distinct / non-empty).
 * Thresholds: <1% low · 1–10% moderate · >10% high · >50% near-unique.
 * The percentage is shown with 1 decimal so sub-1%/low-single-digit ratios
 * (e.g. 1.5% for a city column) read correctly rather than rounding to "2%".
 */
function cardinalityNote(uniqueCount: number, nonEmpty: number): string {
	if (nonEmpty <= 0) return 'no data';
	const ratio = uniqueCount / nonEmpty;
	const pct = (ratio * 100).toFixed(1);
	if (ratio > 0.5) return `near-unique — over half the values are distinct (${pct}% distinct)`;
	if (ratio > 0.1) return `high cardinality (${pct}% distinct)`;
	if (ratio >= 0.01) return `moderate cardinality (${pct}% distinct)`;
	return `low cardinality (${pct}% distinct)`;
}

/** Numeric stats from the raw row buffer: quartiles + 5-bucket histogram. */
function computeNumericStats(
	rows: Record<string, unknown>[],
	column: string
): { count: number; min: number; max: number; mean: number; median: number; q1: number; q3: number; histogram: Array<{ lo: number; hi: number; count: number }> } | null {
	const nums: number[] = [];
	for (const row of rows) {
		const v = row[column];
		if (v === null || v === undefined || v === '') continue;
		const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[$,%]/g, ''));
		if (!isNaN(n)) nums.push(n);
	}
	if (!nums.length) return null;
	nums.sort((a, b) => a - b);
	const count = nums.length;
	const at = (p: number) => nums[Math.min(count - 1, Math.max(0, Math.floor(p * (count - 1))))];
	const min = nums[0];
	const max = nums[count - 1];
	const mean = nums.reduce((a, b) => a + b, 0) / count;
	const median = at(0.5);
	const q1 = at(0.25);
	const q3 = at(0.75);
	// 5 equal-width buckets across [min, max].
	const buckets = 5;
	const span = max - min;
	const width = span > 0 ? span / buckets : 1;
	const histogram = Array.from({ length: buckets }, (_, i) => ({
		lo: min + i * width,
		hi: i === buckets - 1 ? max : min + (i + 1) * width,
		count: 0
	}));
	for (const n of nums) {
		let idx = span > 0 ? Math.floor((n - min) / width) : 0;
		if (idx >= buckets) idx = buckets - 1;
		if (idx < 0) idx = 0;
		histogram[idx].count++;
	}
	return { count, min, max, mean, median, q1, q3, histogram };
}

/** Parse a cell value as a Date (ISO, MM/DD/YYYY, or native-parseable). */
function parseCellDate(v: unknown): Date | null {
	if (v === null || v === undefined || v === '') return null;
	const s = String(v).trim();
	const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
	if (m) {
		const yr = m[3].length === 2 ? 2000 + parseInt(m[3], 10) : parseInt(m[3], 10);
		const d = new Date(yr, parseInt(m[1], 10) - 1, parseInt(m[2], 10));
		if (!isNaN(d.getTime())) return d;
	}
	const d = new Date(s);
	return isNaN(d.getTime()) ? null : d;
}

/** Date stats from the row buffer: range + month-gap analysis. */
function computeDateStats(
	rows: Record<string, unknown>[],
	column: string
): { count: number; min: Date; max: Date; monthsInRange: number; monthsPresent: number; missingMonths: string[] } | null {
	const dates: Date[] = [];
	for (const row of rows) {
		const d = parseCellDate(row[column]);
		if (d) dates.push(d);
	}
	if (!dates.length) return null;
	dates.sort((a, b) => a.getTime() - b.getTime());
	const min = dates[0];
	const max = dates[dates.length - 1];
	const present = new Set<string>();
	for (const d of dates) present.add(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
	// Enumerate every month in [min, max].
	const missing: string[] = [];
	let monthsInRange = 0;
	const cursor = new Date(min.getFullYear(), min.getMonth(), 1);
	const end = new Date(max.getFullYear(), max.getMonth(), 1);
	while (cursor <= end) {
		monthsInRange++;
		const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}`;
		if (!present.has(key)) missing.push(key);
		cursor.setMonth(cursor.getMonth() + 1);
	}
	return { count: dates.length, min, max, monthsInRange, monthsPresent: present.size, missingMonths: missing };
}

/**
 * Result of a deterministic column analysis.
 * - headerText: the column name + the Rows/Distinct/Empty header stats.
 * - bodyText:   the type-specific distribution / pattern / summary section.
 * - chartSpec:  a Vega-Lite spec to render BETWEEN the header and the body,
 *               or null when the column has no plottable data.
 */
export interface ColumnAnalysis {
	headerText: string;
	bodyText: string;
	chartSpec: TopLevelSpec | null;
}

/**
 * Build a deterministic, structured-markdown analysis of a single column.
 * Top-value/percentage/pattern math is computed from the row buffer when
 * available (the profile's topValues/sampleValues are truncated to top-N and
 * its freq map is dropped above 500 distinct values, so they are NOT a reliable
 * full distribution). Falls back to the profile when no buffer is present.
 * Every number is computed — never generated by an LLM.
 *
 * Returns the header + body text split (so the caller can render
 * header → chart → body) plus a deterministic chart spec (null when nothing is
 * plottable). The chart data (20-bin histogram / monthly buckets / top-value
 * frequencies) is computed here from the row buffer — NOT stored on the
 * profile — and shaped into a spec by buildChartSpec(). No synthetic charts:
 * numeric/date charts require the buffer and yield null without it.
 */
async function buildColumnAnalysis(
	col: ColumnProfile,
	totalRows: number,
	rows?: Record<string, unknown>[],
	bufferTotal?: number
): Promise<ColumnAnalysis> {
	const headerLines: string[] = [];
	headerLines.push(`## ${col.name} — ${col.type} column`);

	const haveRows = !!rows && rows.length > 0;
	// Partial note: the buffer is a subset of the full dataset.
	const partial = haveRows && bufferTotal !== undefined && rows!.length < bufferTotal
		? ` _(computed from ${rows!.length.toLocaleString()} buffered rows of ${bufferTotal.toLocaleString()})_`
		: '';

	// ── Header stats ───────────────────────────────────────────────────────
	const fullRows = totalRows || col.count || (haveRows ? rows!.length : 0);
	headerLines.push(`Rows: ${fullRows.toLocaleString()}`);
	headerLines.push(`Distinct: ${withPct(col.uniqueCount ?? 0, fullRows)}`);
	headerLines.push(`Empty: ${(col.nullCount ?? 0).toLocaleString()}`);

	// ── Body (type-specific section) ─────────────────────────────────────────
	let bodyLines: string[];
	if (col.type === 'numeric') {
		bodyLines = numericSection(col, rows, fullRows, partial);
	} else if (col.type === 'datetime') {
		bodyLines = dateSection(col, rows, fullRows, partial);
	} else {
		// text + categorical share the frequency-distribution path.
		bodyLines = frequencySection(col, rows, fullRows, partial);
	}

	// ── Chart spec (deterministic, computed from the row buffer) ──────────────
	const chartSpec = await buildColumnChartSpec(col, rows);

	return {
		headerText: headerLines.join('\n'),
		// Drop the leading '' the section helpers prepend — the caller renders the
		// chart between header and body, so the body shouldn't open with a blank.
		bodyText: bodyLines.join('\n').replace(/^\n+/, ''),
		chartSpec
	};
}

/**
 * Compute the chart data series from the row buffer and shape it into a
 * Vega-Lite spec. Pure data prep here; spec shaping lives in chart-specs.ts.
 *
 *   - numeric     → 20-bin histogram across [min, max]
 *   - datetime    → counts grouped by calendar month ("YYYY-MM")
 *   - categorical → top values by frequency (full distribution from the buffer;
 *     text          else buildChartSpec falls back to the profile's topValues)
 *
 * Returns null when there's no plottable data.
 */
async function buildColumnChartSpec(
	col: ColumnProfile,
	rows?: Record<string, unknown>[]
): Promise<TopLevelSpec | null> {
	const { buildChartSpec } = await import('$lib/visuals/chart-specs.js');
	const haveRows = !!rows && rows.length > 0;

	let data: ChartData | null = null;

	if (col.type === 'numeric') {
		if (!haveRows) return null; // histogram needs the buffer — no synthetic charts
		const bins = computeHistogramBins(rows!, col.name, 20);
		data = bins ? { kind: 'histogram', bins } : null;
	} else if (col.type === 'datetime') {
		if (!haveRows) return null; // monthly buckets need the buffer
		const buckets = computeMonthBuckets(rows!, col.name);
		data = buckets ? { kind: 'timeseries', buckets } : null;
	} else if (haveRows) {
		// categorical + text → bar of top values (full distribution).
		const { freq } = frequencyOf(rows!, col.name);
		const values = sortedEntries(freq)
			.slice(0, 10)
			.map(([label, count]) => ({ label, count }));
		if (values.length) data = { kind: 'category', values };
	}

	// For categorical/text with no buffer, data stays null and buildChartSpec
	// falls back to the profile's topValues/sampleValues.
	return buildChartSpec(col, col.type, data);
}

/** A 20-bin equal-width histogram from the row buffer. */
function computeHistogramBins(
	rows: Record<string, unknown>[],
	column: string,
	bins: number
): Array<{ lo: number; hi: number; count: number }> | null {
	const nums: number[] = [];
	for (const row of rows) {
		const v = row[column];
		if (v === null || v === undefined || v === '') continue;
		const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[$,%]/g, ''));
		if (!isNaN(n)) nums.push(n);
	}
	if (!nums.length) return null;
	const min = Math.min(...nums);
	const max = Math.max(...nums);
	const span = max - min;
	const width = span > 0 ? span / bins : 1;
	const hist = Array.from({ length: bins }, (_, i) => ({
		lo: min + i * width,
		hi: i === bins - 1 ? max : min + (i + 1) * width,
		count: 0
	}));
	for (const n of nums) {
		let idx = span > 0 ? Math.floor((n - min) / width) : 0;
		if (idx >= bins) idx = bins - 1;
		if (idx < 0) idx = 0;
		hist[idx].count++;
	}
	return hist;
}

/** Counts grouped by calendar month ("YYYY-MM"), chronologically. */
function computeMonthBuckets(
	rows: Record<string, unknown>[],
	column: string
): Array<{ month: string; count: number }> | null {
	const counts = new Map<string, number>();
	for (const row of rows) {
		const d = parseCellDate(row[column]);
		if (!d) continue;
		const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	if (counts.size === 0) return null;
	return [...counts.entries()]
		.sort((a, b) => a[0].localeCompare(b[0]))
		.map(([month, count]) => ({ month, count }));
}

/** Numeric: min/max/mean/median/Q1/Q3 + 5-bucket histogram. */
function numericSection(
	col: ColumnProfile,
	rows: Record<string, unknown>[] | undefined,
	fullRows: number,
	partial: string
): string[] {
	const lines: string[] = [''];
	const stats = rows ? computeNumericStats(rows, col.name) : null;
	if (stats) {
		lines.push('**Distribution:**');
		lines.push(`- Min: ${stats.min.toLocaleString()} · Max: ${stats.max.toLocaleString()}`);
		lines.push(`- Mean: ${(Math.round(stats.mean * 100) / 100).toLocaleString()} · Median: ${stats.median.toLocaleString()}`);
		lines.push(`- Q1 (25%): ${stats.q1.toLocaleString()} · Q3 (75%): ${stats.q3.toLocaleString()}`);
		lines.push('');
		lines.push('**Histogram:**');
		const peak = Math.max(...stats.histogram.map((b) => b.count), 1);
		const fmt = (n: number) => (Number.isInteger(n) ? n.toLocaleString() : n.toFixed(1));
		for (const b of stats.histogram) {
			const barLen = Math.round((b.count / peak) * 20);
			const bar = '█'.repeat(barLen) || '·';
			lines.push(`- ${fmt(b.lo)}–${fmt(b.hi)}: ${bar} ${withPct(b.count, stats.count)}`);
		}
		lines.push('');
		lines.push(`**Summary:** Values range ${stats.min.toLocaleString()}–${stats.max.toLocaleString()} with a median of ${stats.median.toLocaleString()}. Half the data falls between ${stats.q1.toLocaleString()} (Q1) and ${stats.q3.toLocaleString()} (Q3).${partial}`);
		return lines;
	}
	// Fallback to the profile's pre-computed stats.
	if (col.min !== undefined) lines.push(`- Min: ${col.min}`);
	if (col.max !== undefined) lines.push(`- Max: ${col.max}`);
	if (col.mean !== undefined) lines.push(`- Mean: ${col.mean}`);
	if (col.median !== undefined) lines.push(`- Median: ${col.median}`);
	lines.push('');
	lines.push(`**Summary:** Numeric column ranging ${col.min ?? '?'}–${col.max ?? '?'} (mean ${col.mean ?? '?'}, median ${col.median ?? '?'}).`);
	return lines;
}

/** Date: range, most common dates, month/quarter gap analysis. */
function dateSection(
	col: ColumnProfile,
	rows: Record<string, unknown>[] | undefined,
	fullRows: number,
	partial: string
): string[] {
	const lines: string[] = [''];
	const stats = rows ? computeDateStats(rows, col.name) : null;
	if (stats) {
		const iso = (d: Date) => d.toISOString().slice(0, 10);
		lines.push('**Range:**');
		lines.push(`- ${iso(stats.min)} → ${iso(stats.max)} (${stats.monthsInRange} months spanned, ${stats.monthsPresent} with data)`);
		// Most common dates from the buffer.
		const { freq } = frequencyOf(rows!, col.name);
		const top = sortedEntries(freq).slice(0, 5);
		if (top.length && top[0][1] > 1) {
			lines.push('');
			lines.push('**Most common dates:**');
			top.forEach(([value, count], i) => lines.push(`${i + 1}. ${value} — ${withPct(count, stats.count)}`));
		}
		lines.push('');
		lines.push('**Patterns:**');
		if (stats.missingMonths.length === 0) {
			lines.push('- No gaps — every month in the range has at least one record.');
		} else if (stats.missingMonths.length <= 12) {
			lines.push(`- Missing months: ${stats.missingMonths.join(', ')}`);
		} else {
			lines.push(`- ${stats.missingMonths.length} of ${stats.monthsInRange} months have no records (sparse coverage).`);
		}
		lines.push('');
		lines.push(`**Summary:** Dates span ${iso(stats.min)} to ${iso(stats.max)}. ${stats.missingMonths.length === 0 ? 'Coverage is continuous across all months.' : `${stats.missingMonths.length} month(s) in that range have no data.`}${partial}`);
		return lines;
	}
	// Fallback: profile top values only.
	if (col.topValues?.length) {
		lines.push('**Most common dates:**');
		col.topValues.slice(0, 5).forEach((v, i) => lines.push(`${i + 1}. ${v.value} — ${withPct(v.count, fullRows)}`));
	}
	lines.push('');
	lines.push('**Summary:** Date column (detailed range/gap analysis needs the row buffer).');
	return lines;
}

/** Text + categorical: top values w/ %, prefix/length/structure patterns. */
function frequencySection(
	col: ColumnProfile,
	rows: Record<string, unknown>[] | undefined,
	fullRows: number,
	partial: string
): string[] {
	const lines: string[] = [''];

	// Prefer the row buffer (full distribution); fall back to the truncated profile.
	let entries: Array<[string, number]>;
	let nonEmpty: number;
	if (rows && rows.length > 0) {
		const f = frequencyOf(rows, col.name);
		entries = sortedEntries(f.freq);
		nonEmpty = f.nonEmpty;
	} else {
		const src = col.topValues?.length ? col.topValues : (col.sampleValues ?? []);
		entries = src.map((v) => [v.value, v.count] as [string, number]);
		nonEmpty = (col.count ?? fullRows) - (col.nullCount ?? 0);
	}

	const distinct = rows && rows.length > 0 ? entries.length : (col.uniqueCount ?? entries.length);
	const allSingletons = entries.length > 0 && entries.slice(0, 10).every(([, c]) => c <= 1);

	// ── Top values ─────────────────────────────────────────────────────────
	if (entries.length) {
		lines.push(allSingletons ? '**Example values** (each appears once):' : '**Top values:**');
		const shown = entries.slice(0, 10);
		shown.forEach(([value, count], i) => {
			lines.push(allSingletons ? `${i + 1}. ${value}` : `${i + 1}. ${value} — ${withPct(count, nonEmpty)}`);
		});
	}

	// ── Patterns ─────────────────────────────────────────────────────────────
	const patternLines: string[] = [];
	const distinctValues = entries.map(([v]) => v);

	if (!allSingletons) {
		const groups = computePrefixGroups(entries, nonEmpty, 0.05);
		for (const g of groups) {
			const range = g.min && g.max && g.min !== g.max ? ` (${g.min}–${g.max})` : '';
			const label = g.prefix === '#' ? 'Non-alphabetic values' : `${g.prefix}-prefix codes${range}`;
			patternLines.push(`- ${label}: ~${(g.share * 100).toFixed(0)}% of rows`);
		}
	}

	const lengths = computeLengthStats(distinctValues);
	if (lengths.max > 0) {
		patternLines.push(`- Value length: ${lengths.min}–${lengths.max} chars (avg ${lengths.avg.toFixed(1)})`);
	}
	const structure = detectStructure(distinctValues.slice(0, 500));
	if (structure) {
		patternLines.push(`- Structure: ${structure.label} (${(structure.share * 100).toFixed(0)}% of values)`);
	}
	patternLines.push(`- Cardinality: ${cardinalityNote(distinct, nonEmpty)}`);

	// Long-tail = distinct values that appear fewer than 100 times. Computed once
	// here and reused verbatim in the Summary so the two figures always match.
	// (Only meaningful when the full per-value distribution is available, i.e.
	// computed from the row buffer; the truncated profile fallback can't count it.)
	const haveFullDistribution = !!rows && rows.length > 0;
	const tailCount = haveFullDistribution ? entries.filter(([, c]) => c < 100).length : 0;
	if (!allSingletons && haveFullDistribution && tailCount > 0) {
		patternLines.push(`- Long tail: ${tailCount.toLocaleString()} value(s) appear <100 times each`);
	}

	if (patternLines.length) {
		lines.push('');
		lines.push('**Patterns:**');
		lines.push(...patternLines);
	}

	// ── Summary ────────────────────────────────────────────────────────────
	lines.push('');
	if (allSingletons) {
		lines.push(`**Summary:** ${col.name} is effectively unique — ${distinct.toLocaleString()} distinct values with little repetition, so there is no meaningful frequency distribution.${partial}`);
	} else if (entries.length) {
		const top = entries[0];
		const topShare = nonEmpty > 0 ? (top[1] / nonEmpty) * 100 : 0;
		const headCount = entries.slice(0, 8).reduce((s, [, c]) => s + c, 0);
		const headShare = nonEmpty > 0 ? (headCount / nonEmpty) * 100 : 0;
		// Long-tail phrasing must reuse the exact same `tailCount` shown in the
		// Patterns section (distinct values appearing <100 times). When the full
		// distribution isn't available (profile fallback), omit the tail clause
		// rather than print a different, derived number.
		const tailClause = haveFullDistribution && tailCount > 0
			? `, with a long tail of ${tailCount.toLocaleString()} value(s) appearing fewer than 100 times`
			: '';
		lines.push(`**Summary:** "${top[0]}" is the most common value at ${topShare.toFixed(1)}%. The top 8 values cover ~${headShare.toFixed(0)}% of rows${tailClause}.${partial}`);
	} else {
		lines.push(`**Summary:** No values to analyze.${partial}`);
	}

	return lines;
}

export function isConversationalQuestion(question: string): boolean {


	const q = question.toLowerCase().trim();

	// Conversational openers
	const conversationalPhrases = [
		'tell me', 'what is this', 'what does this', 'what are', 'explain',
		'summarize', 'summary', 'describe this', 'give me an overview',
		'overview', 'about this', 'what can you', 'help me understand',
		'what should i', 'what do you think', 'any insights', 'any thoughts',
		'what\'s interesting', "what's interesting", 'interesting about',
		'tell me about', 'more about', 'what does it', 'what is it',
		'how does', 'why does', 'what happened', 'what\'s going on',
		"what's going on", 'can you explain', 'can you tell', 'please explain',
		'please summarize', 'give me a', 'provide a', 'write a', 'create a'
	];

	for (const phrase of conversationalPhrases) {
		if (q.includes(phrase)) return true;
	}

	// Questions that start with "what" but don't reference a column operation
	// e.g. "what is this file?" vs "what is the total revenue?"
	// Heuristic: if the question has no numeric/aggregation keywords, treat as conversational
	// NOTE: keep this list in sync with the operations tryDirectOperation() can
	// build. A statistical keyword missing here (e.g. "median", "stddev") makes
	// the question look conversational, so it skips the deterministic operation
	// pipeline and goes to the LLM — which then HALLUCINATES the number
	// (e.g. answering "median of LicenseNo" with a made-up value). Every
	// aggregate/query keyword tryDirectOperation understands MUST appear here.
	const hasDataKeyword = /\b(total|sum|average|avg|mean|median|mode|stddev|std|standard deviation|variance|count|distinct|unique|max|maximum|min|minimum|top|bottom|filter|show|sort|group|trend|distribution|correlation|compare|rank|highest|lowest|largest|smallest|biggest|most|least|per|by|where|between|greater|less|equal)\b/.test(q);


	// Short questions without data keywords are likely conversational
	if (!hasDataKeyword && q.split(' ').length <= 8) return true;

	return false;
}

// ============================================================
// Document-metadata intercept (NO LLM) — pages / words / length
// ============================================================

/**
 * Detect a question about the document's size/length — page count, word count,
 * how long it is, reading time. These have exact, pre-computed answers
 * (summary.pageCount / summary.wordCount), so asking a small model to count
 * pages from a text blob only produces garbled guesses. Tight, explicit
 * patterns — anything not matched falls through to the normal path.
 */
export function isDocumentMetadataQuestion(question: string): boolean {
	const q = question.toLowerCase().trim();
	return (
		/\bhow many pages\b/.test(q) ||
		/\bpage count\b/.test(q) ||
		/\bnumber of pages\b/.test(q) ||
		/\bhow many words\b/.test(q) ||
		/\bword count\b/.test(q) ||
		/\bnumber of words\b/.test(q) ||
		/\breading time\b/.test(q) ||
		/\bhow long (is|to read)\b/.test(q) ||
		/\bhow long('s| is)? (this|the) (document|file|pdf|doc)\b/.test(q) ||
		/\bhow (big|large) (is )?(this|the) (document|file|pdf|doc)\b/.test(q)
	);
}

/**
 * Build a deterministic answer to a document-metadata question from the
 * pre-computed summary fields. Returns null if we have no usable metadata
 * (so the caller falls through to the normal path rather than answer emptily).
 *
 * Pages come from summary.pageCount (PDF/DOCX). Words come from
 * summary.wordCount; if absent, we recover the figure from structureNotes
 * ("~3,400 words") so older summaries still answer correctly. Reading time is
 * derived at ~200 wpm — the same rate the pipeline uses.
 */
export function answerDocumentMetadata(summary: CompressedSummary): string | null {
	// Recover word count: prefer the explicit field, else parse structureNotes.
	let words = summary.wordCount;
	if (words == null && summary.structureNotes) {
		const m = summary.structureNotes.match(/~?([\d,]+)\s+words/i);
		if (m) words = parseInt(m[1].replace(/,/g, ''), 10);
	}

	const pages = summary.pageCount;
	const hasPages = typeof pages === 'number' && pages > 0;
	const hasWords = typeof words === 'number' && words > 0;
	if (!hasPages && !hasWords) return null;

	const parts: string[] = [];
	if (hasPages) {
		parts.push(`**${pages.toLocaleString()}** page${pages === 1 ? '' : 's'}`);
	}
	if (hasWords) {
		const readingMin = Math.max(1, Math.ceil(words! / 200));
		parts.push(
			`**${words!.toLocaleString()}** word${words === 1 ? '' : 's'} (about a ${readingMin}-minute read)`
		);
	}

	return `This document has ${parts.join(' and ')}.`;
}

// ============================================================
// sanitizeChatResponse — strip leaked JSON operation objects
// ============================================================

/**
 * Detect and remove raw JSON operation objects that the LLM leaked into
 * a chat response. This happens when the model was prompted for a structured
 * operation but returned the JSON as prose instead of executing it.
 *
 * Examples of leaked JSON:
 *   {"type":"sort","column":"Order","direction":"desc"}
 *   {"type":"filter","filters":[...]}
 *
 * Strategy:
 *   1. If the entire response is a JSON object with a "type" key → it's a
 *      leaked operation. Return a generic fallback message.
 *   2. If the response contains JSON objects mixed with prose → strip the
 *      JSON fragments and return the remaining prose.
 *   3. Otherwise → return as-is.
 */
function sanitizeChatResponse(text: string): string {
	if (!text || text.trim().length === 0) return text;

	const trimmed = text.trim();

	// Strategy 1: entire response is one or more JSON operation objects (no prose)
	// Handles: single object, repeated objects, objects separated by whitespace
	// e.g. {"type":"sort",...}  {"type":"sort",...}
	if (trimmed.includes('"type"') && /^\s*\{/.test(trimmed)) {
		// Strip ALL {...} blocks that look like operation objects
		const withoutJson = trimmed
			.replace(/\{[^{}]*"type"\s*:\s*"[^"]*"[^{}]*\}/g, '')
			.trim();

		// If nothing meaningful remains (only whitespace/punctuation), it was all JSON
		if (withoutJson.replace(/[\s,;.]+/g, '').length === 0) {
			console.warn('[sanitizeChatResponse] Stripped all-JSON response');
			return "I wasn't able to process that query. Try rephrasing — for example: \"most common [column]\", \"top 5 [column]\", or \"filter [column] = [value]\".";
		}

		// Prose remains after stripping — return the prose
		if (withoutJson !== trimmed) {
			console.warn('[sanitizeChatResponse] Stripped JSON fragments from mixed response');
			return withoutJson.replace(/\s{2,}/g, ' ').trim();
		}
	}

	// Strategy 2: response is valid JSON with a "type" key (single clean object)
	if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
		try {
			const parsed = JSON.parse(trimmed);
			if (parsed && typeof parsed === 'object' && 'type' in parsed) {
				console.warn('[sanitizeChatResponse] Stripped single JSON operation:', parsed.type);
				return "I wasn't able to process that query. Try rephrasing — for example: \"most common [column]\", \"top 5 [column]\", or \"filter [column] = [value]\".";
			}
		} catch {
			// Not valid JSON — fall through
		}
	}

	return text;
}

function makeErrorResult(message: string, raw: string): ParsedLLMResponse {
	// Before giving up, try to extract natural language content
	if (raw.length > 20) {
		return extractNaturalLanguageFallback(raw);
	}
	return {
		sections: {
			summary: `Analysis could not be parsed. ${message}.`,
			error: message
		},
		raw,
		error: message
	};
}

// ============================================================
// buildChatPrompt — conversational prompt for user questions
// ============================================================

/**
 * Build a conversational prompt for a user question about the document.
 * Unlike buildPrompt (which generates a structured report), this answers
 * the user's specific question using the document as context.
 *
 * @param precomputedQueryResult - If provided, injected as ground-truth before the question.
 *   The LLM is instructed to use it verbatim rather than guessing.
 */
export function buildChatPrompt(
	summary: CompressedSummary,
	userQuestion: string,
	selectionContext?: string,
	precomputedQueryResult?: string
): string {
	const parts: string[] = [];

	// System instruction — explicit brevity constraint prevents the 0.5B model from rambling
	parts.push('You are a data analyst. Answer in 1-3 sentences. Be direct and specific. Stop after answering.');
	parts.push('Do not explain your reasoning. Do not repeat yourself. Do not use formulas or definitions.');
	// Anti-hallucination guard (defense-in-depth — the structural fix below, not
	// emitting count-bearing "ranking-shaped" lines for high-cardinality text, is
	// the real protection; small models ignore guardrails when the data
	// presentation invites pattern-completion).
	parts.push('Only use facts stated in the context. Do NOT invent value frequencies, rankings, counts, or "top N" lists that are not given. If the context lists example values, treat them as examples, not a ranked distribution.');

	if (precomputedQueryResult) {
		parts.push('IMPORTANT: A query was already computed for you. Use the COMPUTED QUERY RESULT as ground truth. Do NOT guess or estimate — report the exact number provided.');
	}
	parts.push('');

	// Document context (compact)
	parts.push('=== DOCUMENT CONTEXT ===');
	parts.push(`File: ${summary.fileName} (${summary.fileType.toUpperCase()})`);

	// CSV and Excel share the column-profile context path. Excel previously fell
	// into the structureNotes/textPreview branch below, which gave the small
	// model only a raw column-profile dump — it looped on it (e.g. repeating
	// "Licensee | categorical | top …"). Using column names + sample values
	// (same as CSV) produces coherent conversational answers.
	const isTabular = summary.fileType === 'csv' || summary.fileType === 'excel';

	if (isTabular) {
		parts.push(`Rows: ${summary.rowCount?.toLocaleString() ?? 'unknown'}, Columns: ${summary.columnCount ?? 'unknown'}`);
		if (summary.columnProfiles?.length) {
			const profiles = summary.columnProfiles;

			// Just column names + types for chat context — keep it short
			const cols = profiles.slice(0, 15)
				.map(c => `${c.name}(${c.type})`)
				.join(', ');
			parts.push(`Columns: ${cols}`);

			// Render one grounded "evidence" line for a column.
			//
			// CRITICAL: how the line is shaped controls hallucination. A
			// count-bearing line ("X (3), Y (1), …") for a high-cardinality TEXT
			// column reads like a ranked distribution table, and small models
			// pattern-complete it into a fabricated "top 10 … appears N times"
			// list (see the City/MailingAddress bug). So:
			//   - text → flat, explicitly-labeled EXAMPLES with NO counts
			//   - categorical/datetime → bounded top-value distribution WITH counts
			//     (counts are meaningful here: the value set is small and real)
			//   - numeric → actual min/max/mean range
			const describeForChat = (col: ColumnProfile): string | null => {
				if (col.type === 'numeric' && (col.min !== undefined || col.mean !== undefined)) {
					return `${col.name} (numeric): min ${col.min}, max ${col.max}, mean ${col.mean}`;
				}
				if (col.type === 'text') {
					// Factual framing: a high-cardinality free-text column genuinely
					// has little to summarize. State the concrete facts (cardinality,
					// % unique, nulls) so the model has something TRUE to say instead
					// of wandering into other columns' data and looping.
					const total = col.count || 0;
					const pctUnique = total > 0 ? Math.round((col.uniqueCount / total) * 100) : 0;
					const facts = `${col.name} (text): ${col.uniqueCount.toLocaleString()} distinct values across ${total.toLocaleString()} rows (~${pctUnique}% unique), ${col.nullCount.toLocaleString()} empty`;
					const vals = col.sampleValues?.length ? col.sampleValues : col.topValues;
					if (vals?.length) {
						const examples = vals.slice(0, 6).map(v => v.value).join(', ');
						return `${facts}. Example values (not a ranking): ${examples}`;
					}
					return facts;
				}
				// categorical / datetime — bounded, so counts are real signal
				if (col.topValues?.length) {
					const rendered = col.topValues.slice(0, 8).map(v => `${v.value} (${v.count})`).join(', ');
					return `${col.name} (${col.uniqueCount} distinct) top values: ${rendered}`;
				}
				return null;
			};


			// Prioritize the column the user is actually asking about so its real
			// values are always present — even if it sorts past the first few columns.
			const askedColName = findColumnInQuestion(userQuestion, profiles.map(c => c.name));
			const askedCol = askedColName ? profiles.find(c => c.name === askedColName) : undefined;

			const emitted = new Set<string>();
			if (askedCol) {
				const line = describeForChat(askedCol);
				if (line) {
					parts.push(line);
					emitted.add(askedCol.name);
				}
			}

			// FILLER COLUMNS (general context only).
			//
			// When the user asked about a SPECIFIC column, send ONLY that column —
			// no filler. Filler is what derailed "analyze City": the model abandoned
			// the high-cardinality City column and looped on a LastUpdate datetime
			// column's date list. A focused prompt keeps the model on topic.
			//
			// When NO specific column was asked (general "summarize this data"),
			// list a few value-bearing columns — but EXCLUDE datetime columns,
			// whose low-entropy date lists are the most loop-prone. (Datetime is
			// only ever shown when the user explicitly asks about that column,
			// which goes through the askedCol path above.)
			if (!askedCol) {
				const others = profiles
					.filter(c => !emitted.has(c.name) && (c.type === 'categorical' || c.type === 'text'))
					.slice(0, 3);
				for (const col of others) {
					const line = describeForChat(col);
					if (line) parts.push(line);
				}
			}
		}


	} else {
		// ── Non-tabular documents (txt / md / pdf / docx) ──────────────────────
		// GROUNDING GUARDRAIL (A): a small model handed a thin/empty preview will
		// confabulate entire fake documents (invented URLs, agencies, "[End Of
		// File]" boilerplate). Tell it, in no uncertain terms, to answer ONLY from
		// the text below and to say so plainly when the document is too short —
		// and give it the FULL document (not a 400-char slice) so "what is this
		// about" has the actual content to work from. textPreview already caps at
		// 500 chars upstream; short files (the common case) arrive complete.
		parts.push('Answer ONLY using the document text below. Do NOT invent or guess URLs, names, dates, organizations, numbers, or any facts that do not appear verbatim in it. If the document is too short or vague to answer, say exactly that in one sentence — do not pad the answer.');
		if (summary.structureNotes) parts.push(`Structure: ${summary.structureNotes}`);
		if (summary.textPreview) {
			parts.push('');
			parts.push('DOCUMENT (verbatim):');
			parts.push(summary.textPreview);
		} else {
			parts.push('');
			parts.push('DOCUMENT (verbatim): (empty — no extractable text)');
		}
	}

	if (selectionContext) {
		parts.push('');
		parts.push('Selected text:');
		parts.push(selectionContext.slice(0, 300));
	}



	parts.push('=== END CONTEXT ===');

	// Inject pre-computed query result BEFORE the question so the LLM sees it first
	if (precomputedQueryResult) {
		parts.push('');
		parts.push(precomputedQueryResult);
	}

	parts.push('');
	parts.push(`User question: ${userQuestion}`);
	parts.push('');
	parts.push('Answer:');

	const prompt = parts.join('\n');
	// Cap at 2500 chars to stay within model context budget
	return prompt.length > 2500 ? prompt.slice(0, 2500) : prompt;
}

// ============================================================
// buildContractPrompt — structured, risk-grouped contract prompt
// ============================================================

/**
 * Stop sequences for contract chat. Small models, once they run out of
 * grounded facts, drift into memorized legal boilerplate ("Note:", canned
 * disclaimers, markdown rules). We truncate the generated answer at the first
 * occurrence of any of these so the boilerplate never reaches the user.
 * Applied as POST-processing (runInference has no native stop-sequence param).
 */
const CONTRACT_STOP_SEQUENCES = ['Note:', 'This response', 'Please respect', '---'];

/** Truncate `text` at the earliest occurrence of any stop sequence. */
function applyStopSequences(text: string, stops: string[]): string {
	let cut = text.length;
	for (const s of stops) {
		const idx = text.indexOf(s);
		if (idx !== -1 && idx < cut) cut = idx;
	}
	return text.slice(0, cut).trimEnd();
}

/**
 * Fix punctuation spacing the small model garbles when echoing facts, e.g.
 * "March 14,2023" (missing space AFTER a comma) and
 * "Dispute Resolution ,Force Majeure" (stray space BEFORE a comma/period).
 * Pure cosmetic cleanup applied to the model's contract answer:
 *   1. drop any space(s) BEFORE , ; : . ! ?
 *   2. ensure exactly one space AFTER , ; : (not for . so "Inc." / "3.14" /
 *      decimals and abbreviations survive — sentence spacing is already fine)
 *   3. collapse runs of spaces
 * Never touches newlines.
 */
function normalizePunctuationSpacing(text: string): string {
	return text
		.replace(/[ \t]+([,;:.!?])/g, '$1')        // no space before punctuation
		// One space AFTER , ; : when followed by a non-space — UNLESS the comma/
		// colon sits directly between two digits (a thousands separator like
		// "1,900" or a time/ratio like "3:30" / "16:9"). Without this guard the
		// model's "1,900 hashes/sec" was being rewritten to "1, 900".
		.replace(/([,;:])(?=\S)/g, (m, p, offset, str) => {
			const before = str[offset - 1];
			const after = str[offset + 1];
			if (/\d/.test(before) && /\d/.test(after)) return m; // numeric separator
			return `${p} `;
		})
		.replace(/[ \t]{2,}/g, ' ');                // collapse multiple spaces
}



/**
 * Build a contract-specific chat prompt from the locally-computed
 * ContractProfile. The profile is the model's ONLY source of truth here — the
 * raw clause text never goes to the LLM beyond a 200-char excerpt per clause.
 *
 * Layout (most-grounded facts first):
 *   1. Strict system instruction (answer only from the profile; no invention)
 *   2. Parties + key dates + risk totals + missing standard clauses
 *   3. Clauses grouped HIGH → MEDIUM → LOW, each: "#num [RISK] Label — excerpt"
 *   4. The user's question
 *
 * Clauses are capped (high-risk first) and excerpts truncated to keep the
 * prompt within the small model's budget.
 */
/**
 * Build a compact, deterministic "fact sheet" from the ContractProfile —
 * parties, the effective/key dates (verbatim), and clause/risk totals. These
 * are the facts the small model must NEVER re-derive from raw text (it
 * hallucinates years, miscounts clauses, drops a party). Prepended to EVERY
 * contract LLM path — structured questions AND holistic summaries — so the
 * model always has the exact figures handed to it.
 *
 * Shape (matches the user's requested format):
 *   DETERMINISTIC FACTS (use exactly as written):
 *   Parties: Tiingo, Inc. and Gigperfect, LLC
 *   Effective Date: Mar 14, 2023
 *   Clauses: 36 total, 5 high-risk, 0 medium, 31 low
 */
export function buildContractFactSheet(
	profile: import('$lib/lenses/contract/types.js').ContractProfile
): string {
	const lines: string[] = ['DETERMINISTIC FACTS (use exactly as written):'];

	if (profile.parties.length > 0) {
		const names = profile.parties.map((p) => p.name);
		const joined =
			names.length <= 2
				? names.join(' and ')
				: `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
		lines.push(`Parties: ${joined}`);
	}

	// Dates verbatim — one "Label: Value" per line. These are the exact strings
	// the model must reproduce (the date-hallucination fix lives here).
	for (const d of profile.dates) {
		lines.push(`${d.label} Date: ${d.value}`);
	}

	const rs = profile.riskSummary;
	lines.push(
		`Clauses: ${profile.clauses.length} total, ${rs.high} high-risk, ${rs.medium} medium, ${rs.low} low`
	);

	if (profile.missingStandardClauses.length > 0) {
		lines.push(`Missing standard clauses: ${profile.missingStandardClauses.join(', ')}`);
	}

	return lines.join('\n');
}

export function buildContractPrompt(
	profile: import('$lib/lenses/contract/types.js').ContractProfile,
	userQuestion: string
): string {

	const parts: string[] = [];

	// Detect "top N risks" / "biggest risks" questions so we can (a) instruct the
	// model to return EXACTLY N numbered items and (b) prioritize the high-risk
	// clauses as context. Default N = 3 ("top 3 risks"). The earlier prompt said
	// "1-4 sentences", which let the model return a single risk — this forces a
	// numbered list of the requested count.
	const q = userQuestion.toLowerCase();
	const isRiskQuestion =
		/\b(top|biggest|main|key|worst|highest)\b.*\brisks?\b/.test(q) ||
		/\brisks?\b.*\b(top|biggest|main|key|worst|highest)\b/.test(q) ||
		/\bred flags?\b/.test(q);
	const nMatch = /\b(\d+)\b/.exec(q);
	const riskCount = nMatch ? Math.min(Math.max(parseInt(nMatch[1], 10), 1), 10) : 3;

	// Dates must be deterministic — small models confabulate years from memory
	// (e.g. saying "March 14, 2022" when the profile says 2023). The exact date
	// strings are injected verbatim below ("Key dates: …"); this instruction
	// forbids the model from altering them.
	const DATE_FIDELITY = 'Use dates exactly as provided. Do not change years, months, or days.';

	// 1. System instruction + anti-hallucination guard.
	if (isRiskQuestion) {
		parts.push(
			'You are a contract analyst. Answer ONLY using the contract profile below. ' +
				'Do not invent clauses, risk levels, parties, dates, or disclaimers. ' +
				DATE_FIDELITY + ' ' +
				`List exactly ${riskCount} risks. Number them 1-${riskCount}. ` +
				'Draw them from the HIGH RISK clauses first, then MEDIUM if fewer than ' +
				`${riskCount} high-risk clauses exist. One sentence each. ` +
				'If the profile has fewer risks than requested, list only those that exist. ' +
				'Be direct. Stop after the list.'
		);
	} else {
		parts.push(
			'You are a contract analyst. Answer ONLY using the contract profile below. ' +
				'Do not invent clauses, risk levels, parties, dates, or disclaimers. ' +
				DATE_FIDELITY + ' ' +
				"If the profile doesn't contain the answer, say so plainly. " +
				'Answer in 1-4 sentences. Be direct. Stop after answering.'
		);
	}


	parts.push('');
	parts.push('=== CONTRACT PROFILE (computed locally) ===');

	// 2. Parties / dates / risk totals / missing clauses.
	if (profile.parties.length > 0) {
		parts.push(
			'Parties: ' +
				profile.parties
					.map((p) => `${p.name}${p.role ? ` (${p.role})` : ''}`)
					.join('; ')
		);
	}
	if (profile.dates.length > 0) {
		// Render dates as an explicit, clearly-labeled block (not an inline list)
		// so the model can't miss them — these are the exact strings it must use
		// verbatim (see DATE_FIDELITY above). One "Label: Value" per line.
		parts.push('KEY DATES:');
		for (const d of profile.dates) {
			parts.push(`${d.label}: ${d.value}`);
		}
	}

	const rs = profile.riskSummary;
	parts.push(`Risk totals — HIGH: ${rs.high}, MEDIUM: ${rs.medium}, LOW: ${rs.low}.`);
	if (profile.missingStandardClauses.length > 0) {
		parts.push('Missing standard clauses: ' + profile.missingStandardClauses.join(', ') + '.');
	}

	// 3. Clauses grouped by risk: HIGH first, then MEDIUM, then LOW.
	// Each line: "#num [RISK] Label — <first 200 chars of clause text>".
	// Cap the total rendered clauses (high-risk prioritized by group order) so a
	// long contract stays within budget; note any overflow.
	const order: Array<import('$lib/lenses/contract/types.js').ClauseRisk> = ['high', 'medium', 'low'];
	const MAX_CLAUSES = 30;
	let rendered = 0;
	for (const level of order) {
		const group = profile.clauses.filter((c) => c.risk === level);
		if (group.length === 0) continue;
		parts.push('');
		parts.push(`${level.toUpperCase()} RISK clauses:`);
		for (const c of group) {
			if (rendered >= MAX_CLAUSES) break;
			const excerpt = (c.text ?? c.description ?? '')
				.replace(/\s+/g, ' ')
				.trim()
				.slice(0, 200);
			parts.push(`#${c.number} [${level.toUpperCase()}] ${c.label}${excerpt ? ` — ${excerpt}` : ''}`);
			rendered++;
		}
		if (rendered >= MAX_CLAUSES) break;
	}
	if (profile.clauses.length > rendered) {
		parts.push(`…and ${profile.clauses.length - rendered} more clause(s) not shown.`);
	}

	parts.push('=== END CONTRACT PROFILE ===');
	parts.push('');
	parts.push(`User question: ${userQuestion}`);
	parts.push('');
	parts.push('Answer:');

	const prompt = parts.join('\n');
	// Cap to keep the small model's context budget (matches buildChatPrompt).
	return prompt.length > 2800 ? prompt.slice(0, 2800) : prompt;
}

// ============================================================
// runChatInference — answer a user question about the document
// ============================================================

export interface RunChatOptions {

	onProgress?: (step: string, percent: number) => void;
	onModelProgress?: (percent: number, message: string) => void;
	selectionContext?: string;
	onToken?: (token: string) => void;
	/** Row buffer + column info for client-side query execution before LLM call */
	queryContext?: import('$lib/pipeline/query.js').QueryContext;
	/**
	 * Locally-computed contract profile (clauses + risk + parties + dates).
	 * When present, runChatInference takes a dedicated contract path that builds
	 * a structured, risk-grouped prompt and applies anti-hallucination guardrails
	 * so chat answers reference the ACTUAL classified clauses — never the small
	 * model's confabulated clause text/risk levels.
	 */
	contractProfile?: import('$lib/lenses/contract/types.js').ContractProfile;

	/**
	 * When true, skip the no-LLM query engine (compound filter parser +
	 * detectQueryIntent/executeQuery) entirely and send the prompt straight to
	 * the LLM. Used by menu-originated analysis prompts (e.g. "Analyze this
	 * column") which are narrative requests, not table queries, and must never
	 * be reinterpreted as a filter.
	 */
	skipQueryEngine?: boolean;
}


/**
 * Answer a user's specific question about the document.
 * Uses a conversational prompt (not a structured report template).
 * Uses the same inference.ts path as before streaming was introduced
 * to preserve output quality.
 */

/**
 * Leaf matcher shared with DocumentPane so the "Found N rows" count and the
 * rows shown in the left pane agree exactly — including date ⇄ serial ⇄ numeric
 * equivalence for compound (AND/OR/NOT) filters. Lazily imports matchesValue.
 */
async function makeLeafMatch() {
	const { matchesValue } = await import('$lib/pipeline/valueMatch.js');
	return (cell: unknown, query: string, op: string) =>
		op === 'eq' || op === 'contains'
			? matchesValue(cell, query, op as 'eq' | 'contains')
			: false;
}

export async function runChatInference(
	summary: CompressedSummary,
	userQuestion: string,
	modelConfig: ModelConfig,
	options: RunChatOptions = {}
): Promise<{ text: string; error: string | null; chartSpec?: TopLevelSpec | null }> {
	const { onProgress, onModelProgress, selectionContext, queryContext, skipQueryEngine, contractProfile } = options;


	// CSV and Excel are both row/column data — they share the entire structured
	// query/operation pipeline. (Excel previously fell through to the
	// conversational prompt and the small model looped on the column-profile
	// summary, e.g. repeating "Licensee | categorical | top …".)
	const isTabular = summary.fileType === 'csv' || summary.fileType === 'excel';

	// Deterministic contract facts (parties / dates / clause counts) that get
	// prepended to the fallback conversational prompt for HOLISTIC contract
	// questions. The LLM must never re-derive a date/party/count from raw text
	// (it hallucinates years — "2023" → "2022"). Set in the contract branch
	// below, consumed by buildChatPrompt() at the very end via the
	// precomputedQueryResult channel (which the prompt injects as ground truth).
	let contractFacts: string | undefined;

	// ── Contract chat path (dedicated) — highest precedence for contracts ────

	// When the contract lens is active, the caller passes the locally-computed
	// ContractProfile. We build a structured, risk-grouped prompt straight from
	// it (parties/dates → HIGH/MEDIUM/LOW clauses with type/number/excerpt) and
	// run inference with anti-hallucination guardrails (rep penalty 1.2,
	// no-repeat 4-grams, 256-token cap) plus stop-sequence truncation. This is
	// what stops the small model from confabulating clause text/risk levels —
	// the profile is its ONLY source of truth. Non-tabular by definition
	// (contracts are PDF/DOCX/TXT), so it sits ahead of every tabular branch.
	if (contractProfile && !isTabular) {
		console.log('[runChatInference] contract chat path:', contractProfile.clauses.length, 'clauses');

		// ── Tier 1: deterministic question router (NO LLM) ──────────────────
		// Known patterns (obligations, parties, dates, high-risk, governing law,
		// specific clause types, clause count, missing clauses) are answered
		// straight from the profile — instant, zero hallucination. Unmatched
		// questions return null and fall through to Tier 2 (LLM) below.
		const { routeContractQuestion, isHolisticQuestion } = await import('$lib/lenses/contract/question-router.js');
		const routed = routeContractQuestion(contractProfile, userQuestion);
		if (routed !== null) {
			console.log('[runChatInference] contract router hit (no LLM)');
			onProgress?.('Done', 100);
			return { text: routed, error: null };
		}

		// ── Tier 2: LLM ─────────────────────────────────────────────────────
		// Question shape decides what context the model receives:
		//   - HOLISTIC ("summarize", "what is this about"): the structured profile
		//     is useless to a small model for narrative — send the RAW document
		//     prose via the standard conversational prompt instead.
		//   - SPECIFIC (fact lookups the router didn't catch): send the structured
		//     profile so answers reference the ACTUAL classified clauses.
		if (isHolisticQuestion(userQuestion)) {
			console.log('[runChatInference] contract holistic → raw-text LLM path');
			// Fall out of the contract branch into the conversational prompt below,
			// which feeds summary.textPreview (raw document prose) to the model.
			// Hand it the deterministic fact sheet (parties / exact dates / clause
			// counts) so the summary uses those VERBATIM instead of re-deriving a
			// date from raw prose and hallucinating the year ("2023" → "2022").
			contractFacts = buildContractFactSheet(contractProfile);
		} else {
			const contractPrompt = buildContractPrompt(contractProfile, userQuestion);


			console.log('[runChatInference] contract prompt length:', contractPrompt.length);

			onProgress?.('Loading model…', 10);
			const { loadModel } = await import('$lib/llm/inference.js');
			let pipe: unknown;
			try {
				pipe = await loadModel(modelConfig, (progress) => {
					onModelProgress?.(progress.percent, progress.message);
					const overall = 10 + Math.round(progress.percent * 0.6);
					onProgress?.(progress.message, overall);
				});
			} catch (err) {
				const errMsg = err instanceof Error ? err.message : String(err);
				return { text: '', error: `Model load failed: ${errMsg}` };
			}

			onProgress?.('Thinking…', 75);
			const { runInference } = await import('$lib/llm/inference.js');
			// 256-token cap (contract answers are concise) + anti-repetition tuning.
			const result = await runInference(pipe, contractPrompt, 256, {
				repetitionPenalty: 1.2,
				noRepeatNgramSize: 4
			});
			onProgress?.('Done', 100);
			if (result.error) return { text: '', error: result.error };
			// Truncate at the first boilerplate stop sequence the model drifted into,
			// then normalize the punctuation spacing it garbles around commas
			// (e.g. "March 14,2023", "Dispute Resolution ,Force Majeure").
			return {
				text: normalizePunctuationSpacing(applyStopSequences(result.text, CONTRACT_STOP_SEQUENCES)),
				error: null
			};

		}
	}


	// ── Deterministic column analysis (NO LLM) — highest precedence ──────────

	// "Give me an analysis of the City column", "analyze BusinessName",
	// "breakdown of MailingAddress", "distribution/outliers/patterns of City".
	// Answerable directly from the pre-computed ColumnProfile, so we build
	// structured markdown and return it — never reaching the LLM, which would
	// otherwise confabulate ("18 million entries", invented city names). Runs
	// BEFORE the conversational gate so analysis questions never free-form.
	if (isTabular && summary.columnProfiles?.length) {
		const analysisCol = detectColumnAnalysis(userQuestion, summary.columnProfiles);
		if (analysisCol) {
			console.log('[runChatInference] deterministic column analysis (no LLM):', analysisCol.name);
			onProgress?.('Done', 100);
			const analysis = await buildColumnAnalysis(
				analysisCol,
				summary.rowCount ?? 0,
				queryContext?.rows,
				queryContext?.totalRowCount
			);
			// Header and body are joined with the CHART_SLOT sentinel so the chat
			// renderer can split and draw: header → chart → body. The chartSpec
			// rides alongside (null when nothing is plottable).
			return {
				text: `${analysis.headerText}${CHART_SLOT}${analysis.bodyText}`,
				error: null,
				chartSpec: analysis.chartSpec
			};
		}
	}

	// Narrative/analytical prompts ("give me an analysis of X", "explain", "tell
	// me about …") must NEVER be reinterpreted as a table query. The menu-driven

	// "Analyze this column" action sets skipQueryEngine, but a manually typed or
	// re-sent analytical question carries no flag — and the filter parser would
	// then grab a stray keyword (e.g. "Give") as a search pattern and return
	// "Found 0 rows matching 'Give'". Treat conversational questions as
	// query-engine-exempt too (defense in depth alongside skipQueryEngine).
	const useQueryEngine = !skipQueryEngine && !isConversationalQuestion(userQuestion);


	// ── Compound boolean filter (AND / OR / NOT) — intercept before detectQueryIntent ──
	// If the question contains AND/OR/NOT keywords, try to parse it as a compound
	// filter expression directly. This bypasses detectQueryIntent() which would
	// incorrectly treat "garage AND ZipCode=92661" as a single pattern.
	if (useQueryEngine && queryContext && isTabular && queryContext.rows.length > 0) {

		const hasLogicalOp = /\b(and|or|not|but not|except|excluding|without)\b/i.test(userQuestion);


		if (hasLogicalOp) {
			// Wrapped in try/catch so a parser/matcher hiccup degrades gracefully to
			// the normal query/LLM path below instead of surfacing as a hard
			// "Analysis failed: …" in the chat. (Mirrors the non-fatal treatment of
			// the detectQueryIntent block right below.)
			try {
				const { naturalLanguageToFilter, countMatches, describeFilter } =
					await import('$lib/pipeline/filter.js');
				const filterTree = naturalLanguageToFilter(userQuestion, queryContext.columns);
				if (filterTree) {
					const matchCount = countMatches(filterTree, queryContext.rows, await makeLeafMatch());
					const filterLabel = describeFilter(filterTree);
					const { workspace } = await import('$lib/stores/workspace.svelte.js');
					workspace.setActiveFilter({
						pattern: userQuestion,
						matchCount,
						filterTree
					});
					const partialNote = queryContext.rows.length < queryContext.totalRowCount
						? ` (from ${queryContext.rows.length.toLocaleString()} buffered rows)`
						: '';
					return {
						text: `Found **${matchCount.toLocaleString()}** rows matching ${filterLabel}${partialNote}. Results are now shown in the left pane. Click "Clear filter" to show all rows again.`,
						error: null
					};
				}
			} catch (e) {
				console.warn('[analysis] compound filter failed (non-fatal):', e);
				// Fall through to detectQueryIntent / LLM path below.
			}
		}
	}

	// ── Client-side query execution (before LLM) ──────────────────────────────
	// For CSV files, detect if the user is asking a computable question
	// (count, top-N, distinct, sum, avg, filter). If so, run it against the row
	// buffer and either:
	//   a) inject the real result into the prompt (count/sum/avg/top-N/distinct)
	//   b) set workspace.activeFilter and return immediately without calling LLM (filter_rows)
	let precomputedQueryResult: string | undefined;
	if (useQueryEngine && queryContext && isTabular && queryContext.rows.length > 0) {

		try {
			const { detectQueryIntent, executeQuery, formatQueryResultForPrompt } =


				await import('$lib/pipeline/query.js');
			const intent = detectQueryIntent(userQuestion, queryContext.columns);
			console.log('[runChatInference] detected query intent:', intent.type, intent);

			// ── Date filter intent: set activeFilter with date comparison ─────────
			if (intent.type === 'filter_date' && intent.dateValue) {
				const { dateValue, dateOp, column: col } = intent;
				const targetMs = dateValue.getTime();
				const cols = queryContext.columns;

				// Helper: parse a cell value as a Date
				function parseRowDate(v: unknown): Date | null {
					if (!v) return null;
					const s = String(v).trim();
					// Try direct parse
					const d = new Date(s);
					if (!isNaN(d.getTime())) return d;
					// Try MM/DD/YYYY
					const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
					if (m) {
						const yr = m[3].length === 2 ? 2000 + parseInt(m[3]) : parseInt(m[3]);
						const d2 = new Date(yr, parseInt(m[1]) - 1, parseInt(m[2]));
						if (!isNaN(d2.getTime())) return d2;
					}
					return null;
				}

				function matchesDateOp(rowDate: Date): boolean {
					const rowMs = rowDate.getTime();
					switch (dateOp) {
						case 'after':        return rowMs > targetMs;
						case 'before':       return rowMs < targetMs;
						case 'on':           return rowDate.toDateString() === dateValue.toDateString();
						case 'not_on':       return rowDate.toDateString() !== dateValue.toDateString();
						case 'on_or_after':  return rowMs >= targetMs;
						case 'on_or_before': return rowMs <= targetMs;
						default:             return rowMs > targetMs;

					}
				}

				let matchCount = 0;
				// Find which column(s) to check using semantic hint
				const hint = intent.semanticDateHint ?? 'any';
				const dateCols = col ? [col] : cols.filter(c => {
					const cl = c.toLowerCase().replace(/[\s_\-]/g, '');
					if (hint === 'update') return cl.includes('lastupdate') || cl.includes('updatedate') || cl.includes('modifieddate') || cl.includes('modified') || cl.includes('updated') || cl.includes('lastmodified') || cl.includes('changedate');
					if (hint === 'expiry') return cl.includes('expir') || cl.includes('expire');
					if (hint === 'issue') return cl.includes('issue') || cl.includes('issued') || cl.includes('issuance');
					// 'any': all date-like columns
					return cl.includes('date') || cl.includes('updated') || cl.includes('created') || cl.includes('modified') || cl.includes('expir') || cl.includes('issued');
				});
				const checkCols = dateCols.length > 0 ? dateCols : cols;

				for (const row of queryContext.rows) {
					for (const c of checkCols) {
						const d = parseRowDate(row[c]);
						if (d && matchesDateOp(d)) { matchCount++; break; }
					}
				}

				const { workspace } = await import('$lib/stores/workspace.svelte.js');
				const opLabel = { after: 'after', before: 'before', on: 'on', not_on: 'not on', on_or_after: 'on or after', on_or_before: 'on or before' }[dateOp ?? 'after'];

				const colLabel = col ? ` in "${col}"` : (dateCols.length > 0 ? ` in "${dateCols.join('", "')}"` : '');
				const dateLabel = dateValue.toLocaleDateString();
				const partialNote = queryContext.rows.length < queryContext.totalRowCount
					? ` (from ${queryContext.rows.length.toLocaleString()} buffered rows)`
					: '';

				// Store column only if the user explicitly named one.
				// If we auto-detected multiple date columns, leave column undefined
				// so DocumentPane checks ALL date columns (same heuristic as here).
				workspace.setActiveFilter({
					pattern: '',
					column: col,   // undefined when auto-detected
					matchCount,
					dateFilter: { dateMs: targetMs, dateOp: dateOp ?? 'after', semanticDateHint: intent.semanticDateHint }
				});

				return {
					text: `Found **${matchCount.toLocaleString()}** rows with dates ${opLabel} ${dateLabel}${colLabel}${partialNote}. Results are now shown in the left pane. Click "Clear filter" to show all rows again.`,
					error: null
				};
			}

			// ── Filter rows intent: set activeFilter, skip LLM entirely ──────────
			if (intent.type === 'filter_rows' && intent.pattern) {
				// Only route through the compound boolean parser when the pattern
				// actually contains a logical operator (AND / OR / NOT / except / …).
				// Otherwise the pattern is a literal substring — possibly multi-word,
				// e.g. "po box". naturalLanguageToFilter() tokenizes on spaces and
				// would mangle "po box" into a bare "po" term matched against ANY
				// column, producing the wrong column + a truncated value (the exact
				// bug behind: show me all mailingaddress with "po box" →
				// "any column contains po" → 0 rows). Keep the literal phrase intact
				// and match it against the column detectQueryIntent already resolved.
				const hasLogicalOp =
					/\b(and|or|not|but not|except|excluding|without)\b/i.test(intent.pattern);

				const { naturalLanguageToFilter, countMatches, describeFilter } =
					await import('$lib/pipeline/filter.js');
				const filterTree = hasLogicalOp
					? naturalLanguageToFilter(intent.pattern, queryContext.columns)
					: null;

				let matchCount = 0;
				let filterLabel = `"${intent.pattern}"`;
				let colLabel = intent.column ? ` in "${intent.column}"` : '';

				if (filterTree) {
					// Compound filter — use the recursive engine
					matchCount = countMatches(filterTree, queryContext.rows, await makeLeafMatch());
					filterLabel = describeFilter(filterTree);
					colLabel = ''; // description already includes column info
				} else {
					// Simple pattern match (fallback). Use the shared matchesValue()
					// so Excel date-serial ⇄ date-string equivalence and numeric
					// equality work here exactly as they do in the viewers (e.g.
					// "LastUpdate = 46133" matches the row whose LastUpdate shows
					// the date that serial 46133 represents).
					const { matchesValue } = await import('$lib/pipeline/valueMatch.js');
					const pat = intent.pattern;
					const col = intent.column;
					for (const row of queryContext.rows) {
						if (col) {
							if (matchesValue(row[col], pat, 'contains')) matchCount++;
						} else {
							if (queryContext.columns.some(c => matchesValue(row[c], pat, 'contains'))) matchCount++;
						}
					}
				}


				// When the simple (non-compound) path resolved a specific column,
				// synthesize a single-leaf filterTree so the editable FilterBar can
				// render the chip ("CountyName" / "contains" / "allegheny"). Without
				// this, activeFilter carried only {pattern, column} and the FilterBar
				// (which seeds exclusively from filterTree) showed an empty bar even
				// though the rows were correctly filtered. The column is the canonical
				// name detectQueryIntent() already resolved to.
				const leafTree =
					!filterTree && intent.column
						? ({ column: intent.column, op: 'contains', value: intent.pattern } as
								import('$lib/pipeline/filter.js').Filter)
						: undefined;

				const { workspace } = await import('$lib/stores/workspace.svelte.js');
				workspace.setActiveFilter({
					pattern: intent.pattern,
					column: intent.column,
					matchCount,
					filterTree: filterTree ?? leafTree ?? undefined
				});

				const partialNote = queryContext.rows.length < queryContext.totalRowCount
					? ` (from ${queryContext.rows.length.toLocaleString()} buffered rows)`
					: '';
				return {
					text: `Found **${matchCount.toLocaleString()}** rows matching ${filterLabel}${colLabel}${partialNote}. Results are now shown in the left pane. Click "Clear filter" to show all rows again.`,
					error: null
				};
			}

			// ── Sort rows intent: execute sort, set activeSort, skip LLM entirely ─
			if (intent.type === 'sort_rows' && intent.column) {
				const { executeSort } = await import('$lib/pipeline/engine.js');
				const rowBuffer = queryContext.rows as unknown as Record<string, string>[];
				const direction = intent.direction ?? 'asc';
				const sortResult = executeSort(rowBuffer, {
					columns: [{ column: intent.column, direction }]
				});

				const { workspace } = await import('$lib/stores/workspace.svelte.js');
				workspace.setActiveSort({ column: intent.column, direction });

				const dirLabel = direction === 'desc' ? 'descending' : 'ascending';
				const partialNote = queryContext.rows.length < queryContext.totalRowCount
					? ` (from ${queryContext.rows.length.toLocaleString()} buffered rows)`
					: '';
				const rowCount = sortResult.type === 'rows' ? sortResult.totalCount : queryContext.rows.length;
				return {
					text: `Sorted **${rowCount.toLocaleString()}** rows by **${intent.column}** (${dirLabel})${partialNote}. Results are now shown in the left pane.`,
					error: null
				};
			}

			// ── Other query intents: inject result into prompt ────────────────────
			if (intent.type !== 'none') {
				const result = executeQuery(intent, queryContext);
				if (result) {
					precomputedQueryResult = formatQueryResultForPrompt(result);
					console.log('[runChatInference] pre-computed result:', precomputedQueryResult);
				}
			}
		} catch (e) {
			console.warn('[runChatInference] query engine failed (non-fatal):', e);
		}
	}

	// ── Tabular operation pipeline (CSV + Excel with a row buffer) ───────────
	// For tabular files: use the structured operation pipeline instead of the
	// conversational prompt. This gives precise, deterministic answers for
	// aggregate/filter/sort/group/compare/trend/top_n/correlation/distribution/describe.
	// For non-tabular files, empty row buffers, or conversational questions: fall back.
	const isTabularWithRows = !skipQueryEngine
		&& isTabular
		&& queryContext
		&& queryContext.rows.length > 0
		&& !isConversationalQuestion(userQuestion);


	if (isTabularWithRows && queryContext) {
		// Guard: empty row buffer
		if (queryContext.rows.length === 0) {
			return { text: 'No data loaded. Please upload a file first.', error: null };
		}


		// ── Direct operation (no LLM) — keyword + fuzzy column matching ──────
		// For simple aggregate/top-N/distribution/describe questions where the
		// user explicitly names a column, we can build the operation directly
		// without calling the LLM. This avoids the 1.5B model hallucinating
		// column names like "Col1" when the actual columns are "LicenseNo" etc.
		const directOp = tryDirectOperation(userQuestion, queryContext.columns);
		if (directOp) {
			console.log('[runChatInference] direct operation (no LLM):', directOp.type, directOp);

			// ── filter operation → activate visual filter in left pane ────────────
			// Any filter op (eq, contains, etc.) sets workspace.activeFilter so the
			// CsvViewer highlights/hides matching rows. This applies to ALL filter
			// queries regardless of how they were phrased.
			if (directOp.type === 'filter' && directOp.filters?.length) {
				const f = directOp.filters[0];
				const filterValue = String(f.value ?? '');
				const filterCol = f.column;
				// Count matching rows using the same logic as the visual filter
				let matchCount = 0;
				for (const row of queryContext.rows) {
					const v = row[filterCol];
					if (v === null || v === undefined) continue;
					const cell = String(v).toLowerCase();
					const pat = filterValue.toLowerCase();
					const matches = f.op === 'eq' ? cell === pat : cell.includes(pat);
					if (matches) matchCount++;
				}
				// Carry a single-leaf filterTree (+ matching valueOp) so the editable
				// FilterBar renders the chip with the resolved column, operator, and
				// value. Without filterTree the bar seeds empty even though rows are
				// filtered. f.op is 'eq' or 'contains'; the chip reflects whichever.
				const leafOp: 'eq' | 'contains' = f.op === 'eq' ? 'eq' : 'contains';
				const { workspace } = await import('$lib/stores/workspace.svelte.js');
				workspace.setActiveFilter({
					pattern: filterValue,
					column: filterCol,
					matchCount,
					valueOp: leafOp,
					filterTree: { column: filterCol, op: leafOp, value: filterValue }
				});
				const partialNote = queryContext.rows.length < queryContext.totalRowCount
					? ` _(from ${queryContext.rows.length.toLocaleString()} buffered rows)_`
					: '';
				onProgress?.('Done', 100);
				return {
					text: `Found **${matchCount.toLocaleString()}** rows where **${filterCol}** ${f.op === 'eq' ? '=' : 'contains'} "${filterValue}"${partialNote}. Results are now shown in the left pane. Click "Clear filter" to show all rows again.`,
					error: null
				};
			}

			const { executeOnRows } = await import('$lib/pipeline/engine.js');

			const rowBuffer = queryContext.rows as unknown as Record<string, string>[];
			const opResult = executeOnRows(rowBuffer, directOp);
			const { formatResult } = await import('$lib/pipeline/resultFormatter.js');
			const chatMsg = formatResult(opResult);

			// For filtered counts, enrich the label with the filter value so the
			// user sees "12,345 rows where BusinessType = 'Sole Owner'" instead of
			// just "count(BusinessType): 12,345"
			let content = chatMsg.content;
			if (
				directOp.type === 'aggregate' &&
				directOp.function === 'count' &&
				directOp.filters?.length &&
				opResult.type === 'scalar'
			) {
				const f = directOp.filters[0];
				const count = opResult.value ?? 0;
				content = `**${count.toLocaleString()}** row${count !== 1 ? 's' : ''} where **${f.column}** = "${f.value}"`;
				// Add partial-buffer note if we only scanned a subset
				if (queryContext.rows.length < queryContext.totalRowCount) {
					content += ` _(from ${queryContext.rows.length.toLocaleString()} buffered rows)_`;
				}
			}

			onProgress?.('Done', 100);
			return { text: content, error: chatMsg.isError ? chatMsg.content : null };
		}

		// Build operation-classification prompt (pass selectionContext so the LLM
		// knows which cell/row/column the user is asking about)
		const { buildOperationPrompt } = await import('$lib/pipeline/operationPrompt.js');
		// The chat path operates on a single CSV/sheet, so adapt the streaming
		// CompressedSummary into a single-sheet WorkbookProfile. buildCompressedSummary()
		// renders single-sheet workbooks prefix-free, so the prompt is byte-for-byte
		// the same shape as before for the common (one-sheet) case.
		const opProfile: import('$lib/data/workbook.js').WorkbookProfile = {
			fileName: summary.fileName,
			totalRows: summary.rowCount ?? 0,
			totalColumns: summary.columnCount ?? summary.columnProfiles?.length ?? 0,
			sheets: [
				{
					name: summary.fileName,
					rowCount: summary.rowCount ?? 0,
					columns: summary.columnProfiles ?? [],
					hasFormulas: false
				}
			]
		};
		const opPrompt = buildOperationPrompt(opProfile, userQuestion, precomputedQueryResult, selectionContext);

		console.log('[runChatInference] operation prompt length:', opPrompt.length);

		// Load model
		onProgress?.('Loading model…', 10);
		const { loadModel } = await import('$lib/llm/inference.js');
		let pipe: unknown;
		try {
			pipe = await loadModel(modelConfig, (progress) => {
				onModelProgress?.(progress.percent, progress.message);
				const overall = 10 + Math.round(progress.percent * 0.6);
				onProgress?.(progress.message, overall);
			});
		} catch (err) {
			const errMsg = err instanceof Error ? err.message : String(err);
			return { text: '', error: `Model load failed: ${errMsg}` };
		}

		// Run inference — 256 tokens is enough for a structured JSON operation
		onProgress?.('Thinking…', 75);
		const { runInference } = await import('$lib/llm/inference.js');
		const inferenceResult = await runInference(pipe, opPrompt, 256);

		if (inferenceResult.error) {
			// Inference failure — preserve existing behavior
			return { text: '', error: inferenceResult.error };
		}

		// Parse LLM output into a DataOperation (with 4-strategy recovery)
		const { parseOperation } = await import('$lib/pipeline/operationParser.js');
		const operation = parseOperation(inferenceResult.text);
		console.log('[runChatInference] parsed operation:', operation.type, operation);

		// answer operation — LLM couldn't classify; show raw response
		if (operation.type === 'answer') {
			// If the LLM produced a meaningful answer text, show it.
			// Sanitize first — strip any leaked JSON operation objects.
			const responseText = sanitizeChatResponse(inferenceResult.text.trim() || (operation.context ?? ''));
			onProgress?.('Done', 100);
			return { text: responseText, error: null };
		}

		// ── filter operation from LLM → activate visual filter in left pane ──
		if (operation.type === 'filter' && operation.filters?.length) {
			const f = operation.filters[0];
			const filterValue = String(f.value ?? '');
			const filterCol = f.column;
			let matchCount = 0;
			for (const row of queryContext.rows) {
				const v = row[filterCol];
				if (v === null || v === undefined) continue;
				const cell = String(v).toLowerCase();
				const pat = filterValue.toLowerCase();
				const matches = f.op === 'eq' ? cell === pat : cell.includes(pat);
				if (matches) matchCount++;
			}
			// Same chip-rendering fix as the direct-operation path: carry a
			// single-leaf filterTree (+ valueOp) so the editable FilterBar seeds
			// the chip instead of showing an empty bar.
			const leafOp: 'eq' | 'contains' = f.op === 'eq' ? 'eq' : 'contains';
			const { workspace } = await import('$lib/stores/workspace.svelte.js');
			workspace.setActiveFilter({
				pattern: filterValue,
				column: filterCol,
				matchCount,
				valueOp: leafOp,
				filterTree: { column: filterCol, op: leafOp, value: filterValue }
			});
			const partialNote = queryContext.rows.length < queryContext.totalRowCount
				? ` _(from ${queryContext.rows.length.toLocaleString()} buffered rows)_`
				: '';
			onProgress?.('Done', 100);
			return {
				text: `Found **${matchCount.toLocaleString()}** rows where **${filterCol}** ${f.op === 'eq' ? '=' : 'contains'} "${filterValue}"${partialNote}. Results are now shown in the left pane. Click "Clear filter" to show all rows again.`,
				error: null
			};
		}


		// Execute the operation against the row buffer
		const { executeOnRows } = await import('$lib/pipeline/engine.js');
		// queryContext.rows is Record<string,unknown>[] — cast to Record<string,string>[]
		// The engine handles non-string values via its toNum/toStr helpers
		const rowBuffer = queryContext.rows as unknown as Record<string, string>[];
		const opResult = executeOnRows(rowBuffer, operation);

		// Format the result into a chat message
		const { formatResult } = await import('$lib/pipeline/resultFormatter.js');
		const chatMsg = formatResult(opResult);

		// Sanitize: if the engine returned raw JSON (shouldn't happen, but guard it)
		const safeContent = sanitizeChatResponse(chatMsg.content);

		onProgress?.('Done', 100);
		return { text: safeContent, error: chatMsg.isError ? chatMsg.content : null };
	}

	// ── Document-metadata intercept — deterministic, NO LLM ──────────────────
	// "how many pages", "how long is this document", "word count", "reading
	// time". These have exact, pre-computed answers (summary.pageCount /
	// summary.wordCount). A small model asked to count pages from an extracted
	// text blob has no page boundaries to work with and just garbles a guess —
	// so answer it directly from the metadata. Non-tabular only; CSV/Excel
	// "how many …" questions belong to the row/column query pipeline above.
	if (!isTabular && isDocumentMetadataQuestion(userQuestion)) {
		const metaAnswer = answerDocumentMetadata(summary);
		if (metaAnswer) {
			console.log('[runChatInference] document-metadata intercept (no LLM)');
			onProgress?.('Done', 100);
			return { text: metaAnswer, error: null };
		}
		// No usable metadata → fall through to the normal path.
	}

	// ── Tiny-document short-circuit (B) — deterministic, NO LLM ──────────────
	// For a very short non-tabular document (e.g. a 3-line .txt), a conversational
	// question like "what is this about" has no business going to a ~1.7B model:
	// with almost no context it confabulates entire fake documents (invented URLs,
	// agencies, "[End Of File]" boilerplate). Instead, just hand back the full text
	// verbatim with a one-line factual note. textPreview holds the first 500 chars
	// upstream, so a sub-500-char file arrives complete here.
	const TINY_DOC_CHARS = 500;
	const docText = (summary.textPreview ?? '').trim();
	if (
		!isTabular &&
		docText.length > 0 &&
		docText.length < TINY_DOC_CHARS &&
		isConversationalQuestion(userQuestion)
	) {
		console.log('[runChatInference] tiny-document short-circuit (no LLM):', docText.length, 'chars');
		onProgress?.('Done', 100);
		const lineCount = docText.split(/\r\n|\r|\n/).filter((l) => l.trim().length > 0).length;
		const note = `This document is short (${lineCount} line${lineCount === 1 ? '' : 's'}, ${docText.length} characters). Here is its full content:`;
		return { text: `${note}\n\n${docText}`, error: null };
	}

	// ── Fallback: conversational prompt (non-CSV or no row buffer) ───────────
	// Build conversational prompt (with optional pre-computed result injected).
	// For a HOLISTIC contract question, contractFacts holds the deterministic
	// fact sheet (parties / exact dates / clause counts); inject it through the
	// same ground-truth channel as a pre-computed query result so the model
	// uses those figures verbatim and never re-derives a date from raw prose.
	const groundTruth = [contractFacts, precomputedQueryResult]
		.filter((s): s is string => !!s)
		.join('\n\n') || undefined;
	const prompt = buildChatPrompt(summary, userQuestion, selectionContext, groundTruth);
	console.log('[runChatInference] prompt length:', prompt.length);


	// Load model (same path as runAnalysis — proven to work)
	onProgress?.('Loading model…', 10);
	const { loadModel } = await import('$lib/llm/inference.js');
	let pipe: unknown;
	try {
		pipe = await loadModel(modelConfig, (progress) => {
			onModelProgress?.(progress.percent, progress.message);
			const overall = 10 + Math.round(progress.percent * 0.6);
			onProgress?.(progress.message, overall);
		});
	} catch (err) {
		const errMsg = err instanceof Error ? err.message : String(err);
		return { text: '', error: `Model load failed: ${errMsg}` };
	}

	// Run inference. (C) Cap conversational answers at 128 new tokens — the
	// prompt already asks for 1-3 sentences, and a tight cap stops a small model
	// from drifting past its answer into memorized boilerplate ("Final Note:",
	// "[End Of File]", fake disclaimers) once it has nothing real left to say.
	// Mild anti-repetition tuning (penalty 1.2, no-repeat 4-grams) keeps it from
	// looping on a low-information prompt. Scoped to chat only; the structured
	// JSON report path (runAnalysis) keeps its larger budget and pure greedy.
	onProgress?.('Thinking…', 75);
	const { runInference } = await import('$lib/llm/inference.js');
	const result = await runInference(pipe, prompt, 128, {
		repetitionPenalty: 1.2,
		noRepeatNgramSize: 4
	});


	onProgress?.('Done', 100);
	// Normalize the punctuation spacing the small model garbles around commas
	// ("March 14,2023", "Dispute Resolution ,Force Majeure"). Applied to the
	// conversational fallback too so holistic contract summaries (which inject
	// the deterministic fact sheet) read cleanly.
	return {
		text: result.error ? result.text : normalizePunctuationSpacing(result.text),
		error: result.error
	};
}

// ============================================================
// runAnalysis — full pipeline: buildPrompt → loadModel → runInference → parse
// ============================================================


export interface RunAnalysisOptions {
	onProgress?: (step: string, percent: number) => void;
	onModelProgress?: (percent: number, message: string) => void;
}

/**
 * Full analysis pipeline.
 * 1. Build prompt from summary + template
 * 2. Load model (with progress)
 * 3. Run inference (with timeout)
 * 4. Parse LLM response into AnalysisResult
 */
export async function runAnalysis(
	summary: CompressedSummary,
	template: Template,
	modelConfig: ModelConfig,
	options: RunAnalysisOptions = {}
): Promise<AnalysisResult> {
	const { onProgress, onModelProgress } = options;
	const timings: Record<string, number> = {};

	// Step 1: Build prompt
	onProgress?.('Building prompt…', 5);
	const t0 = performance.now();
	const prompt = buildPrompt(summary, template);
	timings.buildPrompt = Math.round(performance.now() - t0);

	// Step 2: Load model
	onProgress?.('Loading model…', 10);
	const { loadModel } = await import('$lib/llm/inference.js');
	const t1 = performance.now();
	let pipe: unknown;
	try {
		pipe = await loadModel(modelConfig, (progress) => {
			onModelProgress?.(progress.percent, progress.message);
			// Map model load progress (0–100) to overall progress (10–70)
			const overall = 10 + Math.round(progress.percent * 0.6);
			onProgress?.(progress.message, overall);
		});
	} catch (err) {
		const errMsg = err instanceof Error ? err.message : String(err);
		console.error('[runAnalysis] Model load failed:', err);
		return {
			sections: { summary: `Model load failed: ${errMsg}` },
			templateId: template.id,
			createdAt: new Date().toISOString(),
			error: `Model load failed: ${errMsg}`
		};
	}
	timings.loadModel = Math.round(performance.now() - t1);

	// Step 3: Run inference
	// Cap max_new_tokens based on file type:
	// - CSV: structured JSON output is compact, 256 tokens is plenty
	// - Text: allow up to 512 tokens for richer analysis
	// Smaller max_new_tokens = smaller KV-cache allocation = less OOM risk on WebGPU
	onProgress?.('Analyzing…', 75);
	const { runInference } = await import('$lib/llm/inference.js');
	const t2 = performance.now();
	const maxNewTokens = summary.fileType === 'csv' ? 256 : 512;
	const inferenceResult = await runInference(pipe, prompt, maxNewTokens);
	timings.inference = Math.round(performance.now() - t2);

	if (inferenceResult.error) {
		return {
			sections: { summary: `Inference failed: ${inferenceResult.error}` },
			templateId: template.id,
			createdAt: new Date().toISOString(),
			error: inferenceResult.error
		};
	}

	// Step 4: Parse response
	onProgress?.('Parsing response…', 95);
	const parsed = parseLLMResponse(inferenceResult.text);

	onProgress?.('Done', 100);

	return {
		sections: parsed.sections,
		templateId: template.id,
		createdAt: new Date().toISOString(),
		error: parsed.error
	};
}
