/**
 * src/lib/pipeline/query.ts — Client-side CSV query engine
 *
 * Runs real queries against the in-memory row buffer BEFORE the LLM call.
 * Injects computed results into the prompt so the LLM narrates facts
 * rather than hallucinating counts.
 *
 * Supported query types (auto-detected from user question):
 *   - count_where:   "how many have X in their name / how many are in CA"
 *   - top_n:         "what are the top 10 / most common X"
 *   - distinct:      "how many unique / distinct X"
 *   - sum/avg:       "total / average of column X"
 *   - filter_sample: "show me rows where X contains Y"
 *
 * All queries run on workspace.csvRows (up to 100K buffered rows).
 * For files > 100K rows, results are annotated with a caveat.
 */

import type { ColumnProfile } from '$lib/types.js';

// ============================================================
// Types
// ============================================================

export interface TopNEntry {
	value: string;
	count: number;
}

export interface QueryResult {
	/** Human-readable description of what was computed */
	description: string;
	/** The computed value(s) */
	value: string | number | TopNEntry[];
	/** Whether the result covers all rows or just the buffered sample */
	isPartial: boolean;
	/** Total rows in dataset (may exceed buffered rows) */
	totalRows: number;
	/** Rows actually queried */
	queriedRows: number;
}

export interface QueryContext {
	rows: Record<string, unknown>[];
	columns: string[];
	columnProfiles: ColumnProfile[];
	totalRowCount: number; // true count from parser (may exceed rows.length)
}

// ============================================================
// Intent detection
// ============================================================

export type DateOperator = 'after' | 'before' | 'on' | 'not_on' | 'on_or_after' | 'on_or_before';

interface DetectedQuery {
	type: 'count_where' | 'top_n' | 'distinct' | 'sum' | 'avg' | 'filter_sample' | 'filter_rows' | 'filter_date' | 'sort_rows' | 'none';
	column?: string;
	pattern?: string;
	n?: number;
	/** For filter_date: the parsed date as a Date object */
	dateValue?: Date;
	/** For filter_date: the comparison operator */
	dateOp?: DateOperator;
	/**
	 * For filter_date when no explicit column was found:
	 * semantic hint to narrow which date columns to check.
	 * 'update' → LastUpdate/ModifiedDate/UpdateDate
	 * 'expiry' → ExpirationDate/ExpireDate
	 * 'issue'  → IssueDate/IssuedDate
	 * 'any'    → all date-like columns (default)
	 */
	semanticDateHint?: 'update' | 'expiry' | 'issue' | 'any';
	/** For sort_rows: sort direction */
	direction?: 'asc' | 'desc';
}

/**
 * Detect what kind of query the user is asking.
 * Returns 'none' if no structured query is detected.
 */
