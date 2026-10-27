"""document.py — CFP1 document framing for the Python CLI.

Mirrors the "document" export path in src/lib/stores/contract-store.svelte.ts
(exportAsCesvu / CFP1 framing) so files produced by `cesvu encrypt` for a
recognized type (.txt / .md / .csv) open directly in the cesvu.com web app's
viewer — with the SAME `text`/`rawContent` shape the browser itself would
have produced for the identical file — instead of falling into the "raw
vault" download-only path (see RawVaultPayloadError in
contract-store.svelte.ts).

Wire format (identical to the TS side — CFP1 framing):
    [0..3]           magic 'CFP1'
    [4..7]           uint32 BE  docJson length
    [8 .. 8+len)     docJson (UTF-8; the CesvuDocument WITHOUT rawContent)
    [8+len .. end)   raw source bytes (implicit length = remainder)

Per-type parity with the browser's own parsers (src/lib/parsers/*.ts) and
Workspace.svelte's export prep (fileText / fileSourceType / rawContentBytes):
  - 'txt': `text` = UTF-8 decoded file, BOM stripped, then .strip() — matches
    parseTXT()'s `.trim()`. No raw section (rawContent is null for txt, same
    as the browser).
  - 'md': `text` = markdown STRIPPED to plain text (see `_strip_markdown`
    below, a line-for-line port of md.ts's stripMarkdown()) — matches
    fileText()'s md branch, which sends parseMD()'s stripped `parsedData`,
    NOT the raw markdown. No raw section (the web app itself currently has
    no path that preserves the original markdown formatting through export
    either, per rawContentBytes()'s `if (f.type === 'txt' || f.type ===
    'md') return null;` — so this matches its current, if imperfect,
    behavior rather than inventing a new one).
  - 'csv': `text` = "" (matches fileText()'s csv/excel branch — "csv/excel
    have no plain-text body"). The RAW CSV BYTES are appended as the CFP1
    raw section (no UTF-8 decoding/validation at all — matches the browser,
    which just carries an ArrayBuffer via rawContentBytes()), so the web
    app's importer reconstructs the SAME `rawContent` it would have gotten
    from an in-browser upload and re-parses it into a workbook via
    parseCsv()/workbookToCsvData() — CLI-encrypted CSVs open as full,
    interactive tables, not a blank/broken viewer.
"""

from __future__ import annotations

import json
import re
import struct
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Iterator, Optional, Tuple



# Keep in lockstep with CESVU_SCHEMA_VERSION in src/lib/schema.ts.
CESVU_SCHEMA_VERSION = 4

# CFP1 payload framing constants — MUST match PAYLOAD_MAGIC /
# PAYLOAD_HEADER_LEN in src/lib/stores/contract-store.svelte.ts exactly.
PAYLOAD_MAGIC = b"CFP1"
PAYLOAD_HEADER_LEN = 8  # magic(4) + uint32 docJsonLen(4)

# Extension -> SourceType for the types this module can auto-frame as a
# document. Anything not in this map is left to the caller's raw/vault
# fallback (see cli.py's cmd_encrypt).
SUPPORTED_EXTENSIONS = {
    ".txt": "txt",
    ".md": "md",
    ".csv": "csv",
}


def detect_document_source_type(path: Path) -> Optional[str]:
    """Return the SourceType ('txt' | 'md' | 'csv') for `path`'s extension,
    or None if this module doesn't support auto-framing that type (the
    caller should fall back to raw/vault encryption unchanged).
    """
    return SUPPORTED_EXTENSIONS.get(path.suffix.lower())


