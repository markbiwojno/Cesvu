/**
 * src/lib/lenses/contract/clause-splitter.ts — Split contract text into clauses
 *
 * Deterministic, dependency-free. Given the extracted plain text of a contract,
 * break it into individual clauses, each with a number, title, and body text.
 *
 * Strategy (first one that yields ≥2 clauses wins):
 *   1. Numbered sections — "\n 1. INDEMNIFICATION ..." (number + ALL-CAPS title)
 *   2. All-caps headers  — "\n CONFIDENTIALITY ..." (no number; index supplies it)
 *   3. Double-newline paragraphs — last-resort fallback
 *
 * Cross-cutting rules:
 *   - Preamble text before the first detected section → clause 0, title "Preamble".
 *   - Trailing signature blocks (detected via "signature"/"signed"/"date:" …)
 *     are skipped.
 *   - Empty clauses (no body after trimming) are skipped.
 */

export interface Clause {
	/**
	 * Stable, GUARANTEED-UNIQUE id for this clause within a single split result.
	 * Assigned by `splitClauses` from the clause's position so it is unique even
	 * when the document's own section numbers collide (contracts often restart
	 * numbering across articles, producing two clauses both numbered "1"). This
	 * is what the UI keys on and what scroll/highlight targets — never `number`,
	 * which is the (possibly duplicated) document-supplied number for display.
	 */
	id: string;
	/** Section number (from the document) or index when the document has none. */
	number: number;
	/** Section title, e.g. "INDEMNIFICATION" (or "Preamble" / "Clause N"). */
	title: string;
	/** Full clause text (title line + body). */
	text: string;
	/**
	 * Character offset range into the ORIGINAL (pre-normalization) document
	 * text this clause spans — used to match prose notes (which are anchored
	 * by character offset) to the clause they fall inside, for the Contract
	 * Risk Report's inline note rendering. Optional and best-effort: the
	 * automatic tiered splitters (markdown/numbered/caps/paragraph) run over
	 * a NORMALIZED copy of the text (see normalizeForClauses), whose offsets
	 * don't line up with the original — those paths leave this undefined
	 * rather than report a wrong range. Only `clausesFromOffsets()` (the
	 * manual splitter, which always operates on the original text the user
	 * sees) populates it exactly.
	 */
	startOffset?: number;
	endOffset?: number;
}


/**
 * Strip extraction artifacts left by the DOCX/PDF → text/markdown parsers so
 * clause text displays cleanly (and so the classifier/LLM see prose, not markup).
 * Removes: HTML tags + anchors (<a id="...">…</a>), markdown headers (#, ##),
 * markdown emphasis (**, __, *, _), escaped punctuation (\(, \), \[, \-, …),
 * leftover entities, and collapses whitespace.
 */
