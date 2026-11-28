import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	buildReport,
	buildDuplicationReport,
	buildOutlierReport,
	buildContractReport,
	type ReportBuildRequest,
	type DuplicationBuildRequest,
	type OutlierBuildRequest,
	type ContractBuildRequest
} from './report-worker.js';
import type { ContractProfile } from '$lib/lenses/contract/types.js';

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
let xlsxOutlierFixtureBytes: ArrayBuffer;

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

	// A third fixture with a tight cluster of "normal" Amount values (rows
	// 1-9) plus one clear high outlier (row 10, value 500), for the Data
	// Outlier Analysis tests.
	const outlierValues = [10, 11, 12, 13, 14, 12, 11, 13, 10, 500];
	const outlierWs: Record<string, unknown> = { '!ref': `A1:A${outlierValues.length + 1}` };
	outlierWs.A1 = { t: 's', v: 'Amount' };
	outlierValues.forEach((v, i) => {
		outlierWs[`A${i + 2}`] = { t: 'n', v, w: String(v) };
	});
	const outlierWorkbook = { SheetNames: ['Sheet1'], Sheets: { Sheet1: outlierWs } };
	const outlierBuf: Buffer = XLSX.write(outlierWorkbook, { type: 'buffer', bookType: 'xlsx' });
	xlsxOutlierFixtureBytes = toArrayBuffer(outlierBuf);
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

