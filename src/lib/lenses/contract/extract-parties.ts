/**
 * src/lib/lenses/contract/extract-parties.ts — multi-location party extraction
 *
 * The previous approach ran a single regex over the ENTIRE document, which
 * surfaced section headings, defined terms, regulatory references, and
 * signature-field placeholders as "parties" (e.g. "Regulation· EU",
 * "the Platform or Hosted Services", "Name· print").
 *
 * This module extracts parties from the places they're ACTUALLY defined —
 * the preamble, the signature block, and (fallback) the notices section —
 * then merges and validates the candidates.
 *
 * Each location is fed INDEPENDENTLY to the LLM with a location-specific
 * prompt. The signature block carries the legal name; the preamble carries the
 * defined term ("Company", "Client"). We merge by string similarity so the
 * legal name wins for display while the defined term is preserved.
 *
 * GRACEFUL DEGRADATION: an `runInference` callback is optional. When it is not
 * provided (model not loaded), we fall back to deterministic regex candidates
 * so analysis never blocks on the model. The user can always edit/add/remove
 * parties manually afterwards.
 *
 * Everything is client-side. No data leaves the device.
 */

import type { ContractParty } from './types.js';

/** Run a single LLM completion. Mirrors runInference()'s text-in/text-out shape. */
export type RunInferenceFn = (prompt: string) => Promise<string>;

/** A raw extracted candidate before merge/validation. */
interface PartyCandidate {
	name: string;
	definedTerm: string | null;
	source: ContractParty['source'];
}

// ============================================================
// Entity-suffix vocabulary (shared)
// ============================================================

/** Legal-entity indicators. A bare ALL-CAPS string is only a party if it has one. */
const ENTITY_INDICATORS = [
	'Inc', 'LLC', 'L.L.C', 'Ltd', 'Corp', 'Corporation', 'Company', 'Co',
	'LLP', 'LP', 'GmbH', 'S.A', 'B.V', 'PLC', 'Limited', 'Partners', 'Holdings',
	'N.V', 'AG', 'S.p.A', 'Pty'
];
const ENTITY_INDICATOR_RE = new RegExp(
	`\\b(?:${ENTITY_INDICATORS.map((s) => s.replace(/\./g, '\\.')).join('|')})\\.?\\b`,
	'i'
);

// ============================================================
// 1. Preamble extraction
// ============================================================

/**
 * Find the party-definition block in the preamble. Looks for a "between / by and
 * between / among" lead-in that runs up to a recital/operative-clause marker
 * (agree / hereby / hereinafter / witnesseth / WHEREAS / NOW THEREFORE).
 *
 * Falls back to the first 500 words of the document when no pattern matches.
 */
export function findPreambleBlock(text: string): string {
	const re =
		/(between|by and between|among)\s+[\s\S]*?(?:agree|hereby|hereinafter|witnesseth|WHEREAS|NOW THEREFORE)/i;
	const m = re.exec(text);
	if (m && m[0].length >= 12) {
		// Extend to the end of the paragraph(s) the match lands in.
		return m[0].slice(0, 2000);
	}
	return firstNWords(text, 500);
}

const PREAMBLE_PROMPT = (block: string) =>
	`Extract the legal names of all parties from this contract preamble. Return ONLY the entity or person names — not addresses, not jurisdictions, not defined terms in quotes or parentheses. If a party is an individual, return their full name. If a party is a company, return the company name without the legal suffix unless it's part of the name. Also extract any defined terms — the shorthand in quotes or parentheses after each party name, like 'Company' or 'Client'. Return as a JSON array: [{name: string, definedTerm: string | null}]. If no parties are found, return an empty array.\n\nPreamble:\n"""${block}"""\n\nJSON:`;

async function extractFromPreamble(
	text: string,
	runInference: RunInferenceFn | undefined
): Promise<PartyCandidate[]> {
	const block = findPreambleBlock(text);
	if (runInference) {
		try {
			const raw = await runInference(PREAMBLE_PROMPT(block));
			const parsed = parseJsonArray(raw);
			const out: PartyCandidate[] = [];
			for (const item of parsed) {
				const name = typeof item === 'string' ? item : item?.name;
				const definedTerm =
					typeof item === 'object' && item ? (item.definedTerm ?? null) : null;
				if (typeof name === 'string' && name.trim())
					out.push({ name: name.trim(), definedTerm: cleanTerm(definedTerm), source: 'auto-preamble' });
			}
			if (out.length > 0) return out;
		} catch {
			/* fall through to regex */
		}
	}
	return regexPreambleCandidates(block);
}

