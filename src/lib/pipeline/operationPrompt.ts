/**
 * src/lib/pipeline/operationPrompt.ts — LLM system prompt for CSV operation classification
 *
 * Exports:
 *   CSV_OPERATION_SYSTEM_PROMPT  — static system prompt defining all operation types
 *   buildOperationPrompt()       — assembles the full prompt with data summary + question
 *   formatSummaryForPrompt()     — formats a WorkbookProfile into compact text
 *   formatColumnStats()          — formats a single ColumnProfile into a one-liner
 *   capPrompt()                  — truncates prompt to maxChars, preserving structure
 */

import type { ColumnProfile } from '$lib/types.js';
import type { WorkbookProfile } from '$lib/data/workbook.js';
import { buildCompressedSummary } from '$lib/pipeline/pipeline.js';


// ============================================================
// Static system prompt
// ============================================================

export const CSV_OPERATION_SYSTEM_PROMPT = `You are a CSV data analysis engine. Your job is to classify the user's question into a structured JSON operation.

OUTPUT RULES:
- Respond with ONLY a valid JSON object. No prose, no markdown, no code fences.
- Use exact column names from the dataset (case-sensitive).
- Use ISO 8601 dates (YYYY-MM-DD) in filter values.
- If the question is ambiguous, pick the best matching operation.
- If no operation fits, use {"type":"answer","question":"<user question>","context":"<reason>"}.

OPERATION TYPES:

1. aggregate — compute a single value from a column
{"type":"aggregate","function":"sum|avg|min|max|count|median|stddev","column":"ColName","filters":[...],"groupBy":"ColName"}
Example: "total revenue" → {"type":"aggregate","function":"sum","column":"Revenue"}

2. filter — return rows matching conditions
{"type":"filter","filters":[{"column":"Col","op":"eq|neq|gt|gte|lt|lte|contains|starts_with|in|between","value":"..."}],"columns":["Col1","Col2"],"sort":{"column":"Col","direction":"asc|desc"},"limit":50}
Example: "show rows where Status is Active" → {"type":"filter","filters":[{"column":"Status","op":"eq","value":"Active"}]}

3. sort — order rows by one or more columns
{"type":"sort","columns":[{"column":"Col","direction":"asc|desc"}],"limit":20}
Example: "sort by date descending" → {"type":"sort","columns":[{"column":"Date","direction":"desc"}]}
Example: "sort by revenue high to low" → {"type":"sort","columns":[{"column":"revenue","direction":"desc"}]}
Example: "sort alphabetically by product name" → {"type":"sort","columns":[{"column":"product","direction":"asc"}]}
Example: "sort by region then by revenue descending" → {"type":"sort","columns":[{"column":"region","direction":"asc"},{"column":"revenue","direction":"desc"}]}
Example: "order by date newest first, show top 20" → {"type":"sort","columns":[{"column":"date","direction":"desc"}],"limit":20}

4. group — group rows and compute aggregates per group
{"type":"group","column":"GroupCol","aggregates":[{"function":"sum|avg|count|min|max","column":"ValueCol","alias":"label"}]}
Example: "revenue by region" → {"type":"group","column":"Region","aggregates":[{"function":"sum","column":"Revenue","alias":"Total Revenue"}]}

5. compare — compare a metric across categories
{"type":"compare","column":"ValueCol","by":"CategoryCol","function":"sum|avg|count"}
Example: "compare sales by product" → {"type":"compare","column":"Sales","by":"Product","function":"sum"}

6. trend — aggregate a metric over time
{"type":"trend","column":"ValueCol","over":"DateCol","function":"sum|avg"}
Example: "revenue over time" → {"type":"trend","column":"Revenue","over":"Month","function":"sum"}

7. top_n / bottom_n — rank categories by value
{"type":"top_n","n":10,"column":"ValueCol","by":"CategoryCol"}
{"type":"bottom_n","n":5,"column":"ValueCol","by":"CategoryCol"}
Example: "top 5 customers by revenue" → {"type":"top_n","n":5,"column":"Revenue","by":"Customer"}

8. correlation — Pearson correlation between two numeric columns
{"type":"correlation","column_a":"Col1","column_b":"Col2"}
Example: "correlation between price and sales" → {"type":"correlation","column_a":"Price","column_b":"Sales"}

9. distribution — histogram of a numeric column
{"type":"distribution","column":"ColName","bins":10}
Example: "distribution of age" → {"type":"distribution","column":"Age"}

10. describe — statistical summary of columns
{"type":"describe","columns":["Col1","Col2"]}
Example: "describe the dataset" → {"type":"describe"}

11. answer — general question that doesn't map to a structured operation
{"type":"answer","question":"<user question>","context":"<reason why no operation fits>"}

12. crossSheet — relate a column in one sheet to a column in another (correlation/join across sheets)
{"type":"crossSheet","sheetA":"SheetName","columnA":"Col","sheetB":"OtherSheet","columnB":"Col"}
Example: "does marketing spend correlate with revenue?" → {"type":"crossSheet","sheetA":"Marketing","columnA":"Spend","sheetB":"Revenue","columnB":"Amount"}

MULTI-SHEET RULES:
- The dataset summary tells you how many sheets exist. If there is only ONE sheet, do NOT include a "sheet" field — output operations exactly as shown in the examples above.
- If there are MULTIPLE sheets, you MUST include a "sheet" field naming the target sheet in EVERY single-sheet operation (aggregate, filter, sort, group, compare, trend, top_n, bottom_n, correlation, distribution, describe).
- To compare or relate data ACROSS two different sheets, use the crossSheet operation (it names both sheets explicitly and takes no top-level "sheet" field).

MULTI-SHEET EXAMPLES (only when the summary lists more than one sheet):
- "compare revenue across all sheets" → run one aggregate per sheet, e.g. {"type":"aggregate","function":"sum","column":"Revenue","sheet":"Q1"} (repeat per sheet name listed in the summary)
- "does marketing spend correlate with revenue?" → {"type":"crossSheet","sheetA":"Marketing","columnA":"Spend","sheetB":"Revenue","columnB":"Amount"}
- "what's the formula in cell D23 on the Summary sheet?" → {"type":"describe","columns":["D23"],"sheet":"Summary"}

FILTER OPERATORS:
- eq: exact match (string or number)
- neq: not equal
- gt / gte / lt / lte: numeric or date comparison
- contains: case-insensitive substring
- starts_with: case-insensitive prefix
- in: value in list → value must be string[]
- between: inclusive range → value must be [min, max] as [number, number]

RULES:
- Use exact column names from the dataset. Do not invent column names.
- For date filters, use ISO 8601: "2024-01-15"
- For "between", value is [min, max]: {"column":"Age","op":"between","value":[18,65]}
- For "in", value is string[]: {"column":"Status","op":"in","value":["Active","Pending"]}
- If the question mentions multiple conditions, use multiple filter objects (ANDed together).
- If the question is ambiguous, pick the most specific operation that fits.
- If no operation fits, use the "answer" fallback.
- Output ONLY the JSON object. Nothing else.`;

