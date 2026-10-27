/**
 * src/lib/lenses/contract/glossary-loader.ts — Glossary registry (perspective-aware)
 *
 * Loads the two hand-authored glossaries and exposes whichever one matches the
 * active PERSPECTIVE:
 *
 *   - 'employee' (default) → src/lib/data/red-flags.json
 *       The signer's view (employee / founder / tenant). Risky clauses are RED
 *       flags; scripts soften them.
 *   - 'investor'           → src/lib/data/green-flags.json
 *       The drafter's view (hiring manager / investor / landlord). The SAME
 *       clauses are GREEN flags; scripts push to keep them.
 *
 * Both files share identical term/alias/category/definition data (green-flags
 * is generated from red-flags by scripts/build-green-flags.mjs), so what gets
 * DETECTED never changes between perspectives — only the copy and the flag
 * polarity do.
 *
 * Each raw entry is normalized into a single {@link GlossaryEntry} shape so the
 * detector and UI never need to know which JSON it came from:
 *   - flagKind:          'red' | 'green' | 'none'
 *   - isRedFlag:         true only in the employee perspective for a flagged term
 *   - riskNote/benefitNote: whichever the active perspective carries
 *
 * The JSON is bundled at build time (static import, no runtime fetch). Switching
 * perspective is a cheap in-memory remap of ~44 entries; consumers that cache
 * derived data (e.g. the detector's Aho-Corasick trie) subscribe via
 * onPerspectiveChange() to invalidate.
 */

import redFlagsData from '$lib/data/red-flags.json';
import greenFlagsData from '$lib/data/green-flags.json';
import type { GlossaryEntry, ContractCategory, Perspective } from './types.js';

// ── Raw JSON shapes (as authored) ───────────────────────────────────────────

interface RawRedEntry {
	term: string;
	aliases?: string[];
	definition: string;
	category: ContractCategory;
	isRedFlag: boolean;
	riskNote?: string;
	negotiationScript?: string;
	scriptLong?: string;
}

interface RawGreenEntry {
	term: string;
	aliases?: string[];
	definition: string;
	category: ContractCategory;
	isGreenFlag: boolean;
	benefitNote?: string;
	negotiationScript?: string;
	scriptLong?: string;
}

const rawRed = (redFlagsData as { terms: RawRedEntry[] }).terms;
const rawGreen = (greenFlagsData as { terms: RawGreenEntry[] }).terms;

// ── Normalization ───────────────────────────────────────────────────────────

/** Normalize a red-flags entry (employee perspective) into a GlossaryEntry. */
function fromRed(e: RawRedEntry): GlossaryEntry {
	return {
		term: e.term,
		aliases: e.aliases,
		definition: e.definition,
		category: e.category,
		isRedFlag: e.isRedFlag,
		isGreenFlag: false,
		flagKind: e.isRedFlag ? 'red' : 'none',
		riskNote: e.riskNote,
		negotiationScript: e.negotiationScript,
		scriptLong: e.scriptLong
	};
}

/** Normalize a green-flags entry (investor perspective) into a GlossaryEntry. */
function fromGreen(e: RawGreenEntry): GlossaryEntry {
	return {
		term: e.term,
		aliases: e.aliases,
		definition: e.definition,
		category: e.category,
		// In the investor perspective these terms are NOT red flags.
		isRedFlag: false,
		isGreenFlag: e.isGreenFlag,
		flagKind: e.isGreenFlag ? 'green' : 'none',
		benefitNote: e.benefitNote,
		negotiationScript: e.negotiationScript,
		scriptLong: e.scriptLong
	};
}

// Pre-normalize both perspectives once (cheap, ~44 entries each).
const ENTRIES_BY_PERSPECTIVE: Record<Perspective, GlossaryEntry[]> = {
	employee: rawRed.map(fromRed),
	investor: rawGreen.map(fromGreen)
};

// ── Active perspective + lookup maps ────────────────────────────────────────

const PERSPECTIVE_KEY = 'cesvu_glossary_perspective';

function loadPersistedPerspective(): Perspective {
	if (typeof localStorage !== 'undefined') {
		const saved = localStorage.getItem(PERSPECTIVE_KEY);
		if (saved === 'employee' || saved === 'investor') return saved;
	}
	return 'employee';
}

let activePerspective: Perspective = loadPersistedPerspective();
let entries: GlossaryEntry[] = ENTRIES_BY_PERSPECTIVE[activePerspective];

// lowercase term  → entry (exact-term lookups)
let termMap = new Map<string, GlossaryEntry>();
// lowercase alias → entry (alias lookups)
let aliasMap = new Map<string, GlossaryEntry>();

function rebuildMaps() {
	entries = ENTRIES_BY_PERSPECTIVE[activePerspective];
	termMap = new Map();
	aliasMap = new Map();
	for (const entry of entries) {
		termMap.set(entry.term.toLowerCase(), entry);
		if (entry.aliases) {
			for (const alias of entry.aliases) {
				aliasMap.set(alias.toLowerCase(), entry);
			}
		}
	}
}
rebuildMaps();

// ── Perspective change subscription ─────────────────────────────────────────
// Consumers that cache derived data (e.g. the detector's trie) register here so
// they can invalidate when the perspective flips.

type PerspectiveListener = (p: Perspective) => void;
const listeners = new Set<PerspectiveListener>();

/** Subscribe to perspective changes. Returns an unsubscribe function. */
export function onPerspectiveChange(fn: PerspectiveListener): () => void {
	listeners.add(fn);
	return () => listeners.delete(fn);
}

/** The currently-active glossary perspective. */
export function getPerspective(): Perspective {
	return activePerspective;
}

/**
 * Switch the active perspective. Rebuilds the lookup maps, persists the choice,
 * and notifies subscribers (so the detector can rebuild its trie). No-op if the
 * perspective is unchanged.
 */
export function setPerspective(p: Perspective): void {
	if (p === activePerspective) return;
	activePerspective = p;
	if (typeof localStorage !== 'undefined') {
		localStorage.setItem(PERSPECTIVE_KEY, p);
	}
	rebuildMaps();
	for (const fn of listeners) fn(p);
}

// ── Lookups (operate on the active perspective) ─────────────────────────────

/** Look up a single entry by term or alias (case-insensitive). */
export function getEntry(term: string): GlossaryEntry | undefined {
	const lower = term.toLowerCase();
	return termMap.get(lower) ?? aliasMap.get(lower);
}

/** All glossary entries for the active perspective, in authored order. */
export function getAllEntries(): GlossaryEntry[] {
	return entries;
}

/** Only the entries flagged for the active perspective (red OR green). */
export function getFlaggedEntries(): GlossaryEntry[] {
	return entries.filter((e) => e.flagKind === 'red' || e.flagKind === 'green');
}

/**
 * Only the red-flag entries. In the investor perspective this is empty (those
 * terms are green flags there). Kept for backward compatibility.
 */
export function getRedFlags(): GlossaryEntry[] {
	return entries.filter((e) => e.isRedFlag);
}

/** Entries within a given contract category (active perspective). */
export function getByCategory(category: ContractCategory): GlossaryEntry[] {
	return entries.filter((e) => e.category === category);
}
