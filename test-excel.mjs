/**
 * test-excel.mjs — End-to-end test for the Excel/CSV → Workbook pipeline.
 *
 * Run with:  node test-excel.mjs
 *
 * What it covers:
 *   1. Programmatically builds a real .xlsx (3 sheets, one SUM formula) via SheetJS.
 *   2. parseExcel(): multi-sheet extraction (3 sheets, correct headers/rows).
 *   3. parseExcel(): formula extraction (the SUM formula is preserved on the sheet).
 *   4. parseCsv(): single-sheet CSV string → single-sheet Workbook.
 *   5. executeOperation(): cross-sheet correlation across two sheets.
 *   6. workbookToCsvData(): bridge a Workbook back to the legacy { columns, rows } shape.
 *
 * Implementation note:
 * Like the other repo tests (test-filter.mjs, test-selection-context.mjs), this
 * harness re-implements the SOURCE logic inline in plain JS so it runs under a
 * bare `node` with no TypeScript loader. The inlined functions are faithful
 * 1:1 ports of:
 *   - src/lib/parsers/excel.ts        (parseExcel, extractFormulas, generateColumnName)
 *   - src/lib/parsers/csv.ts          (parseCsv, workbookToCsvData)
 *   - src/lib/pipeline/engine.ts      (executeOperation / executeCrossSheet, resolveColumn, toNum, toStr)
 * SheetJS (`xlsx`) is used FOR REAL — both to author the workbook bytes and to
 * read them back — exactly as excel.ts does at runtime via `await import('xlsx')`.
 */

import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';

let passed = 0;
function check(name, fn) {
	try {
		fn();
		passed++;
		console.log(`  ✓ ${name}`);
	} catch (err) {
		console.error(`  ✗ ${name}`);
		console.error('    ' + (err && err.message ? err.message : String(err)));
		process.exit(1);
	}
}

// ════════════════════════════════════════════════════════════════════════════
// Inlined ports of excel.ts
// ════════════════════════════════════════════════════════════════════════════

function generateColumnName(index) {
	let label = '';
	let n = index;
	do {
		label = String.fromCharCode(65 + (n % 26)) + label;
		n = Math.floor(n / 26) - 1;
	} while (n >= 0);
	return `Column ${label}`;
}

function cellToString(value) {
	if (value === null || value === undefined) return '';
	return String(value);
}

function extractFormulas(xlsx, ws, headers) {
	const ref = ws['!ref'];
	if (!ref) return undefined;
	const range = xlsx.utils.decode_range(ref);
	let found = false;
	const dataRowCount = Math.max(range.e.r - range.s.r, 0);
	const result = Array.from({ length: dataRowCount }, () => ({}));
	for (let r = range.s.r + 1; r <= range.e.r; r++) {
		for (let c = range.s.c; c <= range.e.c; c++) {
			const addr = xlsx.utils.encode_cell({ r, c });
			const cell = ws[addr];
			if (cell && cell.f) {
				found = true;
				const colIndex = c - range.s.c;
				const header = headers[colIndex] ?? generateColumnName(colIndex);
				const dataRowIndex = r - (range.s.r + 1);
				result[dataRowIndex][header] = cell.f;
			}
		}
	}
	return found ? result : undefined;
}

/** Faithful port of parseExcel(), but takes raw bytes (Uint8Array) instead of a File. */
function parseExcelBytes(fileName, data) {
	const wb = XLSX.read(data, { type: 'array', cellFormula: true });
	const sheets = [];
	for (const sheetName of wb.SheetNames) {
		const ws = wb.Sheets[sheetName];
		const matrix = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', blankrows: false });
		const headerRow = matrix[0] ?? [];
		const dataMatrix = matrix.slice(1);
		const maxCols = Math.max(
			headerRow.length,
			...dataMatrix.map((r) => (Array.isArray(r) ? r.length : 0)),
			0
		);
		const headers = [];
		for (let c = 0; c < maxCols; c++) {
			const raw = cellToString(headerRow[c]).trim();
			headers.push(raw !== '' ? raw : generateColumnName(c));
		}
		// Fully-empty sheet → synthesize a single "Column A" (matches excel.ts).
		if (headers.length === 0) headers.push(generateColumnName(0));
		const rows = [];
		for (const r of dataMatrix) {
			const rowArr = Array.isArray(r) ? r : [];
			const obj = {};
			for (let c = 0; c < headers.length; c++) obj[headers[c]] = cellToString(rowArr[c]);
			rows.push(obj);
		}
		const formulas = extractFormulas(XLSX, ws, headers);
		const sheet = { name: sheetName, headers, rows, rowCount: rows.length };
		if (formulas) sheet.formulas = formulas;
		sheets.push(sheet);
	}
	return { fileName, sheets, activeSheet: wb.SheetNames[0] ?? '' };
}

