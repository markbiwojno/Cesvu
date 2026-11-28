/**
 * src/lib/report/contract-report.ts — pure data prep for the "Contract Risk
 * Report" PDF, built from an already-computed {@link ContractProfile} (the
 * same structured output ContractSidebar.svelte renders live).
 *
 * No DOM, no model calls, no file re-parsing — a ContractProfile is already
 * plain, synchronous data by the time the user clicks "Generate Report", so
 * this (unlike the Duplication/Outlier reports) never needs to re-parse the
 * original file. report-worker.ts's job for this report type is therefore
 * just "lay out and draw what's already here", same division of labor as
 * the Cell Commentary report.
 *
 * COLOR CHOICE: risk-level colors (red/amber/emerald), NOT the clause
 * highlighter's per-clause rotating palette. ContractSidebar.svelte's Risk
 * Summary already uses red/amber/emerald for high/medium/low — that's the
 * one color scheme in the contract lens that carries actual MEANING (same
 * risk → same color, everywhere). The highlighter's 10-color cycle is
 * assigned by clause ORDER purely to help the eye tell adjacent clauses
 * apart while reading; reproducing it in a report would convey nothing
 * (clause #4 being "violet" has no meaning on its own), so the report
 * intentionally does NOT try to mirror it.
 */

import type { ContractProfile, ClauseInstance, ClauseRisk } from '$lib/lenses/contract/types.js';
import type { ReportTableSection, ReportLine } from './pdf-writer.js';

/**
 * The slice of a prose note contract-report.ts needs — deliberately NOT
 * importing the full `Note`/`notesStore` type here (which would pull
 * notesStore.svelte.ts, a Svelte-runes module, into this plain/worker-safe
 * file). The caller (GenerateReportModal.svelte) maps its notes down to
 * this shape before sending them into the build request.
 */
export interface ContractNoteInput {
	/** Character offset into the document text this note is anchored at. */
	offset: number;
	/** The note body text. */
	body: string;
}

/** Risk → text color, matching ContractSidebar.svelte's light-mode palette
 *  (text-red-600 / text-amber-600 / text-emerald-600) exactly, so the PDF
 *  (always white-background) looks consistent with what the user sees on
 *  screen. */
export const RISK_COLOR: Record<ClauseRisk, string> = {
	high: '#dc2626', // red-600
	medium: '#d97706', // amber-600
	low: '#059669' // emerald-600
};

/** Same amber used by ContractSidebar's "missing standard clauses" warning
 *  box (text-amber-700 on amber-50) — close enough on a white PDF page to
 *  read as the same warning treatment. */
export const MISSING_CLAUSE_COLOR = '#b45309'; // amber-700

function riskLabel(risk: ClauseRisk): string {
	return risk === 'high' ? 'High' : risk === 'medium' ? 'Medium' : 'Low';
}

/** Build the compact "Settings"-equivalent lines printed on page 1. */
export function buildContractSettingsLines(opts: {
	clauseCount: number;
	partyCount: number;
	dateCount: number;
	/** Count of prose notes included in the report (matched + unmatched). */
	noteCount?: number;
	pageSize: 'Letter' | 'A4';
	sha256Full: string;
}): string[] {
	const lines = [
		`Clauses: ${opts.clauseCount.toLocaleString()}`,
		`Parties: ${opts.partyCount.toLocaleString()}`,
		`Dates: ${opts.dateCount.toLocaleString()}`
	];
	if (opts.noteCount) lines.push(`Notes: ${opts.noteCount.toLocaleString()}`);
	lines.push(`Page size: ${opts.pageSize}`, `SHA-256: ${opts.sha256Full}`);
	return lines;
}

/** Build the KPI header: risk tallies, matching ContractSidebar's Risk
 *  Summary numbers exactly (same source data, same counts). */
export function buildContractKpiLines(profile: ContractProfile): string[] {
	const { high, medium, low } = profile.riskSummary;
	return [
		`High risk clauses: ${high.toLocaleString()}`,
		`Medium risk clauses: ${medium.toLocaleString()}`,
		`Low risk clauses: ${low.toLocaleString()}`
	];
}

/**
 * Build the report's warning lines: missing standard clauses (same copy
 * pattern as ContractSidebar's "No {clause} clause" list), plus a note when
 * one or more prose notes couldn't be matched to any clause (e.g. a note
 * left in the preamble, or on a clause with no offset info) — so those
 * notes are never silently dropped from the report without explanation.
 */
export function buildContractWarnings(
	profile: ContractProfile,
	unmatchedNoteCount = 0
): string[] {
	const warnings = profile.missingStandardClauses.map(
		(label) => `No ${label.toLowerCase()} clause detected.`
	);
	if (unmatchedNoteCount > 0) {
		warnings.push(
			`${unmatchedNoteCount.toLocaleString()} note${unmatchedNoteCount === 1 ? '' : 's'} could not be matched to a specific clause and ${unmatchedNoteCount === 1 ? 'is' : 'are'} not shown in the Clauses table.`
		);
	}
	return warnings;
}

