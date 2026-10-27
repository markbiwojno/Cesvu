/**
 * src/lib/pipeline/filter.ts — Recursive boolean filter tree
 *
 * Filter type: a recursive tree of AND / OR / NOT / leaf conditions.
 * evaluate(): walks the tree against a single row.
 * parseDSL(): parses a human-friendly text expression into a Filter tree.
 *
 * DSL syntax:
 *   column:value                    → contains match
 *   column=value                    → exact match
 *   column!=value                   → not equal
 *   column>value / >=value          → numeric greater than
 *   column<value / <=value          → numeric less than
 *   column~value                    → regex match
 *   column^value                    → starts with
 *   column$value                    → ends with
 *   column:                         → isEmpty (no value)
 *   column IN (a,b,c)               → in list
 *   NOT expr                        → negation
 *   expr AND expr                   → conjunction
 *   expr OR expr                    → disjunction
 *   (expr)                          → grouping
 *
 * Examples:
 *   status:active AND role:admin
 *   status:active OR status:pending
 *   NOT status:banned AND (role:admin OR role:moderator)
 *   BusinessName:garage AND ZipCode=92661
 */

// ============================================================
// Filter type
// ============================================================

export type FilterOp =
	| 'eq'         // exact match (case-insensitive)
	| 'neq'        // not equal
	| 'contains'   // substring match (case-insensitive)
	| 'startsWith' // prefix match
	| 'endsWith'   // suffix match
	| 'gt'         // numeric greater than
	| 'gte'        // numeric greater than or equal
	| 'lt'         // numeric less than
	| 'lte'        // numeric less than or equal
	| 'regex'      // regex match
	| 'in'         // value in list
	| 'isEmpty'    // null / empty string
	| 'outside';   // numeric value <= lo OR >= hi (two-sided fence);
	               // value is the [lo, hi] tuple as a string[]. Used by
	               // the dashboard's "Show outliers" call to filter
	               // to the rows outside the IQR fence — expressed as
	               // a single leaf so the AND-only filter bar in
	               // DocumentPane can represent it.

export type FilterLeaf = {
	column: string;
	op: FilterOp;
	value?: string | string[];
};

export type Filter =
	| FilterLeaf
	| { not: Filter }
	| { and: Filter[] }
	| { or: Filter[] };

// ============================================================
// evaluate — walk the tree against a single row
// ============================================================

/**
 * Optional value matcher injected by callers. When provided it is used for the
 * string-ish leaf ops (eq, neq, contains, startsWith, endsWith) so the tree can
 * borrow richer semantics — e.g. valueMatch's Excel-serial ⇄ date-string ⇄
 * numeric equivalence and cross-format date equality. The function returns a
 * boolean for a POSITIVE (non-negated) comparison of `cell` vs `query`.
 *
 * For 'neq' the engine calls matchFn with 'eq' and negates the result, so a
 * caller only needs to implement the positive ops.
 *
 * When omitted, leaves fall back to the built-in naive string logic so existing
 * callers behave exactly as before (backward compatible).
 */
export type LeafMatchFn = (
	cell: unknown,
	query: string,
	op: 'eq' | 'contains' | 'startsWith' | 'endsWith'
) => boolean;

export function evaluate(
	filter: Filter,
	row: Record<string, unknown>,
	matchFn?: LeafMatchFn
): boolean {
	if ('and' in filter) return filter.and.every((f) => evaluate(f, row, matchFn));
	if ('or' in filter) return filter.or.some((f) => evaluate(f, row, matchFn));
	if ('not' in filter) return !evaluate(filter.not, row, matchFn);
	return matchLeaf(filter, row, matchFn);
}

/**
 * Parse a string as a calendar Date, or return null. Used by the gt/gte/lt/lte
 * leaf comparison so date conditions ("LastUpdate before 09/15/2025") work
 * inside the AND filter tree, regardless of how the cell stores its date.
 *
 * Supported cell formats (case-insensitive, separators /, -, or .):
 *   - ISO 8601:        2025-09-14, 2025/09/14, 2025.09.14, 2025-09-14T13:45:00Z
 *   - US numeric:      09/14/2025, 09-14-2025, 9.14.25  (MM DD YY[YY])
 *   - EU/ISO numeric:  2025-09-14 handled above; ambiguous DD-MM is NOT assumed
 *   - Named month:     Sep 14 2025, September 14, 2025, 14 Sep 2025
 *   - Anything else the native Date constructor reliably understands
 *
 * Pure numbers are rejected so a numeric cell like "1000" (or an Excel date
 * serial) isn't misread here — numeric comparisons stay on the parseFloat path,
 * and serial⇄date equivalence is handled by matchesValue() on the eq path.
 *
 * Disambiguation: a 4-digit leading group is treated as the YEAR (ISO order);
 * otherwise the first group is the MONTH (US order). This matches how the
 * filter bar emits values (always MM/DD/YYYY) and the most common US datasets.
 */
