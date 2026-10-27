/**
 * src/lib/lenses/contract/build-profile.ts — Build a ContractProfile from text
 *
 * Pipeline (all client-side, no data leaves the device):
 *   1. splitClauses(text)            — deterministic clause segmentation
 *   2. classifyClause(clause.text)   — model-backed clause-type + risk
 *   3. extract parties / dates       — deterministic regex heuristics
 *   4. compute missing standard clauses
 *   → ContractProfile (consumed by ContractSidebar.svelte)
 *
 * The classifier is model-backed, so this is async and the caller should show a
 * loading state. Clause classification failures degrade gracefully (the clause
 * is kept with a neutral 'low'/"Unclassified" fallback) rather than aborting the
 * whole profile.
 */

import { splitClauses, type Clause } from './clause-splitter.js';
import { classifyClause } from '$lib/models/legal-classifier.js';
import { extractParties, type RunInferenceFn } from './extract-parties.js';


import type {
	ContractProfile,
	ClauseInstance,
	ContractDate,
	RiskSummary
} from './types.js';


/**
 * Standard clause types we EXPECT in a typical contract. If none of a group's
 * raw labels are detected, we surface a "missing" warning using the display
 * name. Keyed by display name → the raw classifier labels that satisfy it.
 */
const STANDARD_CLAUSES: Record<string, string[]> = {
	'Governing Law': ['governing_law'],
	Confidentiality: ['confidentiality'],
	Termination: ['termination_convenience', 'auto_renewal'],
	Indemnification: ['indemnification'],
	'Limitation of Liability': ['liability_limitation', 'liability_uncapped'],
	// The classifier maps dispute resolution to binding arbitration / covenant
	// not to sue; treat either as satisfying a "dispute resolution" clause.
	'Dispute Resolution': ['binding_arbitration', 'covenant_not_sue', 'class_action_waiver'],
	'Force Majeure': ['force_majeure'],
	Assignment: ['assignment_restriction'],
	Amendment: ['unilateral_amendment'],
	Notice: ['notice_requirements'],
	// The classifier has no dedicated label for these standard boilerplate
	// clauses. With no satisfying label they will always surface as "missing",
	// which is the intended conservative behavior (we can't confirm presence).
	Severability: [],
	'Entire Agreement': [],
	Waiver: []
};


/**
 * Build the full structured profile of a contract from its extracted text using
 * the AUTOMATIC clause splitter. Thin wrapper over {@link buildProfileFromClauses}.
 */
export async function buildContractProfile(
	text: string,
	runInference?: RunInferenceFn
): Promise<ContractProfile> {
	return buildProfileFromClauses(text ?? '', splitClauses(text ?? ''), runInference);
}


/**
 * Build a ContractProfile from a PRE-SPLIT clause list.
 *
 * This is the shared core: it classifies each clause and runs the deterministic
 * party/date/missing-clause extraction over `text`. Both the automatic path
 * ({@link buildContractProfile} → splitClauses) and the MANUAL ClauseSplitter
 * path (clausesFromOffsets → here) funnel through this so manual and auto splits
 * produce identical downstream profiles. `text` is the full document text (used
 * for party/date extraction); `clauses` is the chosen segmentation.
 */
export async function buildProfileFromClauses(
	text: string,
	clauses: Clause[],
	runInference?: RunInferenceFn
): Promise<ContractProfile> {

	// Classify each clause. Skip the preamble (number 0) — it's boilerplate, not

	// a substantive clause, and would just add noise/low-confidence labels.
	const classifiable = clauses.filter((c) => c.number !== 0);

	const instances: ClauseInstance[] = await Promise.all(
		// Reuse the splitter's `c.id` — a stable, GUARANTEED-UNIQUE id derived
		// from the clause's position in splitClauses() output. This matters
		// because (a) document clause numbers can collide (contracts restart
		// numbering across articles → two clauses both numbered "1"), which
		// previously produced duplicate `clause-${number}` ids and crashed
		// Svelte's keyed {#each} with each_key_duplicate, and (b) it keeps the
		// sidebar's clause id identical to the DocumentPane anchor's element id,
		// so click-to-scroll/highlight resolves to the correct clause.
		classifiable.map(async (c): Promise<ClauseInstance> => {
			const id = c.id;
			try {

				const cls = await classifyClause(c.text);
				return {
					id,
					number: c.number,
					label: cls.label,
					rawLabel: cls.rawLabel,
					risk: cls.risk,
					description: cls.description,
					score: cls.score,
					text: c.text
				};
			} catch {
				// Degrade gracefully: keep the clause, neutral metadata.
				return {
					id,
					number: c.number,
					label: c.title || `Clause ${c.number}`,
					rawLabel: 'unclassified',
					risk: 'low',
					description: 'Could not classify this clause.',
					text: c.text
				};
			}

		})
	);


	const riskSummary = tallyRisk(instances);
	const detectedRaw = new Set(instances.map((i) => i.rawLabel));
	const missingStandardClauses = computeMissing(detectedRaw);

	// Party extraction is async (multi-location + optional LLM refinement). It
	// degrades to deterministic regex candidates when no model is provided.
	const parties = await extractParties(text ?? '', runInference);

	return {
		riskSummary,
		clauses: instances,
		parties,
		dates: extractDates(text ?? ''),
		missingStandardClauses
	};
}


