/**
 * test-selection-context.mjs
 * Unit tests for cell/row/column selection context injection into LLM prompts.
 * Run with: node test-selection-context.mjs
 */

// ── Inline the selectionContext builder from ChatPane.svelte ─────────────────

function buildSelectionContext(selection) {
	if (!selection) return undefined;

	if (selection.type === 'text') {
		return selection.data.text;
	}
	if (selection.type === 'column') {
		return `Column: ${selection.data.column}`;
	}
	if (selection.type === 'row') {
		const d = selection.data;
		const rowLines = Object.entries(d.rowData)
			.map(([k, v]) => `  ${k}: ${v}`)
			.join('\n');
		return `Row ${d.rowIndex + 1}:\n${rowLines}`;
	}
	if (selection.type === 'cell') {
		const d = selection.data;
		return `Selected cell — Column: ${d.column}, Row: ${d.rowIndex + 1}, Value: ${d.value}`;
	}
	return undefined;
}

// ── Inline buildOperationPrompt (simplified, no TS imports) ──────────────────

function buildOperationPrompt(summary, question, computedResult, selectionContext) {
	const parts = [];

	parts.push('[SYSTEM PROMPT]');
	parts.push('');
	parts.push(`=== DATASET ===`);
	parts.push(`File: ${summary.fileName}`);
	parts.push(`Rows: ${summary.rowCount}`);
	parts.push(`=== END DATASET ===`);
	parts.push('');

	if (selectionContext) {
		parts.push('=== USER SELECTION (the user has selected this data) ===');
		parts.push(selectionContext);
		parts.push('=== END USER SELECTION ===');
		parts.push('');
	}

	if (computedResult) {
		parts.push('=== PRE-COMPUTED RESULT (use as ground truth) ===');
		parts.push(computedResult);
		parts.push('=== END PRE-COMPUTED RESULT ===');
		parts.push('');
	}

	parts.push(`Question: ${question}`);
	parts.push('');
	parts.push('Respond with ONLY the JSON operation object:');

	return parts.join('\n');
}

// ── Tests ────────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(label, condition, detail = '') {
	if (condition) {
		console.log(`✅ ${label}`);
		if (detail) console.log(`   ${detail}`);
		passed++;
	} else {
		console.log(`❌ ${label}`);
		if (detail) console.log(`   ${detail}`);
		failed++;
	}
}

// ── 1. Cell selection → selectionContext string ───────────────────────────────
{
	const selection = {
		type: 'cell',
		label: 'Revenue · Row 5',
		data: { column: 'Revenue', rowIndex: 4, value: 42000 }
	};
	const ctx = buildSelectionContext(selection);
	assert(
		'Cell selection → non-undefined selectionContext',
		ctx !== undefined,
		`got: ${JSON.stringify(ctx)}`
	);
	assert(
		'Cell selection → contains column name',
		ctx?.includes('Revenue'),
		`got: ${ctx}`
	);
	assert(
		'Cell selection → contains value',
		ctx?.includes('42000'),
		`got: ${ctx}`
	);
	assert(
		'Cell selection → contains row number (1-indexed)',
		ctx?.includes('Row: 5'),
		`got: ${ctx}`
	);
	console.log(`   full context: "${ctx}"`);
	console.log('');
}

// ── 2. Row selection → selectionContext string ────────────────────────────────
{
	const selection = {
		type: 'row',
		label: 'Row 12',
		data: {
			rowIndex: 11,
			rowData: { Name: 'Acme Corp', Revenue: 150000, Status: 'Active' }
		}
	};
	const ctx = buildSelectionContext(selection);
	assert(
		'Row selection → non-undefined selectionContext',
		ctx !== undefined,
		`got: ${JSON.stringify(ctx)}`
	);
	assert(
		'Row selection → contains row number (1-indexed)',
		ctx?.includes('Row 12'),
		`got: ${ctx}`
	);
	assert(
		'Row selection → contains row data',
		ctx?.includes('Acme Corp') && ctx?.includes('150000'),
		`got: ${ctx}`
	);
	console.log(`   full context: "${ctx}"`);
	console.log('');
}

