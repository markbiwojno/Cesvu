/**
 * src/lib/report/column-heuristics.ts — default aggregation suggestion for a
 * numeric column, based on its header text.
 *
 * Numeric-looking columns are NOT all summable: an "Invoice #", a "Zip Code",
 * or a "Year" are numbers but summing them is meaningless. This module
 * suggests 'none' for columns whose header token set matches a known
 * identifier-like word, and 'sum' otherwise. The user can always override
 * the suggestion per column in the report modal — this only sets the
 * pre-filled default.
 *
 * Matching is on WHOLE TOKENS after splitting the header on spaces,
 * underscores, hyphens, and camelCase boundaries — so "Amount Paid" (tokens:
 * "amount", "paid") does NOT match the "no" token from "Invoice No", and
 * "ZipCode" (tokens: "zip", "code") DOES match via "zip". A substring match
 * would have falsely excluded "Amount Paid" (no reason) or "Code Number"
 * style columns too aggressively; tokenizing avoids that.
 */

/** Header tokens (lowercased) that mark an identifier-like column. */
const ID_LIKE_TOKENS = new Set([
	'id',
	'no',
	'num',
	'number',
	'#',
	'code',
	'zip',
	'postal',
	'year',
	'phone'
]);

/**
 * Split a header into lowercase tokens on spaces/underscores/hyphens and
 * camelCase boundaries. "Invoice#" → ["invoice", "#"]; "ZipCode" →
 * ["zip", "code"]; "Amount Paid" → ["amount", "paid"].
 */
export function tokenizeHeader(header: string): string[] {
	// Insert a boundary between a lowercase/digit and a following uppercase
	// letter (camelCase split), and around '#' (kept as its OWN token since
	// it's a meaningful identifier marker, e.g. "Invoice#" / "Invoice #").
	const withBoundaries = header
		.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
		.replace(/#/g, ' # ');
	return withBoundaries
		.split(/[^a-zA-Z0-9#]+/)
		.map((t) => t.toLowerCase())
		.filter((t) => t.length > 0);
}

/** True when any whole token of `header` is a known identifier-like word. */
export function looksLikeIdentifierColumn(header: string): boolean {
	const tokens = tokenizeHeader(header);
	return tokens.some((t) => ID_LIKE_TOKENS.has(t));
}

export type AggregationChoice = 'sum' | 'average' | 'none';

/**
 * Suggest a default aggregation for a numeric column. Date-formatted columns
 * are the caller's responsibility to exclude BEFORE calling this (see
 * summary-report.ts — date columns feed the KPI date range instead of
 * appearing here at all).
 */
export function suggestAggregation(header: string): AggregationChoice {
	return looksLikeIdentifierColumn(header) ? 'none' : 'sum';
}
