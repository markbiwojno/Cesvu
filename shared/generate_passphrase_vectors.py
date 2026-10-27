"""Generate shared/passphrase-vectors.json — the cross-language contract for
passphrase normalization.

Run: python shared/generate_passphrase_vectors.py

WHY THIS FILE EXISTS
--------------------
`cesvu-crypto.ts` and `cesvu_crypto.py` must derive byte-identical Argon2id
input from the same typed passphrase. Reviewing the two implementations side
by side does NOT guarantee that: two fixes can agree with each other's author
and still disagree with the spec, or agree today and drift tomorrow. A shared
vector file consumed by both test suites is what actually pins the behaviour.

This generator is deliberately a THIRD, independent transcription of
`.cesvu SPEC/README.md` § "passProfile normalization (must match exactly)".
It does not import from either implementation. If it agrees with both, three
separate readings of the spec agree.

INPUT ENCODING — read this before adding a vector
-------------------------------------------------
`inputUtf16` is a list of **UTF-16 code units**, not code points. That choice
is forced, not stylistic:

    ["D800", "DC00"]

In JavaScript this is a well-formed surrogate PAIR and the string contains
exactly one character, U+10000 — no surrogates are observable by any
code-point-level iteration. In Python, `chr(0xD800) + chr(0xDC00)` is two
LONE surrogates that `.encode('utf-8')` refuses. Same two numbers, genuinely
different strings. Defining the input as UTF-16 code units and having Python
build it via utf-16-le decoding makes the two languages construct the *same*
string, so a disagreement in the results is a real bug rather than an
artifact of how the fixture was spelled.

Expected values are hex-encoded UTF-8 bytes for the same reason: a literal
normalized string in a JSON file is at the mercy of every editor, formatter,
and git filter between here and the test runner, and the entire subject of
this file is invisible characters.
"""

import json
import struct
import unicodedata
from pathlib import Path

# ── Spec constants ────────────────────────────────────────────────────────

# README.md § CANONICAL_WHITESPACE — exactly these 30 code points.
# The union of the Python and JavaScript whitespace sets, so that neither
# implementation depends on its own runtime's notion of whitespace.
CANONICAL_WHITESPACE = [
    0x0009, 0x000A, 0x000B, 0x000C, 0x000D, 0x001C, 0x001D, 0x001E, 0x001F,
    0x0020, 0x0085, 0x00A0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004,
    0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200A, 0x2028, 0x2029, 0x202F,
    0x205F, 0x3000, 0xFEFF,
]
assert len(CANONICAL_WHITESPACE) == 30
assert len(set(CANONICAL_WHITESPACE)) == 30

# The subset where the two runtimes' built-in `\s` actually disagree. These
# are the code points that would silently produce different keys if either
# implementation regressed to a native whitespace class.
#   U+001C-U+001F, U+0085 : Python's \s matches, JavaScript's does not
#   U+FEFF                : JavaScript's \s matches, Python's does not
DIVERGENT_WHITESPACE = [0x001C, 0x001D, 0x001E, 0x001F, 0x0085, 0xFEFF]

# Profile 2 deletes these outright (in addition to CANONICAL_WHITESPACE).
EMOJI_DELETE = (
    [0xFE0E, 0xFE0F]                      # variation selectors
    + list(range(0x200B, 0x200D + 1))     # ZWSP / ZWNJ / ZWJ
    + [0xFEFF]                            # BOM
    + list(range(0x202A, 0x202E + 1))     # bidi embedding/override
    + list(range(0x2066, 0x2069 + 1))     # bidi isolates
)

PROFILE_TEXT, PROFILE_EMOJI, PROFILE_RAW = 1, 2, 3

# Profile 3 only. UTF-8 BYTES, not characters.
#
# 512 rather than a larger number because the web app's decrypt entry points
# (SecureOpenModal / ImportModal) gate their passphrase input at 512
# `String.length` UTF-16 units, and UTF-16 units <= UTF-8 bytes for every
# possible string (1:1 ASCII, 1:2 Cyrillic, 1:3 CJK, 2:4 astral). A byte cap
# of 512 therefore cannot admit any passphrase the browser refuses to accept.
# Raising this above the UI's character cap would let the CLI create files
# whose passphrase cannot be typed into the web app at all — the file would
# be permanently unopenable there. Keep RAW_MAX_BYTES <= the UI character cap.
RAW_MAX_BYTES = 512