// ============================================================
// formatColumnStats — one-liner per column
// ============================================================

/**
 * Format a single ColumnProfile into a compact one-liner for the prompt.
 * Numeric: name (numeric) | count=N, unique=U, nulls=X | min=M, max=M, mean=M
 * Categorical: name (categorical) | count=N, unique=U | top: A(10), B(8), C(5)
 * Datetime: name (datetime) | count=N, unique=U | top: 2024-01(5), 2024-02(3)
 * Text: name (text) | count=N, unique=U, nulls=X
 */
export function formatColumnStats(col: ColumnProfile): string {
	const parts: string[] = [`${col.name} (${col.type})`];
	parts.push(`count=${col.count}, unique=${col.uniqueCount}, nulls=${col.nullCount}`);

	if (col.type === 'numeric') {
		const stats: string[] = [];
		if (col.min !== undefined) stats.push(`min=${col.min}`);
		if (col.max !== undefined) stats.push(`max=${col.max}`);
		if (col.mean !== undefined) stats.push(`mean=${col.mean}`);
		if (col.median !== undefined) stats.push(`median=${col.median}`);
		if (stats.length) parts.push(stats.join(', '));
	} else if ((col.type === 'categorical' || col.type === 'datetime') && col.topValues?.length) {
		const top = col.topValues
			.slice(0, 5)
			.map(v => `${v.value}(${v.count})`)
			.join(', ');
		parts.push(`top: ${top}`);
	}

	return parts.join(' | ');
}

// ============================================================
// formatSummaryForPrompt — compact dataset description
// ============================================================