# ── md.ts's stripMarkdown(), ported line-for-line (same regex order) ────────
#
# Each replacement below corresponds 1:1 to a `.replace(...)` call in
# src/lib/parsers/md.ts's stripMarkdown(). Python's `re` uses the same PCRE-ish
# syntax for all of these patterns; the only translation needed is
# `$1`/`$2` -> `\1`/`\2` and JS's `m`/`g` flags -> Python's re.MULTILINE
# (applied via `re.sub(..., flags=re.MULTILINE)` where the source used `/gm`).
def _strip_markdown(md: str) -> str:
    text = md
    # Fenced code blocks → keep content, remove fences
    text = re.sub(r"```[\w]*\n([\s\S]*?)```", r"\1", text)
    # Inline code
    text = re.sub(r"`([^`]+)`", r"\1", text)
    # ATX headings (# ## ### etc.)
    text = re.sub(r"^#{1,6}\s+(.+)$", r"\1", text, flags=re.MULTILINE)
    # Bold + italic ***text***
    text = re.sub(r"\*{3}(.+?)\*{3}", r"\1", text)
    # Bold **text** or __text__
    text = re.sub(r"(\*{2}|_{2})(.+?)\1", r"\2", text)
    # Italic *text* or _text_
    text = re.sub(r"(\*|_)(.+?)\1", r"\2", text)
    # Strikethrough ~~text~~
    text = re.sub(r"~~(.+?)~~", r"\1", text)
    # Images ![alt](url) → alt text
    text = re.sub(r"!\[([^\]]*)\]\([^)]*\)", r"\1", text)
    # Links [text](url) → text
    text = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", text)
    # Reference links [text][ref] → text
    text = re.sub(r"\[([^\]]+)\]\[[^\]]*\]", r"\1", text)
    # Blockquotes
    text = re.sub(r"^>\s?", "", text, flags=re.MULTILINE)
    # Horizontal rules
    text = re.sub(r"^[-*_]{3,}\s*$", "", text, flags=re.MULTILINE)
    # Unordered list markers
    text = re.sub(r"^[ \t]*[-*+]\s+", "", text, flags=re.MULTILINE)
    # Ordered list markers
    text = re.sub(r"^[ \t]*\d+\.\s+", "", text, flags=re.MULTILINE)
    # HTML tags
    text = re.sub(r"<[^>]+>", "", text)
    # Multiple blank lines → single blank line
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def _read_text_stripping_bom(path: Path) -> str:
    """Read `path` as UTF-8 text, stripping a leading BOM if present.

    Raises UnicodeDecodeError if the file isn't valid UTF-8 — callers should
    catch this and fall back to raw/vault encryption instead of failing the
    whole encrypt command, since a non-UTF-8 ".txt"/".md" is still a
    perfectly valid file to hand off via the vault path.
    """
    raw = path.read_bytes()
    if raw.startswith(b"\xef\xbb\xbf"):
        raw = raw[3:]
    return raw.decode("utf-8")  # raises UnicodeDecodeError on non-UTF-8 input


def _build_doc_json(name: str, source_type: str, text: str) -> bytes:
    now_ms = int(time.time() * 1000)
    doc = {
        "id": str(uuid.uuid4()),
        "version": CESVU_SCHEMA_VERSION,
        "name": name,
        "sourceType": source_type,
        "createdAt": now_ms,
        "updatedAt": now_ms,
        "text": text,
        "paragraphs": [],
        "rawContent": None,
        "splits": {"manual": [], "auto": [], "mode": "manual"},
        "profile": None,
        "clauses": [],
        "annotations": [],
        "messages": [],
    }
    # ensure_ascii=False: keep non-ASCII characters (emoji, accented text,
    # etc.) as literal UTF-8 bytes instead of Python's default \uXXXX
    # escaping (which for astral-plane characters like emoji means an
    # escaped UTF-16 surrogate pair). Matches JS's JSON.stringify(), which
    # never escapes non-ASCII — so a Python-CLI-produced document is
    # byte-for-byte consistent with what the browser's exportAsCesvu()
    # would write for identical content, not just semantically equivalent.
    return json.dumps(doc, ensure_ascii=False).encode("utf-8")