export function detectQueryIntent(
	question: string,
	columns: string[]
): DetectedQuery {
	const q = question.toLowerCase();

	// ── Open-ended analysis short-circuit ────────────────────────────────────
	// Requests that ask the LLM to ANALYZE / SUMMARIZE / EXPLAIN / DESCRIBE / WHY
	// are narrative questions, not structured table queries. Return 'none' early
	// so they're never misread as a filter (e.g. the "Analyze this column" menu
	// prompt `Analyze the X column: describe its distribution…` was being parsed
	// as `filter: any column contains "Analyze"`). This runs BEFORE any filter
	// logic, so it cannot affect count/top-N/filter detection for real queries.
	// NOTE: we deliberately do NOT include "what"/"how" here — "how many …" and
	// "what are the top 10 …" are legitimate structured queries handled below.
	if (/^\s*(?:please\s+)?(?:analy[sz]e|summar[ie]z?e|explain|describe|give me an? (?:analysis|overview|summary)|tell me about|why)\b/.test(q)) {
		return { type: 'none' };
	}

	// Normalize column names for matching

	// Strip spaces, underscores, hyphens for fuzzy matching
	const colLower = columns.map(c => c.toLowerCase());
	const colNorm = columns.map(c => c.toLowerCase().replace(/[\s_\-]/g, ''));
	// Also normalize the query the same way for column matching (used by findColumn internally)
	void q.replace(/[\s_\-]/g, ''); // qNorm — used inside findColumn via closure

	// Find which column is mentioned (longest match wins)
	// Tries both exact substring and normalized (no-space) substring
	function findColumn(text: string): string | undefined {
		const textNorm = text.replace(/[\s_\-]/g, '');
		let best: string | undefined;
		let bestLen = 0;
		for (let i = 0; i < columns.length; i++) {
			const cl = colLower[i];
			const cn = colNorm[i];
			// Exact match (e.g. "revenue" in "what is the revenue")
			if (text.includes(cl) && cl.length > bestLen) {
				best = columns[i];
				bestLen = cl.length;
			}
			// Normalized match (e.g. "lastupdate" matches "last update" or "last_update")
			if (cn.length >= 4 && textNorm.includes(cn) && cn.length > bestLen) {
				best = columns[i];
				bestLen = cn.length;
			}
		}
		return best;
	}

	// Extract quoted or unquoted search pattern
	function extractPattern(text: string): string | undefined {
		// Quoted: "tree service" or 'tree service'
		const quoted = text.match(/["']([^"']+)["']/);
		if (quoted) return quoted[1];
		// After "contains", "with", "named", "called", "matching", "=", "=="
		const after = text.match(/(?:contains?|with|named?|called|matching|like|includes?|==?)\s*([a-z0-9][a-z0-9 _-]*)/i);
		if (after) return after[1].trim();
		return undefined;
	}

	// COUNT WHERE pattern: "how many", "count of", "number of"
	if (/how many|count of|number of|# of/.test(q)) {
		const col = findColumn(q);
		const pattern = extractPattern(q);
		if (pattern) {
			return { type: 'count_where', column: col, pattern };
		}
		// "how many unique/distinct X"
		if (/unique|distinct/.test(q) && col) {
			return { type: 'distinct', column: col };
		}
		// "how many rows" → total count
		if (/rows?|records?|entries|items/.test(q)) {
			return { type: 'count_where', column: undefined, pattern: undefined };
		}
		// "how many are in X" / "how many contractors in X" / "how many X"
		// Extract the value after "in", "from", "at", "for", or at end of sentence
		const locationMatch = q.match(/\b(?:in|from|at|for)\s+([a-z][a-z0-9 ]+?)(?:\s*[?,.]|$)/);
		if (locationMatch) {
			const val = locationMatch[1].trim();
			if (val.length >= 2) {
				return { type: 'count_where', column: col, pattern: val };
			}
		}
		// Last resort: extract the last meaningful noun phrase after "how many"
		// e.g. "how many contractors are licensed" → no pattern, skip
		// e.g. "how many have expired licenses" → pattern = "expired"
		const afterHowMany = q.match(/how many\s+(?:\w+\s+)*?(?:are|have|with|named?|called)\s+([a-z][a-z0-9 ]+?)(?:\s*[?,.]|$)/);
		if (afterHowMany) {
			const val = afterHowMany[1].trim();
			if (val.length >= 2 && !['the', 'a', 'an', 'in', 'on', 'at', 'for', 'of'].includes(val)) {
				return { type: 'count_where', column: col, pattern: val };
			}
		}
	}

	// DISTINCT: "how many unique", "distinct values of"
	if (/unique|distinct|different/.test(q)) {
		const col = findColumn(q);
		if (col) return { type: 'distinct', column: col };
	}

	// TOP N: "top 5", "most common", "most frequent", "top ten"
	const topMatch = q.match(/top\s+(\d+|ten|five|three|twenty)/);
	const mostCommon = /most common|most frequent|most popular/.test(q);
	if (topMatch || mostCommon) {
		const col = findColumn(q);
		const nStr = topMatch?.[1];
		const n = nStr === 'ten' ? 10 : nStr === 'five' ? 5 : nStr === 'three' ? 3 : nStr === 'twenty' ? 20 : parseInt(nStr ?? '10');
		if (col) return { type: 'top_n', column: col, n: isNaN(n) ? 10 : n };
	}

	// SUM: "total", "sum of"
	if (/total|sum of|sum the/.test(q)) {
		const col = findColumn(q);
		if (col) return { type: 'sum', column: col };
	}

	// AVG: "average", "mean of"
	if (/average|mean of|avg/.test(q)) {
		const col = findColumn(q);
		if (col) return { type: 'avg', column: col };
	}

	// DATE FILTER: "updated after 08/06/2026", "created before 2024-01-01", "on 03/15/2025"
	// Detect date comparison queries and return filter_date intent.
	{
		const dateOpMap: Array<[RegExp, DateOperator]> = [
			[/\b(?:on or after|>=|since)\b/, 'on_or_after'],
			[/\b(?:on or before|<=|until|up to)\b/, 'on_or_before'],
			// Exact-match operators MUST be checked before the bare "after"/"before"/"on"
			// word matches. "LastUpdate = 09/15/2025" means rows ON that exact date,
			// not after it. Covers: =, ==, :, "equal(s)", "is", "exactly", "on".
			[/(?:==?|:|\bequals?\b|\bexactly\b|\bis\b)/, 'on'],
			[/\bafter\b/, 'after'],
			[/\bbefore\b/, 'before'],
			[/\bon\b/, 'on'],
		];

		// Match date patterns: MM/DD/YYYY, YYYY-MM-DD, MM-DD-YYYY, "January 5 2024", etc.
		const datePatterns = [
			/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/,   // MM/DD/YYYY or MM-DD-YYYY
			/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/,       // YYYY-MM-DD
		];
		let parsedDate: Date | null = null;
		let rawDateStr = '';
		for (const pat of datePatterns) {
			const m = q.match(pat);
			if (m) {
				rawDateStr = m[0];
				// Try to parse — handle both MM/DD/YYYY and YYYY-MM-DD
				const d = new Date(m[0].replace(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/, '$3-$1-$2'));
				if (!isNaN(d.getTime())) { parsedDate = d; break; }
				// Try direct parse
				const d2 = new Date(m[0]);
				if (!isNaN(d2.getTime())) { parsedDate = d2; break; }
			}
		}
		if (parsedDate) {
			let op: DateOperator = 'after';
			for (const [re, opVal] of dateOpMap) {
				if (re.test(q)) { op = opVal; break; }
			}
			// Try to find an explicit column name first
			let col = findColumn(q);

			// If no explicit column found, use semantic heuristics based on query keywords
			// to narrow down which date column(s) to check.
			// Store as a special marker so analysis.ts knows to use semantic matching.
			let semanticDateHint: 'update' | 'expiry' | 'issue' | 'any' = 'any';
			if (!col) {
				if (/last\s*(?:date|update|updated|modified|changed)|update\s*date|modified\s*date|recent/i.test(q)) {
					semanticDateHint = 'update';
				} else if (/expir|expiration|expire/i.test(q)) {
					semanticDateHint = 'expiry';
				} else if (/issue|issued|issuance/i.test(q)) {
					semanticDateHint = 'issue';
				}
			}

			return { type: 'filter_date', column: col, dateValue: parsedDate, dateOp: op, pattern: rawDateStr, semanticDateHint };
		}
	}

	// SORT ROWS: "sort by X", "order by X", "arrange by X"
	// Detected BEFORE filter_rows so "sort by name" doesn't get swallowed by the
	// filter_rows "find" keyword check.
	if (/\b(?:sort|order by|arrange)\b/.test(q)) {
		const col = findColumn(q);
		if (col) {
			// Direction detection — check DESC keywords first, then ASC, default asc
			let direction: 'asc' | 'desc' = 'asc';
			if (
				/high(?:est)?\s+(?:to\s+)?(?:low(?:est)?)|descend(?:ing)?|\bdesc\b|z\s+to\s+a|newest\s+first|latest\s+first/.test(q)
			) {
				direction = 'desc';
			} else if (
				/low(?:est)?\s+(?:to\s+)?(?:high(?:est)?)|ascend(?:ing)?|\basc\b|a\s+to\s+z|oldest\s+first|alphabetically/.test(q)
			) {
				direction = 'asc';
			}
			return { type: 'sort_rows', column: col, direction };
		}
	}

	// FILTER ROWS (show in left pane): "show me", "filter", "find", "display"
	// Also catch "column = value" patterns even without show/filter keywords.
	// These trigger a live table filter — no LLM call needed.
	if (/show me|filter|find|display|give me|=/.test(q)) {
		// ── Explicit "column <op> value" comparison ──────────────────────────
		// MUST run before extractPattern(). extractPattern matches connector
		// words like "with"/"contains" and captures the text up to the operator,
		// so for "show me all with LastUpdate = 46133" it returned the COLUMN
		// name ("lastupdate") as the pattern and dropped the value (46133).
		// Here we scan for an explicit operator, resolve the column from the
		// LEFT side, and take the RIGHT side as the value — so "LastUpdate = 46133"
		// → { column: 'LastUpdate', pattern: '46133' }.
		const cmp = q.match(
			/([a-z0-9 _\-]+?)\s*(>=|<=|!=|==|=|:)\s*("[^"]*"|'[^']*'|[^\s?]+(?:\s+[^\s?]+)*?)\s*[?.!]*\s*$/i
		);
		if (cmp) {
			const lhsRaw = cmp[1].trim();
			let rhs = cmp[3].trim().replace(/^["']|["']$/g, '');
			// Resolve the column from the LHS. The LHS often includes filler
			// ("show me all with LastUpdate") — findColumn picks the longest
			// column-name match anywhere in it.
			const cmpCol = findColumn(lhsRaw.toLowerCase());
			if (cmpCol && rhs.length >= 1) {
				return { type: 'filter_rows', column: cmpCol, pattern: rhs };
			}
		}

		const col = findColumn(q);
		const pattern = extractPattern(q);
		if (pattern) {
			return { type: 'filter_rows', column: col, pattern };
		}


		// If a column was identified, extract the VALUE that follows the column name.
		// e.g. "show me contractors of businesstype sole owner"
		//   → col=BusinessType, value="sole owner"
		// e.g. "show me contractors where city is los angeles"
		//   → col=City, value="los angeles"
		if (col) {
			const colLow = col.toLowerCase();
			// Build all forms of the column name to search for in the query:
			// "BusinessType" → ["businesstype", "business type", "business_type", "business-type"]
			const colForms: string[] = [colLow];
			// Add spaced version (camelCase split): "BusinessType" → "business type"
			const spaced = col.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
			if (spaced !== colLow) colForms.push(spaced);
			// Add underscore/hyphen variants
			colForms.push(colLow.replace(/[\s_\-]/g, ' ').trim());
			colForms.push(colLow.replace(/[\s_\-]/g, '_'));
			colForms.push(colLow.replace(/[\s_\-]/g, '-'));

			let afterCol = '';
			for (const form of colForms) {
				const idx = q.indexOf(form);
				if (idx >= 0) {
					afterCol = q.slice(idx + form.length).trim();
					break;
				}
			}

			// Fallback: word-by-word scan for the column's words
			if (!afterCol) {
				const words = q.split(/\s+/);
				const colWords = colLow.split(/[\s_\-]+/).filter(Boolean);
				for (let wi = 0; wi <= words.length - colWords.length; wi++) {
					if (words.slice(wi, wi + colWords.length).join(' ') === colWords.join(' ')) {
						afterCol = words.slice(wi + colWords.length).join(' ').trim();
						break;
					}
				}
			}

			// Strip leading connectors: "is", "are", "=", ":", "of", "equals"
			afterCol = afterCol.replace(/^(?:is|are|=|:|of|equals?|contains?|with|named?|called|matching)\s*/i, '').trim();
			// Strip trailing noise: "companies", "contractors", "records", "rows"
			afterCol = afterCol.replace(/\s+(?:companies?|contractors?|businesses?|records?|rows?|entries?)$/i, '').trim();
			if (afterCol.length >= 2) {
				return { type: 'filter_rows', column: col, pattern: afterCol };
			}
		}

		// "show me contractors in los angeles" — extract location after "in/from/at"
		// Only use this when no column was identified
		if (!col) {
			const locMatch = q.match(/\b(?:in|from|at|for)\s+([a-z][a-z0-9 ]+?)(?:\s*[?,.]|$)/);
			if (locMatch) {
				const val = locMatch[1].trim();
				if (val.length >= 2) {
					return { type: 'filter_rows', column: col, pattern: val };
				}
			}
			// "show me tree service companies" — last noun phrase
			const nounMatch = q.match(/(?:show me|filter|find|display|give me)\s+(?:all\s+)?(?:the\s+)?([a-z][a-z0-9 ]+?)(?:\s+(?:companies?|contractors?|businesses?|records?|rows?|entries?))?(?:\s*[?,.]|$)/);
			if (nounMatch) {
				const val = nounMatch[1].trim();
				if (val.length >= 2 && !['me', 'all', 'the', 'rows', 'records', 'data'].includes(val)) {
					return { type: 'filter_rows', column: col, pattern: val };
				}
			}
		}
	}

	// FILTER SAMPLE (legacy — for "show me rows where X contains Y" with explicit column)
	if (/show me|list|find rows?/.test(q)) {
		const col = findColumn(q);
		const pattern = extractPattern(q);
		if (col && pattern) return { type: 'filter_sample', column: col, pattern };
	}

	return { type: 'none' };
}

// ============================================================
// Query execution
// ============================================================

function toStr(v: unknown): string {
	if (v === null || v === undefined) return '';
	return String(v).toLowerCase();
}

function toNum(v: unknown): number | null {
	if (typeof v === 'number') return isNaN(v) ? null : v;
	if (typeof v === 'string') {
		const n = parseFloat(v.replace(/[$,%]/g, ''));
		return isNaN(n) ? null : n;
	}
	return null;
}

/**
 * Execute a detected query against the row buffer.
 * Returns null if the query type is 'none' or execution fails.
 */
export function executeQuery(
	intent: DetectedQuery,
	ctx: QueryContext
): QueryResult | null {
	const { rows, columns, totalRowCount } = ctx;
	const isPartial = rows.length < totalRowCount;
	const base = { isPartial, totalRows: totalRowCount, queriedRows: rows.length };

	if (intent.type === 'none') return null;

	try {
		switch (intent.type) {
			case 'count_where': {
				if (!intent.pattern && !intent.column) {
					// Just total row count
					return {
						...base,
						description: `Total row count`,
						value: totalRowCount
					};
				}
				const col = intent.column;
				const pat = intent.pattern?.toLowerCase() ?? '';
				let count = 0;
				for (const row of rows) {
					if (col) {
						if (toStr(row[col]).includes(pat)) count++;
					} else {
						// Search all columns
						if (columns.some(c => toStr(row[c]).includes(pat))) count++;
					}
				}
				const colLabel = col ? `in column "${col}"` : 'across all columns';
				return {
					...base,
					description: `Rows containing "${intent.pattern}" ${colLabel}`,
					value: count
				};
			}

			case 'distinct': {
				const col = intent.column!;
				const seen = new Set<string>();
				for (const row of rows) {
					const v = toStr(row[col]);
					if (v) seen.add(v);
				}
				return {
					...base,
					description: `Distinct values in column "${col}"`,
					value: seen.size
				};
			}

			case 'top_n': {
				const col = intent.column!;
				const n = intent.n ?? 10;
				const freq = new Map<string, number>();
				for (const row of rows) {
					const v = toStr(row[col]);
					if (v) freq.set(v, (freq.get(v) ?? 0) + 1);
				}
				const sorted = [...freq.entries()]
					.sort((a, b) => b[1] - a[1])
					.slice(0, n)
					.map(([value, count]) => ({ value, count }));
				return {
					...base,
					description: `Top ${n} values in column "${col}"`,
					value: sorted
				};
			}

			case 'sum': {
				const col = intent.column!;
				let sum = 0;
				let counted = 0;
				for (const row of rows) {
					const n = toNum(row[col]);
					if (n !== null) { sum += n; counted++; }
				}
				return {
					...base,
					description: `Sum of column "${col}" (${counted.toLocaleString()} non-null values)`,
					value: Math.round(sum * 100) / 100
				};
			}

			case 'avg': {
				const col = intent.column!;
				let sum = 0;
				let counted = 0;
				for (const row of rows) {
					const n = toNum(row[col]);
					if (n !== null) { sum += n; counted++; }
				}
				const avg = counted > 0 ? sum / counted : 0;
				return {
					...base,
					description: `Average of column "${col}" (${counted.toLocaleString()} non-null values)`,
					value: Math.round(avg * 100) / 100
				};
			}

			case 'filter_sample': {
				const col = intent.column!;
				const pat = intent.pattern?.toLowerCase() ?? '';
				const matches: Record<string, unknown>[] = [];
				for (const row of rows) {
					if (toStr(row[col]).includes(pat)) {
						matches.push(row);
						if (matches.length >= 10) break;
					}
				}
				// Count total matches
				let totalMatches = 0;
				for (const row of rows) {
					if (toStr(row[col]).includes(pat)) totalMatches++;
				}
				const sample = matches.slice(0, 5).map(r => {
					// Show first 4 columns of each matching row
					const entry: Record<string, unknown> = {};
					columns.slice(0, 4).forEach(c => { entry[c] = r[c]; });
					return entry;
				});
				return {
					...base,
					description: `${totalMatches.toLocaleString()} rows where "${col}" contains "${intent.pattern}" (showing first 5)`,
					value: JSON.stringify(sample, null, 2)
				};
			}
		}
	} catch (e) {
		console.warn('[query] execution failed:', e);
		return null;
	}
	return null;
}

// ============================================================
// Format query result for injection into LLM prompt
// ============================================================

/**
 * Format a QueryResult as a compact string to inject into the LLM prompt.
 * The LLM is instructed to use this as ground truth.
 */
export function formatQueryResultForPrompt(result: QueryResult): string {
	const lines: string[] = [];
	lines.push('=== COMPUTED QUERY RESULT (use this as ground truth) ===');
	lines.push(`Query: ${result.description}`);

	if (Array.isArray(result.value)) {
		// top_n result
		lines.push('Results:');
		for (const item of result.value as TopNEntry[]) {
			lines.push(`  ${item.value}: ${item.count.toLocaleString()}`);
		}
	} else if (typeof result.value === 'string' && result.value.startsWith('[')) {
		lines.push('Sample rows:');
		lines.push(result.value);
	} else {
		lines.push(`Result: ${typeof result.value === 'number' ? result.value.toLocaleString() : result.value}`);
	}

	if (result.isPartial) {
		lines.push(`Note: Result is based on ${result.queriedRows.toLocaleString()} buffered rows out of ${result.totalRows.toLocaleString()} total. Actual value may differ.`);
	} else {
		lines.push(`(Based on all ${result.queriedRows.toLocaleString()} rows)`);
	}
	lines.push('=== END QUERY RESULT ===');
	return lines.join('\n');
}
