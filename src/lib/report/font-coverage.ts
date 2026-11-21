/**
 * src/lib/report/font-coverage.ts — glyph-coverage guard for the embedded
 * report font.
 *
 * The report PDF embeds a single Unicode font (Noto Sans, Latin/Greek/
 * Cyrillic/Vietnamese coverage — see pdf-writer.ts). That font does NOT cover
 * CJK or Arabic. Drawing a character the font can't encode makes pdf-lib
 * throw ("WinAnsi cannot encode ..." / a fontkit encoding error), which would
 * crash report generation on an unsupported script instead of degrading
 * gracefully.
 *
 * `sanitizeForFont` replaces any code point outside the font's character set
 * with a placeholder (default '?') and reports how many were replaced, so the
 * caller can both avoid the crash AND tell the user ("14 characters could not
 * be displayed and were replaced with '?' — likely non-Latin script such as
 * Japanese or Arabic, which this report does not yet support.").
 */

/** A fontkit `Font`'s character set — exposes every supported code point. */
export interface FontLike {
	characterSet: number[];
}

/** Build a fast lookup Set from a fontkit font's character set, once. */
export function buildCoverageSet(font: FontLike): Set<number> {
	return new Set(font.characterSet);
}

export interface SanitizeResult {
	text: string;
	/** Count of code points replaced because the font can't render them. */
	replacedCount: number;
}

/**
 * Replace every code point in `text` that isn't in `coverage` with
 * `placeholder`. Iterates by CODE POINT (`for...of`), not UTF-16 code unit,
 * so astral characters (e.g. emoji, some CJK extensions) are replaced as a
 * single unit rather than as two mangled surrogate halves.
 *
 * `\n` and `\r` are always preserved (never replaced) — callers split on
 * `\n` themselves before drawing (pdf-lib doesn't do its own line breaks),
 * so these must survive this pass unchanged.
 */
export function sanitizeForFont(
	text: string,
	coverage: Set<number>,
	placeholder = '?'
): SanitizeResult {
	let replacedCount = 0;
	let out = '';
	for (const ch of text) {
		const cp = ch.codePointAt(0)!;
		if (cp === 0x0a || cp === 0x0d) {
			out += ch;
			continue;
		}
		if (coverage.has(cp)) {
			out += ch;
		} else {
			out += placeholder;
			replacedCount++;
		}
	}
	return { text: out, replacedCount };
}