def build_cfp1_document_plaintext(path: Path, source_type: str) -> bytes:
    """Build the CFP1-framed plaintext buffer that should be handed to
    encrypt_cesvu_stream/encrypt_cesvu in place of the raw file bytes, for
    `path` detected as `source_type` ('txt' | 'md' | 'csv').

    Raises UnicodeDecodeError for 'txt'/'md' if the file isn't valid UTF-8
    text (see `_read_text_stripping_bom`); 'csv' never raises this, since its
    bytes are carried raw with no decoding, matching the browser's own
    ArrayBuffer-based handling of CSV files.
    """
    if source_type == "csv":
        # Matches Workspace.svelte's fileText() ("csv/excel have no
        # plain-text body") and rawContentBytes() (raw ArrayBuffer, carried
        # as the CFP1 raw section) — the CSV's raw bytes are the ONLY
        # payload the viewer needs; it re-parses them into a workbook via
        # parseCsv()/workbookToCsvData() exactly as an in-browser upload
        # would.
        raw_bytes = path.read_bytes()
        doc_json = _build_doc_json(path.name, source_type, "")
        header = PAYLOAD_MAGIC + struct.pack(">I", len(doc_json))
        return header + doc_json + raw_bytes

    text = _read_text_stripping_bom(path)
    if source_type == "txt":
        # Matches parseTXT()'s `.trim()`.
        text = text.strip()
    elif source_type == "md":
        # Matches fileText()'s md branch, which sends parseMD()'s
        # markdown-STRIPPED parsedData as `text`, not the raw markdown.
        text = _strip_markdown(text)

    doc_json = _build_doc_json(path.name, source_type, text)
    header = PAYLOAD_MAGIC + struct.pack(">I", len(doc_json))
    return header + doc_json


# ── decrypt-side: unwrapping CFP1 framing back to plain content ─────────
#
# This is the symmetric counterpart to build_cfp1_document_plaintext() /
# exportAsCesvu() (the TS side, src/lib/stores/contract-store.svelte.ts),
# used by cli.py's cmd_decrypt so that decrypting ANY CFP1-framed .cesvu
# file — whether produced by this CLI (txt/md/csv only) or by the web app's
# own Export button (all six SourceTypes: txt/md/csv/pdf/docx/excel) —
# writes out just the human content, not the raw CFP1 blob (magic bytes +
# JSON metadata + payload) landing in the output file verbatim.
#
# All 6 real SourceTypes (see src/lib/schema.ts) are recognized here, even
# though build_cfp1_document_plaintext() above only ever PRODUCES
# txt/md/csv — decrypt must still correctly unwrap a pdf/docx/excel file
# that was encrypted by the web app, not just files this CLI itself made.
_VALID_SOURCE_TYPES = frozenset({"txt", "md", "csv", "pdf", "docx", "excel"})
# SourceTypes for which `text` IS the designed, complete representation of
# the content (no raw section ever accompanies it) — see
# build_cfp1_document_plaintext()'s docstring and Workspace.svelte's
# fileText(). Used only to decide whether falling back to `text` (because
# the raw section is empty) counts as an unexpected "fallback" worth
# warning about, or is simply normal/expected.
_TEXT_IS_NATIVE_CONTENT = frozenset({"txt", "md"})


def _looks_like_valid_cfp1_doc(doc: object) -> bool:
    """Structural sanity check applied to the parsed JSON before ANY
    unwrapping happens. This exists so that a raw/vault-encrypted file whose
    plaintext coincidentally starts with the 4 bytes 'CFP1' is never
    misinterpreted as a document — every one of these conditions must hold,
    not just the magic bytes, before we trust the JSON enough to extract
    content from it.
    """
    return (
        isinstance(doc, dict)
        and doc.get("sourceType") in _VALID_SOURCE_TYPES
        and isinstance(doc.get("text"), str)
        and isinstance(doc.get("id"), str)
        and isinstance(doc.get("version"), int)
    )