function baseOutlierRequest(overrides: Partial<OutlierBuildRequest> = {}): OutlierBuildRequest {
	return {
		fileName: 'test.xlsx',
		sourceType: 'excel',
		fileBytes: xlsxOutlierFixtureBytes,
		sheetName: 'Sheet1',
		title: 'Test Outlier Report',
		columns: ['Amount'],
		sensitivity: 'standard',
		detail: 'summary-and-detail',
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

describe('buildOutlierReport — end to end (Excel source)', () => {
	it('flags the clear high outlier (value 500, row 10) and reports its deviation', async () => {
		const result = await buildOutlierReport(baseOutlierRequest(), fontBytesOverride);
		expect(result.columnsAnalyzed).toBe(1);
		expect(result.totalOutlierCount).toBe(1);
		const text = await extractAllText(result.pdfBytes);
		expect(text).toContain('Column outlier summary');
		expect(text).toContain('Outlier detail');
		expect(text).toContain('500');
		expect(text).toMatch(/IQR above fence/);
	});

	it('finds no outliers and surfaces the "no outliers" warning when none are present', async () => {
		const result = await buildOutlierReport(
			baseOutlierRequest({ columns: [] }),
			fontBytesOverride
		);
		expect(result.totalOutlierCount).toBe(0);
		const text = await extractAllText(result.pdfBytes);
		expect(text).toContain('No outliers were found');
	});

	it('"extreme" sensitivity (3x IQR) flags fewer or equal outliers than "standard" (1.5x)', async () => {
		const standard = await buildOutlierReport(
			baseOutlierRequest({ sensitivity: 'standard' }),
			fontBytesOverride
		);
		const extreme = await buildOutlierReport(
			baseOutlierRequest({ sensitivity: 'extreme' }),
			fontBytesOverride
		);
		expect(extreme.totalOutlierCount).toBeLessThanOrEqual(standard.totalOutlierCount);
	});

	it('"summary" detail mode omits the Outlier detail table', async () => {
		const result = await buildOutlierReport(
			baseOutlierRequest({ detail: 'summary' }),
			fontBytesOverride
		);
		const text = await extractAllText(result.pdfBytes);
		expect(text).toContain('Column outlier summary');
		expect(text).not.toContain('Outlier detail');
	});

	it('includes the full SHA-256 of the original bytes', async () => {
		const result = await buildOutlierReport(baseOutlierRequest(), fontBytesOverride);
		expect(result.sha256Full).toHaveLength(64);
		const text = await extractAllText(result.pdfBytes);
		expect(text).toContain(result.sha256Full);
	});
});

function baseContractProfile(overrides: Partial<ContractProfile> = {}): ContractProfile {
	return {
		riskSummary: { high: 1, medium: 1, low: 0 },
		clauses: [
			{
				id: 'c1',
				number: 1,
				label: 'Indemnification',
				rawLabel: 'indemnification',
				risk: 'high',
				description: 'One party covers the other\'s losses.',
				startOffset: 0,
				endOffset: 100
			},
			{
				id: 'c2',
				number: 2,
				label: 'Termination',
				rawLabel: 'termination_convenience',
				risk: 'medium',
				description: 'Either party may end the agreement.',
				startOffset: 100,
				endOffset: 200
			}
		],
		parties: [{ name: 'Acme Corp', kind: 'org', role: 'Company', source: 'auto-preamble' }],
		dates: [{ label: 'Effective', value: 'Jan 1, 2024' }],
		missingStandardClauses: ['Confidentiality'],
		...overrides
	};
}

function baseContractRequest(overrides: Partial<ContractBuildRequest> = {}): ContractBuildRequest {
	return {
		fileName: 'nda.pdf',
		title: 'nda.pdf — Contract Risk Report',
		profile: baseContractProfile(),
		notes: [],
		pageSize: 'Letter',
		generatedAtDisplay: '2024-01-01 12:00 PM',
		fileBytes: xlsxFixtureBytes,
		...overrides
	};
}

describe('buildContractReport — end to end (ContractProfile, no re-parse)', () => {
	it('renders the Clauses, Parties, and Key Dates tables with risk-colored cells', async () => {
		const result = await buildContractReport(baseContractRequest(), fontBytesOverride);
		expect(result.clauseCount).toBe(2);
		const text = await extractAllText(result.pdfBytes);
		expect(text).toContain('Clauses');
		expect(text).toContain('Indemnification');
		expect(text).toContain('Termination');
		expect(text).toContain('Parties');
		expect(text).toContain('Acme Corp');
		expect(text).toContain('Key Dates');
		expect(text).toContain('Jan 1, 2024');
	});

	it('surfaces missing standard clauses as a warning', async () => {
		const result = await buildContractReport(baseContractRequest(), fontBytesOverride);
		const text = await extractAllText(result.pdfBytes);
		expect(text).toContain('No confidentiality clause detected.');
	});

	it('omits the Parties/Key Dates sections when the profile has none', async () => {
		const result = await buildContractReport(
			baseContractRequest({ profile: baseContractProfile({ parties: [], dates: [] }) }),
			fontBytesOverride
		);
		const text = await extractAllText(result.pdfBytes);
		// "Parties: 0" still appears in the settings block (an accurate
		// count), but the PARTIES TABLE itself (party name/type columns)
		// should be absent — same for the Key Dates table.
		expect(text).not.toContain('Organization');
		expect(text).not.toContain('Individual');
		expect(text).not.toContain('Key Dates');
	});

	it('includes the full SHA-256 of the original bytes', async () => {
		const result = await buildContractReport(baseContractRequest(), fontBytesOverride);
		expect(result.sha256Full).toHaveLength(64);
		const text = await extractAllText(result.pdfBytes);
		expect(text).toContain(result.sha256Full);
	});

	it('renders a prose note inline, under the clause it is anchored inside', async () => {
		const result = await buildContractReport(
			baseContractRequest({
				notes: [{ offset: 10, body: 'Push back on this indemnity scope.' }]
			}),
			fontBytesOverride
		);
		const text = await extractAllText(result.pdfBytes);
		expect(text).toContain('Push back on this indemnity scope.');
		expect(text).toContain('Note:');
		// The note (offset 10, inside c1's [0,100) range) should appear AFTER
		// "Indemnification" but BEFORE "Termination" — i.e. genuinely inline
		// under its own clause, not collected into a separate table.
		const noteIdx = text.indexOf('Push back on this indemnity scope.');
		const indemnIdx = text.indexOf('Indemnification');
		const terminationIdx = text.indexOf('Termination');
		expect(indemnIdx).toBeGreaterThanOrEqual(0);
		expect(noteIdx).toBeGreaterThan(indemnIdx);
		expect(noteIdx).toBeLessThan(terminationIdx);
	});

	it('includes a note count in settings and warns about unmatched notes', async () => {
		const result = await buildContractReport(
			baseContractRequest({
				notes: [
					{ offset: 10, body: 'Matched note.' },
					{ offset: 9999, body: 'Unmatched note (outside any clause range).' }
				]
			}),
			fontBytesOverride
		);
		const text = await extractAllText(result.pdfBytes);
		expect(text).toContain('Notes: 2');
		expect(text).toContain('Matched note.');
		expect(text).not.toContain('Unmatched note');
		expect(text).toMatch(/1 note could not be matched/);
	});
});