/**
 * Format a WorkbookProfile into a compact text block for the prompt.
 *
 * Delegates the actual compression to `buildCompressedSummary()` (pipeline.ts),
 * which produces a single-sheet, prefix-free body for one-sheet workbooks and a
 * per-sheet ("## Sheet: …") body for multi-sheet workbooks. The body is wrapped
 * in === DATASET === / === END DATASET === markers so `capPrompt()` can locate
 * and truncate it without touching the system prompt or the question.
 */
export function formatSummaryForPrompt(profile: WorkbookProfile): string {
	const body = buildCompressedSummary(profile);
	return `=== DATASET ===\n${body}\n=== END DATASET ===`;
}


// ============================================================
// capPrompt — truncate to maxChars, preserve structure
// ============================================================

const MAX_PROMPT_CHARS = 2500;

/**
 * Cap the full prompt to maxChars characters.
 *
 * Strategy:
 *   1. If prompt fits, return as-is.
 *   2. Truncate the summary section first (between === DATASET === and === END DATASET ===).
 *   3. If still too long, truncate the summary block to fit.
 *   4. Never cut mid-word — trim to last space boundary.
 *   5. Always preserve the system prompt and user question.
 */
export function capPrompt(prompt: string, maxChars = MAX_PROMPT_CHARS): string {
	if (prompt.length <= maxChars) return prompt;

	// Find the dataset block boundaries
	const datasetStart = prompt.indexOf('=== DATASET ===');
	const datasetEnd = prompt.indexOf('=== END DATASET ===');

	if (datasetStart === -1 || datasetEnd === -1) {
		// No dataset block — truncate at word boundary
		return truncateAtWord(prompt, maxChars);
	}

	const before = prompt.slice(0, datasetStart);          // system prompt
	const after = prompt.slice(datasetEnd + '=== END DATASET ==='.length); // question + computed result
	const datasetBlock = prompt.slice(datasetStart, datasetEnd + '=== END DATASET ==='.length);

	const fixedLen = before.length + after.length;
	const budgetForDataset = maxChars - fixedLen;

	if (budgetForDataset <= 0) {
		// Fixed parts already exceed budget — truncate at word boundary
		return truncateAtWord(before + after, maxChars);
	}

	if (datasetBlock.length <= budgetForDataset) {
		// Dataset fits — no truncation needed (shouldn't reach here, but guard)
		return prompt.slice(0, maxChars);
	}

	// Truncate the dataset block to fit the budget
	const truncatedDataset = truncateAtWord(datasetBlock, budgetForDataset);
	return before + truncatedDataset + after;
}

/** Truncate a string to maxChars at the last word boundary (space). */
function truncateAtWord(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const cut = text.slice(0, maxChars);
	const lastSpace = cut.lastIndexOf(' ');
	return lastSpace > maxChars * 0.8 ? cut.slice(0, lastSpace) : cut;
}

// ============================================================
// buildOperationPrompt — assemble the full prompt
// ============================================================

/**
 * Build the full prompt for CSV operation classification.
 *
 * Structure:
 *   [CSV_OPERATION_SYSTEM_PROMPT]
 *   [Dataset summary]
 *   [Selected cell/row/column context (if provided)]
 *   [Computed result (if provided)]
 *   [User question]
 *
 * Capped to 2500 chars. Summary is truncated first if needed.
 */
export function buildOperationPrompt(
	profile: WorkbookProfile,
	question: string,
	computedResult?: string,
	selectionContext?: string
): string {
	const parts: string[] = [];

	// 1. System prompt
	parts.push(CSV_OPERATION_SYSTEM_PROMPT);
	parts.push('');

	// 2. Dataset summary
	parts.push(formatSummaryForPrompt(profile));

	parts.push('');

	// 3. Selected cell/row/column context — inject BEFORE the question so the
	//    LLM knows exactly which data the user is asking about.
	if (selectionContext) {
		parts.push('=== USER SELECTION (the user has selected this data) ===');
		parts.push(selectionContext);
		parts.push('=== END USER SELECTION ===');
		parts.push('');
	}

	// 4. Pre-computed result (ground truth — inject before question)
	if (computedResult) {
		parts.push('=== PRE-COMPUTED RESULT (use as ground truth) ===');
		parts.push(computedResult);
		parts.push('=== END PRE-COMPUTED RESULT ===');
		parts.push('');
	}

	// 5. User question
	parts.push(`Question: ${question}`);
	parts.push('');
	parts.push('Respond with ONLY the JSON operation object:');

	const full = parts.join('\n');
	return capPrompt(full, MAX_PROMPT_CHARS);
}
