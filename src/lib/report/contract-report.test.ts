import { describe, it, expect } from 'vitest';
import {
	buildContractSettingsLines,
	buildContractKpiLines,
	buildContractWarnings,
	buildClauseSection,
	buildPartiesSection,
	buildDatesSection,
	buildContractSections,
	matchNotesToClauses,
	RISK_COLOR,
	type ContractNoteInput
} from './contract-report.js';
import type { ContractProfile, ClauseInstance } from '$lib/lenses/contract/types.js';

function clause(overrides: Partial<ClauseInstance> = {}): ClauseInstance {
	return {
		id: 'c1',
		number: 1,
		label: 'Confidentiality',
		rawLabel: 'confidentiality',
		risk: 'low',
		description: 'Keeps things secret.',
		...overrides
	};
}

function profile(overrides: Partial<ContractProfile> = {}): ContractProfile {
	return {
		riskSummary: { high: 1, medium: 1, low: 1 },
		clauses: [
			clause({ id: 'c1', number: 1, risk: 'high', label: 'Indemnification', startOffset: 0, endOffset: 50 }),
			clause({ id: 'c2', number: 2, risk: 'medium', label: 'Termination', startOffset: 50, endOffset: 100 }),
			clause({ id: 'c3', number: 3, risk: 'low', label: 'Notices', startOffset: 100, endOffset: 150 })
		],
		parties: [
			{ name: 'Acme Corp', kind: 'org', role: 'Company', source: 'auto-preamble' },
			{ name: 'Jane Doe', kind: 'person', role: 'Employee', source: 'auto-signature' }
		],
		dates: [{ label: 'Effective', value: 'Jan 1, 2024' }],
		missingStandardClauses: ['Severability'],
		...overrides
	};
}

describe('buildContractSettingsLines', () => {
	it('includes clause/party/date counts, page size, and the hash', () => {
		const lines = buildContractSettingsLines({
			clauseCount: 3,
			partyCount: 2,
			dateCount: 1,
			pageSize: 'Letter',
			sha256Full: 'abc123'
		});
		expect(lines).toContain('Clauses: 3');
		expect(lines).toContain('Parties: 2');
		expect(lines).toContain('Dates: 1');
		expect(lines).toContain('Page size: Letter');
		expect(lines).toContain('SHA-256: abc123');
	});
});

describe('buildContractKpiLines', () => {
	it('reports the exact risk tallies from the profile', () => {
		const lines = buildContractKpiLines(profile());
		expect(lines).toEqual([
			'High risk clauses: 1',
			'Medium risk clauses: 1',
			'Low risk clauses: 1'
		]);
	});
});

describe('buildContractWarnings', () => {
	it('surfaces missing standard clauses as lowercase warnings', () => {
		const warnings = buildContractWarnings(profile());
		expect(warnings).toEqual(['No severability clause detected.']);
	});

	it('returns no warnings when nothing is missing', () => {
		const warnings = buildContractWarnings(profile({ missingStandardClauses: [] }));
		expect(warnings).toEqual([]);
	});

	it('appends an unmatched-note warning when unmatchedNoteCount > 0', () => {
		const warnings = buildContractWarnings(profile({ missingStandardClauses: [] }), 2);
		expect(warnings).toEqual([
			'2 notes could not be matched to a specific clause and are not shown in the Clauses table.'
		]);
	});

	it('uses singular phrasing for exactly one unmatched note', () => {
		const warnings = buildContractWarnings(profile({ missingStandardClauses: [] }), 1);
		expect(warnings).toEqual([
			'1 note could not be matched to a specific clause and is not shown in the Clauses table.'
		]);
	});
});

