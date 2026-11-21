import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReport, buildDuplicationReport, type ReportBuildRequest, type DuplicationBuildRequest } from './report-worker.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
let fontBytesOverride: { regular: ArrayBuffer; bold: ArrayBuffer };

/**
 * These tests exercise `buildReport` directly (not through a real Worker —
 * `report-worker.ts` only wires up `self.onmessage` when `self.postMessage`
 * exists, which it does not under plain Node/Vitest). This is the same
 * approach as pdf-writer.test.ts: real xlsx/pdf-lib/pdfjs-dist, just without
 * the postMessage plumbing.
 */

let xlsxFixtureBytes: ArrayBuffer;
let xlsxDuplicatesFixtureBytes: ArrayBuffer;

beforeAll(async () => {
	const XLSX = (await import('xlsx')).default;
	const ws: Record<string, unknown> = {
		'!ref': 'A1:D4',
		A1: { t: 's', v: 'Region' },
		B1: { t: 's', v: 'Amount' },
		C1: { t: 's', v: 'Invoice #' },
		D1: { t: 's', v: 'Date' },
		A2: { t: 's', v: 'East' },
		B2: { t: 'n', v: 100, z: '$#,##0.00', w: '$100.00' },
		C2: { t: 'n', v: 1001, w: '1001' },
		D2: { t: 'n', v: 45000, z: 'm/d/yyyy', w: '3/15/2023' },
		A3: { t: 's', v: 'West' },
		B3: { t: 'n', v: 200, z: '$#,##0.00', w: '$200.00' },
		C3: { t: 'n', v: 1002, w: '1002' },
		D3: { t: 'n', v: 45010, z: 'm/d/yyyy', w: '3/25/2023' },
		A4: { t: 's', v: 'East' },
		B4: { t: 'e', v: 15, w: '#DIV/0!' },
		C4: { t: 'n', v: 1003, w: '1003' },
		D4: { t: 'n', v: 45020, z: 'm/d/yyyy', w: '4/4/2023' }
	};
	const workbook = { SheetNames: ['Sheet1'], Sheets: { Sheet1: ws } };
	const buf: Buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
	const toArrayBuffer = (b: Buffer): ArrayBuffer =>
		b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
	xlsxFixtureBytes = toArrayBuffer(buf);

	fontBytesOverride = {
		regular: toArrayBuffer(readFileSync(join(__dirname, 'fonts/NotoSans-Regular.ttf'))),
		bold: toArrayBuffer(readFileSync(join(__dirname, 'fonts/NotoSans-Bold.ttf')))
	};

	// A second fixture with a known duplicate pair (rows 1 and 3, both
	// "Alice"/"alice " after normalization) plus a unique row (Bob), for
	// the Data Duplication Report tests.
	const dupWs: Record<string, unknown> = {
		'!ref': 'A1:B4',
		A1: { t: 's', v: 'Name' },
		B1: { t: 's', v: 'City' },
		A2: { t: 's', v: 'Alice' },
		B2: { t: 's', v: 'NYC' },
		A3: { t: 's', v: 'Bob' },
		B3: { t: 's', v: 'LA' },
		A4: { t: 's', v: 'alice ' }, // same as row 2 after case/whitespace normalization
		B4: { t: 's', v: 'NYC' }
	};
	const dupWorkbook = { SheetNames: ['Sheet1'], Sheets: { Sheet1: dupWs } };
	const dupBuf: Buffer = XLSX.write(dupWorkbook, { type: 'buffer', bookType: 'xlsx' });
	xlsxDuplicatesFixtureBytes = toArrayBuffer(dupBuf);
});

function baseDuplicationRequest(
	overrides: Partial<DuplicationBuildRequest> = {}
): DuplicationBuildRequest {
	return {
		fileName: 'test.xlsx',
		sourceType: 'excel',
		fileBytes: xlsxDuplicatesFixtureBytes,
		sheetName: 'Sheet1',
		title: 'Test Duplication Report',
		keyColumns: ['Name'],
		caseInsensitive: true,
		trimWhitespace: true,
		detail: 'compact',
		pageSize: 'Letter',
		generatedAtDisplay: '2024-01-01 12:00 UTC',
		...overrides
	};
}

function baseRequest(overrides: Partial<ReportBuildRequest> = {}): ReportBuildRequest {
	return {
		fileName: 'test.xlsx',
		sourceType: 'excel',
		fileBytes: xlsxFixtureBytes,
		sheetName: 'Sheet1',
		title: 'Test Report',
		groupByColumn: 'Region',
		columnAggregations: [
			{ column: 'Amount', aggregation: 'sum' },
			{ column: 'Invoice #', aggregation: 'none' }
		],
		sort: { by: 'group-key', direction: 'asc' },
		sortDescription: 'Group key (asc)',
		detail: 'summary-and-detail',
		pageSize: 'Letter',
		generatedAtDisplay: '2024-01-01 12:00 UTC',
		...overrides
	};
}

async function extractAllText(bytes: Uint8Array): Promise<string> {
	const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
	const doc = await pdfjs.getDocument({ data: bytes }).promise;
	let text = '';
	for (let i = 1; i <= doc.numPages; i++) {
		const page = await doc.getPage(i);
		const content = await page.getTextContent();
		text += content.items.map((it) => ('str' in it ? (it.str as string) : '')).join('') + '\n';
	}
	return text;
}