@dataclass(frozen=True)
class UnrestorableExtras:
    """How much USER-AUTHORED structured data a CFP1 document carries that
    `cesvu decrypt` cannot represent in a plain file on disk.

    Counts, not booleans, so the CLI can tell the user exactly what is in
    the file ("3 notes and 1 marked clause") instead of listing everything
    it *might* contain. A count is checkable against what the user remembers
    doing; a vague "may contain notes" is not, and is indistinguishable from
    a false alarm.

    DERIVED data is deliberately NOT counted here — see
    `count_unrestorable_extras` for why.
    """

    notes: int = 0  # doc["annotations"] — notes the user wrote
    marks: int = 0  # doc["clauses"] — clause highlights the user marked
    messages: int = 0  # doc["messages"] — chat turns
    manual_splits: int = 0  # doc["splits"]["manual"] — hand-placed boundaries

    @property
    def total(self) -> int:
        return self.notes + self.marks + self.messages + self.manual_splits

    def describe(self) -> str:
        """Human phrase naming ONLY the non-zero categories, correctly
        pluralized: "3 notes", "1 marked clause and 2 chat messages", etc.
        Returns "" when nothing is present (callers should check `total`).
        """
        parts: list[str] = []
        for count, singular, plural in (
            (self.notes, "note", "notes"),
            (self.marks, "marked clause", "marked clauses"),
            (self.messages, "chat message", "chat messages"),
            (self.manual_splits, "manual clause split", "manual clause splits"),
        ):
            if count:
                parts.append(f"{count} {singular if count == 1 else plural}")
        if not parts:
            return ""
        if len(parts) == 1:
            return parts[0]
        return ", ".join(parts[:-1]) + " and " + parts[-1]


def _count_list(value: object) -> int:
    """len() of `value` if it's actually a list, else 0.

    Defensive on purpose: this runs at the very END of decrypt, AFTER the
    output file has already been written. A hand-edited or non-conformant
    document whose `annotations` is a string (or null, or an object) must
    not raise here and turn an otherwise-successful decrypt into a crash
    over a cosmetic informational message.
    """
    return len(value) if isinstance(value, list) else 0


def count_unrestorable_extras(doc: dict) -> UnrestorableExtras:
    """Count the user-authored structured data in `doc` that this CLI has no
    viewer for and cannot write into a plain file.

    Counted (all only ever non-empty through deliberate user action):
      - `annotations` — notes the user typed
      - `clauses`     — clause highlights the user marked
      - `messages`    — the user's chat history
      - `splits.manual` — clause boundaries the user placed by hand

    NOT counted, because it is DERIVED rather than authored:
      - `profile` — the built contract analysis. DocumentPane.svelte runs the
        analysis automatically on document open and calls
        `workspace.persistProfile(profile)` on success, so MERELY OPENING a
        document in the web app writes a non-null `profile`. Warning about
        it fired on virtually every web-app-exported file, including ones
        with no user work in them at all. Nothing is lost by ignoring it:
        the profile is recomputed from the text the next time the document
        is opened.
      - `splits.auto` — likewise recomputed by the clause splitter on open.
    """
    splits = doc.get("splits")
    manual_splits = _count_list(splits.get("manual")) if isinstance(splits, dict) else 0
    return UnrestorableExtras(
        notes=_count_list(doc.get("annotations")),
        marks=_count_list(doc.get("clauses")),
        messages=_count_list(doc.get("messages")),
        manual_splits=manual_splits,
    )


# All-zero singleton for the non-document / bail-out return paths.
_NO_EXTRAS = UnrestorableExtras()