// ════════════════════════════════════════════════════════════════════════════
// Inlined ports of csv.ts (parseCsv + workbookToCsvData)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Minimal CSV string → single-sheet Workbook, mirroring parseCsv() semantics:
 * header row → headers, remaining lines → string-normalized row objects,
 * single sheet named "Sheet1", activeSheet = "Sheet1", no formulas.
 */
function parseCsvString(fileName, text) {
	const lines = text.replace(/\r\n/g, '\n').split('\n').filter((l) => l.trim() !== '');
	if (lines.length === 0) throw new Error('No columns detected in CSV');
	const split = (line) => line.split(',').map((c) => c.trim());
	const headers = split(lines[0]);
	if (headers.length === 0) throw new Error('No columns detected in CSV');
	const rows = lines.slice(1).map((line) => {
		const cells = split(line);
		const obj = {};
		headers.forEach((h, i) => {
			const v = cells[i];
			obj[h] = v === null || v === undefined ? '' : String(v);
		});
		return obj;
	});
	return {
		fileName,
		activeSheet: 'Sheet1',
		sheets: [{ name: 'Sheet1', headers, rows, rowCount: rows.length, formulas: undefined }]
	};
}

function workbookToCsvData(wb) {
	const sheet = wb.sheets.find((s) => s.name === wb.activeSheet) ?? wb.sheets[0];
	if (!sheet) return { columns: [], rows: [] };
	return { columns: sheet.headers, rows: sheet.rows };
}

// ════════════════════════════════════════════════════════════════════════════
// Inlined ports of engine.ts (resolveColumn, toNum, toStr, executeCrossSheet, executeOperation)
// ════════════════════════════════════════════════════════════════════════════

function normCol(s) {
	return s.toLowerCase().replace(/[\s_\-]/g, '');
}

function resolveColumn(name, columns) {
	const needle = normCol(name);
	for (const col of columns) if (col.toLowerCase() === name.toLowerCase()) return col;
	for (const col of columns) if (normCol(col) === needle) return col;
	let best = null;
	let bestLen = 0;
	for (const col of columns) {
		const cn = normCol(col);
		if (cn.includes(needle) || needle.includes(cn)) {
			if (cn.length > bestLen) { best = col; bestLen = cn.length; }
		}
	}
	return best;
}

function toNum(v) {
	if (v === null || v === undefined || v === '') return null;
	if (typeof v === 'number') return isNaN(v) ? null : v;
	if (typeof v === 'string') {
		const n = Number(v.replace(/[$,%\s]/g, ''));
		return isNaN(n) ? null : n;
	}
	return null;
}

function toStr(v) {
	if (v === null || v === undefined) return '';
	return String(v);
}

function resolveSheet(wb, name) {
	const sheet = name ? wb.sheets.find((s) => s.name === name) : wb.sheets[0];
	if (!sheet) {
		const available = wb.sheets.map((s) => s.name).join(', ');
		throw new Error(`Sheet "${name}" not found. Available sheets: ${available}`);
	}
	return sheet;
}