// ── 3. Column selection → selectionContext string ─────────────────────────────
{
	const selection = {
		type: 'column',
		label: 'Revenue',
		data: { column: 'Revenue' }
	};
	const ctx = buildSelectionContext(selection);
	assert(
		'Column selection → non-undefined selectionContext',
		ctx !== undefined,
		`got: ${JSON.stringify(ctx)}`
	);
	assert(
		'Column selection → contains column name',
		ctx?.includes('Revenue'),
		`got: ${ctx}`
	);
	console.log(`   full context: "${ctx}"`);
	console.log('');
}

// ── 4. Text selection → selectionContext string ───────────────────────────────
{
	const selection = {
		type: 'text',
		label: '"The licensee shall..."',
		data: { text: 'The licensee shall indemnify the licensor.' }
	};
	const ctx = buildSelectionContext(selection);
	assert(
		'Text selection → non-undefined selectionContext',
		ctx !== undefined,
		`got: ${JSON.stringify(ctx)}`
	);
	assert(
		'Text selection → contains the text',
		ctx?.includes('licensee'),
		`got: ${ctx}`
	);
	console.log(`   full context: "${ctx}"`);
	console.log('');
}

// ── 5. No selection → undefined ───────────────────────────────────────────────
{
	const ctx = buildSelectionContext(null);
	assert(
		'No selection → undefined selectionContext',
		ctx === undefined,
		`got: ${JSON.stringify(ctx)}`
	);
	console.log('');
}

// ── 6. Cell selectionContext appears in buildOperationPrompt ──────────────────
{
	const summary = { fileName: 'sales.csv', rowCount: 10000 };
	const selection = {
		type: 'cell',
		label: 'Revenue · Row 5',
		data: { column: 'Revenue', rowIndex: 4, value: 42000 }
	};
	const ctx = buildSelectionContext(selection);
	const prompt = buildOperationPrompt(summary, 'Why is this value so high?', undefined, ctx);

	assert(
		'Cell context appears in operation prompt',
		prompt.includes('=== USER SELECTION'),
		`prompt snippet: ${prompt.slice(prompt.indexOf('=== USER'), prompt.indexOf('=== USER') + 200)}`
	);
	assert(
		'Cell value appears in operation prompt',
		prompt.includes('42000'),
		`prompt snippet: ${prompt.slice(prompt.indexOf('42000') - 20, prompt.indexOf('42000') + 50)}`
	);
	assert(
		'Cell column appears in operation prompt',
		prompt.includes('Revenue'),
		`prompt snippet: ${prompt.slice(prompt.indexOf('Revenue') - 10, prompt.indexOf('Revenue') + 50)}`
	);
	assert(
		'USER SELECTION block appears BEFORE the Question line',
		prompt.indexOf('=== USER SELECTION') < prompt.indexOf('Question:'),
		`USER SELECTION at ${prompt.indexOf('=== USER SELECTION')}, Question at ${prompt.indexOf('Question:')}`
	);
	console.log('');
}

// ── 7. No selection → no USER SELECTION block in prompt ──────────────────────
{
	const summary = { fileName: 'sales.csv', rowCount: 10000 };
	const prompt = buildOperationPrompt(summary, 'Total revenue?', undefined, undefined);
	assert(
		'No selection → no USER SELECTION block in prompt',
		!prompt.includes('=== USER SELECTION'),
		`prompt: ${prompt.slice(0, 200)}`
	);
	console.log('');
}

// ── 8. selectionContext appears BEFORE computedResult in prompt ───────────────
{
	const summary = { fileName: 'sales.csv', rowCount: 10000 };
	const ctx = 'Selected cell — Column: Revenue, Row: 5, Value: 42000';
	const computed = 'COMPUTED: sum(Revenue) = 1,234,567';
	const prompt = buildOperationPrompt(summary, 'Is this typical?', computed, ctx);

	const selIdx = prompt.indexOf('=== USER SELECTION');
	const compIdx = prompt.indexOf('=== PRE-COMPUTED RESULT');
	assert(
		'selectionContext block appears before computedResult block',
		selIdx !== -1 && compIdx !== -1 && selIdx < compIdx,
		`USER SELECTION at ${selIdx}, PRE-COMPUTED at ${compIdx}`
	);
	console.log('');
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`Results: ${passed} passed, ${failed} failed`);