/** Tally clauses into high / medium / low buckets. */
function tallyRisk(clauses: ClauseInstance[]): RiskSummary {
	const summary: RiskSummary = { high: 0, medium: 0, low: 0 };
	for (const c of clauses) summary[c.risk]++;
	return summary;
}

/** Which standard clause groups have NO detected member label. */
function computeMissing(detectedRaw: Set<string>): string[] {
	const missing: string[] = [];
	for (const [displayName, rawLabels] of Object.entries(STANDARD_CLAUSES)) {
		if (!rawLabels.some((r) => detectedRaw.has(r))) missing.push(displayName);
	}
	return missing;
}

// ============================================================
// Date extraction (deterministic — no model)
// ============================================================


const MONTHS = [
	'January', 'February', 'March', 'April', 'May', 'June',
	'July', 'August', 'September', 'October', 'November', 'December'
];
const MONTH_ABBR = MONTHS.map((m) => m.slice(0, 3));

/**
 * A real date pattern: a month name OR a numeric date, always ending in a
 * 4-digit year. We extract ONLY this clean date from the text after a label —
 * never the surrounding clause prose (which produced garbled fragments with
 * escaped characters before).
 */
const DATE_PATTERN = new RegExp(
	[
		// Long-form legal: "the 14th day of March, 2023" / "14th day of March 2023".
		// Listed FIRST so it wins over the bare "14 March 2023" alternative, which
		// would otherwise match only "March, 2023"–like fragments inside it.
		`(?:the\\s+)?\\d{1,2}(?:st|nd|rd|th)?\\s+day\\s+of\\s+(?:${[...MONTHS, ...MONTH_ABBR].join('|')})\\.?,?\\s+\\d{4}`,
		// "March 14, 2023" / "Mar 14 2023" / "14 March 2023"
		`(?:${[...MONTHS, ...MONTH_ABBR].join('|')})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}`,
		`\\d{1,2}\\s+(?:${[...MONTHS, ...MONTH_ABBR].join('|')})\\.?,?\\s+\\d{4}`,
		// ISO "2023-03-14" / "2023/03/14"
		`\\d{4}[-/]\\d{1,2}[-/]\\d{1,2}`,
		// US "03/14/2023" / "3-14-2023"
		`\\d{1,2}[-/]\\d{1,2}[-/]\\d{4}`
	].join('|'),
	'i'
);


/**
 * Extract labeled dates. For each label ("Effective", "Expiration",
 * "Execution") we find the label, then regex-extract the FIRST real date
 * (\d{1,2}…\d{4} or a month-name date) appearing shortly after it — NOT the raw
 * clause text. The extracted date is normalized to "Mon D, YYYY". If no genuine
 * date follows the label, that label is skipped entirely (no garbled fragments).
 */