function toDate(v: string): Date | null {
	// Coerce defensively: callers pass `string` per the type, but at runtime a
	// numeric cell value can flow in. `.trim()` on a number throws
	// "v.trim is not a function" — String() makes it total.
	const s = String(v).trim();
	if (s === '') return null;
	// Reject pure numbers (incl. decimals) — numeric/serial comparisons, not dates.
	if (/^-?\d+(\.\d+)?$/.test(s)) return null;

	// 1. All-numeric date with /, -, or . separators.
	//    ISO order  (YYYY sep MM sep DD)  when the first group is 4 digits.
	//    US order   (MM sep DD sep YY[YY]) otherwise.
	const num = s.match(/^(\d{1,4})[\/\-.](\d{1,2})[\/\-.](\d{1,4})$/);
	if (num) {
		let year: number, month: number, day: number;
		if (num[1].length === 4) {
			// ISO: YYYY-MM-DD
			year = parseInt(num[1]); month = parseInt(num[2]); day = parseInt(num[3]);
		} else {
			// US: MM-DD-YYYY (2-digit year → 2000-range)
			month = parseInt(num[1]); day = parseInt(num[2]);
			year = num[3].length <= 2 ? 2000 + parseInt(num[3]) : parseInt(num[3]);
		}
		// Validate ranges before constructing (Date would silently roll over).
		if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
			const d2 = new Date(year, month - 1, day);
			if (!isNaN(d2.getTime())) return d2;
		}
		return null;
	}

	// 2. ISO 8601 with a time component (2025-09-14T13:45:00Z, with / or . too) —
	//    normalize separators in the date part and hand to the native parser.
	const iso = s.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})[T ].*/);
	if (iso) {
		const d = new Date(s.replace(/[\/.]/g, '-'));
		if (!isNaN(d.getTime())) return d;
	}

	// 3. Named-month and other locale strings the engine handles reliably
	//    ("Sep 14 2025", "September 14, 2025", "14 Sep 2025", RFC dates).
	const d = new Date(s);
	if (!isNaN(d.getTime())) return d;

	return null;
}


function matchLeaf(leaf: FilterLeaf, row: Record<string, unknown>, matchFn?: LeafMatchFn): boolean {

	// Fuzzy column resolution: if the exact column name isn't in the row,
	// try normalized matching (strip spaces/underscores/hyphens).
	// This handles cases where the user types "BusinessName" but the actual
	// column is "Business Name" or "business_name".
	let raw = row[leaf.column];
	if (raw === undefined && leaf.column !== '_any_') {
		const needle = leaf.column.toLowerCase().replace(/[\s_\-]/g, '');
		for (const key of Object.keys(row)) {
			if (key.toLowerCase().replace(/[\s_\-]/g, '') === needle) {
				raw = row[key];
				break;
			}
		}
	}
	const cell = raw === null || raw === undefined ? '' : String(raw);
	const cellLower = cell.toLowerCase();

	switch (leaf.op) {
		case 'isEmpty':
			return cell.trim() === '';

		case 'eq': {
			const v = String(leaf.value ?? '');
			// Injected matcher first (handles date ⇄ serial ⇄ numeric equivalence).
			if (matchFn && matchFn(raw, v, 'eq')) return true;
			return cellLower === v.toLowerCase();
		}

		case 'neq': {
			const v = String(leaf.value ?? '');
			// Negate the positive equality check so date/numeric equivalence is honored.
			if (matchFn) return !matchFn(raw, v, 'eq');
			return cellLower !== v.toLowerCase();
		}

		case 'contains': {
			const v = String(leaf.value ?? '');
			if (matchFn && matchFn(raw, v, 'contains')) return true;
			return cellLower.includes(v.toLowerCase());
		}

		case 'startsWith': {
			const v = String(leaf.value ?? '');
			if (matchFn && matchFn(raw, v, 'startsWith')) return true;
			return cellLower.startsWith(v.toLowerCase());
		}

		case 'endsWith': {
			const v = String(leaf.value ?? '');
			if (matchFn && matchFn(raw, v, 'endsWith')) return true;
			return cellLower.endsWith(v.toLowerCase());
		}

		case 'gt':
		case 'gte':
		case 'lt':
		case 'lte': {
			// Date-aware comparison: if BOTH the cell and the filter value parse as
			// calendar dates, compare them as timestamps. This lets compound filters
			// express "LastUpdate before 09/15/2025" (→ lt) etc. inside the AND tree.
			// If either side isn't a date, fall through to the numeric path below so
			// existing numeric comparisons (Revenue > 1000) are unaffected.
			const cd = toDate(cell);
			const td = toDate(String(leaf.value ?? ''));
			if (cd && td) {
				const a = cd.getTime();
				const b = td.getTime();
				if (leaf.op === 'gt')  return a > b;
				if (leaf.op === 'gte') return a >= b;
				if (leaf.op === 'lt')  return a < b;
				return a <= b; // lte
			}

			const num = parseFloat(cell);
			const target = parseFloat(String(leaf.value ?? ''));
			if (isNaN(num) || isNaN(target)) return false;
			if (leaf.op === 'gt')  return num > target;
			if (leaf.op === 'gte') return num >= target;
			if (leaf.op === 'lt')  return num < target;
			if (leaf.op === 'lte') return num <= target;
			return false;
		}


		case 'regex': {
			try {
				const re = new RegExp(String(leaf.value ?? ''), 'i');
				return re.test(cell);
			} catch {
				return false;
			}
		}

		case 'in': {
			const list = Array.isArray(leaf.value)
				? leaf.value.map(v => v.toLowerCase())
				: [String(leaf.value ?? '').toLowerCase()];
			if (matchFn && list.some((v) => matchFn(raw, v, 'eq'))) return true;
			return list.includes(cellLower);
		}

		/**
		 * The 'outside' op: cell is numerically <= lo OR >= hi. Used by
		 * "Show outliers" on the dashboard. Implemented as a single leaf
		 * (not an `or` tree) so the AND-only filter bar in DocumentPane
		 * can represent it. value is the [lo, hi] tuple as string[].
		 */
		case 'outside': {
			if (!Array.isArray(leaf.value) || leaf.value.length !== 2) return false;
			const lo = parseFloat(String(leaf.value[0]));
			const hi = parseFloat(String(leaf.value[1]));
			if (isNaN(lo) || isNaN(hi)) return false;
			const num = parseFloat(cell);
			if (isNaN(num)) return false;
			return num <= lo || num >= hi;
		}

		default:
			return false;
	}
}