/** Deterministic preamble candidates: "<Name> ("<Term>")" pairs + between-split. */
function regexPreambleCandidates(block: string): PartyCandidate[] {
	const out: PartyCandidate[] = [];
	const seen = new Set<string>();
	const NAME = `[A-Z][A-Za-z.&'-]+(?:\\s+[A-Z][A-Za-z.&'0-9-]+){0,5}`;
	const reQuoted = new RegExp(`(${NAME})(?:,?\\s+${ENTITY_INDICATORS.map((s) => s.replace(/\./g, '\\.')).join('|')})?\\s*\\(\\s*["“']?(?:the\\s+)?([A-Za-z ]{2,40}?)["”']?\\s*\\)`, 'g');
	let m: RegExpExecArray | null;
	while ((m = reQuoted.exec(block)) !== null) {
		const name = m[1].trim();
		const key = name.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({ name, definedTerm: cleanTerm(m[2]), source: 'auto-preamble' });
	}
	return out;
}

// ============================================================
// 2. Signature block extraction
// ============================================================

/** The last 500 words of the document — where signatures live. */
export function findSignatureBlock(text: string): string {
	return lastNWords(text, 500);
}

const SIGNATURE_PROMPT = (block: string) =>
	`Extract the legal names of all signing parties from this signature block. Return ONLY the entity or person names exactly as they appear — this is the legal name. Return as a JSON array of strings. If no parties are found, return an empty array.\n\nSignature block:\n"""${block}"""\n\nJSON:`;

async function extractFromSignature(
	text: string,
	runInference: RunInferenceFn | undefined
): Promise<PartyCandidate[]> {
	const block = findSignatureBlock(text);
	if (runInference) {
		try {
			const raw = await runInference(SIGNATURE_PROMPT(block));
			const parsed = parseJsonArray(raw);
			const out: PartyCandidate[] = [];
			for (const item of parsed) {
				const name = typeof item === 'string' ? item : item?.name;
				if (typeof name === 'string' && name.trim())
					out.push({ name: name.trim(), definedTerm: null, source: 'auto-signature' });
			}
			if (out.length > 0) return out;
		} catch {
			/* fall through to regex */
		}
	}
	return regexSignatureCandidates(block);
}

/** Deterministic signature candidates: entity names preceding "By:" / "/s/". */
function regexSignatureCandidates(block: string): PartyCandidate[] {
	const out: PartyCandidate[] = [];
	const seen = new Set<string>();
	const SUFFIX = ENTITY_INDICATORS.map((s) => s.replace(/\./g, '\\.')).join('|');
	const patterns = [
		// "ACME, INC.\nBy:" — caps entity above a By: line.
		new RegExp(`([A-Z][A-Z\\s,\\.]+(?:${SUFFIX})\\.?)\\s*\\n\\s*By:`, 'g'),
		// "By: /s/ John Doe" or "By: John Doe"
		/By:\s*(?:\/s\/\s*)?([A-Z][A-Za-z.&'-]+(?:\s+[A-Z][A-Za-z.&'-]+){0,4})/g,
		// Generic entity name with suffix on a signature line.
		new RegExp(`\\b([A-Z][A-Za-z.&'-]+(?:\\s+[A-Z][A-Za-z.&'0-9-]+){0,4},?\\s+(?:${SUFFIX})\\.?)\\b`, 'g')
	];
	for (const re of patterns) {
		let m: RegExpExecArray | null;
		while ((m = re.exec(block)) !== null) {
			const name = m[1].replace(/\s+/g, ' ').trim().replace(/[,\s]+$/, '');
			const key = name.toLowerCase();
			if (seen.has(key)) continue;
			seen.add(key);
			out.push({ name, definedTerm: null, source: 'auto-signature' });
		}
	}
	return out;
}

// ============================================================
// 3. Notices section extraction (fallback)
// ============================================================

/** Find the "Notices" section text, or '' if absent. */
export function findNoticesSection(text: string): string {
	const m = /\bnotices?\b/i.exec(text);
	if (!m) return '';
	return text.slice(m.index, m.index + 1200);
}

const NOTICES_PROMPT = (block: string) =>
	`Extract party names from this notices section. Return as a JSON array of strings.\n\nNotices section:\n"""${block}"""\n\nJSON:`;