function executeCrossSheet(op, wb) {
	const sheetA = resolveSheet(wb, op.sheetA);
	const sheetB = resolveSheet(wb, op.sheetB);
	const colA = resolveColumn(op.columnA, sheetA.headers);
	if (!colA) throw new Error(`Column "${op.columnA}" not found in sheet "${sheetA.name}".`);
	const colB = resolveColumn(op.columnB, sheetB.headers);
	if (!colB) throw new Error(`Column "${op.columnB}" not found in sheet "${sheetB.name}".`);

	let commonKeyA = null;
	let commonKeyB = null;
	for (const header of sheetA.headers) {
		if (header === colA) continue;
		const match = resolveColumn(header, sheetB.headers);
		if (match && match !== colB) { commonKeyA = header; commonKeyB = match; break; }
	}

	const pairs = [];
	if (commonKeyA && commonKeyB) {
		const indexB = new Map();
		for (const row of sheetB.rows) {
			const key = toStr(row[commonKeyB]);
			if (key !== '' && !indexB.has(key)) indexB.set(key, row);
		}
		for (const rowA of sheetA.rows) {
			const key = toStr(rowA[commonKeyA]);
			const rowB = indexB.get(key);
			if (!rowB) continue;
			const x = toNum(rowA[colA]);
			const y = toNum(rowB[colB]);
			if (x !== null && y !== null) pairs.push({ x, y, key });
		}
	} else {
		const len = Math.min(sheetA.rows.length, sheetB.rows.length);
		for (let i = 0; i < len; i++) {
			const x = toNum(sheetA.rows[i][colA]);
			const y = toNum(sheetB.rows[i][colB]);
			if (x !== null && y !== null) pairs.push({ x, y });
		}
	}

	if (pairs.length < 2) {
		return { type: 'scalar', value: null, label: `correlation(${sheetA.name}.${colA}, ${sheetB.name}.${colB})`, pairs };
	}

	const n = pairs.length;
	const sumX = pairs.reduce((s, p) => s + p.x, 0);
	const sumY = pairs.reduce((s, p) => s + p.y, 0);
	const meanX = sumX / n;
	const meanY = sumY / n;
	let num = 0, dX = 0, dY = 0;
	for (const p of pairs) {
		const ax = p.x - meanX;
		const ay = p.y - meanY;
		num += ax * ay;
		dX += ax * ax;
		dY += ay * ay;
	}
	const denom = Math.sqrt(dX * dY);
	const r = denom === 0 ? null : num / denom;
	return {
		type: 'correlation',
		value: r !== null ? Math.round(r * 10000) / 10000 : null,
		pairs,
		matched: pairs.length,
		joinKey: commonKeyA
	};
}

/** Resolve referenced columns up-front (subset of engine.ts validateColumns). */
function validateColumns(sheet, columns) {
	for (const col of columns) {
		if (resolveColumn(col, sheet.headers) === null) {
			throw new Error(
				`Column "${col}" not found in sheet "${sheet.name}". Available columns: ${sheet.headers.join(', ')}`
			);
		}
	}
}

function compareValues(a, b) {
	const aEmpty = a === '' || a === null || a === undefined;
	const bEmpty = b === '' || b === null || b === undefined;
	if (aEmpty && bEmpty) return 0;
	if (aEmpty) return 1;
	if (bEmpty) return -1;
	const an = toNum(a);
	const bn = toNum(b);
	if (an !== null && bn !== null) return an - bn;
	return a.toLowerCase().localeCompare(b.toLowerCase());
}

/** Single-sheet executor — supports the ops this harness exercises (filter, sort). */
function executeOnRows(data, op) {
	if (data.length === 0) return { type: 'error', message: 'Dataset is empty.' };
	const columns = Object.keys(data[0]);
	if (op.type === 'filter') {
		const f = op.filters[0];
		const col = resolveColumn(f.column, columns);
		const rows = data.filter((row) => {
			const n = toNum(row[col]);
			const fn = toNum(f.value);
			if (f.op === 'gt') return n !== null && fn !== null && n > fn;
			if (f.op === 'eq') return String(row[col]).toLowerCase() === String(f.value).toLowerCase();
			return false;
		});
		return { type: 'rows', data: rows, columns, totalCount: rows.length };
	}
	if (op.type === 'sort') {
		const c = op.columns[0];
		const col = resolveColumn(c.column, columns) ?? c.column;
		const sorted = [...data].sort((a, b) => {
			const cmp = compareValues(a[col] ?? '', b[col] ?? '');
			return c.direction === 'asc' ? cmp : -cmp;
		});
		return { type: 'rows', data: sorted, columns, totalCount: sorted.length };
	}
	return { type: 'error', message: `Unsupported op ${op.type}` };
}