// ============================================================
// countMatches — count rows matching a filter tree
// ============================================================

export function countMatches(
	filter: Filter,
	rows: Record<string, unknown>[],
	matchFn?: LeafMatchFn
): number {
	let count = 0;
	for (const row of rows) {
		if (evaluate(filter, row, matchFn)) count++;
	}
	return count;
}

// ============================================================
// parseDSL — text expression → Filter tree
// ============================================================

/**
 * Parse a human-friendly filter expression into a Filter tree.
 *
 * Supports:
 *   column:value          → contains
 *   column=value          → eq
 *   column!=value         → neq
 *   column>value          → gt
 *   column>=value         → gte
 *   column<value          → lt
 *   column<=value         → lte
 *   column~value          → regex
 *   column^value          → startsWith
 *   column$value          → endsWith
 *   column:               → isEmpty
 *   column IN (a,b,c)     → in
 *   NOT expr              → not
 *   expr AND expr         → and
 *   expr OR expr          → or
 *   (expr)                → grouping
 *
 * Returns null if the expression cannot be parsed.
 */
export function parseDSL(expr: string): Filter | null {
	try {
		// Pre-process: collapse "col OP val" with spaces around operator into "col=val"
		// This handles user input like "BusinessName = garage" or "Revenue >= 1000"
		const collapsed = collapseSpacedOperators(expr.trim());
		console.log('[parseDSL] collapsed:', JSON.stringify(collapsed));
		const tokens = tokenize(collapsed);
		console.log('[parseDSL] tokens:', JSON.stringify(tokens));
		if (tokens.length === 0) return null;
		const result = parseOr(tokens, { pos: 0 });
		console.log('[parseDSL] result:', JSON.stringify(result));
		return result;
	} catch (e) {
		console.error('[parseDSL] parse error:', e, 'expr:', JSON.stringify(expr));
		return null;
	}
}

/** True when a value string looks like a calendar date. Used so "col = 09/15/2025"
 *  becomes a strict day-equality match (eq) rather than a loose substring
 *  (contains). Accepts /, -, or . separators in either US (MM-DD-YYYY) or ISO
 *  (YYYY-MM-DD) order — mirrors the formats toDate() can actually compare. */
function looksLikeDate(v: string): boolean {
	const s = String(v).trim();
	if (/^\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}$/.test(s)) return true; // MM/DD/YYYY
	if (/^\d{4}[\/\-.]\d{1,2}[\/\-.]\d{1,2}$/.test(s)) return true;   // YYYY-MM-DD
	return false;
}


/**
 * Collapse spaced operators into compact form so the tokenizer can parse them.
 * "BusinessName = garage"  → "BusinessName:garage"  (string = → contains)
 * "Revenue >= 1000"        → "Revenue>=1000"
 * "Status != banned"       → "Status!=banned"
 * "Name : garage"          → "Name:garage"
 *
 * IMPORTANT: Natural language "col = value" where value is a non-numeric string
 * is treated as CONTAINS (`:`) not exact match (`=`). This matches user intent:
 * "BusinessName = garage" means "business name contains garage", not exact eq.
 * Numeric values, DATE values, and explicit != / >= / <= keep exact equality.
 *
 * Only collapses when the left side looks like a word (no spaces in it),
 * to avoid collapsing across AND/OR/NOT keywords.
 */
