/**
 * Quick unit test for filter.ts logic (runs with: node test-filter.mjs)
 * Uses inline JS equivalents of the TypeScript functions (no TS compilation needed).
 */

// ── Inline the core logic from filter.ts ─────────────────────────────────────

function collapseSpacedOperators(expr) {
	return expr.replace(
		/\b([A-Za-z_][A-Za-z0-9_]*)\s+(>=|<=|!=|>|<|=|:)\s+([^\s()]+)/g,
		(_, col, op, val) => {
			// NL "col = string" → contains (:); numeric keeps eq (=)
			if (op === '=' && isNaN(Number(val))) {
				return `${col}:${val}`;
			}
			return `${col}${op}${val}`;
		}
	);
}

function buildColumnMap(columns) {
	const map = new Map();
	for (const col of columns) {
		map.set(col.toLowerCase(), col);
		map.set(col.toLowerCase().replace(/[\s_\-]/g, ''), col);
	}
	return map;
}

function resolveColumn(phrase, colMap) {
	const lower = phrase.toLowerCase();
	const normalized = lower.replace(/[\s_\-]/g, '');
	// Return NORMALIZED form (no spaces) so DSL tokenizer handles it as one token
	if (colMap.has(lower)) return colMap.get(lower).replace(/[\s_\-]/g, '');
	if (colMap.has(normalized)) return colMap.get(normalized).replace(/[\s_\-]/g, '');
	for (const [key, val] of colMap) {
		if (key.includes(normalized) || normalized.includes(key)) return val.replace(/[\s_\-]/g, '');
	}
	return null;
}

function normalizePhraseToConditions(phrase, columns) {
	const colMap = buildColumnMap(columns);
	let result = phrase;

	// "column IS NOT value" → "column!=value"
	result = result.replace(
		/\b([A-Za-z_][A-Za-z0-9_]*)\s+is\s+not\s+([^\s()]+)/gi,
		(_, col, val) => {
			const canonical = resolveColumn(col.trim(), colMap);
			return canonical ? `${canonical}!=${val}` : _;
		}
	);
	// "column IS value" / "column EQUALS value" → "column=value"
	// NOTE: spaced "=" is handled by collapseSpacedOperators, not here
	result = result.replace(
		/\b([A-Za-z_][A-Za-z0-9_]*)\s+(?:is|equals)\s+([^\s()]+)/gi,
		(_, col, val) => {
			const canonical = resolveColumn(col.trim(), colMap);
			return canonical ? `${canonical}=${val}` : _;
		}
	);
	// "column CONTAINS value" → "column:value"
	result = result.replace(
		/\b([A-Za-z_][A-Za-z0-9_]*)\s+contains\s+([^\s()]+)/gi,
		(_, col, val) => {
			const canonical = resolveColumn(col.trim(), colMap);
			return canonical ? `${canonical}:${val}` : _;
		}
	);
	return result;
}

