/**
 * src/lib/lenses/contract/question-router.ts — Tier 1 deterministic answers
 *
 * Two-tier strategy (same as the spreadsheet analysis path):
 *   Tier 1 (here): deterministic facts straight from the ContractProfile — no
 *                  LLM, instant, zero hallucination risk.
 *   Tier 2 (LLM):  free-form interpretation with the full profile as context,
 *                  for questions Tier 1 doesn't recognize.
 *
 * routeContractQuestion() runs BEFORE the LLM call inside runChatInference's
 * contract branch. A keyword match returns a formatted Markdown answer; no
 * match returns null so the caller falls through to the LLM (Tier 2).
 *
 * All answers are built ONLY from profile fields that actually exist
 * (clauses[], parties[], dates[], riskSummary, missingStandardClauses) — there
 * are no governingLaw/effectiveDate/terminationDate top-level fields. Governing
 * law is a clause (rawLabel 'governing_law'); dates live in dates[].
 */

import type { ContractProfile, ClauseInstance, ClauseRisk } from './types.js';
import { isObligationLabel } from './obligations.js';


/** Risk → emoji + label, for the structured clause list output. */
const RISK_BADGE: Record<ClauseRisk, string> = {
	high: '🔴 HIGH RISK',
	medium: '🟡 MEDIUM RISK',
	low: '🟢 LOW RISK'
};

// NOTE: obligations are surfaced via the ContractSidebar "Obligations" filter
// tab (see OBLIGATION_LABELS in ./obligations.ts), not through this router.

/**
 * Holistic / "tell me about the whole document" questions — summarize, what is

 * this about, overview, explain. These want a NARRATIVE summary, which a
 * structured profile cannot provide: summarizing prose requires prose. So the
 * router deliberately SKIPS these (routeContractQuestion returns null) and the
 * caller routes them to the LLM via the raw-document-text path — the same path
 * document mode uses. The contract profile is for structured lookups (parties,
 * dates, clauses), never narrative generation.
 */
export function isHolisticQuestion(question: string): boolean {
	const q = question.toLowerCase().trim();
	return (
		/\bsummari[sz]e\b/.test(q) ||
		/\bsummary\b/.test(q) ||
		/\boverview\b/.test(q) ||
		/\bwhat is this\b/.test(q) ||
		/\bwhat'?s this\b/.test(q) ||
		/\bwhat is this about\b/.test(q) ||
		/\bexplain\b/.test(q) ||
		/\btell me about (this|the) (document|contract|agreement)\b/.test(q) ||
		/\bwhat does this (document|contract|agreement) (say|cover|do)\b/.test(q)
	);
}




/**
 * Keyword → set of classifier rawLabels, for "find me the <specific clause>"
 * questions (e.g. "what's the non-compete say?"). Ordered most-specific first
 * in the lookup loop below.
 */
const SPECIFIC_CLAUSE_KEYWORDS: Array<{ keywords: string[]; labels: string[] }> = [
	{ keywords: ['non-compete', 'noncompete', 'non compete'], labels: ['non_compete'] },
	{ keywords: ['non-solicit', 'nonsolicit', 'non solicit', 'solicitation'], labels: ['non_solicit'] },
	{ keywords: ['non-disclosure', 'nondisclosure', 'nda'], labels: ['confidentiality'] },
	{ keywords: ['confidential'], labels: ['confidentiality'] },
	{ keywords: ['indemnif'], labels: ['indemnification'] },
	{ keywords: ['arbitration'], labels: ['binding_arbitration'] },
	{ keywords: ['class action'], labels: ['class_action_waiver'] },
	{ keywords: ['intellectual property', 'ip assignment', 'ip rights'], labels: ['ip_assignment'] },
	{ keywords: ['exclusivit', 'exclusive'], labels: ['exclusivity'] },
	{ keywords: ['insurance'], labels: ['insurance_requirement'] },
	{ keywords: ['audit'], labels: ['audit_rights'] },
	{ keywords: ['warrant'], labels: ['warranty'] },
	{ keywords: ['liabilit'], labels: ['liability_limitation', 'liability_uncapped'] },
	{ keywords: ['auto-renew', 'auto renew', 'renewal'], labels: ['auto_renewal'] },
	{ keywords: ['force majeure'], labels: ['force_majeure'] },
	{ keywords: ['assignment'], labels: ['assignment_restriction'] },
	{ keywords: ['data', 'privacy'], labels: ['data_rights'] }
];

/**
 * Truncate clause text for the LIST view (single line, ~200 chars + ellipsis).
 * The full clause text remains available on click/expand in the sidebar; the
 * list should stay scannable rather than dump entire clauses.
 */
function excerpt(c: ClauseInstance, max = 200): string {
	const t = (c.text ?? c.description ?? '').replace(/\s+/g, ' ').trim();
	if (t.length <= max) return t;
	// Trim at the last word boundary within the cap so we don't cut mid-word.
	const slice = t.slice(0, max);
	const lastSpace = slice.lastIndexOf(' ');
	const trimmed = lastSpace > max - 30 ? slice.slice(0, lastSpace) : slice;
	return `${trimmed.trimEnd()}...`;
}