async function extractFromNotices(
	text: string,
	runInference: RunInferenceFn | undefined
): Promise<PartyCandidate[]> {
	const block = findNoticesSection(text);
	if (!block) return [];
	if (runInference) {
		try {
			const raw = await runInference(NOTICES_PROMPT(block));
			const parsed = parseJsonArray(raw);
			const out: PartyCandidate[] = [];
			for (const item of parsed) {
				const name = typeof item === 'string' ? item : item?.name;
				if (typeof name === 'string' && name.trim())
					out.push({ name: name.trim(), definedTerm: null, source: 'auto-notices' });
			}
			if (out.length > 0) return out;
		} catch {
			/* fall through */
		}
	}
	// Deterministic: entity names with a suffix near the notices heading.
	const out: PartyCandidate[] = [];
	const seen = new Set<string>();
	const SUFFIX = ENTITY_INDICATORS.map((s) => s.replace(/\./g, '\\.')).join('|');
	const re = new RegExp(`\\b([A-Z][A-Za-z.&'-]+(?:\\s+[A-Z][A-Za-z.&'0-9-]+){0,4},?\\s+(?:${SUFFIX})\\.?)\\b`, 'g');
	let m: RegExpExecArray | null;
	while ((m = re.exec(block)) !== null) {
		const name = m[1].replace(/\s+/g, ' ').trim().replace(/[,\s]+$/, '');
		const key = name.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({ name, definedTerm: null, source: 'auto-notices' });
	}
	return out;
}

// ============================================================
// 4. Merge
// ============================================================

/**
 * Merge preamble + signature candidates. Signature names take precedence for
 * display (legal name); the matched preamble's defined term is attached.
 * Unmatched candidates are kept with their own source tag.
 */
function mergeParties(
	preamble: PartyCandidate[],
	signature: PartyCandidate[]
): PartyCandidate[] {
	const merged: PartyCandidate[] = [];
	const usedPreamble = new Set<number>();

	for (const sig of signature) {
		// Find the best-matching preamble candidate by similarity.
		let bestIdx = -1;
		let bestScore = 0;
		preamble.forEach((pre, i) => {
			if (usedPreamble.has(i)) return;
			const score = similarity(sig.name, pre.name);
			if (score > bestScore) {
				bestScore = score;
				bestIdx = i;
			}
		});
		if (bestIdx >= 0 && bestScore >= 0.6) {
			usedPreamble.add(bestIdx);
			merged.push({
				name: sig.name, // legal name wins
				definedTerm: preamble[bestIdx].definedTerm,
				source: 'auto-signature'
			});
		} else {
			merged.push(sig);
		}
	}

	// Unmatched preamble candidates retain their "from preamble" source.
	preamble.forEach((pre, i) => {
		if (!usedPreamble.has(i)) merged.push(pre);
	});

	return merged;
}

// ============================================================
// 5. Validation
// ============================================================

const FALSE_POSITIVES = new Set([
	'print', 'sign', 'date', 'title', 'name· print', 'name', 'signature',
	'witness', 'by', 'address', 'attn', 'email', 'phone', 'fax'
]);
const REGULATORY = /\b(?:GDPR|CCPA|HIPAA|regulation[·\s]*\(?EU\)?|directive)\b/i;
const PRODUCT_NOISE =
	/\b(?:the\s+platform|hosted\s+services|the\s+services?|the\s+software|the\s+product)\b/i;
const HEADING_FRAGMENT =
	/\b(?:IF YOU DO|PURCHASER AND SELLER|INTEREST|TERMS AND CONDITIONS|COMMERCIAL DEBTS)\b/;

/** True when `name` is a plausible party name (not noise). */
export function isValidPartyName(name: string): boolean {
	const trimmed = name.trim();
	if (trimmed.length < 2) return false;

	// >15 words → likely a sentence fragment.
	const words = trimmed.split(/\s+/);
	if (words.length > 15) return false;

	// Template placeholders.
	if (/\[[^\]]*\]/.test(trimmed)) return false; // [Company Name], [Name]
	if (/_{2,}/.test(trimmed)) return false; // ______

	// Known false-positive single tokens / labels.
	if (FALSE_POSITIVES.has(trimmed.toLowerCase())) return false;

	// Regulatory references, product/service names, heading fragments.
	if (REGULATORY.test(trimmed)) return false;
	if (PRODUCT_NOISE.test(trimmed)) return false;
	if (HEADING_FRAGMENT.test(trimmed)) return false;

	// All-caps without an entity indicator → heading/boilerplate, not a party.
	const isAllCaps = trimmed === trimmed.toUpperCase() && /[A-Z]/.test(trimmed);
	if (isAllCaps && !ENTITY_INDICATOR_RE.test(trimmed)) return false;

	// Must contain at least one capital letter (a real name does).
	if (!/[A-Z]/.test(trimmed)) return false;

	return true;
}

