/**
 * src/lib/crypto/emoji-wordlist.invariants.test.ts
 *
 * Entropy-critical invariants for the curated 800-emoji wordlist used by
 * {@link generateEmojiPassphrase} (see cesvu-crypto.ts). The claimed
 * ~77.2 bits of entropy for an 8-emoji passphrase is only true if:
 *
 *   1. The wordlist has exactly 800 entries (EMOJI_WORDLIST_LEN).
 *   2. Every entry is a single Unicode codepoint — no ZWJ sequences
 *      (e.g. "👨‍👩‍👧") and no trailing variation selector (e.g. "❤️"
 *      is U+2764 + VS16, two codepoints).
 *   3. Every entry survives {@link normalizeEmojiPassphrase} UNCHANGED.
 *      That function strips zero-width chars (U+200B–200D, which
 *      includes ZWJ) and variation selectors (U+FE0E/FE0F), then applies
 *      NFC. If any wordlist entry actually depended on those characters
 *      to be distinct, normalization would silently mangle it or collapse
 *      it onto another entry.
 *   4. After normalization, all 800 entries remain pairwise distinct.
 *      This is the actual security property: a collision here means two
 *      "different" passphrase symbols are indistinguishable post-
 *      normalization, silently reducing the real entropy below the
 *      ~77.2 bits documented in generateEmojiPassphrase's doc comment.
 *
 * None of this is enforced by TypeScript or Zod — it's a data invariant
 * on a bundled JSON file, so it MUST be enforced here, in CI, on every
 * change to emoji-wordlist.json. A failure here is release-blocking.
 */

import { describe, it, expect } from 'vitest';
import { normalizeEmojiPassphrase, EMOJI_WORDLIST_LEN } from './cesvu-crypto.js';
// eslint-disable-next-line @typescript-eslint/no-var-requires
import wordlistJson from '$lib/data/emoji-wordlist.json';

const wordlist = wordlistJson as unknown as string[];

describe('emoji-wordlist invariants (entropy-critical)', () => {
	it(`has exactly ${EMOJI_WORDLIST_LEN} entries`, () => {
		expect(wordlist.length).toBe(EMOJI_WORDLIST_LEN);
	});

	it('every entry is a single Unicode codepoint (no ZWJ sequences, no bare modifiers)', () => {
		// Array.from() iterates by codepoint (correctly handling surrogate
		// pairs), unlike `.length` which counts UTF-16 code units — a single
		// emoji like "🀄" is 1 codepoint but 2 UTF-16 code units.
		const multiCodepoint = wordlist.filter((e) => Array.from(e).length !== 1);
		expect(multiCodepoint).toEqual([]);
	});

	it('every entry survives normalizeEmojiPassphrase unchanged', () => {
		const mutated = wordlist
			.map((e) => ({ original: e, normalized: normalizeEmojiPassphrase(e) }))
			.filter(({ original, normalized }) => normalized !== original);
		// Assert on the full list of offenders (not just a boolean) so a
		// failure names exactly which emoji broke the invariant.
		expect(mutated).toEqual([]);
	});

	it('all entries remain pairwise distinct after normalization', () => {
		const normalized = wordlist.map(normalizeEmojiPassphrase);
		const seen = new Map<string, string[]>();
		for (let i = 0; i < normalized.length; i++) {
			const key = normalized[i];
			const bucket = seen.get(key) ?? [];
			bucket.push(wordlist[i]);
			seen.set(key, bucket);
		}
		const collisions = [...seen.values()].filter((bucket) => bucket.length > 1);
		// If this fails, `collisions` shows exactly which original emoji
		// collapsed onto the same normalized value.
		expect(collisions).toEqual([]);
		expect(seen.size).toBe(EMOJI_WORDLIST_LEN);
	});
});