function collapseSpacedOperators(expr: string): string {
	// The value is captured LAZILY up to the next boolean keyword (AND / OR /
	// NOT), a paren, or end-of-string — NOT just up to the next space. This is
	// what lets MULTI-WORD VALUES work: "businessname = d k iron and …" captures
	// the whole "d k iron" instead of stopping at "d". The captured value is then
	// wrapped in double-quotes so the tokenizer reads it as one token (it already
	// knows how to consume a quoted run including its spaces).
	//   VALUE_TERM = (?=\s+(?:AND|OR|NOT)\b|\s*[()]|\s*$)
	return expr.replace(
		/\b([A-Za-z_][A-Za-z0-9_]*)\s*(>=|<=|!=|>|<|=|:)\s*((?:"[^"]*")|.+?)(?=\s+(?:AND|OR|NOT)\b|\s*[()]|\s*$)/g,
		(_, col, op, rawVal) => {
			// Unwrap any quotes the user already typed; we re-add our own.
			let val = String(rawVal).trim();
			const wasQuoted = val.startsWith('"') && val.endsWith('"');
			if (wasQuoted) val = val.slice(1, -1);

			// For plain "=" with a non-numeric, non-date value, use contains (:) not
			// exact eq (=). This matches natural language intent: "Status = active"
			// → 'Status:"active"'. Numeric AND date values keep exact equality so
			// "LastUpdate = 09/15/2025" → 'LastUpdate="09/15/2025"' (eq) — the leaf
			// matcher then resolves it as same-calendar-day equality via matchesValue.
			const isNumeric = !isNaN(Number(val));
			const isDate = looksLikeDate(val);
			const useContains = op === '=' && !isNumeric && !isDate;
			const finalOp = useContains ? ':' : op;
			// Always wrap in quotes so a multi-word value survives tokenization.
			return `${col}${finalOp}"${val}"`;
		}
	);
}


// ── Tokenizer ─────────────────────────────────────────────────────────────────

type Token =
	| { type: 'WORD'; value: string }
	| { type: 'AND' }
	| { type: 'OR' }
	| { type: 'NOT' }
	| { type: 'LPAREN' }
	| { type: 'RPAREN' }
	| { type: 'CONDITION'; column: string; op: FilterOp; value?: string | string[] };

function tokenize(expr: string): Token[] {
	const tokens: Token[] = [];
	let i = 0;

	while (i < expr.length) {
		// Skip whitespace
		if (/\s/.test(expr[i])) { i++; continue; }

		// Parentheses
		if (expr[i] === '(') { tokens.push({ type: 'LPAREN' }); i++; continue; }
		if (expr[i] === ')') { tokens.push({ type: 'RPAREN' }); i++; continue; }

		// Read a token. A token normally ends at whitespace or a paren, BUT a
		// quoted value may contain spaces: col:"d k iron" or col="2316 ralston rd".
		// We read up to the operator, then if a double-quote follows, consume the
		// whole quoted run (including its spaces) as part of this token. This is
		// what lets MULTI-WORD VALUES survive the tokenizer — without it,
		// "d k iron" would split into three separate tokens.
		let word = '';
		while (i < expr.length && !/[\s()]/.test(expr[i])) {
			if (expr[i] === '"') {
				// Consume the quoted value verbatim (spaces and all), keeping the
				// quotes so the condition regex below can strip them.
				word += expr[i++]; // opening quote
				while (i < expr.length && expr[i] !== '"') word += expr[i++];
				if (i < expr.length) word += expr[i++]; // closing quote
				continue;
			}
			word += expr[i++];
		}


		if (!word) { i++; continue; }

		// Keywords
		if (word.toUpperCase() === 'AND') { tokens.push({ type: 'AND' }); continue; }
		if (word.toUpperCase() === 'OR')  { tokens.push({ type: 'OR' });  continue; }
		if (word.toUpperCase() === 'NOT') { tokens.push({ type: 'NOT' }); continue; }

		// Check for "column IN (a,b,c)" — peek ahead
		// word is the column name, next non-space should be "IN"
		const restTrimmed = expr.slice(i).trimStart();
		const inMatch = restTrimmed.match(/^IN\s*\(([^)]*)\)/i);
		if (inMatch) {
			const values = inMatch[1].split(',').map(v => v.trim()).filter(v => v.length > 0);
			tokens.push({ type: 'CONDITION', column: word, op: 'in', value: values });
			i += expr.slice(i).indexOf(inMatch[0]) + inMatch[0].length;
			// Advance past the IN(...) part
			const inStart = expr.indexOf(inMatch[0], i - inMatch[0].length - 10);
			if (inStart !== -1) i = inStart + inMatch[0].length;
			continue;
		}

		// Try to parse as a condition: column OP value
		// Operators (longest first to avoid ambiguity): >=, <=, !=, >, <, =, :, ~, ^, $
		const condMatch = word.match(
			/^([^=!<>:~^$]+)(>=|<=|!=|>|<|=|~|\^|\$|:)(.*)$/
		);
		if (condMatch) {
			const col = condMatch[1];
			const opStr = condMatch[2];
			// Strip surrounding double-quotes from the value. The tokenizer keeps
			// quotes so a multi-word value ("d k iron") survives as one token;
			// here we unwrap them back to the raw value for matching.
			let val = condMatch[3];
			if (val.length >= 2 && val.startsWith('"') && val.endsWith('"')) {
				val = val.slice(1, -1);
			}

			let op: FilterOp;

			switch (opStr) {
				case '=':  op = 'eq'; break;
				case '!=': op = 'neq'; break;
				case '>':  op = 'gt'; break;
				case '>=': op = 'gte'; break;
				case '<':  op = 'lt'; break;
				case '<=': op = 'lte'; break;
				case '~':  op = 'regex'; break;
				case '^':  op = 'startsWith'; break;
				case '$':  op = 'endsWith'; break;
				case ':':  op = val === '' ? 'isEmpty' : 'contains'; break;
				default:   op = 'contains';
			}

			tokens.push({
				type: 'CONDITION',
				column: col,
				op,
				value: op === 'isEmpty' ? undefined : val
			});
			continue;
		}

		// Plain word — treat as a bare search term (contains match across all columns)
		tokens.push({ type: 'WORD', value: word });
	}

	return tokens;
}

