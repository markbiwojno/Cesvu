/**
 * src/lib/pipeline/operationParser.ts — LLM output parser with recovery strategies
 *
 * Parses raw LLM text into a DataOperation with four recovery strategies:
 *   1. Direct JSON.parse
 *   2. Extract JSON from ```json ... ``` code blocks
 *   3. Extract first {...} object from text
 *   4. Fallback to { type: "answer", question: raw, context: "..." }
 */

import type { DataOperation } from '$lib/pipeline/operations.js';

// ============================================================
// validateOperation — type guard
// ============================================================

/**
 * Validate that an unknown value is a well-formed DataOperation.
 * Checks the `type` discriminant and required fields per operation type.
 */
export function validateOperation(op: unknown): op is DataOperation {
	if (op === null || op === undefined) return false;
	if (typeof op !== 'object') return false;

	const o = op as Record<string, unknown>;
	const type = o['type'];
	if (typeof type !== 'string') return false;

	switch (type) {
		case 'aggregate':
			return typeof o['function'] === 'string' && typeof o['column'] === 'string';

		case 'filter':
			return Array.isArray(o['filters']);

		case 'sort':
			return Array.isArray(o['columns']);

		case 'group':
			return typeof o['column'] === 'string' && Array.isArray(o['aggregates']);

		case 'compare':
			return typeof o['column'] === 'string' && typeof o['by'] === 'string';

		case 'trend':
			return typeof o['column'] === 'string' && typeof o['over'] === 'string';

		case 'top_n':
		case 'bottom_n':
			return typeof o['n'] === 'number' && typeof o['column'] === 'string';

		case 'correlation':
			return typeof o['column_a'] === 'string' && typeof o['column_b'] === 'string';

		case 'distribution':
			return typeof o['column'] === 'string';

		case 'describe':
			// columns is optional — always valid if type is present
			return true;

		case 'answer':
			return typeof o['question'] === 'string';

		default:
			return false;
	}
}

// ============================================================
// Fallback factory
// ============================================================

function answerFallback(raw: string, reason?: string): DataOperation {
	return {
		type: 'answer',
		question: raw.trim(),
		context: reason ?? 'Could not parse the response into a structured operation.'
	};
}

// ============================================================
// parseOperation — four-strategy recovery
// ============================================================

/**
 * Parse raw LLM output into a DataOperation.
 *
 * Recovery order:
 *   1. Direct JSON.parse of the full string
 *   2. Extract JSON from ```json ... ``` or ``` ... ``` code blocks
 *   3. Extract the first {...} object from the text
 *   4. Fallback: { type: "answer", question: raw, context: "..." }
 */
export function parseOperation(raw: string): DataOperation {
	const text = raw.trim();

	// ── Strategy 1: Direct JSON parse ──────────────────────────
	try {
		const parsed = JSON.parse(text);
		if (validateOperation(parsed)) return parsed as DataOperation;
		// Parsed but invalid structure — fall through to next strategy
	} catch {
		// Not valid JSON — fall through
	}

	// ── Strategy 2: Extract from ```json ... ``` code block ────
	const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
	if (codeBlockMatch) {
		try {
			const parsed = JSON.parse(codeBlockMatch[1].trim());
			if (validateOperation(parsed)) return parsed as DataOperation;
		} catch {
			// Code block content not valid JSON — fall through
		}
	}

	// ── Strategy 3: Extract first {...} object from text ───────
	// Find the outermost balanced { ... } in the string
	const firstBrace = text.indexOf('{');
	if (firstBrace !== -1) {
		let depth = 0;
		let end = -1;
		for (let i = firstBrace; i < text.length; i++) {
			if (text[i] === '{') depth++;
			else if (text[i] === '}') {
				depth--;
				if (depth === 0) { end = i; break; }
			}
		}
		if (end !== -1) {
			const candidate = text.slice(firstBrace, end + 1);
			try {
				const parsed = JSON.parse(candidate);
				if (validateOperation(parsed)) return parsed as DataOperation;
			} catch {
				// Extracted object not valid JSON — fall through
			}
		}
	}

	// ── Strategy 4: Fallback ───────────────────────────────────
	return answerFallback(text);
}