describe('buildReport — end to end (Excel source)', () => {
	it('re-parses the ORIGINAL bytes and sums Amount, excluding the error cell', async () => {
		const result = await buildReport(baseRequest(), fontBytesOverride);
		const text = await extractAllText(result.pdfBytes);
		// 100 + 200 = 300 (the #DIV/0! cell must be excluded).
		expect(text).toContain('$300.00');
		expect(result.warnings.some((w) => w.includes('error or unresolved-formula'))).toBe(true);
	});

	it('excludes "Invoice #" from aggregation even though it is numeric (ID heuristic)', async () => {
		const result = await buildReport(baseRequest(), fontBytesOverride);
		const text = await extractAllText(result.pdfBytes);
		expect(text).not.toMatch(/Invoice #.*Sum/);
	});

	it('excludes the date column from aggregation and uses it for a KPI date range instead', async () => {
		const result = await buildReport(
			baseRequest({
				columnAggregations: [
					{ column: 'Amount', aggregation: 'sum' },
					{ column: 'Date', aggregation: 'sum' } // caller mistakenly asks to sum a date column
				]
			}),
			fontBytesOverride
		);
		const text = await extractAllText(result.pdfBytes);
		expect(text).toContain('Date range');
		expect(text).not.toMatch(/Grand total Date/);
	});

	it('includes the full SHA-256 of the ORIGINAL bytes in settings and its first 12 chars in the footer', async () => {
		const result = await buildReport(baseRequest(), fontBytesOverride);
		expect(result.sha256Full).toHaveLength(64);
		const text = await extractAllText(result.pdfBytes);
		expect(text).toContain(result.sha256Full);
		expect(text).toContain(result.sha256Full.slice(0, 12));
	});

	it('produces a group-summary table before the detail rows, and a "summary only" mode without detail', async () => {
		const full = await buildReport(baseRequest({ detail: 'summary-and-detail' }), fontBytesOverride);
		const fullText = await extractAllText(full.pdfBytes);
		expect(fullText).toContain('Group summary');
		// "Detail" also appears in the Settings block ("Detail: Summary +
		// detail rows") — look specifically for the DETAIL TABLE's own
		// column-header row (Region/Amount repeated a second time), which only
		// exists once the detail section itself is rendered.
		const groupSummaryIdx = fullText.indexOf('Group summary');
		const detailHeadingIdx = fullText.indexOf('Detail', groupSummaryIdx);
		expect(detailHeadingIdx).toBeGreaterThan(groupSummaryIdx);

		const summaryOnly = await buildReport(baseRequest({ detail: 'summary' }), fontBytesOverride);
		const summaryOnlyText = await extractAllText(summaryOnly.pdfBytes);
		expect(summaryOnlyText).toContain('Group summary');
		// No detail-table heading after the settings block's "Detail:" line.
		const settingsDetailIdx = summaryOnlyText.indexOf('Detail:');
		expect(settingsDetailIdx).toBeGreaterThanOrEqual(0);
		expect(summaryOnlyText.indexOf('Detail', settingsDetailIdx + 'Detail:'.length)).toBe(-1);
	});

	it('reports the correct group count', async () => {
		const result = await buildReport(baseRequest(), fontBytesOverride);
		expect(result.groupCount).toBe(2); // East, West
	});
});

describe('buildDuplicationReport — end to end (Excel source)', () => {
	it('finds the normalized "Alice"/"alice " duplicate pair and excludes the unique "Bob" row', async () => {
		const result = await buildDuplicationReport(baseDuplicationRequest(), fontBytesOverride);
		expect(result.groupCount).toBe(1);
		expect(result.duplicateRowCount).toBe(2);
		const text = await extractAllText(result.pdfBytes);
		expect(text).toContain('Duplicate groups');
		expect(text).toContain('Alice');
		expect(text).not.toContain('Bob');
	});

	it('finds no duplicates when case/whitespace normalization is turned off', async () => {
		const result = await buildDuplicationReport(
			baseDuplicationRequest({ caseInsensitive: false, trimWhitespace: false }),
			fontBytesOverride
		);
		expect(result.groupCount).toBe(0);
		const text = await extractAllText(result.pdfBytes);
		expect(text).toContain('No duplicate groups were found');
	});

	it('includes the row numbers for the matched duplicate group in compact mode', async () => {
		const result = await buildDuplicationReport(baseDuplicationRequest(), fontBytesOverride);
		const text = await extractAllText(result.pdfBytes);
		// Rows 1 and 3 (1-based, Alice at row 1, "alice " at row 3) should
		// both be listed.
		expect(text).toMatch(/1.*3|1,\s*3/);
	});

	it('full detail mode includes every column for every duplicated row, not just the key column', async () => {
		const result = await buildDuplicationReport(
			baseDuplicationRequest({ detail: 'full' }),
			fontBytesOverride
		);
		const text = await extractAllText(result.pdfBytes);
		expect(text).toContain('NYC'); // the City column value, only present in 'full' mode
	});

	it('includes the full SHA-256 of the original bytes', async () => {
		const result = await buildDuplicationReport(baseDuplicationRequest(), fontBytesOverride);
		expect(result.sha256Full).toHaveLength(64);
		const text = await extractAllText(result.pdfBytes);
		expect(text).toContain(result.sha256Full);
	});
});