# ── Spec implementation (independent of both production modules) ──────────

def _has_surrogate(s: str) -> bool:
    return any(0xD800 <= ord(ch) <= 0xDFFF for ch in s)


def _normalize_text(s: str) -> str:
    """Profile 1 — text/diceware."""
    # 1. Replace every CANONICAL_WHITESPACE code point with U+0020.
    ws = set(CANONICAL_WHITESPACE)
    s = "".join(" " if ord(ch) in ws else ch for ch in s)
    # 2. Collapse runs of U+0020, strip leading/trailing U+0020.
    s = " ".join(part for part in s.split(" ") if part != "")
    # 3. NFC (not NFKC).
    s = unicodedata.normalize("NFC", s)
    # 4. ASCII-only lowercase.
    return "".join(
        chr(ord(ch) + 32) if "A" <= ch <= "Z" else ch for ch in s
    )


def _normalize_emoji(s: str) -> str:
    """Profile 2 — emoji."""
    s = unicodedata.normalize("NFC", s)
    drop = set(EMOJI_DELETE) | set(CANONICAL_WHITESPACE)
    return "".join(ch for ch in s if ord(ch) not in drop)


def _normalize_raw(s: str) -> str:
    """Profile 3 — raw. Identity. Every code point, including U+0020,
    is significant."""
    return s


def evaluate(s: str, profile: int):
    """Return ('ok', utf8_bytes) or ('error', CODE), per the spec's
    preconditions order: surrogates -> normalize -> encode -> empty -> cap."""
    if _has_surrogate(s):
        return ("error", "PASSPHRASE_INVALID_ENCODING")
    if profile == PROFILE_EMOJI:
        normalized = _normalize_emoji(s)
    elif profile == PROFILE_RAW:
        normalized = _normalize_raw(s)
    else:
        normalized = _normalize_text(s)
    encoded = normalized.encode("utf-8")
    if len(encoded) == 0:
        return ("error", "PASSPHRASE_EMPTY")
    if profile == PROFILE_RAW and len(encoded) > RAW_MAX_BYTES:
        return ("error", "PASSPHRASE_TOO_LONG")
    return ("ok", encoded)


# ── Vector construction ───────────────────────────────────────────────────

def units(s: str):
    """Python str -> list of UTF-16 code unit hex strings."""
    raw = s.encode("utf-16-le", errors="surrogatepass")
    return ["%04X" % u for (u,) in struct.iter_unpack("<H", raw)]


def from_units(hex_units):
    """List of UTF-16 code unit hex strings -> Python str. Mirrors what the
    JS harness gets from String.fromCharCode, including surrogate pairing."""
    raw = b"".join(struct.pack("<H", int(u, 16)) for u in hex_units)
    return raw.decode("utf-16-le", errors="surrogatepass")


VECTORS = []
_seen_ids = set()


def add(vid, group, profile, hex_units, note=None):
    if vid in _seen_ids:
        raise AssertionError("duplicate vector id: " + vid)
    _seen_ids.add(vid)

    s = from_units(hex_units)
    kind, value = evaluate(s, profile)

    entry = {
        "id": vid,
        "group": group,
        "profile": profile,
        "inputUtf16": hex_units,
    }
    if note:
        entry["note"] = note
    if kind == "ok":
        entry["expect"] = {"normalizedUtf8Hex": value.hex().upper()}
    else:
        entry["expect"] = {"error": value}
    VECTORS.append(entry)


def add_str(vid, group, profile, s, note=None):
    add(vid, group, profile, units(s), note)


# 1 ── Every CANONICAL_WHITESPACE code point, all three profiles.
#      Interior position, so profile 1 exercises replace+collapse rather
#      than only the trim.
for cp in CANONICAL_WHITESPACE:
    tag = "%04X" % cp
    divergent = cp in DIVERGENT_WHITESPACE
    note = (
        "runtime \\s classes disagree on this code point" if divergent else None
    )
    group = "whitespace-divergent" if divergent else "whitespace"
    for profile in (PROFILE_TEXT, PROFILE_EMOJI, PROFILE_RAW):
        add(
            f"ws-{tag}-p{profile}",
            group,
            profile,
            ["0061", tag, "0062"],  # "a" + ws + "b"
            note,
        )

