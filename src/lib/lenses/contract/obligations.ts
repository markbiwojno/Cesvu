/**
 * src/lib/lenses/contract/obligations.ts — shared obligation classification
 *
 * Single source of truth for "which clause types represent an OBLIGATION on a
 * party" — i.e. something a party MUST DO or is bound by, as opposed to a
 * descriptive/boilerplate clause (governing law, force majeure, definitions).
 *
 * Derived from the classifier's actual label taxonomy in
 * `src/lib/models/legal-classifier.ts` (CLAUSE_INFO / label_config.json). Only
 * labels the model can actually emit are listed — no idealized labels the model
 * never produces. Mapping rationale per label is inline below.
 *
 * Consumed by BOTH:
 *   - ContractSidebar.svelte → "Obligations" filter tab (in-place, no LLM)
 *   - question-router.ts      → kept in sync (router no longer routes
 *     "obligations" to chat, but shares the set for any future use)
 */

/**
 * Classifier rawLabels that represent a binding obligation/restriction on a
 * party. These are the clauses where the reader "must do" or "must not do"
 * something, or is otherwise constrained.
 */
export const OBLIGATION_LABELS: Set<string> = new Set<string>([
	// Affirmative duties — you must actively do something.
	'indemnification', // must cover the other party's losses
	'confidentiality', // must keep information secret
	'insurance_requirement', // must maintain insurance coverage
	'audit_rights', // must submit to / permit audits of your records
	'minimum_commitment', // must buy/use a minimum amount
	'notice_requirements', // must give formal notice in a prescribed way
	'warranty', // must guarantee quality/performance

	// Restrictive covenants — you must NOT do something.
	'non_compete', // cannot work with competitors
	'non_solicit', // cannot hire their staff / solicit customers
	'non_disparagement', // cannot speak negatively about them
	'exclusivity', // can only work with them
	'ip_assignment' // must assign ownership of your work/IP
]);

/** True when a clause's raw classifier label is a binding obligation. */
export function isObligationLabel(rawLabel: string): boolean {
	return OBLIGATION_LABELS.has(rawLabel);
}
