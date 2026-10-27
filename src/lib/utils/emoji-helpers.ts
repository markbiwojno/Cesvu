// SPDX-License-Identifier: Apache-2.0

/**
 * Emoji-passphrase UI helpers. These functions are display-only — they
 * derive the hex codepoint form of an emoji SOLELY to look up its Noto SVG
 * asset for rendering. The hex form never enters the crypto path: the
 * passphrase itself is always the raw Unicode emoji character(s), joined
 * with no separator (see `generateEmojiPassphrase` / `normalizeEmojiPassphrase`
 * in `$lib/crypto`).
 *
 * Emoji renders: Noto Emoji (OFL-1.1). See static/noto-svg/LICENSE
 */

/**
 * Convert a single emoji character to its uppercase hex codepoint, e.g.
 * `emojiToHex('🦏')` → `'1F98F'`.
 *
 * Uses `codePointAt(0)` (not `charCodeAt`), so this is correct for emoji
 * outside the BMP that are represented as a UTF-16 surrogate pair in JS
 * strings — `codePointAt` reads the full 21-bit code point across both
 * surrogate halves, whereas `charCodeAt` would return just the high
 * surrogate.
 *
 * Throws if `emoji` is empty (no code point at position 0).
 */
export function emojiToHex(emoji: string): string {
	const cp = emoji.codePointAt(0);
	if (!cp) throw new Error(`Invalid emoji: ${emoji}`);
	return cp.toString(16).toUpperCase();
}

/**
 * Build the static Noto SVG URL for a single emoji character, e.g.
 * `emojiSvgUrl('🦏')` → `'/noto-svg/1F98F.svg'`.
 *
 * The `static/noto-svg/` directory is populated with one SVG per emoji in
 * the curated 800-emoji wordlist, filed under its uppercase hex codepoint
 * filename (matching `emojiToHex`'s output exactly).
 */
export function emojiSvgUrl(emoji: string): string {
	return `/noto-svg/${emojiToHex(emoji)}.svg`;
}