describe('buildClauseSection', () => {
	it('builds one row per clause with the risk cell colored per RISK_COLOR', () => {
		const section = buildClauseSection(profile().clauses);
		expect(section.heading).toBe('Clauses');
		expect(section.columns).toEqual(['#', 'Clause', 'Risk', 'Description']);
		expect(section.lines).toHaveLength(3);

		const [high, medium, low] = section.lines;
		if (high.kind !== 'data' || medium.kind !== 'data' || low.kind !== 'data') {
			throw new Error('expected data lines');
		}
		expect(high.cells).toEqual(['1', 'Indemnification', 'High', 'Keeps things secret.']);
		expect(high.cellColors).toEqual([null, null, RISK_COLOR.high, null]);
		expect(medium.cellColors).toEqual([null, null, RISK_COLOR.medium, null]);
		expect(low.cellColors).toEqual([null, null, RISK_COLOR.low, null]);
	});

	it('renders a matched note as an inline row directly under its clause', () => {
		const notes: ContractNoteInput[] = [{ offset: 10, body: 'Negotiate this down.' }];
		const section = buildClauseSection(profile().clauses, notes);
		// Clause row, then its note row, then the next two clauses with no notes.
		expect(section.lines).toHaveLength(4);
		const [clauseRow, noteRow, secondClause] = section.lines;
		if (clauseRow.kind !== 'data' || noteRow.kind !== 'data' || secondClause.kind !== 'data') {
			throw new Error('expected data lines');
		}
		expect(clauseRow.cells[1]).toBe('Indemnification');
		expect(noteRow.cells[1]).toContain('Negotiate this down.');
		expect(noteRow.cells[1]).toContain('Note:');
		expect(secondClause.cells[1]).toBe('Termination');
	});

	it('renders multiple notes on the same clause, each as its own inline row', () => {
		const notes: ContractNoteInput[] = [
			{ offset: 5, body: 'First note.' },
			{ offset: 20, body: 'Second note.' }
		];
		const section = buildClauseSection(profile().clauses, notes);
		expect(section.lines).toHaveLength(5); // 3 clauses + 2 note rows
		const bodies = section.lines
			.filter((l) => l.kind === 'data')
			.map((l) => (l as { cells: string[] }).cells[1]);
		expect(bodies.some((b) => b.includes('First note.'))).toBe(true);
		expect(bodies.some((b) => b.includes('Second note.'))).toBe(true);
	});

	it('omits a note whose offset falls outside every clause range', () => {
		const notes: ContractNoteInput[] = [{ offset: 9999, body: 'Orphaned note.' }];
		const section = buildClauseSection(profile().clauses, notes);
		expect(section.lines).toHaveLength(3); // no extra row added
		const bodies = section.lines.map((l) => (l as { cells: string[] }).cells[1]);
		expect(bodies.some((b) => b.includes('Orphaned note.'))).toBe(false);
	});
});

describe('matchNotesToClauses', () => {
	it('buckets each note under the clause whose offset range contains it', () => {
		const notes: ContractNoteInput[] = [
			{ offset: 10, body: 'in c1' },
			{ offset: 75, body: 'in c2' }
		];
		const { byClauseId, unmatched } = matchNotesToClauses(profile().clauses, notes);
		expect(byClauseId.get('c1')?.map((n) => n.body)).toEqual(['in c1']);
		expect(byClauseId.get('c2')?.map((n) => n.body)).toEqual(['in c2']);
		expect(unmatched).toEqual([]);
	});

	it('returns a note as unmatched when its offset is outside every clause', () => {
		const notes: ContractNoteInput[] = [{ offset: 500, body: 'nowhere' }];
		const { byClauseId, unmatched } = matchNotesToClauses(profile().clauses, notes);
		expect(byClauseId.size).toBe(0);
		expect(unmatched).toEqual([{ offset: 500, body: 'nowhere' }]);
	});

	it('treats a clause with no startOffset/endOffset as unmatchable', () => {
		const clausesWithoutOffsets = [clause({ id: 'c1', startOffset: undefined, endOffset: undefined })];
		const notes: ContractNoteInput[] = [{ offset: 10, body: 'orphaned' }];
		const { byClauseId, unmatched } = matchNotesToClauses(clausesWithoutOffsets, notes);
		expect(byClauseId.size).toBe(0);
		expect(unmatched).toHaveLength(1);
	});
});

describe('buildPartiesSection', () => {
	it('builds one row per party with name/role/type', () => {
		const section = buildPartiesSection(profile());
		expect(section.heading).toBe('Parties');
		expect(section.lines).toHaveLength(2);
		const [first] = section.lines;
		if (first.kind !== 'data') throw new Error('expected a data line');
		expect(first.cells).toEqual(['Acme Corp', 'Company', 'Organization']);
	});
});

describe('buildDatesSection', () => {
	it('builds one row per date', () => {
		const section = buildDatesSection(profile());
		expect(section.heading).toBe('Key Dates');
		expect(section.lines).toHaveLength(1);
		const [first] = section.lines;
		if (first.kind !== 'data') throw new Error('expected a data line');
		expect(first.cells).toEqual(['Effective', 'Jan 1, 2024']);
	});
});

describe('buildContractSections', () => {
	it('includes Clauses always, and Parties/Dates only when non-empty', () => {
		const sections = buildContractSections(profile());
		expect(sections.map((s) => s.heading)).toEqual(['Clauses', 'Parties', 'Key Dates']);
	});

	it('omits Parties/Dates sections when the profile has none', () => {
		const sections = buildContractSections(profile({ parties: [], dates: [] }));
		expect(sections.map((s) => s.heading)).toEqual(['Clauses']);
	});
});
