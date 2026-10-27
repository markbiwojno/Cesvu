/**
 * src/lib/lenses/contract/types.ts — Contract-lens data model
 *
 * The `ContractProfile` is the structured output the contract lens produces
 * from a parsed contract (clause splitting + classification + party/date
 * extraction). It is what the UI — notably ContractSidebar.svelte — consumes.
 *
 * Defined here (rather than the global types.ts) to keep the contract lens
 * self-contained. Reuses `ClauseRisk` from the classifier so risk levels stay
 * in one place.
 */

import type { ClauseRisk } from '$lib/models/legal-classifier.js';

export type { ClauseRisk };

/** A single classified clause within a contract. */
export interface ClauseInstance {
	/** Stable id used to scroll the document viewer to this clause. */
	id: string;
	/** Section number from the document (0 = preamble). */
	number: number;
	/** Prettified clause-type label, e.g. "Indemnification". */
	label: string;
	/** Raw model label (snake_case) — for debugging / grouping. */
	rawLabel: string;
	/** Risk level driving the colored dot. */
	risk: ClauseRisk;
	/** Plain-English description of what the clause means. */
	description: string;
	/** Classifier confidence 0–1 (optional; deterministic splits may omit it). */
	score?: number;
	/**
	 * Raw clause text from the document. Optional and NOT rendered by the
	 * sidebar — it exists so downstream consumers (e.g. the contract chat
	 * prompt) can quote the actual wording. Kept full here; consumers truncate.
	 */
	text?: string;
}


/** How a party was discovered (drives the source badge in the editor UI). */
export type PartySource =
	| 'auto-signature'
	| 'auto-preamble'
	| 'auto-notices'
	| 'manual';

/** A party to the contract. */
export interface ContractParty {
	/** Display name, e.g. "Acme Corp" or "John Doe". */
	name: string;
	/** Whether the party is an organization or an individual (drives the icon). */
	kind: 'org' | 'person';
	/** Optional role, e.g. "Party 1", "Client", "Vendor". User-editable. */
	role?: string;
	/**
	 * The shorthand defined term for this party from the preamble, e.g. the
	 * "Company" in `Acme Corp ("Company")`. Null when none was found.
	 */
	definedTerm?: string | null;
	/**
	 * Where this party came from. Auto-detected parties carry the location they
	 * were extracted from; user-added/edited parties become 'manual'.
	 */
	source: PartySource;
}


/** A named date extracted from the contract. */
export interface ContractDate {
	/** What the date represents, e.g. "Effective", "Expiration". */
	label: string;
	/** Human-readable value as it should be displayed, e.g. "Jan 15, 2025". */
	value: string;
}

/** Count of clauses at each risk level. */
export interface RiskSummary {
	high: number;
	medium: number;
	low: number;
}

/**
 * The full structured profile of a contract — the contract lens's output and
 * the ContractSidebar's single input prop.
 */
export interface ContractProfile {
	/** Risk tallies for the summary header. */
	riskSummary: RiskSummary;
	/** All classified clauses, in document order. */
	clauses: ClauseInstance[];
	/** Extracted parties. */
	parties: ContractParty[];
	/** Extracted dates (effective, expiration, …). */
	dates: ContractDate[];
	/**
	 * Standard clause types that are EXPECTED but absent from this contract,
	 * surfaced as warnings (e.g. "Confidentiality"). Stored as prettified labels.
	 */
	missingStandardClauses: string[];
}


// ============================================================
// Glossary / red-flag overlay (src/lib/data/red-flags.json)
// ============================================================
//
// The glossary powers the in-document red-flag overlay: known legal terms are
// detected in the contract text (Aho-Corasick, see glossary-detector.ts) and
// rendered with an underline + tooltip. Red-flag terms additionally carry a
// risk note and a negotiation script (a short "what to say" one-liner, plus an
// optional longer version revealed on demand). All copy lives in the JSON —
// never hardcoded in components — and `isRedFlag` is the single source of truth
// for the visual treatment.

/** Contract domains a glossary term belongs to. Mirrors red-flags.json categories. */
export type ContractCategory =
	| 'employment'
	| 'severance'
	| 'startup-vc'
	| 'rental'
	| 'general';

/**
 * Whose side the glossary reads from.
 *
 *   - 'employee' (default): the signer's perspective (employee / founder /
 *     tenant). Risky clauses are RED flags and the scripts soften them.
 *     Source: red-flags.json.
 *   - 'investor': the drafter's perspective (hiring manager / investor /
 *     landlord). The SAME clauses are GREEN flags and the scripts push to keep
 *     them. Source: green-flags.json.
 *
 * The detected terms/aliases are identical across perspectives — only the copy
 * and the flag polarity differ.
 */
export type Perspective = 'employee' | 'investor';


/** A single glossary definition, as authored in red-flags.json `terms[]`. */
export interface GlossaryEntry {
	/** Canonical term, e.g. "non-compete clause". */
	term: string;
	/** Alternate spellings/phrasings that also match this entry. */
	aliases?: string[];
	/** Plain-English explanation of what the term means. */
	definition: string;
	/** Contract domain (drives the category badge). */
	category: ContractCategory;
	/** Whether this term is a red flag (drives the wavy-red treatment + scripts). */
	isRedFlag: boolean;
	/**
	 * Whether this term is a green flag (investor/hiring-manager perspective).
	 * Present on entries sourced from green-flags.json. Mutually exclusive with
	 * isRedFlag for a given perspective.
	 */
	isGreenFlag?: boolean;
	/**
	 * Which polarity the entry currently carries for the ACTIVE perspective.
	 * Set by the loader so components don't have to know which JSON it came from:
	 *   - 'red'   → risky for the signer (employee perspective)
	 *   - 'green' → favorable for the drafter (investor perspective)
	 *   - 'none'  → a plain glossary term (neither flag) in this perspective
	 */
	flagKind?: 'red' | 'green' | 'none';
	/** Why the term is risky (red flags only). */
	riskNote?: string;
	/** Why the term favors the drafter (green flags only — investor perspective). */
	benefitNote?: string;
	/**
	 * Short, copy-pasteable negotiation one-liner shown on tap/hover for flagged
	 * terms. The concise "what to say" ask (soften it in employee mode, keep it
	 * in investor mode).
	 */
	negotiationScript?: string;
	/**
	 * Longer, multi-sentence negotiation script revealed when the user asks for
	 * more ("Show full script"). Optional — falls back to negotiationScript.
	 */
	scriptLong?: string;
}


/** A glossary term located within the document text. */
export interface GlossaryMatch {
	/** The matched glossary entry. */
	entry: GlossaryEntry;
	/** The actual text found in the document (preserves original casing). */
	matchedText: string;
	/** Character position of the match start in the document text. */
	startIndex: number;
	/** Character position one past the match end. */
	endIndex: number;
	/** 1-indexed line number of the match start. */
	lineNumber: number;
}

/** Aggregate red-flag tally for a document. */
export interface RedFlagSummary {
	/** Total number of red-flag matches found. */
	totalRedFlags: number;
	/** Red-flag counts broken down by category. */
	byCategory: Record<ContractCategory, number>;
	/** The red-flag matches themselves, in document order. */
	matches: GlossaryMatch[];
}