/**
 * Render a list of clauses in the structured "Label (Clause N) — RISK" format.
 * PRECONDITION: callers MUST guard for an empty list and return null themselves
 * (so the LLM gets a shot). This helper never emits a "None found" string — a
 * canned no-data string here was the exact bug that made unrelated questions
 * return the same useless sentence instead of falling through to the LLM.
 */
function renderClauseList(title: string, clauses: ClauseInstance[]): string {
	const lines: string[] = [`${title} (${clauses.length} found)`, ''];
	for (const c of clauses) {
		lines.push(`**${c.label}** (Clause ${c.number}) — ${RISK_BADGE[c.risk]}`);
		const ex = excerpt(c);
		if (ex) lines.push(ex);
		lines.push('');
	}
	return lines.join('\n').trimEnd();
}

// ============================================================
// Per-route handlers. THE RULE (do not break it):
//   • Has data → return a deterministic Markdown answer.
//   • No data  → return null → caller falls through to the LLM.
//   • NEVER return a canned/generic "none found" string.
// Each handler decides BOTH whether the question is for it AND whether it has
// the data to answer. 'missing clauses' was the only working path before; these
// are all modeled on it.
// ============================================================

/** Clause count — always answerable from the profile (a count is data). */
function routeClauseCount(profile: ContractProfile, q: string): string | null {
	if (!/\bhow many clauses\b/.test(q) && !/\bclause count\b/.test(q) && !/\bnumber of clauses\b/.test(q)) {
		return null;
	}
	const rs = profile.riskSummary;
	return `This contract has **${profile.clauses.length}** classified clause${profile.clauses.length === 1 ? '' : 's'} — ${rs.high} high risk, ${rs.medium} medium risk, ${rs.low} low risk.`;
}