# 2 ── Leading/trailing whitespace, and a run of mixed whitespace, using
#      the divergent code points specifically.
add(
    "ws-leading-trailing-divergent-p1",
    "whitespace-divergent",
    PROFILE_TEXT,
    ["001C", "0061", "0085", "0085", "0062", "FEFF"],
    "trim + collapse must use CANONICAL_WHITESPACE, not the host \\s",
)
add(
    "ws-run-collapse-p1",
    "whitespace",
    PROFILE_TEXT,
    ["0061", "0020", "0009", "000A", "3000", "0062"],
    "a run of four different whitespace code points collapses to one U+0020",
)
add(
    "ws-only-p1",
    "whitespace",
    PROFILE_TEXT,
    ["0020", "0009", "FEFF", "0085"],
    "normalizes to empty -> rejected",
)
add(
    "ws-only-p2",
    "whitespace",
    PROFILE_EMOJI,
    ["0020", "0009", "FEFF", "0085"],
    "normalizes to empty -> rejected",
)
add(
    "ws-only-p3",
    "whitespace",
    PROFILE_RAW,
    ["0020", "0009", "FEFF", "0085"],
    "RAW is identity: whitespace is significant and this is NOT empty",
)
add(
    "single-space-p3",
    "whitespace",
    PROFILE_RAW,
    ["0020"],
    "a single space is a valid 1-byte RAW passphrase",
)

# 3 ── Surrogates. The load-bearing case: Python's encoder raises, JS's
#      TextEncoder is required by WHATWG to substitute U+FFFD and never
#      throw, so JS must scan explicitly or it derives a key from bytes the
#      user never typed.
for profile in (PROFILE_TEXT, PROFILE_EMOJI, PROFILE_RAW):
    add(
        f"surrogate-lone-high-p{profile}",
        "surrogates",
        profile,
        ["0061", "D800", "0062"],
        "lone high surrogate",
    )
    add(
        f"surrogate-lone-low-p{profile}",
        "surrogates",
        profile,
        ["0061", "DFFF", "0062"],
        "lone low surrogate",
    )
    add(
        f"surrogate-reversed-pair-p{profile}",
        "surrogates",
        profile,
        ["DC00", "D800"],
        "low followed by high — never combines, two lone surrogates",
    )
    add(
        f"surrogate-valid-pair-p{profile}",
        "surrogates",
        profile,
        ["D83D", "DE00"],
        "WELL-FORMED pair = U+1F600. Must be ACCEPTED, not caught by the "
        "surrogate scan. Scan code points, never UTF-16 code units.",
    )

# 4 ── NFC vs NFD. The vector that pins the RAW decision: identical under
#      profiles 1 and 2, DIFFERENT under profile 3.
CAFE_NFD = ["0063", "0061", "0066", "0065", "0301"]  # cafe + combining acute
CAFE_NFC = ["0063", "0061", "0066", "00E9"]          # café precomposed
for profile in (PROFILE_TEXT, PROFILE_EMOJI, PROFILE_RAW):
    add(f"cafe-nfd-p{profile}", "normalization-form", profile, CAFE_NFD)
    add(f"cafe-nfc-p{profile}", "normalization-form", profile, CAFE_NFC)

# 5 ── Case mapping is ASCII-ONLY. Every non-ASCII case pair below must pass
#      through untouched; a stray toLowerCase()/.lower() shows up here.
add_str("case-ascii-p1", "case", PROFILE_TEXT, "ABCxyz")
add_str("case-turkish-dotted-I-p1", "case", PROFILE_TEXT, "\u0130stanbul",
        "U+0130; Unicode lowercase would yield i+U+0307 and locale rules differ")
add_str("case-turkish-dotless-i-p1", "case", PROFILE_TEXT, "\u0131rmak")
add_str("case-greek-sigma-p1", "case", PROFILE_TEXT, "\u03a3\u03a4\u0391",
        "final-sigma handling is context sensitive; ASCII-only rule avoids it")
add_str("case-cyrillic-p1", "case", PROFILE_TEXT, "\u041f\u0420\u0418\u0412\u0415\u0422")
add_str("case-fullwidth-p1", "case", PROFILE_TEXT, "\uff21\uff22",
        "fullwidth A/B: NFKC would fold these to ASCII, NFC must not")
add_str("nfkc-ligature-p1", "normalization-form", PROFILE_TEXT, "\ufb01n",
        "U+FB01 LATIN SMALL LIGATURE FI: NFKC would expand to 'fi', NFC must not")