/** Note color — a muted slate, distinct from any risk color, so an inline
 *  note row never reads as though it carries its own risk level. */
const NOTE_COLOR = '#64748b'; // slate-500

/**
 * Match each prose note to the clause whose [startOffset, endOffset) range
 * contains the note's offset. Notes that fall outside every clause's range
 * (e.g. in the preamble, or a clause with no offset info at all — see the
 * optionality note on ClauseInstance.startOffset) are returned separately
 * as `unmatched`, not silently dropped.
 */
export function matchNotesToClauses(
	clauses: ClauseInstance[],
	notes: ContractNoteInput[]
): { byClauseId: Map<string, ContractNoteInput[]>; unmatched: ContractNoteInput[] } {
	const byClauseId = new Map<string, ContractNoteInput[]>();
	const unmatched: ContractNoteInput[] = [];

	for (const note of notes) {
		const clause = clauses.find(
			(c) =>
				c.startOffset !== undefined &&
				c.endOffset !== undefined &&
				note.offset >= c.startOffset &&
				note.offset < c.endOffset
		);
		if (!clause) {
			unmatched.push(note);
			continue;
		}
		const existing = byClauseId.get(clause.id);
		if (existing) existing.push(note);
		else byClauseId.set(clause.id, [note]);
	}

	return { byClauseId, unmatched };
}

/**
 * Build the "Clauses" table: Number / Label / Risk / Description, with the
 * Risk cell colored per {@link RISK_COLOR} — the report's one visual tie to
 * the contract lens's on-screen risk coloring. When `notes` is provided,
 * each clause's user notes are rendered INLINE directly beneath it (an
 * indented "note" row, muted color, before the next clause's row) rather
 * than in a separate table — so a note reads in the same place the user
 * left it, next to the clause it's actually about.
 */
export function buildClauseSection(
	clauses: ClauseInstance[],
	notes: ContractNoteInput[] = []
): ReportTableSection {
	const columns = ['#', 'Clause', 'Risk', 'Description'];
	const { byClauseId } = matchNotesToClauses(clauses, notes);

	const lines: ReportLine[] = [];
	for (const c of clauses) {
		lines.push({
			kind: 'data',
			cells: [String(c.number), c.label, riskLabel(c.risk), c.description],
			cellColors: [null, null, RISK_COLOR[c.risk], null]
		});
		for (const note of byClauseId.get(c.id) ?? []) {
			lines.push({
				kind: 'data',
				// Blank the #/Risk/Description cells so the note visually reads
				// as a sub-row of the clause above it, not a sibling clause.
				cells: ['', `↳ Note: ${note.body}`, '', ''],
				cellColors: [null, NOTE_COLOR, null, null]
			});
		}
	}

	const columnSamples = columns.map((_, i) =>
		lines.slice(0, 20).map((l) => (l.kind === 'group-header' ? l.label : (l.cells[i] ?? '')))
	);
	return { heading: 'Clauses', columns, columnSamples, lines };
}

/** Build the "Parties" table: Name / Role / Type. */
export function buildPartiesSection(profile: ContractProfile): ReportTableSection {
	const columns = ['Party', 'Role', 'Type'];
	const lines: ReportLine[] = profile.parties.map((p) => ({
		kind: 'data',
		cells: [p.name, p.role ?? '—', p.kind === 'org' ? 'Organization' : 'Individual']
	}));
	const columnSamples = columns.map((_, i) =>
		lines.slice(0, 20).map((l) => (l.kind === 'group-header' ? l.label : (l.cells[i] ?? '')))
	);
	return { heading: 'Parties', columns, columnSamples, lines };
}

/** Build the "Key Dates" table: Label / Date. */
export function buildDatesSection(profile: ContractProfile): ReportTableSection {
	const columns = ['Date', 'Value'];
	const lines: ReportLine[] = profile.dates.map((d) => ({
		kind: 'data',
		cells: [d.label, d.value]
	}));
	const columnSamples = columns.map((_, i) =>
		lines.slice(0, 20).map((l) => (l.kind === 'group-header' ? l.label : (l.cells[i] ?? '')))
	);
	return { heading: 'Key Dates', columns, columnSamples, lines };
}

/**
 * Build every table section for the Contract Risk Report, in display
 * order: Clauses (with the user's prose notes rendered inline under the
 * clause they're anchored to — see {@link buildClauseSection}), Parties,
 * Dates. Missing standard clauses are reported as `warnings` (see
 * {@link buildContractWarnings}), not a table section — mirroring how the
 * Duplication/Outlier reports surface "nothing found" as a warning rather
 * than an empty table.
 */
export function buildContractSections(
	profile: ContractProfile,
	notes: ContractNoteInput[] = []
): ReportTableSection[] {
	const sections: ReportTableSection[] = [buildClauseSection(profile.clauses, notes)];
	if (profile.parties.length > 0) sections.push(buildPartiesSection(profile));
	if (profile.dates.length > 0) sections.push(buildDatesSection(profile));
	return sections;
}