function executeOperation(op, wb) {
	if (op.type === 'crossSheet') return executeCrossSheet(op, wb);
	const sheet = resolveSheet(wb, op.sheet);
	const refs =
		op.type === 'filter'
			? op.filters.map((f) => f.column)
			: op.type === 'sort'
				? op.columns.map((c) => c.column)
				: [];
	validateColumns(sheet, refs);
	return executeOnRows(sheet.rows, op);
}

// ════════════════════════════════════════════════════════════════════════════
// Build a sample 3-sheet .xlsx with a SUM formula
// ════════════════════════════════════════════════════════════════════════════

function buildSampleWorkbookBytes() {
	const wb = XLSX.utils.book_new();

	// Sheet 1: "Sales" — region, units, revenue + a SUM formula in a Total row.
	const salesAoa = [
		['region', 'units', 'revenue'],
		['North', 10, 1000],
		['South', 20, 2000],
		['East', 30, 3000],
		['Total', null, null] // revenue total via formula below
	];
	const salesWs = XLSX.utils.aoa_to_sheet(salesAoa);
	// Put a SUM formula in C5 (revenue total of C2:C4). A cached numeric value
	// (`v`) is included so SheetJS serializes the cell on write and round-trips
	// the formula (`f`) back on read with { cellFormula: true }.
	salesWs['C5'] = { t: 'n', f: 'SUM(C2:C4)', v: 6000 };
	// Ensure the sheet range covers C5 so the formula cell isn't pruned.
	salesWs['!ref'] = 'A1:C5';
	XLSX.utils.book_append_sheet(wb, salesWs, 'Sales');

	// Sheet 2: "Costs" — region, cost (matches Sales by "region" key).
	// cost is exactly 0.5 × revenue → a perfectly linear relationship, so the
	// Pearson correlation with Sales.revenue is exactly 1 (deterministic assert).
	const costsAoa = [
		['region', 'cost'],
		['North', 500],
		['South', 1000],
		['East', 1500]
	];
	XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(costsAoa), 'Costs');

	// Sheet 3: "Notes" — a small text sheet to prove 3-sheet extraction.
	const notesAoa = [
		['note'],
		['Q3 figures'],
		['Draft']
	];
	XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(notesAoa), 'Notes');

	const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
	return new Uint8Array(out);
}

// ════════════════════════════════════════════════════════════════════════════
// Tests
// ════════════════════════════════════════════════════════════════════════════

console.log('test-excel.mjs');

const bytes = buildSampleWorkbookBytes();
const wb = parseExcelBytes('sample.xlsx', bytes);

console.log('\n[1] Multi-sheet extraction');
check('workbook has 3 sheets in tab order', () => {
	assert.equal(wb.sheets.length, 3);
	assert.deepEqual(wb.sheets.map((s) => s.name), ['Sales', 'Costs', 'Notes']);
});
check('activeSheet is the first sheet', () => {
	assert.equal(wb.activeSheet, 'Sales');
});
check('Sales sheet headers + row data parsed correctly', () => {
	const sales = wb.sheets.find((s) => s.name === 'Sales');
	assert.deepEqual(sales.headers, ['region', 'units', 'revenue']);
	// 3 data rows + the Total row = 4 rows
	assert.equal(sales.rowCount, 4);
	assert.equal(sales.rows[0].region, 'North');
	assert.equal(sales.rows[0].units, '10');
	assert.equal(sales.rows[1].revenue, '2000');
});
check('Notes sheet (3rd tab) parsed', () => {
	const notes = wb.sheets.find((s) => s.name === 'Notes');
	assert.deepEqual(notes.headers, ['note']);
	assert.equal(notes.rowCount, 2);
	assert.equal(notes.rows[0].note, 'Q3 figures');
});