add_str("nfkc-superscript-p1", "normalization-form", PROFILE_TEXT, "x\u00b2",
        "superscript two: NFKC would fold to '2', NFC must not")
add_str("nfkc-nbsp-p3", "normalization-form", PROFILE_RAW, "a\u00a0b",
        "NBSP under RAW identity: preserved as U+00A0, never folded to space")

# 6 ── Profile 2 deletions.
add("emoji-vs16-p2", "emoji-deletions", PROFILE_EMOJI, ["2764", "FE0F"],
    "heart + VS16 -> bare heart")
add("emoji-vs15-p2", "emoji-deletions", PROFILE_EMOJI, ["2764", "FE0E"])
add("emoji-zwj-family-p2", "emoji-deletions", PROFILE_EMOJI,
    ["D83D", "DC68", "200D", "D83D", "DC69", "200D", "D83D", "DC67"],
    "ZWJ family sequence: joiners deleted, the three people remain")
add("emoji-bidi-p2", "emoji-deletions", PROFILE_EMOJI,
    ["202A", "0061", "2066", "0062", "2069", "202C"],
    "bidi controls deleted")
add("emoji-zwsp-p2", "emoji-deletions", PROFILE_EMOJI,
    ["0061", "200B", "200C", "200D", "FEFF", "0062"])
add("emoji-only-deletables-p2", "emoji-deletions", PROFILE_EMOJI,
    ["FE0F", "200D", "202A"],
    "everything is deleted -> empty -> rejected")
# The same deletables under RAW must survive untouched.
add("emoji-vs16-p3", "emoji-deletions", PROFILE_RAW, ["2764", "FE0F"],
    "RAW is identity: the variation selector is significant")
add("emoji-zwj-p3", "emoji-deletions", PROFILE_RAW, ["0061", "200D", "0062"])

# 7 ── RAW byte-length boundary. Every case is built so that a code-point
#      count or a UTF-16 length would give the wrong verdict.
add_str("raw-len-ascii-511", "raw-length", PROFILE_RAW, "a" * 511)
add_str("raw-len-ascii-512", "raw-length", PROFILE_RAW, "a" * 512,
        "exactly at the cap — must be ACCEPTED")
add_str("raw-len-ascii-513", "raw-length", PROFILE_RAW, "a" * 513,
        "one byte over — rejected")
add_str("raw-len-cyrillic-256", "raw-length", PROFILE_RAW, "\u0430" * 256,
        "256 chars / 512 bytes: accepted. len()==256 would be nowhere near "
        "the cap, so a code-point check passes this for the wrong reason")
add_str("raw-len-cyrillic-257", "raw-length", PROFILE_RAW, "\u0430" * 257,
        "257 chars / 514 bytes: REJECTED. A code-point or UTF-16 length "
        "check sees 257 and wrongly accepts")
add_str("raw-len-cjk-170", "raw-length", PROFILE_RAW, "\u4e00" * 170,
        "170 chars / 510 bytes: accepted")
add_str("raw-len-cjk-171", "raw-length", PROFILE_RAW, "\u4e00" * 171,
        "171 chars / 513 bytes: REJECTED at 171 code points")
add_str("raw-len-emoji-128", "raw-length", PROFILE_RAW, "\U0001f600" * 128,
        "128 astral chars / 256 UTF-16 units / 512 bytes: accepted")
add_str("raw-len-emoji-129", "raw-length", PROFILE_RAW, "\U0001f600" * 129,
        "129 astral chars / 258 UTF-16 units / 516 bytes: REJECTED. "
        "String.length says 258 and Python len() says 129 — both under any "
        "character-based cap, so only a byte count gets this right")
# The cap is profile 3 ONLY.
add_str("raw-len-cap-is-p3-only-p1", "raw-length", PROFILE_TEXT, "a" * 2000,
        "profiles 1 and 2 have no upper byte limit")
add_str("raw-len-cap-is-p3-only-p2", "raw-length", PROFILE_EMOJI,
        "\U0001f600" * 400,
        "profiles 1 and 2 have no upper byte limit")

# 8 ── Empty input.
for profile in (PROFILE_TEXT, PROFILE_EMOJI, PROFILE_RAW):
    add(f"empty-p{profile}", "empty", profile, [])