def unwrap_cfp1_plaintext(
    chunks: Iterable[bytes],
) -> Tuple[bool, bool, UnrestorableExtras, Iterator[bytes]]:

    """Given `chunks` (the decrypted plaintext of a .cesvu file, as an
    iterable of byte chunks in order), detect whether it's CFP1 document
    framing and, if so, return just the underlying content instead.

    Returns (is_document, is_text_fallback, extras, content_chunks):

      - is_document=True: `content_chunks` yields the unwrapped content.
        Content selection is keyed off whether the CFP1 raw section
        (everything after the doc JSON) actually has bytes, not off
        `sourceType`:
          * raw section non-empty → those raw bytes (the original
            pdf/docx/xlsx/csv file, full fidelity).
          * raw section empty → `doc["text"]` (UTF-8 encoded) instead. This
            is the NORMAL, designed path for 'txt'/'md' (which never carry
            a raw section). For 'csv'/'excel'/'pdf'/'docx', an empty raw
            section means the sender excluded the original file at export
            time (see ExportModal.svelte's "Include the original file"
            checkbox) — `is_text_fallback` is then True, signaling the
            caller to warn that this is extracted text, not the real
            binary file.
      - is_text_fallback=True only when content came from `text` for a type
        that normally carries the original file as a raw section
        ('csv'/'excel'/'pdf'/'docx') and that section was empty. Always
        False for 'txt'/'md' (using `text` there is expected, not a
        fallback) and always False when is_document is False.
      - extras is an UnrestorableExtras COUNTING the user-authored data the
        document carries (notes / marked clauses / chat / manual splits) —
        data this CLI has no viewer for and cannot write into a plain file.
        `extras.total == 0` means there is nothing to tell the user about.
        Purely informational; nothing here is ever written to disk. Derived
        data (`profile`, `splits.auto`) is deliberately excluded — see
        `count_unrestorable_extras`. All-zero when is_document is False.

      - is_document=False: `content_chunks` yields the ORIGINAL bytes,
        completely unchanged (byte-for-byte), for every case where the input
        isn't confidently identifiable as a real CFP1 document — including
        plain raw/vault files, truncated/corrupted CFP1-ish data, and files
        that merely happen to start with the 'CFP1' magic bytes.

    Only the (always small) header + doc JSON is ever buffered in memory,
    plus a single-chunk lookahead used to test whether the raw section is
    empty. The (potentially large) raw section itself streams straight
    through chunk-by-chunk rather than being loaded fully into memory, so
    this stays safe for a large CLI- or web-app-encrypted file; non-document
    files (the common case for large binary raw/vault files) are streamed
    with no extra buffering at all.
    """
    it = iter(chunks)
    buf = bytearray()
    exhausted = False

    def _pull_until(n: int) -> bool:
        nonlocal exhausted
        while len(buf) < n and not exhausted:
            try:
                buf.extend(next(it))
            except StopIteration:
                exhausted = True
        return len(buf) >= n

    def _passthrough() -> Iterator[bytes]:
        if buf:
            yield bytes(buf)
        for chunk in it:
            yield chunk

    if not _pull_until(PAYLOAD_HEADER_LEN) or bytes(buf[:4]) != PAYLOAD_MAGIC:
        return False, False, _NO_EXTRAS, _passthrough()


    (doc_len,) = struct.unpack(">I", bytes(buf[4:8]))
    need = PAYLOAD_HEADER_LEN + doc_len
    if not _pull_until(need):
        # Declared length exceeds the actual plaintext — not a genuine CFP1
        # file (or it's truncated/corrupted). Fail safe: passthrough.
        return False, False, _NO_EXTRAS, _passthrough()


    doc_json_bytes = bytes(buf[PAYLOAD_HEADER_LEN:need])
    try:
        doc = json.loads(doc_json_bytes.decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError):
        return False, False, _NO_EXTRAS, _passthrough()

    if not _looks_like_valid_cfp1_doc(doc):
        return False, False, _NO_EXTRAS, _passthrough()

    source_type = doc["sourceType"]
    extras = count_unrestorable_extras(doc)


    # Determine whether the raw section (everything after the doc JSON) is
    # actually non-empty, using at most a single-chunk lookahead — so a
    # huge non-document raw/vault file is never affected (that path returns
    # long before this point), and a huge CFP1 raw section (e.g. a large
    # web-app-exported xlsx) is never buffered, just peeked one chunk ahead.
    leftover = bytes(buf[need:])
    if not leftover:
        for chunk in it:
            if chunk:
                leftover = chunk
                break
            # an empty chunk from the source iterator contributes nothing;
            # keep looking for the first non-empty one (or exhaustion).

    if leftover:
        # Raw section present: the ORIGINAL file bytes are the content,
        # regardless of sourceType. Stream it through rather than buffering.
        def _raw_content() -> Iterator[bytes]:
            yield leftover
            for chunk in it:
                yield chunk

        return True, False, extras, _raw_content()


    # Raw section empty: fall back to `text`. Expected/native for txt/md;
    # a fallback (worth warning about) for every other type.
    is_fallback = source_type not in _TEXT_IS_NATIVE_CONTENT

    def _text_content() -> Iterator[bytes]:
        yield doc["text"].encode("utf-8")

    return True, is_fallback, extras, _text_content()