// ── Recursive descent parser ──────────────────────────────────────────────────

type ParseState = { pos: number };

function parseOr(tokens: Token[], state: ParseState): Filter {
	let left = parseAnd(tokens, state);

	while (state.pos < tokens.length && tokens[state.pos].type === 'OR') {
		state.pos++; // consume OR
		const right = parseAnd(tokens, state);
		// Flatten nested ORs
		const leftOrs = 'or' in left ? left.or : [left];
		const rightOrs = 'or' in right ? right.or : [right];
		left = { or: [...leftOrs, ...rightOrs] };
	}

	return left;
}

function parseAnd(tokens: Token[], state: ParseState): Filter {
	let left = parseNot(tokens, state);

	while (state.pos < tokens.length && tokens[state.pos].type === 'AND') {
		state.pos++; // consume AND
		const right = parseNot(tokens, state);
		// Flatten nested ANDs
		const leftAnds = 'and' in left ? left.and : [left];
		const rightAnds = 'and' in right ? right.and : [right];
		left = { and: [...leftAnds, ...rightAnds] };
	}

	return left;
}

function parseNot(tokens: Token[], state: ParseState): Filter {
	if (state.pos < tokens.length && tokens[state.pos].type === 'NOT') {
		state.pos++; // consume NOT
		const operand = parseNot(tokens, state); // right-associative
		return { not: operand };
	}
	return parsePrimary(tokens, state);
}

function parsePrimary(tokens: Token[], state: ParseState): Filter {
	if (state.pos >= tokens.length) {
		throw new Error('Unexpected end of expression');
	}

	const tok = tokens[state.pos];

	// Grouped expression
	if (tok.type === 'LPAREN') {
		state.pos++; // consume (
		const inner = parseOr(tokens, state);
		if (state.pos < tokens.length && tokens[state.pos].type === 'RPAREN') {
			state.pos++; // consume )
		}
		return inner;
	}

	// Condition token
	if (tok.type === 'CONDITION') {
		state.pos++;
		return { column: tok.column, op: tok.op, value: tok.value } as FilterLeaf;
	}

	// Bare word — treat as a global contains search
	// We'll represent this as a special sentinel column '_any_'
	// DocumentPane will handle '_any_' by searching all columns
	if (tok.type === 'WORD') {
		state.pos++;
		return { column: '_any_', op: 'contains', value: tok.value } as FilterLeaf;
	}

	throw new Error(`Unexpected token: ${tok.type}`);
}

// ============================================================
// naturalLanguageToFilter — NL phrase → Filter tree
// ============================================================

/**
 * Convert a natural language filter phrase into a Filter tree.
 * Handles compound AND/OR/NOT expressions by:
 *   1. Normalizing NL operators to DSL keywords
 *   2. Mapping column name aliases to actual column names
 *   3. Parsing the resulting DSL expression
 *
 * Returns null if the phrase cannot be parsed as a filter.
 */