# 9 ── Realistic passphrases, as a smoke test that the machinery composes.
add_str("real-diceware-messy-p1", "realistic", PROFILE_TEXT,
        "  Correct  HORSE Battery\tStaple Winter FOREST \n")
add_str("real-diceware-clean-p1", "realistic", PROFILE_TEXT,
        "correct horse battery staple winter forest",
        "must equal real-diceware-messy-p1 — normalization is idempotent")
add_str("real-raw-password-p3", "realistic", PROFILE_RAW,
        "  Tr0ub4dor&3 — with spaces  ",
        "RAW keeps the leading/trailing spaces and the em dash")


# ── Cross-checks before writing ───────────────────────────────────────────

def _expect_of(vid):
    for v in VECTORS:
        if v["id"] == vid:
            return v["expect"]
    raise KeyError(vid)


# The RAW decision, asserted rather than assumed.
assert _expect_of("cafe-nfd-p1") == _expect_of("cafe-nfc-p1"), \
    "profile 1 must unify NFD and NFC"
assert _expect_of("cafe-nfd-p2") == _expect_of("cafe-nfc-p2"), \
    "profile 2 must unify NFD and NFC"
assert _expect_of("cafe-nfd-p3") != _expect_of("cafe-nfc-p3"), \
    "profile 3 is identity: NFD and NFC are DIFFERENT passwords"

# Idempotence of profile 1.
assert _expect_of("real-diceware-messy-p1") == _expect_of("real-diceware-clean-p1")

# A well-formed surrogate pair is a character, not an error.
assert _expect_of("surrogate-valid-pair-p3") == {
    "normalizedUtf8Hex": "\U0001f600".encode("utf-8").hex().upper()
}
assert _expect_of("surrogate-lone-high-p3") == {
    "error": "PASSPHRASE_INVALID_ENCODING"
}

# The boundary really is the boundary.
assert "normalizedUtf8Hex" in _expect_of("raw-len-ascii-512")
assert _expect_of("raw-len-ascii-513") == {"error": "PASSPHRASE_TOO_LONG"}
assert "normalizedUtf8Hex" in _expect_of("raw-len-emoji-128")
assert _expect_of("raw-len-emoji-129") == {"error": "PASSPHRASE_TOO_LONG"}

doc = {
    "$schema": "https://cesvu.com/schemas/passphrase-vectors-1.json",
    "$comment": (
        "GENERATED by shared/generate_passphrase_vectors.py — do not hand-edit. "
        "Contract for .cesvu SPEC/README.md section 'passProfile normalization "
        "(must match exactly)'. Consumed by BOTH the pytest and vitest suites; "
        "a change here is a wire-format change and must be reviewed as one."
    ),
    "version": 1,
    "inputEncoding": (
        "inputUtf16 is a list of UTF-16 CODE UNITS as 4-digit hex. JS: "
        "units.map(u => String.fromCharCode(parseInt(u, 16))).join(''). "
        "Python: decode the little-endian packed units with "
        "errors='surrogatepass'. Do NOT treat these as code points — "
        "['D800','DC00'] is one astral character, not two surrogates."
    ),
    "expectEncoding": (
        "expect.normalizedUtf8Hex is the uppercase hex of the UTF-8 bytes "
        "handed to Argon2id. expect.error is one of PASSPHRASE_INVALID_ENCODING, "
        "PASSPHRASE_TOO_LONG, PASSPHRASE_EMPTY. PASSPHRASE_EMPTY has no "
        "CesvuError code in either implementation — both raise a generic "
        "Error/ValueError — so harnesses assert only that it throws."
    ),
    "rawMaxBytes": RAW_MAX_BYTES,
    "canonicalWhitespace": ["%04X" % cp for cp in CANONICAL_WHITESPACE],
    "divergentWhitespace": ["%04X" % cp for cp in DIVERGENT_WHITESPACE],
    "vectors": VECTORS,
}

out = Path(__file__).with_name("passphrase-vectors.json")
out.write_text(json.dumps(doc, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")
print(f"wrote {out} — {len(VECTORS)} vectors")

by_group = {}
for v in VECTORS:
    by_group[v["group"]] = by_group.get(v["group"], 0) + 1
for g in sorted(by_group):
    print(f"  {g:24} {by_group[g]:4}")
errors = sum(1 for v in VECTORS if "error" in v["expect"])
print(f"  {'(of which expect errors)':24} {errors:4}")
