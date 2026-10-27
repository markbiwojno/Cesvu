/**
 * src/lib/lenses/contract/glossary-detector.ts — Aho-Corasick glossary scanner
 *
 * Scans document text for all glossary terms + aliases in O(n) using a single
 * Aho-Corasick automaton built once and cached for the module's lifetime. The
 * trie is NOT rebuilt per document — it's a function of the static glossary.
 *
 * Matching rules:
 *   - Longest match wins when terms overlap (e.g. "full ratchet" beats
 *     "ratchet").
 *   - Matches that span a line break are discarded (likely false positives
 *     across paragraph boundaries).
 *   - Overlapping matches are de-duplicated, keeping the longest.
 *
 * The detector is framework-agnostic (pure functions over a string), so it can
 * run in a component, a worker, or a test harness identically.
 */

import type {
	GlossaryEntry,
	GlossaryMatch,
	RedFlagSummary,
	ContractCategory
} from './types.js';
import { getAllEntries, onPerspectiveChange } from './glossary-loader.js';


interface TrieNode {
	children: Map<string, TrieNode>;
	output: GlossaryEntry | null;
	fail?: TrieNode;
}

/** Build the keyword trie from every term + alias. Longest phrase wins per node. */
function buildTrie(entries: GlossaryEntry[]): TrieNode {
	const root: TrieNode = { children: new Map(), output: null };

	for (const entry of entries) {
		const phrases = [entry.term, ...(entry.aliases ?? [])];
		for (const phrase of phrases) {
			// Skip implausibly long phrases (likely false positives).
			if (phrase.length > 50) continue;

			let node = root;
			const lower = phrase.toLowerCase();
			for (const char of lower) {
				let next = node.children.get(char);
				if (!next) {
					next = { children: new Map(), output: null };
					node.children.set(char, next);
				}
				node = next;
			}
			// Longest term wins when two phrases share a terminal node.
			if (!node.output || entry.term.length > node.output.term.length) {
				node.output = entry;
			}
		}
	}

	return root;
}

/** Build Aho-Corasick failure links (BFS) and merge longer outputs along them. */
function buildFailureLinks(root: TrieNode): void {
	const queue: TrieNode[] = [];

	for (const child of root.children.values()) {
		child.fail = root;
		queue.push(child);
	}

	while (queue.length > 0) {
		const current = queue.shift()!;

		for (const [char, child] of current.children) {
			queue.push(child);

			let failNode = current.fail!;
			while (failNode !== root && !failNode.children.has(char)) {
				failNode = failNode.fail!;
			}
			child.fail = failNode.children.get(char) ?? root;

			// Inherit a longer output from the fail chain when applicable.
			if (
				child.fail!.output &&
				(!child.output || child.fail!.output.term.length > child.output.term.length)
			) {
				child.output = child.fail!.output;
			}
		}
	}
}

// Built once per perspective, reused for every document. The trie embeds the
// active perspective's GlossaryEntry objects in its `output` nodes, so when the
// perspective flips we must rebuild — onPerspectiveChange invalidates the cache.
let trieCache: TrieNode | null = null;

onPerspectiveChange(() => {
	trieCache = null;
});

function getTrie(): TrieNode {
	if (!trieCache) {
		trieCache = buildTrie(getAllEntries());
		buildFailureLinks(trieCache);
	}
	return trieCache;
}


/**
 * Find every glossary term/alias occurrence in `text`. Returns matches in
 * document order, de-duplicated so overlapping hits keep the longest.
 */
export function detectGlossaryTerms(text: string): GlossaryMatch[] {
	const trie = getTrie();
	const matches: GlossaryMatch[] = [];

	// Precompute line-start offsets for O(log n) line-number lookup.
	const lines = text.split('\n');
	const lineOffsets: number[] = [0];
	for (const line of lines) {
		lineOffsets.push(lineOffsets[lineOffsets.length - 1] + line.length + 1);
	}

	function getLineNumber(charIndex: number): number {
		let lo = 0;
		let hi = lineOffsets.length - 1;
		while (lo < hi) {
			const mid = Math.floor((lo + hi + 1) / 2);
			if (lineOffsets[mid] <= charIndex) lo = mid;
			else hi = mid - 1;
		}
		return lo + 1; // 1-indexed
	}

	let node = trie;
	const lower = text.toLowerCase();

	for (let i = 0; i < lower.length; i++) {
		const char = lower[i];

		// Follow failure links until we can consume `char` (or reach root).
		while (node !== trie && !node.children.has(char)) {
			node = node.fail!;
		}
		node = node.children.get(char) ?? trie;

		// Emit every match ending at position i (walk the fail chain).
		let temp: TrieNode | undefined = node;
		while (temp && temp !== trie) {
			if (temp.output) {
				const termLength = temp.output.term.length;
				const startIndex = i - termLength + 1;
				const matchedText = text.slice(startIndex, i + 1);
				// Don't flag terms that straddle a line break.
				if (startIndex >= 0 && !matchedText.includes('\n')) {
					matches.push({
						entry: temp.output,
						matchedText,
						startIndex,
						endIndex: i + 1,
						lineNumber: getLineNumber(startIndex)
					});
				}
			}
			temp = temp.fail;
		}
	}

	return deduplicateMatches(matches);
}

/** Drop overlapping matches, keeping the longest at each position. */
function deduplicateMatches(matches: GlossaryMatch[]): GlossaryMatch[] {
	if (matches.length <= 1) return matches;

	// Sort by start asc, then by length desc (longest first at a given start).
	const sorted = [...matches].sort((a, b) => {
		if (a.startIndex !== b.startIndex) return a.startIndex - b.startIndex;
		return b.endIndex - b.startIndex - (a.endIndex - a.startIndex);
	});

	const result: GlossaryMatch[] = [sorted[0]];
	for (let i = 1; i < sorted.length; i++) {
		const prev = result[result.length - 1];
		const curr = sorted[i];
		// Keep only matches that start at/after the previous match's end.
		if (curr.startIndex >= prev.endIndex) {
			result.push(curr);
		}
		// Otherwise it overlaps — the longer one is already kept (sorted desc).
	}
	return result;
}

/**
 * Tally FLAGGED matches in `text`, broken down by category.
 *
 * "Flagged" means the active perspective marks the term as a flag — red flags
 * in the employee perspective, green flags in the investor perspective. Because
 * the term set is identical across perspectives, the count is the same; only
 * the polarity (and the badge styling that consumes `flagKind`) differs. The
 * field is still named `totalRedFlags` on {@link RedFlagSummary} for backward
 * compatibility.
 */
export function getRedFlagSummary(text: string): RedFlagSummary {
	const matches = detectGlossaryTerms(text);
	const flaggedMatches = matches.filter(
		(m) => m.entry.flagKind === 'red' || m.entry.flagKind === 'green'
	);

	const byCategory: Record<ContractCategory, number> = {
		employment: 0,
		severance: 0,
		'startup-vc': 0,
		rental: 0,
		general: 0
	};
	for (const match of flaggedMatches) {
		byCategory[match.entry.category]++;
	}

	return {
		totalRedFlags: flaggedMatches.length,
		byCategory,
		matches: flaggedMatches
	};
}