export function naturalLanguageToFilter(
	phrase: string,
	columns: string[]
): Filter | null {
	if (!phrase || columns.length === 0) return null;

	// Step 1: Strip leading filler words ("show me all", "find", "list", "display", etc.)
	// Two passes: the lead verb ("show me all", "find", …) AND a trailing
	// "where"/"for which"/"in which" the verb may leave behind. Without the
	// second pass, "show me where countyname = …" keeps a stray "where" token
	// that derails the AND-tree parse (the rest of the conditions get dropped).
	const cleaned = phrase
		.replace(/^\s*(?:show\s+(?:me\s+)?(?:all\s+)?|find\s+(?:all\s+)?|list\s+(?:all\s+)?|display\s+(?:all\s+)?|get\s+(?:all\s+)?|filter\s+(?:by\s+)?)/i, '')
		.replace(/^\s*(?:where|for\s+which|in\s+which|that\s+(?:have|are)|with)\s+/i, '')
		.trim();

	// Step 2: Normalize NL operators to DSL keywords
	// Do "but not" / "except" / "excluding" / "without" BEFORE "not" to avoid double-replace
	const dsl0 = cleaned
		.replace(/\bbut\s+not\b/gi, ' AND NOT ')
		.replace(/\bexcept\b/gi, ' AND NOT ')
		.replace(/\bexcluding\b/gi, ' AND NOT ')
		.replace(/\bwithout\b/gi, ' AND NOT ')
		.replace(/\band\b/gi, ' AND ')
		.replace(/\bor\b/gi, ' OR ')
		.replace(/\bnot\b/gi, ' NOT ')
		.replace(/\s{2,}/g, ' ')
		.trim();

	// Step 3: Normalize "column OP value" NL phrases to DSL condition syntax
	// Only replace when the column name is an actual column in the dataset
	const dsl = normalizePhraseToConditions(dsl0, columns);

	console.log('[naturalLanguageToFilter] input:', JSON.stringify(phrase));
	console.log('[naturalLanguageToFilter] cleaned:', JSON.stringify(cleaned));
	console.log('[naturalLanguageToFilter] dsl:', JSON.stringify(dsl));

	const result = parseDSL(dsl);
	console.log('[naturalLanguageToFilter] result:', JSON.stringify(result));
	return result;
}

/**
 * Normalize natural language condition phrases to DSL syntax.
 * e.g. "BusinessName = garage" → "BusinessName=garage"
 *      "ZipCode is 92661"      → "ZipCode=92661"
 *      "Status contains active" → "Status:active"
 *      "Revenue > 1000"        → "Revenue>1000"
 */