export function cleanClauseText(raw: string): string {
	if (!raw) return '';
	return raw
		// HTML/XML tags (e.g. <a id="...">, </a>, <br>)
		.replace(/<[^>]+>/g, '')
		// Markdown ATX headers at line start: "# ", "## " …
		.replace(/^\s{0,3}#{1,6}\s*/gm, '')
		// Markdown emphasis markers
		.replace(/\*\*|__/g, '')
		.replace(/(^|\s)[*_](?=\S)|(?<=\S)[*_](\s|$)/g, '$1$2')
		// Backslash-escaped punctuation: \( \) \[ \] \- \. \* \_ \# etc → bare char
		.replace(/\\([\\`*_{}\[\]()#+\-.!|>~])/g, '$1')
		// Common HTML entities
		.replace(/&nbsp;/gi, ' ')
		.replace(/&amp;/gi, '&')
		.replace(/&lt;/gi, '<')
		.replace(/&gt;/gi, '>')
		.replace(/&quot;/gi, '"')
		// Collapse runs of whitespace, normalize newlines
		.replace(/[ \t\u00a0]+/g, ' ')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}


/**
 * Normalize extracted text into a CANONICAL paragraph/heading shape so the
 * splitter behaves identically regardless of source parser.
 *
 * WHY: DOCX (via mammoth) and PDF (via pdf.js) produce structurally different
 * text for the SAME document:
 *   - DOCX → markdown with real "# Heading" lines and paragraph breaks.
 *   - PDF  → flat, per-VISUAL-LINE text. Every wrapped line ends in "\n", real
 *     paragraph breaks are mostly absent, words are hyphen-split across lines,
 *     and each page is prefixed with a "Page N:" marker (buildPdfAiContext).
 * Feeding PDF text straight into the splitter meant Tier 0 (markdown) never
 * fired and Tier 3 (double-newline paragraphs) saw no blank lines → one giant
 * blob. Normalizing first gives PDF text the same paragraph structure DOCX has,
 * so the SAME tiers fire for both and the output is consistent.
 *
 * Transformations (all conservative, deterministic):
 *   1. Normalize line endings (\r\n / \r → \n).
 *   2. Drop "Page N:" page-marker lines injected by the PDF AI-context builder.
 *   3. De-hyphenate words split across a line break: "indemni-\nfication"
 *      → "indemnification".
 *   4. Reflow soft-wrapped lines into paragraphs: a lone "\n" is a SOFT wrap
 *      (join with a space) UNLESS the next line starts a new block — a numbered
 *      section ("3. ..."), an ALL-CAPS heading, or a bullet — OR the previous
 *      line ended a sentence/heading (terminal punctuation or a colon). Those
 *      become hard paragraph breaks ("\n\n").
 *   5. Collapse 3+ newlines to a paragraph break.
 */
export function normalizeForClauses(input: string): string {
	if (!input) return '';

	// 1. Unify newlines.
	let text = input.replace(/\r\n?/g, '\n');

	// 2. Strip "Page N:" markers (PDF buildPdfAiContext prefix) on their own line.
	text = text.replace(/^[ \t]*Page\s+\d+\s*:?[ \t]*$/gim, '');

	// 2b. Strip REPEATED RUNNING HEADERS/FOOTERS. PDFs repeat the document title
	//     (and footer boilerplate) on every page — e.g. "BASIC RENTAL AGREEMENT
	//     OR RESIDENTIAL LEASE", "FARMLAND FOR THE NEXT GENERATION…". These get
	//     mistaken for section headings and produce duplicate clauses. Any
	//     non-trivial line that appears 3+ times verbatim is page furniture →
	//     drop all but the first occurrence.
	{
		const rawLines = text.split('\n');
		const counts = new Map<string, number>();
		for (const ln of rawLines) {
			const key = ln.trim();
			if (key.length >= 8 && key.length <= 80) counts.set(key, (counts.get(key) ?? 0) + 1);
		}
		const repeated = new Set([...counts].filter(([, c]) => c >= 3).map(([k]) => k));
		if (repeated.size) {
			const seen = new Set<string>();
			text = rawLines
				.filter((ln) => {
					const key = ln.trim();
					if (!repeated.has(key)) return true;
					if (seen.has(key)) return false; // drop repeats after the first
					seen.add(key);
					return true;
				})
				.join('\n');
		}
	}


	// 2c. Repair DROP-CAP SPACING. Some PDFs render a styled drop-cap as a
	//     separate glyph, so the extractor emits "S EVERANCE P AY", "C OOPERATION".
	//     On a line that is otherwise ALL-CAPS, collapse "X YYYY" → "XYYYY" where a
	//     lone capital is followed by a space and a capitalized run. Applied per
	//     line, only to caps-dominated lines, so normal prose is untouched.
	text = text
		.split('\n')
		.map((ln) => {
			const t = ln.trim();
			// Heuristic: line is short and mostly uppercase letters/spaces.
			if (t.length <= 80 && /^[A-Z][A-Z ]+$/.test(t) && / [A-Z] /.test(` ${t} `)) {
				// Repeatedly glue a lone capital to the following capital token.
				return ln.replace(/\b([A-Z]) (?=[A-Z])/g, '$1');
			}
			return ln;
		})
		.join('\n');

	// 3. De-hyphenate line-wrapped words: "word-\nnext" → "wordnext".
	//    Only when a lowercase letter precedes the hyphen and a letter follows
	//    the break (avoids joining real hyphenated headings / number ranges).
	text = text.replace(/([a-z])-\n([a-z])/g, '$1$2');

	// 4. Reflow soft-wrapped lines.
	const lines = text.split('\n');
	const out: string[] = [];
	/** Does this line START a new structural block (heading / list item)? */
	const startsBlock = (line: string): boolean => {
		const l = line.trimStart();
		if (l === '') return false;
		if (/^\d+[.)]\s+/.test(l)) return true;            // "3. " / "3) " numbered
		if (/^[A-Z][A-Z0-9 ,&/'-]{3,}$/.test(l.trim())) return true; // ALL-CAPS heading line
		if (/^(ARTICLE|SECTION|SCHEDULE|EXHIBIT|APPENDIX|ANNEX)\b/i.test(l)) return true;
		if (/^[•\-*\u2022]\s+/.test(l)) return true;       // bullet
		return false;
	};
	/** Does this line END a block (sentence/heading terminator)? */
	const endsBlock = (line: string): boolean => {
		const l = line.trimEnd();
		if (l === '') return true;
		if (/[.:;!?]$/.test(l)) return true;               // sentence / heading colon
		if (/^[A-Z][A-Z0-9 ,&/'-]{3,}$/.test(l.trim())) return true; // standalone CAPS heading
		return false;
	};

	for (let i = 0; i < lines.length; i++) {
		const cur = lines[i];
		out.push(cur);
		const next = lines[i + 1];
		if (next === undefined) break;
		if (cur.trim() === '' || next.trim() === '') {
			out.push('\n');                                  // preserve existing break
			continue;
		}
		// Hard break before a new block, or after a block-ending line.
		if (startsBlock(next) || endsBlock(cur)) {
			out.push('\n\n');
		} else {
			out.push(' ');                                   // soft wrap → space
		}
	}

	return out
		.join('')
		.replace(/[ \t]+/g, ' ')      // collapse runs of spaces produced by joins
		.replace(/ *\n/g, '\n')       // trim spaces before newlines
		.replace(/\n{3,}/g, '\n\n')   // cap blank runs at one paragraph break
		.trim();
}


// Tier 0: markdown headings emitted by the DOCX→markdown parser (mammoth) —

// "# Indemnification", "## 5. Governing Law". Capture group (1) = heading text.
// Anchored to line start (m flag) since markdown headers begin a line.
const MARKDOWN_HEADER_RE = /^\s{0,3}#{1,6}\s+(.+?)\s*$/gm;

// Tier 1: TOP-LEVEL numbered section headings.
//
// Matches a section number that is NOT a sub-number — i.e. "\n 9. Title" but
// NOT "\n 9.1 Title" — followed by a SHORT heading (Title-Case or ALL-CAPS),
// terminated by a period, newline, or the start of the body.
//
// WHY this shape: the two parsers disagree on heading case. mammoth (DOCX)
// emits markdown headings (handled by Tier 0). pdf.js (PDF) emits the headings
// inline as mixed-case "1. Definitions.", "9. Indemnification." — the old
// ALL-CAPS-only pattern never matched those, so PDF fell through to fragment
// matching and produced wrong/duplicate clauses. Allowing Title-Case headings
// (and requiring a TOP-LEVEL number, capped length, ending in a period) makes
// the PDF split on the same top-level sections DOCX does.
//
// Breakdown:
//   \n\s*          line start + indent
//   (?!\d+\.\d)    NOT a sub-number like "9.1" (negative lookahead)
//   (\d{1,2})\.    top-level number 1–99 + dot         → group 1
//   [ \t]+         space
//   ([A-Z][^\n.]{2,60}?)\.   heading: starts uppercase, no newline/period
//                            inside, 3–61 chars, up to the first period → group 2
//   (?=\s)         followed by whitespace (period is a real sentence end)
const NUMBERED_SECTION_RE = /\n\s*(?!\d+\.\d)(\d{1,2})\.[ \t]+([A-Z][^\n.]{2,60}?)\.(?=\s)/g;



// Tier 2: bare ALL-CAPS headers — "\n  CONFIDENTIALITY". Min 4 chars to avoid
// matching short shouty fragments / acronyms.
const CAPS_HEADER_RE = /\n\s*([A-Z][A-Z\s]{3,})/g;

/**
 * Boilerplate ALL-CAPS lines that are NOT section headings. Leases, forms, and
 * execution pages are full of these ("WITNESS", "OWNER", "SAMPLE"…). When a
 * captured CAPS "header" normalizes to one of these (or is dominated by them),
 * it is rejected as a clause boundary. Lowercased, punctuation-stripped compare.
 */
const CAPS_BOILERPLATE = new Set([
	'witness', 'witnesseth', 'owner', 'resident', 'tenant', 'landlord', 'lessor',
	'lessee', 'buyer', 'seller', 'sample', 'address', 'date', 'dated', 'name',
	'signature', 'signed', 'by', 'title', 'state of', 'county of', 'i certify',
	'in witness whereof', 'this agreement witnesseth', 'caution', 'notice', 'free',
	'agreement', 'contract', 'exhibit', 'schedule', 'attachment', 'appendix',
	'whereas', 'now therefore', 'recitals', 'preamble', 'page', 'id', 'cws', 'aba',
	'ssn', 'phi', 'hipaa', 'rfp', 'sow', 'userid'
]);

/** Normalize a candidate heading for boilerplate comparison. */
function headingKey(s: string): string {
	return s.toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Is this captured CAPS line a plausible SECTION HEADING (vs form-label /
 * boilerplate noise)? A real heading is short, is not in the boilerplate set,
 * and is not a fragment of a multi-line ALL-CAPS disclaimer (those tend to be
 * many consecutive CAPS lines — handled by the caller requiring a following
 * lowercase body).
 */
function isPlausibleCapsHeading(title: string, body: string): boolean {
	const key = headingKey(title);
	if (!key) return false;
	if (CAPS_BOILERPLATE.has(key)) return false;
	// Reject very long "headings" (likely a wrapped sentence fragment in CAPS).
	if (title.trim().length > 60) return false;
	// A real heading is followed by SUBSTANTIVE body text. If the body is empty
	// or itself looks like more shouting (another CAPS line, no lowercase prose),
	// this is probably part of a CAPS disclaimer block, not a heading.
	const bodyTrim = body.trim();
	if (bodyTrim.length < 40) return false;
	if (!/[a-z]/.test(bodyTrim.slice(0, 120))) return false; // no lowercase prose nearby
	return true;
}

/**
 * Phrases that mark the start of a signature / execution block. If a clause's
 * (lowercased) text is dominated by these — i.e. it looks like a signing block
 * rather than a substantive clause — it is dropped.
 */
const SIGNATURE_MARKERS = [
	'in witness whereof',
	'signature',
	'signed by',
	'signed:',
	'date:',
	'by:',
	'name:',
	'title:',
	'authorized representative',
	'_______' // signature lines rendered as underscores
];

/**
 * Heuristic: does this chunk, as a STANDALONE block, look like a
 * signature/execution block? Used to skip a clause that is *entirely* a signing
 * block — not to discard a substantive clause that merely mentions "signature".
 */
function isSignatureBlock(text: string): boolean {
	const lower = text.toLowerCase();
	const hits = SIGNATURE_MARKERS.filter((m) => lower.includes(m)).length;
	// Signature blocks are short and marker-dense. Require either multiple
	// markers, or a single marker inside a very short chunk.
	if (hits >= 2) return true;
	if (hits >= 1 && lower.replace(/\s+/g, ' ').trim().length < 120) return true;
	return false;
}

/**
 * Cut a trailing signature/execution block off a clause body, if present.
 * The final numbered clause's body often runs to end-of-document and absorbs
 * the "IN WITNESS WHEREOF … Signature: …" tail. We truncate at the earliest
 * signature marker so the substantive clause text is preserved (rather than the
 * whole clause being dropped as a "signature block").
 */
function stripTrailingSignature(body: string): string {
	const lower = body.toLowerCase();
	let cut = -1;
	for (const m of SIGNATURE_MARKERS) {
		const i = lower.indexOf(m);
		if (i !== -1 && (cut === -1 || i < cut)) cut = i;
	}
	return cut === -1 ? body : body.slice(0, cut);
}

/**
 * Clean a captured ALL-CAPS title.
 * The capture regex is greedy and can absorb the leading capital letter of the
 * next (Mixed-case) body word — e.g. "DEFINITIONS F" where the body starts
 * "From…". We strip a trailing lone single-letter token, then collapse
 * whitespace.
 */
function cleanTitle(raw: string): string {
	let t = raw.replace(/\s+/g, ' ').trim();
	// Drop a dangling single capital letter (the start of the next word).
	t = t.replace(/\s+[A-Z]$/, '');
	return t.trim();
}


/**
 * Build a clause, skipping empties. Returns null when there's no body.
 * The `id` is a placeholder here ('') — `splitClauses` stamps the final,
 * guaranteed-unique id once the winning strategy's full list is known.
 */
function makeClause(
	number: number,
	title: string,
	text: string,
	offsets?: { startOffset: number; endOffset: number }
): Clause | null {
	// Strip parser artifacts (markdown/HTML/escapes) before storing/classifying.
	const body = cleanClauseText(text);
	if (!body) return null;
	return {
		id: '',
		number,
		title: cleanClauseText(title) || `Clause ${number}`,
		text: body,
		...offsets
	};
}

/**
 * Stamp a stable, unique id onto each clause based on its position in the list.
 * Position is unique even when document `number`s collide, so this is the safe
 * key for Svelte's keyed {#each}, DOM element ids, and scroll/highlight targets.
 */
function assignIds(clauses: Clause[]): Clause[] {
	for (let i = 0; i < clauses.length; i++) {
		clauses[i].id = `clause-${i}-${clauses[i].number}`;
	}
	return clauses;
}



/**
 * Tier 0 — split on markdown headings (mammoth's DOCX→markdown output).
 *
 * Skips ALL text before the first heading (cover page, recitals, "WHEREAS"
 * preamble) — that text is NOT a clause and must not be classified. Each
 * heading starts a clause whose body runs to the next heading. A leading
 * "5." / "5)" number in the heading text is used as the clause number.
 * Returns [] if fewer than 2 headings are found (caller falls through).
 */
function splitMarkdownHeaders(text: string): Clause[] {
	const matches = [...text.matchAll(MARKDOWN_HEADER_RE)];
	if (matches.length < 2) return [];

	const clauses: Clause[] = [];
	let idx = 0;
	for (let i = 0; i < matches.length; i++) {
		const m = matches[i];
		const rawTitle = m[1].trim();
		// Heading-only line; body runs from end of this heading line to next heading.
		const start = (m.index ?? 0) + m[0].length;
		const end = i + 1 < matches.length ? matches[i + 1].index ?? text.length : text.length;
		const body = stripTrailingSignature(text.slice(start, end));
		if (!body.trim()) continue; // heading with no body → skip

		// Use a leading "5." / "5)" in the heading as the clause number if present.
		const numMatch = /^(\d+)[.)]?\s+/.exec(rawTitle);
		const num = numMatch ? parseInt(numMatch[1], 10) : ++idx;
		const title = numMatch ? rawTitle.slice(numMatch[0].length) : rawTitle;

		const full = `${title}\n${body}`;
		if (isSignatureBlock(full)) continue;
		const clause = makeClause(num, title, full);
		if (clause) clauses.push(clause);
	}
	// NOTE: preamble (text before matches[0]) is intentionally NOT emitted.
	return clauses;
}

/**
 * Tier 1 — split on numbered ALL-CAPS sections.
 * Returns [] if fewer than 2 numbered sections are found (so the caller can
 * fall through to the next strategy).
 */
function splitNumbered(text: string): Clause[] {

	const matches = [...text.matchAll(NUMBERED_SECTION_RE)];
	if (matches.length < 2) return [];

	const clauses: Clause[] = [];

	// Preamble: anything before the first numbered section.
	const firstStart = matches[0].index ?? 0;
	const preamble = makeClause(0, 'Preamble', text.slice(0, firstStart));
	if (preamble && !isSignatureBlock(preamble.text)) clauses.push(preamble);

	for (let i = 0; i < matches.length; i++) {
		const m = matches[i];
		const num = parseInt(m[1], 10);
		const title = cleanTitle(m[2]);
		// Body runs from the end of this header to the start of the next.
		const start = (m.index ?? 0) + m[0].length;
		const end = i + 1 < matches.length ? matches[i + 1].index ?? text.length : text.length;
		// Trim any trailing signature/execution block off the body so the last
		// substantive clause isn't lost when the signing block is glued to it.
		const body = stripTrailingSignature(text.slice(start, end));
		if (!body.trim()) continue; // nothing substantive left → skip
		const full = `${num}. ${title}\n${body}`;

		const clause = makeClause(num, title, full);
		if (clause) clauses.push(clause);
	}

	return clauses;
}

/**
 * Tier 2 — split on bare ALL-CAPS headers (no leading number).

 * The section `number` is the 1-based index of the header.
 */
function splitCapsHeaders(text: string): Clause[] {
	const matches = [...text.matchAll(CAPS_HEADER_RE)];
	if (matches.length < 2) return [];

	const clauses: Clause[] = [];

	const firstStart = matches[0].index ?? 0;
	const preamble = makeClause(0, 'Preamble', text.slice(0, firstStart));
	if (preamble && !isSignatureBlock(preamble.text)) clauses.push(preamble);

	let idx = 0;
	for (let i = 0; i < matches.length; i++) {
		const m = matches[i];
		const title = cleanTitle(m[1]);
		const start = (m.index ?? 0) + m[0].length;
		const end = i + 1 < matches.length ? matches[i + 1].index ?? text.length : text.length;
		const body = text.slice(start, end);
		const full = `${title}\n${body}`;

		if (isSignatureBlock(body)) continue;
		// Reject form-labels / boilerplate / multi-line CAPS disclaimer fragments
		// ("WITNESS", "OWNER", "SAMPLE"…). Only real headings (short, non-boiler,
		// followed by substantive lowercase prose) become clause boundaries.
		if (!isPlausibleCapsHeading(title, body)) continue;
		idx++;
		const clause = makeClause(idx, title, full);
		if (clause) clauses.push(clause);
	}

	return clauses;
}

/**
 * Tier 3 — last-resort: split on blank lines (double newlines).
 * Each paragraph becomes a clause; the title is its first short line.
 */
function splitParagraphs(text: string): Clause[] {
	const paras = text
		.split(/\n\s*\n/)
		.map((p) => p.trim())
		.filter(Boolean);

	const clauses: Clause[] = [];
	let idx = 0;
	for (const para of paras) {
		if (isSignatureBlock(para)) continue;
		idx++;
		// Title = first line, truncated; falls back to "Clause N".
		const firstLine = para.split('\n')[0].trim();
		const title = firstLine.length > 0 && firstLine.length <= 80 ? firstLine : `Clause ${idx}`;
		const clause = makeClause(idx, title, para);
		if (clause) clauses.push(clause);
	}
	return clauses;
}

/**
 * Score a candidate clause list for how much it "looks like" a well-segmented
 * contract. Higher is better. Used to choose among the tier strategies instead
 * of the old "first tier with ≥2 clauses wins" rule — which let a noisy tier
 * (256 "Clause N" fragments, or ALL-CAPS form labels) beat a clean numbered
 * split. The score is a normalized 0–1 confidence.
 *
 * Signals (see FINDINGS.md):
 *   + clause count in a sane band (≈3–40 top-level sections is typical)
 *   + healthy median body length (real clauses carry substantive prose)
 *   + title-like headings (short, mostly unique)
 *   − explosion: >60 clauses (margin numbering, page furniture, fragments)
 *   − tiny bodies: median body < 50 chars (sentence fragments, not clauses)
 *   − duplicate titles (same heading repeated → boilerplate/furniture)
 *   − fallback penalty for the paragraph tier (structureless last resort)
 */
function scoreCandidate(clauses: Clause[], tier: number): number {
	const n = clauses.length;
	if (n === 0) return 0;

	const bodyLens = clauses.map((c) => c.text.length).sort((a, b) => a - b);
	const median = bodyLens[Math.floor(bodyLens.length / 2)];
	const titles = clauses.map((c) => headingKey(c.title)).filter(Boolean);
	const uniqueTitles = new Set(titles).size;
	const dupRatio = titles.length ? 1 - uniqueTitles / titles.length : 0;
	// Headings that are "Clause N" placeholders mean the splitter invented
	// numbers rather than finding real titles (paragraph-fallback fragments).
	const placeholderRatio =
		clauses.filter((c) => /^clause \d+$/i.test(c.title.trim())).length / clauses.length;

	let score = 0.5;


	// Count band: reward a sane number of sections, penalize explosions/collapse.
	// 2 clauses is barely a "split" — most real contracts have many sections, so
	// a 2-clause result usually means the splitter only found the title + one
	// block (collapse). Treat it as weak, not confident.
	if (n >= 4 && n <= 45) score += 0.25;
	else if (n === 3) score += 0.1;
	else if (n <= 2) score -= 0.2;
	if (n > 60) score -= 0.45;
	else if (n > 45) score -= 0.15;

	// Body substance: real clauses have prose; fragments don't.
	if (median >= 120) score += 0.2;
	else if (median >= 50) score += 0.1;
	else score -= 0.3; // tiny median = fragment soup

	// Duplicate titles indicate repeated furniture ("SAMPLE", "OWNER", repeated
	// running headers like "FARMLAND…"). Heavily penalized — a contract's
	// top-level sections should have distinct names.
	score -= dupRatio * 0.7;

	// "Clause N" placeholder titles = the splitter never found real headings and
	// invented numbers (paragraph-fallback fragments). The more of them, the less
	// the result resembles a genuine section structure.
	score -= placeholderRatio * 0.4;

	// Tier bias: structured strategies (0/1) are more trustworthy than the
	// structureless paragraph fallback (3).
	if (tier === 3) score -= 0.2;

	return Math.max(0, Math.min(1, score));

}

export interface SplitResult {
	/** The chosen clause list (ids already assigned). */
	clauses: Clause[];
	/** 0–1 confidence of the winning strategy. */
	confidence: number;
	/** True when confidence is below threshold → caller should warn the user. */
	lowConfidence: boolean;
	/** Which tier won: 0 markdown, 1 numbered, 2 caps, 3 paragraph fallback. */
	tier: number;
}

/** Below this score, a parse is flagged low-confidence (best-effort). */
const CONFIDENCE_THRESHOLD = 0.55;

/**
 * Split contract text and report parse confidence.
 *
 * Unlike the legacy "first tier ≥2 wins" rule, this runs ALL strategies, scores
 * each candidate (scoreCandidate), and returns the highest-scoring one. When
 * even the best candidate scores below CONFIDENCE_THRESHOLD, `lowConfidence` is
 * set so the UI can show a "best-effort parse" notice instead of presenting a
 * wrong clause list as authoritative.
 */
export function splitClausesWithConfidence(rawText: string): SplitResult {
	if (!rawText || !rawText.trim()) {
		return { clauses: [], confidence: 0, lowConfidence: true, tier: -1 };
	}

	const text = normalizeForClauses(rawText);

	const candidates: { clauses: Clause[]; tier: number }[] = [
		{ clauses: splitMarkdownHeaders(text), tier: 0 },
		{ clauses: splitNumbered(text), tier: 1 },
		{ clauses: splitCapsHeaders(text), tier: 2 },
		{ clauses: splitParagraphs(text), tier: 3 }
	].filter((c) => c.clauses.length >= 1);

	let best: { clauses: Clause[]; tier: number; score: number } | null = null;
	for (const c of candidates) {
		const score = scoreCandidate(c.clauses, c.tier);
		// Prefer a higher score; on a tie, prefer the more-structured (lower) tier.
		if (!best || score > best.score || (score === best.score && c.tier < best.tier)) {
			best = { ...c, score };
		}
	}

	if (!best) {
		return { clauses: [], confidence: 0, lowConfidence: true, tier: -1 };
	}

	// The paragraph fallback (tier 3) is a structureless last resort: it never
	// found real headings, so we always treat its output as best-effort, even if
	// the heuristic score happens to clear the threshold.
	const lowConfidence = best.score < CONFIDENCE_THRESHOLD || best.tier === 3;

	return {
		clauses: assignIds(best.clauses),
		confidence: best.score,
		lowConfidence,
		tier: best.tier
	};

}

/**
 * Split contract text into individual clauses.
 *
 * Backward-compatible thin wrapper over {@link splitClausesWithConfidence} —
 * returns just the clause list. New callers that want to surface a "best-effort
 * parse" warning should use splitClausesWithConfidence and read `lowConfidence`.
 *
 * @param rawText The extracted plain text of the contract.
 * @returns Ordered clauses. Empty array if the input has no usable text.
 */
export function splitClauses(rawText: string): Clause[] {
	return splitClausesWithConfidence(rawText).clauses;
}


/** One paragraph segment for the manual ClauseSplitter UI. */
export interface Paragraph {
	/** Character offset into the source text where this paragraph starts. */
	offset: number;
	/** The paragraph's display text (trimmed). */
	text: string;
}

/**
 * Break `text` into paragraph segments for MANUAL clause splitting.
 *
 * Returns one entry per paragraph (split on blank lines), each carrying the
 * character offset (into the ORIGINAL `text`) where the paragraph begins and
 * its trimmed text. The manual ClauseSplitter UI renders a tappable divider
 * before each paragraph (except the first) and tracks which offsets the user
 * promotes to clause boundaries. Offsets index into `text` (not a normalized
 * copy) so {@link clausesFromOffsets} can slice it directly. Deterministic.
 */
export function splitParagraphOffsets(text: string): Paragraph[] {
	const paras: Paragraph[] = [];
	if (!text) return paras;
	const re = /\n[ \t]*\n+/g;
	let last = 0;
	let m: RegExpExecArray | null;
	const push = (start: number, end: number) => {
		const raw = text.slice(start, end);
		if (!raw.trim()) return;
		// Align the recorded offset with the first visible character.
		const lead = raw.length - raw.trimStart().length;
		paras.push({ offset: start + lead, text: raw.trim() });
	};
	while ((m = re.exec(text)) !== null) {
		push(last, m.index);
		last = m.index + m[0].length;
	}
	push(last, text.length);
	return paras;
}

/**
 * Build classifiable {@link Clause}s from user-chosen split offsets.
 *
 * `splits` is a list of character offsets (into `text`) where each clause
 * BEGINS — exactly the offsets the manual ClauseSplitter UI collects from
 * divider taps. Text before the first split becomes the preamble (number 0)
 * when non-empty; each subsequent run becomes clause 1..N. Mirrors the shape
 * splitClauses() produces (ids via assignIds, first-line titles, cleaned body)
 * so downstream classification/rendering treat manual and auto splits
 * identically. With an empty `splits`, the whole text is a single clause.
 */
export function clausesFromOffsets(text: string, splits: number[]): Clause[] {
	if (!text || !text.trim()) return [];
	const bounds = [...new Set(splits.filter((s) => s > 0 && s < text.length))].sort(
		(a, b) => a - b
	);
	const cuts = [0, ...bounds, text.length];
	const clauses: Clause[] = [];
	let idx = 0;
	for (let i = 0; i < cuts.length - 1; i++) {
		const rawStart = cuts[i];
		const rawEnd = cuts[i + 1];
		const seg = text.slice(rawStart, rawEnd).trim();
		if (!seg) continue;
		// A non-empty leading segment (before the first user split) is the preamble.
		const isPreamble = i === 0 && bounds.length > 0;
		const number = isPreamble ? 0 : ++idx;
		const firstLine = seg.split('\n')[0].trim();
		const title = isPreamble
			? 'Preamble'
			: firstLine.length > 0 && firstLine.length <= 80
				? firstLine
				: `Clause ${number}`;
		// Offsets into the ORIGINAL text, accounting for leading/trailing
		// whitespace trimmed off `seg` (cuts[] are raw segment boundaries,
		// not the trimmed content's own start/end).
		const leadingWs = text.slice(rawStart, rawEnd).length - text.slice(rawStart, rawEnd).trimStart().length;
		const startOffset = rawStart + leadingWs;
		const endOffset = startOffset + seg.length;
		const clause = makeClause(number, title, seg, { startOffset, endOffset });
		if (clause) clauses.push(clause);
	}
	return assignIds(clauses);
}