function naturalLanguageToFilter_steps(phrase, columns) {
	if (!phrase || columns.length === 0) return { cleaned: null, dsl: null, result: null };

	// Step 1: Strip filler
	let cleaned = phrase
		.replace(/^\s*(?:show\s+(?:me\s+)?(?:all\s+)?|find\s+(?:all\s+)?|list\s+(?:all\s+)?|display\s+(?:all\s+)?|get\s+(?:all\s+)?|filter\s+(?:by\s+)?|where\s+)/i, '')
		.trim();

	// Step 2: NL operators
	let dsl = cleaned
		.replace(/\bbut\s+not\b/gi, ' AND NOT ')
		.replace(/\bexcept\b/gi, ' AND NOT ')
		.replace(/\bexcluding\b/gi, ' AND NOT ')
		.replace(/\bwithout\b/gi, ' AND NOT ')
		.replace(/\band\b/gi, ' AND ')
		.replace(/\bor\b/gi, ' OR ')
		.replace(/\bnot\b/gi, ' NOT ')
		.replace(/\s{2,}/g, ' ')
		.trim();

	// Step 3: Normalize conditions
	dsl = normalizePhraseToConditions(dsl, columns);

	// Step 4: collapseSpacedOperators (in parseDSL)
	const collapsed = collapseSpacedOperators(dsl);

	return { cleaned, dsl, collapsed };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

// Test with both compact and spaced column names (simulating real datasets)
const columns = ['BusinessName', 'ZIPCode', 'Status', 'Revenue', 'Role'];
const spacedColumns = ['BUSINESS NAME', 'ZIP CODE', 'STATUS', 'REVENUE', 'ROLE'];

const tests = [
	{
		// string "=" → contains (:); ZIPCode is numeric so stays =
		label: 'Compound AND with spaces around = (string→contains, numeric→eq)',
		input: 'show me all BusinessName = garage and ZIPCode = 92661',
		expectedCollapsed: 'BusinessName:garage AND ZIPCode=92661'
	},
	{
		label: 'DSL compact syntax (already collapsed, no spaces)',
		input: 'BusinessName=garage AND ZIPCode=92661',
		expectedCollapsed: 'BusinessName=garage AND ZIPCode=92661'
	},
	{
		// string "=" → contains
		label: 'OR filter (string = → contains)',
		input: 'Status = active or Status = pending',
		expectedCollapsed: 'Status:active OR Status:pending'
	},
	{
		// string "=" → contains
		label: 'NOT filter (string = → contains)',
		input: 'not Status = banned',
		expectedCollapsed: 'NOT Status:banned'
	},
	{
		label: 'Numeric comparison (> stays as-is)',
		input: 'Revenue > 1000',
		expectedCollapsed: 'Revenue>1000'
	},
	{
		label: 'Contains (explicit :)',
		input: 'BusinessName contains garage',
		expectedCollapsed: 'BusinessName:garage'
	},
	{
		// string "=" → contains; ZIPCode numeric → eq
		label: 'Complex: (A OR B) AND C',
		input: '(Status = active or Status = pending) and ZIPCode = 92661',
		expectedCollapsed: '(Status:active OR Status:pending) AND ZIPCode=92661'
	},
];

// Spaced-column tests (simulating "BUSINESS NAME", "ZIP CODE" etc.)
const spacedTests = [
	{
		// string "=" → contains (:); ZIPCode 92661 is numeric → stays =
		// matchLeaf fuzzy-matches "BusinessName" → "BUSINESS NAME" at evaluation time ✓
		label: '[SPACED] Compound AND — user types compact, columns have spaces',
		input: 'show me all BusinessName = garage and ZIPCode = 92661',
		cols: spacedColumns,
		expectedCollapsed: 'BusinessName:garage AND ZIPCode=92661'
	},
	{
		// string "=" → contains (:)
		label: '[SPACED] OR filter with spaced columns',
		input: 'STATUS = active or STATUS = pending',
		cols: spacedColumns,
		expectedCollapsed: 'STATUS:active OR STATUS:pending'
	},
];

let passed = 0;
let failed = 0;

for (const test of [...tests.map(t => ({...t, cols: columns})), ...spacedTests]) {
	const { cleaned, dsl, collapsed } = naturalLanguageToFilter_steps(test.input, test.cols);
	const ok = collapsed === test.expectedCollapsed;
	if (ok) {
		console.log(`✅ ${test.label}`);
		console.log(`   input:     "${test.input}"`);
		console.log(`   collapsed: "${collapsed}"`);
		passed++;
	} else {
		console.log(`❌ ${test.label}`);
		console.log(`   input:     "${test.input}"`);
		console.log(`   cleaned:   "${cleaned}"`);
		console.log(`   dsl:       "${dsl}"`);
		console.log(`   collapsed: "${collapsed}"`);
		console.log(`   expected:  "${test.expectedCollapsed}"`);
		failed++;
	}
	console.log('');
}

console.log(`Results: ${passed} passed, ${failed} failed`);