// ============================================================
// Public entry point
// ============================================================

/**
 * Extract parties from a contract using multi-location extraction + merge +
 * validation. `runInference` is optional; without it the extractor uses
 * deterministic regex candidates so it never blocks on the model.
 *
 * Fallback order: signature → preamble → notices → first 500 words → empty.
 */
export async function extractParties(
	text: string,
	runInference?: RunInferenceFn
): Promise<ContractParty[]> {
	const src = text ?? '';
	if (src.trim().length === 0) return [];

	const [preamble, signature] = await Promise.all([
		extractFromPreamble(src, runInference),
		extractFromSignature(src, runInference)
	]);

	let candidates = mergeParties(preamble, signature);

	// Notices fallback only if preamble + signature produced nothing valid.
	if (candidates.filter((c) => isValidPartyName(c.name)).length === 0) {
		const notices = await extractFromNotices(src, runInference);
		if (notices.length > 0) candidates = notices;
	}

	// Validate + de-dupe (case-insensitive) + cap.
	const seen = new Set<string>();
	const parties: ContractParty[] = [];
	for (const c of candidates) {
		const name = c.name.replace(/\s+/g, ' ').trim().replace(/^[,\s]+|[,\s]+$/g, '');
		if (!isValidPartyName(name)) continue;
		const key = name.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		parties.push({
			name,
			kind: ENTITY_INDICATOR_RE.test(name) ? 'org' : 'person',
			definedTerm: c.definedTerm,
			source: c.source
		});
		if (parties.length >= 8) break;
	}

	console.debug(
		`[extractParties] ${src.length} chars → ${parties.length} parties:`,
		parties.map((p) => `${p.name} [${p.source}]`)
	);
	return parties;
}

// ============================================================
// Helpers
// ============================================================

/** First N words of a string. */
function firstNWords(text: string, n: number): string {
	return (text ?? '').split(/\s+/).slice(0, n).join(' ');
}
/** Last N words of a string. */
function lastNWords(text: string, n: number): string {
	const words = (text ?? '').split(/\s+/);
	return words.slice(Math.max(0, words.length - n)).join(' ');
}

/** Clean a defined term: strip quotes/parens/"the", null if empty or a stopword. */
function cleanTerm(term: string | null | undefined): string | null {
	if (!term) return null;
	const t = term.replace(/["“”'()]/g, '').replace(/^\s*the\s+/i, '').trim();
	if (t.length < 1 || t.length > 40) return null;
	return t;
}

/**
 * Parse a JSON array from a possibly-noisy LLM response. Extracts the first
 * `[...]` block and JSON.parses it. Returns [] on any failure.
 */
function parseJsonArray(raw: string): Array<string | { name?: string; definedTerm?: string | null }> {
	if (!raw) return [];
	const start = raw.indexOf('[');
	const end = raw.lastIndexOf(']');
	if (start === -1 || end === -1 || end <= start) return [];
	try {
		const parsed = JSON.parse(raw.slice(start, end + 1));
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

/**
 * Normalized string similarity 0–1 (Levenshtein-based). Used to match a
 * preamble party to its signature-block counterpart regardless of order.
 */
export function similarity(a: string, b: string): number {
	const s1 = normalizeForMatch(a);
	const s2 = normalizeForMatch(b);
	if (s1 === s2) return 1;
	if (!s1 || !s2) return 0;
	// Containment shortcut: "Acme" vs "Acme Corp" → high similarity.
	if (s1.includes(s2) || s2.includes(s1)) return 0.85;
	const dist = levenshtein(s1, s2);
	return 1 - dist / Math.max(s1.length, s2.length);
}

/** Lowercase, drop entity suffixes + punctuation, collapse whitespace. */
function normalizeForMatch(s: string): string {
	return s
		.toLowerCase()
		.replace(ENTITY_INDICATOR_RE, '')
		.replace(/[.,&'"()-]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

/** Classic Levenshtein edit distance. */
function levenshtein(a: string, b: string): number {
	const m = a.length;
	const n = b.length;
	if (m === 0) return n;
	if (n === 0) return m;
	let prev = Array.from({ length: n + 1 }, (_, i) => i);
	let curr = new Array<number>(n + 1);
	for (let i = 1; i <= m; i++) {
		curr[0] = i;
		for (let j = 1; j <= n; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
		}
		[prev, curr] = [curr, prev];
	}
	return prev[n];
}