/** Parties → null if profile.parties is empty. */
function routeParties(profile: ContractProfile, q: string): string | null {
	const asks = /\bparties\b/.test(q) || /\bwho (is|are)\b/.test(q) || /\bwho('s| is) (the )?(party|counterparty)/.test(q);
	if (!asks) return null;
	if (profile.parties.length === 0) return null; // no data → LLM
	const lines = [`Parties (${profile.parties.length} found)`, ''];
	for (const p of profile.parties) {
		lines.push(`- **${p.name}**${p.role ? ` — ${p.role}` : ''} (${p.kind === 'org' ? 'organization' : 'individual'})`);
	}
	return lines.join('\n');
}

/** Dates → null if profile.dates is empty. */
function routeDates(profile: ContractProfile, q: string): string | null {
	const asks =
		/\beffective date\b/.test(q) ||
		/\bexpir/.test(q) ||
		/\bkey dates?\b/.test(q) ||
		/\bimportant dates?\b/.test(q) ||
		/\bwhen does (it|this|the contract|the agreement)\b/.test(q) ||
		/\bwhat (are|were) the dates?\b/.test(q);
	if (!asks) return null;
	if (profile.dates.length === 0) return null; // no data → LLM
	const lines = ['Key dates', ''];
	for (const d of profile.dates) {
		lines.push(`- **${d.label}:** ${d.value}`);
	}
	return lines.join('\n');
}

/** Governing law → null if no governing_law clause was classified. */
function routeGoverningLaw(profile: ContractProfile, q: string): string | null {
	const asks = /\bgoverning law\b/.test(q) || /\bjurisdiction\b/.test(q) || /\bwhich (state|country|law)\b/.test(q);
	if (!asks) return null;
	const gov = profile.clauses.filter((c) => c.rawLabel === 'governing_law');
	if (gov.length === 0) return null; // no data → LLM
	return renderClauseList('Governing law', gov);
}

/**
 * Risk analysis ("top risks", "high-risk clauses", "red flags") is NARRATIVE —
 * it requires explanation and prioritization the profile can't provide. Always
 * return null so the LLM handles it. (We still answer the purely factual
 * "clause count" elsewhere, but risk *analysis* is never deterministic.)
 */
function routeRiskAnalysis(_profile: ContractProfile, q: string): string | null {
	const asks =
		/\b(top|biggest|main|key|worst)\b.*\brisks?\b/.test(q) ||
		/\bhigh[ -]?risk\b/.test(q) ||
		/\brisky\b/.test(q) ||
		/\bdangerous\b/.test(q) ||
		/\bred flags?\b/.test(q) ||
		/\brisk(s| analysis| assessment)?\b/.test(q);
	if (!asks) return null;
	return null; // narrative → always defer to the LLM
}

/** Obligations → null if no obligation-type clauses are present. */
function routeObligations(profile: ContractProfile, q: string): string | null {
	const asks = /\bobligations?\b/.test(q) || /\bwhat (do|does|must) (i|we|they|the parties)\b/.test(q) || /\bresponsibilit/.test(q);
	if (!asks) return null;
	const obligations = profile.clauses.filter((c) => isObligationLabel(c.rawLabel));
	if (obligations.length === 0) return null; // no data → LLM
	return renderClauseList('Key obligations', obligations);
}

/** Missing standard clauses → null if none are missing. (Original template.) */
function routeMissingClauses(profile: ContractProfile, q: string): string | null {
	const asks = /\bmissing\b/.test(q) || /\bwhat('s| is) not in\b/.test(q) || /\bwhat('s| is) absent\b/.test(q) || /\bnot included\b/.test(q);
	if (!asks) return null;
	if (profile.missingStandardClauses.length === 0) return null; // no data → LLM
	const lines = [`Missing standard clauses (${profile.missingStandardClauses.length})`, ''];
	for (const name of profile.missingStandardClauses) {
		lines.push(`- ${name}`);
	}
	lines.push('');
	lines.push('These commonly-expected clauses were not detected. Their absence may or may not be intentional.');
	return lines.join('\n');
}

/** Specific clause lookup → null if that clause type wasn't classified. */
function routeSpecificClause(profile: ContractProfile, q: string): string | null {
	for (const { keywords, labels } of SPECIFIC_CLAUSE_KEYWORDS) {
		if (keywords.some((k) => q.includes(k))) {
			const matched = profile.clauses.filter((c) => labels.includes(c.rawLabel));
			if (matched.length === 0) return null; // no data → LLM
			const display = keywords[0]
				.replace(/[-_]/g, ' ')
				.replace(/\b\w/g, (ch) => ch.toUpperCase());
			return renderClauseList(`${display} clause${matched.length === 1 ? '' : 's'}`, matched);
		}
	}
	return null;
}

/**
 * Count how many DISTINCT router topics a question touches. Used to detect
 * compound questions ("parties AND key dates") that a single handler would
 * answer only half of. Each topic's "asks" trigger is mirrored here as a
 * lightweight predicate (no profile needed — we only care about intent).
 */
function countMatchedTopics(q: string): number {
	const topics: RegExp[] = [
		// clause count
		/\b(how many clauses|clause count|number of clauses)\b/,
		// parties
		/\bparties\b|\bwho (is|are)\b|\bcounterpart/,
		// dates
		/\beffective date\b|\bexpir|\bkey dates?\b|\bimportant dates?\b|\bwhat (are|were) the dates?\b/,
		// governing law
		/\bgoverning law\b|\bjurisdiction\b/,
		// risk
		/\brisks?\b|\bred flags?\b|\bhigh[ -]?risk\b/,
		// obligations
		/\bobligations?\b|\bresponsibilit/,
		// missing clauses
		/\bmissing\b|\bnot included\b|\bwhat('s| is) (not in|absent)\b/,
		// specific clause types (any keyword from the lookup table)
		new RegExp(
			'\\b(' +
				SPECIFIC_CLAUSE_KEYWORDS.flatMap((e) => e.keywords)
					.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
					.join('|') +
				')\\b'
		)
	];
	let count = 0;
	for (const re of topics) if (re.test(q)) count++;
	return count;
}

/**
 * Try to answer a contract question deterministically from the profile.
 * Returns a Markdown string on a match WITH data, or null to fall through to
 * the LLM. Risk analysis is checked BEFORE the specific-clause lookup so a
 * "top risks" question is treated as narrative, never as a clause lookup.
 */
export function routeContractQuestion(

	profile: ContractProfile,
	question: string
): string | null {
	const q = question.toLowerCase().trim();

	// Holistic questions (summarize / overview / explain) → LLM raw-text path.
	if (isHolisticQuestion(question)) return null;

	// Compound questions ("Who are the parties AND key dates?") match more than
	// one router topic. A single handler would answer only its half and silently
	// drop the rest, so defer the whole question to the LLM (which receives the
	// FULL profile — parties + dates + clauses — and can answer both parts).
	// Only triggers when the question actually joins clauses with and/&/plus/
	// also/as well as; a topic mentioned once still takes the fast deterministic
	// path.
	if (/\b(and|&|plus|also|as well as)\b/.test(q) && countMatchedTopics(q) > 1) {
		console.debug('[routeContractQuestion] compound question → LLM (multiple topics)');
		return null;
	}


	// Each handler returns a string only when it BOTH matches the question and
	// has data; otherwise null. The first non-null wins. Risk analysis is listed
	// before specific-clause lookup so "top 3 risks" defers to the LLM instead
	// of being mis-routed into a clause list.
	const handlers = [
		routeClauseCount,
		routeParties,
		routeDates,
		routeGoverningLaw,
		routeRiskAnalysis,
		routeObligations,
		routeMissingClauses,
		routeSpecificClause
	];

	for (const handler of handlers) {
		const answer = handler(profile, q);
		if (answer !== null) {
			console.debug(`[routeContractQuestion] answered by ${handler.name}`);
			return answer;
		}
	}

	// No deterministic match (or matched but no data) → fall through to the LLM.
	console.debug('[routeContractQuestion] no deterministic answer → LLM');
	return null;
}


