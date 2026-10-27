/**
 * src/lib/lenses/detect-lens.ts — Deterministic document-type ("lens") detector
 *
 * Decides which "lens" the app should open a file with, purely from the file
 * extension and the extracted text. No model, no network, no randomness — same
 * input always yields the same output.
 *
 *   - Spreadsheets (.xlsx / .xls / .csv / .tsv) → 'spreadsheet' (extension alone
 *     decides; text is irrelevant).
 *   - Everything else (.pdf / .docx / .txt / .md / …) → inspect the text for
 *     contract language and classify as 'contract' or 'document'.
 *
 * CONTRACT DETECTION (tuned to avoid false positives):
 *   Earlier versions counted DISTINCT keyword hits with a flat threshold of 5.
 *   That over-fired: ordinary prose that merely *discusses* legal/business
 *   topics (e.g. a chat transcript mentioning "agreement", "parties", "breach",
 *   "confidential") would clear 5 generic words and be misclassified as a
 *   contract. The detector now uses three layered defenses:
 *
 *     A. WEIGHTED SCORING — keywords are weighted by how strongly they signal a
 *        real legal instrument. Archaic boilerplate that essentially never
 *        appears outside contracts ("hereinafter", "whereas", "force majeure")
 *        is weight 3. Contract-typical-but-occasional terms are weight 2.
 *        Words that leak heavily into everyday prose ("agreement", "parties",
 *        "breach", "confidential") are weight 1.
 *
 *     B. WORD-BOUNDARY MATCHING — keywords match on word boundaries, so
 *        "third parties" / "interested parties" don't inflate the score the way
 *        raw substring matching did. Multi-word phrases still match directly.
 *
 *     C. STRONG-SIGNAL GATE — a document is classified 'contract' only if it
 *        contains AT LEAST ONE strong (weight-3) keyword AND the total weighted
 *        score meets the threshold. The strong-signal requirement is the
 *        decisive filter: real contracts always carry legal boilerplate
 *        ("hereby", "whereas", "governing law", "in witness whereof"); prose
 *        that merely talks about legal topics does not.
 *
 * Runs on the EXTRACTED text (what the parser produced), never the raw bytes.
 */

export type Lens = 'spreadsheet' | 'contract' | 'document';

/**
 * Minimum WEIGHTED score required to classify as a contract. A real contract
 * clears this comfortably (repeated strong + medium terms). Generic prose
 * built only from weight-1 words cannot reach it (weak words are capped), and
 * the strong-signal gate (below) blocks it regardless. Mymods: I bumped this up to 25 from 15
 */
export const CONTRACT_SCORE_THRESHOLD = 25;

/**
 * The combined contribution of WEAK keywords is capped at this value. Weak
 * words ('agreement', 'parties', 'confidential', …) are common in ordinary
 * business writing; without a cap, a long report trivially accumulates enough
 * of them to clear the threshold on its own. Capping them means weak words can
 * never qualify a document alone — strong/medium signals must do the lifting.
 */
const WEAK_SCORE_CAP = 4;

/**
 * Minimum distinct STRONG signals required. A single archaic word ('herein')
 * appearing once in a long article or report is NOT enough — real legal
 * instruments use this boilerplate repeatedly and in clusters.
 */
const MIN_STRONG_HITS = 2;


/**
 * Strong keywords (weight 3). Archaic / formulaic legal boilerplate that is
 * almost never present outside an actual legal instrument. At least one of
 * these MUST appear for a document to be classified as a contract.
 */
const STRONG_KEYWORDS: readonly string[] = [
	'hereby',
	'herein',
	'hereinafter',
	'heretofore',
	'whereas',
	'governing law',
	'force majeure',
	'indemnification',
	'hold harmless',
	'severability',
	'in witness whereof'
];

/**
 * Medium keywords (weight 2). Strongly associated with contracts but with some
 * presence in ordinary business writing.
 */
const MEDIUM_KEYWORDS: readonly string[] = [
	'indemnify',
	'covenants',
	'non-compete',
	'non-disclosure',
	'arbitration',
	'effective date',
	'disclosing party',
	'receiving party',
	'letter of intent',
	'non-binding'
];

/**
 * Weak keywords (weight 1). Common in contracts but also frequent in everyday
 * prose, so they contribute little on their own.
 */
const WEAK_KEYWORDS: readonly string[] = [
	'agreement',
	'parties',
	'confidential',
	'confidentiality',
	'termination',
	'warranties',
	'representations',
	'breach',
	'proposed terms'
];

/** File extensions that always open in the spreadsheet lens (text not consulted). */
const SPREADSHEET_EXTENSIONS = new Set(['xlsx', 'xls', 'csv', 'tsv']);

/** Extract the lowercased file extension (without the dot), or '' if none. */
function extensionOf(fileName: string): string {
	const dot = fileName.lastIndexOf('.');
	if (dot === -1 || dot === fileName.length - 1) return '';
	return fileName.slice(dot + 1).toLowerCase();
}

/** Escape a string for safe interpolation into a RegExp. */
function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Presence test for a keyword phrase using word-boundary matching, so
 * "parties" does NOT match inside unrelated tokens and "third parties" is not
 * counted differently from "parties". Multi-word phrases match directly.
 * `text` must already be lowercased.
 */