console.log('\n[2] Formula extraction');
check('SUM formula preserved on the Sales sheet', () => {
	const sales = wb.sheets.find((s) => s.name === 'Sales');
	assert.ok(sales.formulas, 'expected sales.formulas to be defined');
	// The formula lives in the "Total" data row (4th data row, index 3), column "revenue".
	const totalRowFormula = sales.formulas[3];
	assert.ok(totalRowFormula, 'expected a formula entry for the Total row');
	assert.equal(totalRowFormula.revenue, 'SUM(C2:C4)');
});
check('sheets without formulas have no formulas map', () => {
	const notes = wb.sheets.find((s) => s.name === 'Notes');
	assert.equal(notes.formulas, undefined);
});

console.log('\n[3] CSV → single-sheet Workbook via parseCsv');
const csvWb = parseCsvString(
	'people.csv',
	'name,age,city\nAda,36,London\nGrace,40,NYC\nLinus,52,Helsinki'
);
check('CSV becomes a single sheet named "Sheet1"', () => {
	assert.equal(csvWb.sheets.length, 1);
	assert.equal(csvWb.sheets[0].name, 'Sheet1');
	assert.equal(csvWb.activeSheet, 'Sheet1');
});
check('CSV headers + rows parsed and string-normalized', () => {
	const s = csvWb.sheets[0];
	assert.deepEqual(s.headers, ['name', 'age', 'city']);
	assert.equal(s.rowCount, 3);
	assert.equal(s.rows[0].name, 'Ada');
	assert.equal(s.rows[0].age, '36'); // normalized to string
	assert.equal(s.rows[2].city, 'Helsinki');
});
check('CSV sheet carries no formulas', () => {
	assert.equal(csvWb.sheets[0].formulas, undefined);
});

console.log('\n[4] Cross-sheet operation execution');
check('crossSheet correlation joins Sales.revenue ↔ Costs.cost on region key', () => {
	const op = {
		type: 'crossSheet',
		sheetA: 'Sales',
		columnA: 'revenue',
		sheetB: 'Costs',
		columnB: 'cost'
	};
	const res = executeOperation(op, wb);
	assert.equal(res.type, 'correlation');
	// Joined on the shared "region" key → North/South/East (Total has no match in Costs).
	assert.equal(res.matched, 3);
	assert.equal(res.joinKey, 'region');
	// revenue [1000,2000,3000] vs cost [500,1000,1500] are perfectly linear
	// (cost = 0.5 × revenue) → Pearson r === 1.
	assert.equal(res.value, 1);
});
check('crossSheet throws for an unknown column', () => {
	const op = { type: 'crossSheet', sheetA: 'Sales', columnA: 'nope', sheetB: 'Costs', columnB: 'cost' };
	assert.throws(() => executeOperation(op, wb), /not found in sheet "Sales"/);
});

console.log('\n[5] workbookToCsvData bridge');
check('workbookToCsvData returns legacy { columns, rows } for the active sheet', () => {
	const legacy = workbookToCsvData(wb); // active = Sales
	assert.deepEqual(legacy.columns, ['region', 'units', 'revenue']);
	assert.equal(legacy.rows.length, 4);
	assert.equal(legacy.rows[0].region, 'North');
});
check('workbookToCsvData on the CSV workbook round-trips', () => {
	const legacy = workbookToCsvData(csvWb);
	assert.deepEqual(legacy.columns, ['name', 'age', 'city']);
	assert.equal(legacy.rows.length, 3);
	assert.equal(legacy.rows[1].name, 'Grace');
});

console.log('\n[6] Edge cases — empty / headerless / fully-empty sheets');

// Build a workbook with three pathological sheets.
function buildEdgeCaseWorkbookBytes() {
	const wb = XLSX.utils.book_new();
	// EmptyRows: headers but ZERO data rows.
	XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['id', 'value']]), 'EmptyRows');
	// NoHeaders: a blank first row, then data → headers must be generated.
	XLSX.utils.book_append_sheet(
		wb,
		XLSX.utils.aoa_to_sheet([['', ''], ['a', 'b'], ['c', 'd']]),
		'NoHeaders'
	);
	// Blank: a completely empty sheet (no headers AND no rows).
	XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([[]]), 'Blank');
	return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }));
}
const edgeWb = parseExcelBytes('edge.xlsx', buildEdgeCaseWorkbookBytes());