function normalizePhraseToConditions(phrase: string, columns: string[]): string {
	const colMap = buildColumnMap(columns);
	let result = phrase;

	// ── Idempotency / non-overlap guard ──────────────────────────────────────
	// The rules below run as a SEQUENCE of regex rewrites over one shared string.
	// Without protection, the DSL a rule emits (e.g. `BusinessDescription:"hvac"`)
	// can be RE-MATCHED and re-processed by a later rule (especially the final
	// bare `=`/`:` rule) — the class of bug behind the "hvac"→"27" incident. To
	// keep the rules non-overlapping, every rule MASKS the DSL it produces: it
	// returns an opaque sentinel `\uE000<index>\uE001` (Private-Use-Area chars —
	// they can't match [A-Za-z0-9_], aren't AND/OR/NOT, and aren't whitespace or
	// parens) and stashes the real DSL in `masks`. A converted condition is thus
	// invisible to every subsequent rule. `unmaskAll()` restores them at the end.
	const masks: string[] = [];
	const MASK_OPEN = '\uE000';
	const MASK_CLOSE = '\uE001';
	const mask = (dsl: string): string => {
		const i = masks.length;
		masks.push(dsl);
		return `${MASK_OPEN}${i}${MASK_CLOSE}`;
	};
	const unmaskAll = (s: string): string =>
		s.replace(/\uE000(\d+)\uE001/g, (_, i) => masks[Number(i)] ?? '');

	// IMPORTANT: All regexes use [A-Za-z0-9_]+ (NO spaces) for the column name.
	// This prevents the regex from consuming AND/OR/NOT keywords that appear
	// between conditions. The column name must be a single word token.
	//
	// Multi-word column names (e.g. "Business Name") are handled by resolveColumn()
	// which does normalized matching (strips spaces/underscores).

	// Multi-word values: every value group below captures LAZILY up to the next
	// boolean keyword (AND / OR / NOT), a paren, or end-of-string — via the
	// shared terminator VT — and is wrapped in double-quotes so the DSL tokenizer
	// reads it as one token. Without this, "MailingAddress is 2316 ralston road"
	// would capture only "2316" and leave "ralston road" as stray bare-word terms.
	//
	// The value alternation is a CAPTURING group so every rule receives the
	// matched VALUE as its next callback arg. If it were non-capturing, the rule
	// would instead receive the regex match OFFSET (a number) — which is exactly
	// what turned "allegheny" into "0" and "active" into "0".
	//
	// The lookahead also stops at a mask sentinel (\uE000) so an NL value's lazy
	// run can't bleed into an already-converted (masked) condition.
	const VT = String.raw`("[^"]*"|.+?)(?=\s+(?:AND|OR|NOT)\b|\s*[()]|\uE000|\s*$)`;
	const unq = (v: string) => {
		const t = String(v).trim();
		return t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t;
	};

	// "column IS NOT value" → 'column!="value"'
	result = result.replace(
		new RegExp(String.raw`\b([A-Za-z_][A-Za-z0-9_]*)\s+is\s+not\s+${VT}`, 'gi'),
		(_, col, val) => {
			const canonical = resolveColumn(col.trim(), colMap);
			return canonical ? mask(`${canonical}!="${unq(val)}"`) : _;
		}
	);

	// "column IS value" / "column EQUALS value" → 'column="value"'
	// NOTE: does NOT match "column = value" (spaced =) — that's handled by
	// collapseSpacedOperators() in parseDSL. This only handles the word forms.
	result = result.replace(
		new RegExp(String.raw`\b([A-Za-z_][A-Za-z0-9_]*)\s+(?:is|equals)\s+${VT}`, 'gi'),
		(_, col, val) => {
			const canonical = resolveColumn(col.trim(), colMap);
			return canonical ? mask(`${canonical}="${unq(val)}"`) : _;
		}
	);

	// "column CONTAINS value" → 'column:"value"'
	result = result.replace(
		new RegExp(String.raw`\b([A-Za-z_][A-Za-z0-9_]*)\s+contains\s+${VT}`, 'gi'),
		(_, col, val) => {
			const canonical = resolveColumn(col.trim(), colMap);
			return canonical ? mask(`${canonical}:"${unq(val)}"`) : _;
		}
	);

	// "column STARTS WITH value" → 'column^"value"'
	result = result.replace(
		new RegExp(String.raw`\b([A-Za-z_][A-Za-z0-9_]*)\s+starts\s+with\s+${VT}`, 'gi'),
		(_, col, val) => {
			const canonical = resolveColumn(col.trim(), colMap);
			return canonical ? mask(`${canonical}^"${unq(val)}"`) : _;
		}
	);

	// "column ENDS WITH value" → 'column$"value"'
	result = result.replace(
		new RegExp(String.raw`\b([A-Za-z_][A-Za-z0-9_]*)\s+ends\s+with\s+${VT}`, 'gi'),
		(_, col, val) => {
			const canonical = resolveColumn(col.trim(), colMap);
			return canonical ? mask(`${canonical}$"${unq(val)}"`) : _;
		}
	);

	// "column > value" / ">= value" etc. (numeric comparisons with spaces).
	// Numeric ops keep a single-token value (no quotes) — comparisons are numeric.
	// The value class excludes the mask sentinel (\uE000) so it can't swallow an
	// already-converted condition.
	result = result.replace(
		/\b([A-Za-z_][A-Za-z0-9_]*)\s*(>=|<=|!=|>|<)\s*([^\s()\uE000]+)/g,
		(_, col, op, val) => {
			const canonical = resolveColumn(col.trim(), colMap);
			return canonical ? mask(`${canonical}${op}${val}`) : _;
		}
	);

	// "column IN (a, b, c)" — mask only the column token; the "IN (a,b,c)" list
	// stays as plain text for the DSL tokenizer's IN-list handling (it isn't
	// re-matched by the column-OP-value rules, which require an operator char).
	result = result.replace(
		/\b([A-Za-z_][A-Za-z0-9_]*)\s+IN\s*\(/gi,
		(_, col) => {
			const canonical = resolveColumn(col.trim(), colMap);
			return canonical ? `${mask(canonical)} IN (` : _;
		}
	);

	// Reversed phrasing: "<value> in <Column>" → 'Column:"value"'.
	// Users naturally write "hvac in BusinessDescription" meaning
	// "BusinessDescription contains hvac" — the inverse of "Column contains value".
	// We ONLY rewrite when the token after "in" resolves to a REAL column; that
	// guard is what keeps location phrases ("in los angeles", "in CA") from being
	// misread as a column reference. The leading group captures (and preserves)
	// the boolean connector / start-of-string / open-paren so the value can't
	// bleed across an AND/OR/NOT into the previous condition.
	result = result.replace(
		new RegExp(
			String.raw`(^|\bAND\b|\bOR\b|\bNOT\b|\()\s*([A-Za-z0-9][A-Za-z0-9 _\-]*?)\s+in\s+(?:the\s+)?([A-Za-z_][A-Za-z0-9_]*)(?:\s+column)?(?=\s+(?:AND|OR|NOT)\b|\s*[()]|\uE000|\s*$)`,
			'gi'
		),
		(m, lead, val, colTok) => {
			const canonical = resolveColumn(String(colTok).trim(), colMap);
			if (!canonical) return m;
			return `${lead} ${mask(`${canonical}:"${String(val).trim()}"`)}`;
		}
	);

	// Bare spaced "column = value" / "column : value" — resolve the column to its
	// canonical name so the filter-bar chip shows the right column (without this,
	// the leaf kept the user's raw token e.g. "countyname", which evaluate()
	// still fuzzy-matches but the chip dropdown can't, so it rendered blank).
	// The operator is preserved and quoted; collapseSpacedOperators() then decides
	// contains-vs-eq exactly as before. resolveColumn returning null (token isn't
	// a real column) leaves the text untouched, so "12:30"-style values stay safe.
	// This rule runs LAST, so masked tokens (which contain no =/:) are immune.
	result = result.replace(
		new RegExp(String.raw`\b([A-Za-z_][A-Za-z0-9_]*)\s*([=:])\s*${VT}`, 'gi'),
		(m, col, op, val) => {
			const canonical = resolveColumn(String(col).trim(), colMap);
			if (!canonical) return m;
			return `${canonical}${op}"${unq(val)}"`;
		}
	);

	return unmaskAll(result);
}


/** Build a map from normalized column name → canonical column name */
function buildColumnMap(columns: string[]): Map<string, string> {
	const map = new Map<string, string>();
	for (const col of columns) {
		// Exact lowercase
		map.set(col.toLowerCase(), col);
		// Normalized (no spaces/underscores/hyphens)
		map.set(col.toLowerCase().replace(/[\s_\-]/g, ''), col);
	}
	return map;
}

/**
 * Resolve a phrase to a DSL-safe column token.
 *
 * Returns the NORMALIZED form (no spaces/underscores) of the canonical column
 * name so the DSL tokenizer can parse it as a single word token.
 * evaluate() / matchLeaf() does fuzzy matching to find the actual column in
 * the row, so the normalized form works correctly at evaluation time.
 *
 * Example: phrase="ZIPCode", actual column="ZIP CODE"
 *   → returns "ZIPCODE" (normalized, no space)
 *   → DSL: "ZIPCODE=92661"
 *   → matchLeaf: row["ZIP CODE"] found via fuzzy match ✓
 */
function resolveColumn(phrase: string, colMap: Map<string, string>): string | null {
	const lower = phrase.toLowerCase();
	const normalized = lower.replace(/[\s_\-]/g, '');

	// 1. Exact lowercase match
	if (colMap.has(lower)) {
		const canonical = colMap.get(lower)!;
		// Return normalized form (no spaces) so DSL tokenizer handles it as one token
		return canonical.replace(/[\s_\-]/g, '');
	}
	// 2. Normalized match
	if (colMap.has(normalized)) {
		const canonical = colMap.get(normalized)!;
		return canonical.replace(/[\s_\-]/g, '');
	}
	// 3. Partial match (phrase is substring of column or vice versa).
	//    Require the phrase to be at least 3 chars so a stray short token doesn't
	//    accidentally resolve to an unrelated column.
	if (normalized.length >= 3) {
		// Prefer the LONGEST matching key so "lastupdate" beats a generic "date".
		let best: string | null = null;
		let bestLen = 0;
		for (const [key, val] of colMap) {
			if ((key.includes(normalized) || normalized.includes(key)) && key.length > bestLen) {
				best = val.replace(/[\s_\-]/g, '');
				bestLen = key.length;
			}
		}
		if (best) return best;
	}
	return null;
}

// ============================================================
// describeFilter — human-readable summary of a Filter tree
// ============================================================

export function describeFilter(filter: Filter): string {
	if ('and' in filter) {
		return filter.and.map(describeFilter).join(' AND ');
	}
	if ('or' in filter) {
		const parts = filter.or.map(describeFilter);
		return parts.length > 1 ? `(${parts.join(' OR ')})` : parts[0];
	}
	if ('not' in filter) {
		return `NOT ${describeFilter(filter.not)}`;
	}
	// Leaf
	const leaf = filter as FilterLeaf;
	const col = leaf.column === '_any_' ? 'any column' : leaf.column;
	switch (leaf.op) {
		case 'eq':         return `${col} = "${leaf.value}"`;
		case 'neq':        return `${col} ≠ "${leaf.value}"`;
		case 'contains':   return `${col} contains "${leaf.value}"`;
		case 'startsWith': return `${col} starts with "${leaf.value}"`;
		case 'endsWith':   return `${col} ends with "${leaf.value}"`;
		case 'gt':         return `${col} > ${leaf.value}`;
		case 'gte':        return `${col} ≥ ${leaf.value}`;
		case 'lt':         return `${col} < ${leaf.value}`;
		case 'lte':        return `${col} ≤ ${leaf.value}`;
		case 'regex':      return `${col} matches /${leaf.value}/`;
		case 'in':         return `${col} in [${(leaf.value as string[]).join(', ')}]`;
		case 'isEmpty':    return `${col} is empty`;
		case 'outside': {
			const v = Array.isArray(leaf.value) ? leaf.value : [String(leaf.value ?? '')];
			return `${col} outside [${v.join(', ')}]`;
		}
		default:           return `${col} ${leaf.op} ${leaf.value}`;
	}
}