function containsKeyword(text: string, keyword: string): boolean {
	const pattern = new RegExp(`\\b${escapeRegExp(keyword)}\\b`, 'i');
	return pattern.test(text);
}

/**
 * Count word-boundary OCCURRENCES of a keyword (not just presence). A real
 * contract repeats its boilerplate ("the Parties shall…", "hereby…", "shall
 * indemnify…") many times; incidental prose mentions a legal word once or
 * twice. Counting occurrences lets the score reflect that density.
 * `text` must already be lowercased.
 */
function countOccurrences(text: string, keyword: string): number {
	const pattern = new RegExp(`\\b${escapeRegExp(keyword)}\\b`, 'gi');
	const m = text.match(pattern);
	return m ? m.length : 0;
}

/** Result of scoring a document's contract signals. */
export interface ContractScore {
	/** Total weighted score across all matched keywords (weak portion capped). */
	score: number;
	/** Number of DISTINCT strong (weight-3) keywords present. */
	strongHits: number;
	/** Total OCCURRENCES of strong keywords (density signal). */
	strongOccurrences: number;
	/** The distinct keywords that matched (for debugging / tuning UI). */
	matched: string[];
}

/**
 * Score the contract signals present in the text. Weighted AND density-aware:
 *   - Strong/medium keywords score per OCCURRENCE (capped per keyword so one
 *     spammed word can't dominate), rewarding the repetition real instruments
 *     exhibit.
 *   - Weak keywords score by PRESENCE only, and their combined contribution is
 *     capped at WEAK_SCORE_CAP so common business words can never qualify a
 *     document on their own.
 * Returns the total score, distinct + total strong hits, and matched keywords.
 */
export function scoreContractSignals(text: string): ContractScore {
	const lower = (text ?? '').toLowerCase();
	let score = 0;
	let strongHits = 0;
	let strongOccurrences = 0;
	const matched: string[] = [];

	// Per-keyword occurrence cap: a single repeated word contributes at most
	// this many times, so e.g. "agreement" x500 can't run away with the score.
	const PER_KEYWORD_OCCURRENCE_CAP = 5;

	for (const kw of STRONG_KEYWORDS) {
		const n = countOccurrences(lower, kw);
		if (n > 0) {
			strongHits++;
			strongOccurrences += n;
			score += 3 * Math.min(n, PER_KEYWORD_OCCURRENCE_CAP);
			matched.push(kw);
		}
	}
	for (const kw of MEDIUM_KEYWORDS) {
		const n = countOccurrences(lower, kw);
		if (n > 0) {
			score += 2 * Math.min(n, PER_KEYWORD_OCCURRENCE_CAP);
			matched.push(kw);
		}
	}
	// Weak words: presence-only, and their TOTAL contribution is capped.
	let weakScore = 0;
	for (const kw of WEAK_KEYWORDS) {
		if (containsKeyword(lower, kw)) {
			weakScore += 1;
			matched.push(kw);
		}
	}
	score += Math.min(weakScore, WEAK_SCORE_CAP);

	return { score, strongHits, strongOccurrences, matched };
}

/**
 * True when the scored signals qualify the text as a contract. Requires ALL of:
 *   - at least MIN_STRONG_HITS DISTINCT strong (weight-3) keywords present
 *     (a lone archaic word in a long report is not enough), AND
 *   - a total weighted score at or above CONTRACT_SCORE_THRESHOLD.
 *
 * As an alternative path, a document with a SINGLE distinct strong keyword may
 * still qualify if that boilerplate is dense (appears repeatedly) AND the score
 * clears the threshold — this catches short, tightly-worded agreements (e.g. an
 * NDA) that lean on one boilerplate term used many times.
 */
export function isContractScore(s: ContractScore): boolean {
	if (s.score < CONTRACT_SCORE_THRESHOLD) return false;
	if (s.strongHits >= MIN_STRONG_HITS) return true;
	// Single-strong-keyword fallback: only if it's used densely (≥3 times).
	return s.strongHits === 1 && s.strongOccurrences >= 3;
}


/**
 * Backwards-compatible helper retained for callers/tests that want a single
 * number. Returns the weighted contract score (NOT a raw keyword count).
 */
export function countContractKeywords(text: string): number {
	return scoreContractSignals(text).score;
}

/**
 * Detect the lens for an opened document.
 *
 * @param text     The extracted text content (ignored for spreadsheets).
 * @param fileName The original file name — its extension drives spreadsheet
 *                 routing and is the only thing consulted for tabular files.
 * @returns 'spreadsheet' | 'contract' | 'document'
 */
export function detectLens(text: string, fileName: string): Lens {
	// 1. Spreadsheets are decided by extension alone (existing behaviour).
	if (SPREADSHEET_EXTENSIONS.has(extensionOf(fileName))) {
		return 'spreadsheet';
	}

	// 2. Text documents: weighted contract scoring + strong-signal gate.
	const signals = scoreContractSignals(text ?? '');
	return isContractScore(signals) ? 'contract' : 'document';
}