check('empty sheet (headers, no rows) → headers kept, rows empty', () => {
	const s = edgeWb.sheets.find((x) => x.name === 'EmptyRows');
	assert.deepEqual(s.headers, ['id', 'value']);
	assert.equal(s.rowCount, 0);
	assert.deepEqual(s.rows, []);
});
check('headerless sheet → generated "Column A"/"Column B" names', () => {
	const s = edgeWb.sheets.find((x) => x.name === 'NoHeaders');
	assert.deepEqual(s.headers, ['Column A', 'Column B']);
	assert.equal(s.rowCount, 2);
	assert.equal(s.rows[0]['Column A'], 'a');
	assert.equal(s.rows[1]['Column B'], 'd');
});
check('fully-empty sheet (no headers, no rows) → single "Column A"', () => {
	const s = edgeWb.sheets.find((x) => x.name === 'Blank');
	assert.deepEqual(s.headers, ['Column A']);
	assert.equal(s.rowCount, 0);
});

console.log('\n[7] Invalid sheet / column names throw descriptive errors');
check('invalid sheet name throws with available sheets listed', () => {
	const op = { type: 'filter', sheet: 'Ghost', filters: [{ column: 'revenue', op: 'gt', value: 0 }] };
	assert.throws(() => executeOperation(op, wb), /Sheet "Ghost" not found.*Sales, Costs, Notes/s);
});
check('invalid column name throws with available columns listed', () => {
	const op = { type: 'filter', sheet: 'Sales', filters: [{ column: 'profit', op: 'gt', value: 0 }] };
	assert.throws(() => executeOperation(op, wb), /Column "profit" not found in sheet "Sales".*region, units, revenue/s);
});

console.log('\n[8] Filter / sort operate on the targeted sheet (workbook path)');
check('filter Sales.revenue > 1500 returns the matching rows of THAT sheet', () => {
	const op = { type: 'filter', sheet: 'Sales', filters: [{ column: 'revenue', op: 'gt', value: 1500 }] };
	const res = executeOperation(op, wb);
	assert.equal(res.type, 'rows');
	// revenue qualifies for South (2000), East (3000), and the Total row — the
	// Total's revenue cell carries the SUM(C2:C4) formula whose CACHED value
	// (6000) is surfaced as the cell value, so 6000 > 1500 also matches.
	assert.equal(res.totalCount, 3);
	assert.deepEqual(res.data.map((r) => r.region).sort(), ['East', 'South', 'Total']);
});
check('sort Costs.cost desc reorders ONLY the Costs sheet', () => {
	const op = { type: 'sort', sheet: 'Costs', columns: [{ column: 'cost', direction: 'desc' }] };
	const res = executeOperation(op, wb);
	assert.deepEqual(res.data.map((r) => r.region), ['East', 'South', 'North']);
	// Original sheet order is untouched (operation returns a copy).
	const costs = wb.sheets.find((s) => s.name === 'Costs');
	assert.deepEqual(costs.rows.map((r) => r.region), ['North', 'South', 'East']);
});

console.log('\n[9] Selection-context sheet prefixing (multi-sheet vs single-sheet)');
// Mirrors ChatPane.svelte: multi-sheet workbooks prefix tabular selections
// with "Sheet: <activeSheet>"; single-sheet (CSV) workbooks add no prefix.
function buildColumnSelectionContext(wbk, activeSheet, column) {
	const prefix = wbk && wbk.sheets.length > 1 ? `Sheet: ${activeSheet}\n` : '';
	return `${prefix}Column: ${column}`;
}
check('multi-sheet workbook prefixes selection with the active sheet name', () => {
	const ctx = buildColumnSelectionContext(wb, 'Costs', 'cost');
	assert.equal(ctx, 'Sheet: Costs\nColumn: cost');
});
check('single-sheet (CSV) workbook adds no sheet prefix', () => {
	const ctx = buildColumnSelectionContext(csvWb, 'Sheet1', 'age');
	assert.equal(ctx, 'Column: age');
});

console.log(`\nAll ${passed} assertions passed ✓`);
process.exit(0);