export function extractDates(rawText: string): ContractDate[] {
	const dates: ContractDate[] = [];
	const seen = new Set<string>();

	// Normalize exotic whitespace (non-breaking spaces, tabs, newlines from DOCX
	// extraction) to plain spaces so "March 14,\u00a02022" still matches the date
	// pattern. DOCX → text conversion is a common source of these (was producing
	// 0 dates on a doc the LLM could read).
	const text = (rawText ?? '').replace(/[\s\u00a0]+/g, ' ');


	const labeled: Array<{ label: string; re: RegExp }> = [
		{ label: 'Effective', re: /effective\s+(?:date|as of)?/i },
		{ label: 'Expiration', re: /(?:expiration|expiry|expires?)\s*(?:date|on)?/i },
		// "dated", "executed", "made as of", "entered into as of", "as of"
		{ label: 'Execution', re: /(?:dated|executed|made|entered into)\s+(?:as of\s+)?|as of\s+/i }
	];

	for (const { label, re } of labeled) {
		const m = re.exec(text);
		if (!m) continue;
		// Look at a bounded window AFTER the label for a real date.
		const after = text.slice(m.index + m[0].length, m.index + m[0].length + 60);
		const dm = DATE_PATTERN.exec(after);
		if (!dm) continue; // no genuine date near this label → skip it
		const value = normalizeDate(dm[0]);
		if (value && !seen.has(label)) {
			seen.add(label);
			dates.push({ label, value });
		}
	}

	// Fallback: if no labeled date matched, grab the FIRST real date anywhere in
	// the document (contract preambles almost always lead with the effective
	// date, e.g. "...as of March 14, 2022, by and between..."). Better to surface
	// it as "Effective" than to return nothing and force the LLM path.
	if (dates.length === 0) {
		const dm = DATE_PATTERN.exec(text);
		if (dm) {
			const value = normalizeDate(dm[0]);
			if (value) dates.push({ label: 'Effective', value });
		}
	}

	console.debug(
		`[extractDates] input ${text.length} chars → ${dates.length} dates:`,
		dates.map((d) => `${d.label}: ${d.value}`)
	);
	return dates;
}



/**
 * Normalize a raw date fragment into "Mon D, YYYY" when we can confidently
 * parse it; otherwise return a cleaned version of the raw text (capped length).
 */
function normalizeDate(raw: string): string {
	const cleaned = raw.replace(/\s+/g, ' ').trim().replace(/[.,;]+$/, '');

	// Long-form legal: "the 14th day of March, 2023" → "Mar 14, 2023".
	// Checked first because the day precedes the month here (the generic
	// month-name pattern below assumes month-first and would otherwise misread it).
	const longForm = new RegExp(
		`\\b(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+day\\s+of\\s+(${[...MONTHS, ...MONTH_ABBR].join('|')})\\.?,?\\s+(\\d{4})`,
		'i'
	);
	let lm = longForm.exec(cleaned);
	if (lm) {
		const monthIdx = monthIndex(lm[2]);
		if (monthIdx >= 0) return `${MONTHS[monthIdx].slice(0, 3)} ${parseInt(lm[1], 10)}, ${lm[3]}`;
	}

	// "January 15, 2025" / "Jan 15 2025"

	const monthName = new RegExp(
		`\\b(${[...MONTHS, ...MONTH_ABBR].join('|')})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})`,
		'i'
	);
	let m = monthName.exec(cleaned);
	if (m) {
		const monthIdx = monthIndex(m[1]);
		if (monthIdx >= 0) return `${MONTHS[monthIdx].slice(0, 3)} ${parseInt(m[2], 10)}, ${m[3]}`;
	}

	// ISO "2025-01-15" or "2025/01/15"
	m = /\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})\b/.exec(cleaned);
	if (m) {
		const monthIdx = parseInt(m[2], 10) - 1;
		if (monthIdx >= 0 && monthIdx < 12) return `${MONTHS[monthIdx].slice(0, 3)} ${parseInt(m[3], 10)}, ${m[1]}`;
	}

	// "01/15/2025" (US M/D/Y)
	m = /\b(\d{1,2})[/](\d{1,2})[/](\d{4})\b/.exec(cleaned);
	if (m) {
		const monthIdx = parseInt(m[1], 10) - 1;
		if (monthIdx >= 0 && monthIdx < 12) return `${MONTHS[monthIdx].slice(0, 3)} ${parseInt(m[2], 10)}, ${m[3]}`;
	}

	// Couldn't structure it — return the raw fragment (length-capped).
	return cleaned.length > 40 ? cleaned.slice(0, 40) : cleaned;
}

function monthIndex(token: string): number {
	const t = token.toLowerCase().replace(/\.$/, '');
	const full = MONTHS.findIndex((m) => m.toLowerCase() === t);
	if (full >= 0) return full;
	return MONTH_ABBR.findIndex((m) => m.toLowerCase() === t);
}
