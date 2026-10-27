"""output_names.py — deciding an output filename from UNTRUSTED metadata.

`CesvuMetadata.filename` is authenticated: it lives inside the AEAD-protected
metadata, so it cannot be tampered with in transit. That is NOT the same as
trustworthy. Authentication proves only that whoever produced the file held the
passphrase, and the producer is exactly the party we are defending against when
a `.cesvu` arrives from someone else. So the embedded name may INFORM the
output path; it may never DECIDE it.

── Why rejection happens BEFORE the rename, not after ────────────────────────
An earlier design verified the result after `os.replace()` and fell back if the
filesystem had done something unexpected. That is not a control, because the
damage is already done. Measured on Windows 11:

    requested        result                 on disk
    'trailing.'      "ok", 4 bytes          'trailing'   (extension silently gone)
    'trailing...'    "ok", 4 bytes          'trailing'   (COLLAPSED onto the same
                                                          entry, destroying the
                                                          previous file)
    'NUL'            "ok", 0 bytes          nothing at all — data discarded

Noticing afterwards that `trailing...` landed on `trailing` does not bring back
the file it overwrote. Verification is therefore diagnostics only (see
`describe_write_discrepancies`), and everything that can refuse must refuse
before the destructive step.

── Why a rejection list, not a sanitizer ─────────────────────────────────────
"Strip anything unusual" was considered and rejected: it destroys the extension
dot, mangles every non-ASCII name, and still would not stop `NUL`. Instead the
policy rejects a narrow set of names with PLATFORM SEMANTICS and preserves
everything else byte-for-byte. Measured, these all save correctly and are
deliberately allowed through untouched:

    '..pdf'  '...pdf'  '.pdf'  'report .txt'  '契約書.pdf'  'Übersicht.docx'

The rules are applied UNCONDITIONALLY, including the Windows-specific ones on
POSIX hosts. A file decrypted on Linux and copied to Windows meets Win32
semantics there, so a CLI that only guarded on Windows would happily produce
names that are hostile somewhere else.

── Threat model (declared, not aspirational) ─────────────────────────────────
This is sized for a local, non-privileged, single-user CLI. Collision detection
uses `os.path.lexists()`, which observes the filesystem's own case-folding and
Unicode normalization but is inherently racy: another process may create the
entry between the check and the rename. That is accepted here and is NOT safe
in a directory writable by hostile users or processes, nor under privileged
execution. Elevation detection is deliberately not attempted — it is a
platform-specific and imperfect proxy for the real risk, which is concurrent
hostile mutation of the destination hierarchy.
"""

from __future__ import annotations

import os
import unicodedata

from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Iterable, Optional

# The Win32 reserved character set, adopted wholesale rather than by
# case-by-case judgement. Note `:` earns its place twice over: it blocks NTFS
# alternate data streams (`report.txt:hidden` writes an invisible stream) AND
# the drive-relative form `C:evil.txt`, which has no separator at all and so
# survives naive basename logic while resolving against the current directory
# of another drive.
WINDOWS_FORBIDDEN_CHARS = frozenset('<>:"/\\|?*')

# NUL plus the C0 control range, kept as their own rule rather than folded into
# the set above. Windows rejects these outright (measured: 'a\tb.txt' fails with
# EINVAL); POSIX permits most of them, which is precisely why they need refusing
# here — a newline or ESC in a filename is a terminal-injection primitive, and
# `\x00` truncates the name in any C API.
_CONTROL_CHARS = frozenset(chr(c) for c in range(0x00, 0x20)) | {chr(0x7F)}

# Win32 device names. These resolve to devices rather than files REGARDLESS of
# extension, so `NUL.txt` is as dangerous as `NUL` and must be matched on the
# stem. Superscript digit forms are included because Win32 folds ¹²³ onto 1/2/3
# during device-name resolution: `COM¹.txt` reaches the device while looking
# like an ordinary text file, which is the exact "succeeds wrongly" shape this
# module exists to stop.
_SUPERSCRIPT_DIGITS = str.maketrans({"\u00b9": "1", "\u00b2": "2", "\u00b3": "3"})
RESERVED_DEVICE_STEMS = frozenset(
    ["CON", "PRN", "AUX", "NUL"]
    + [f"COM{i}" for i in range(1, 10)]
    + [f"LPT{i}" for i in range(1, 10)]
)

# Conservative single-component byte budget. Most filesystems allow 255 bytes
# per component; NTFS counts UTF-16 units instead, so this is a floor rather
# than an exact match for any one filesystem. Measured: a 300-character name
# fails loudly with ENOENT, so this rule converts a crash into a fallback
# rather than preventing a silent problem.
MAX_COMPONENT_BYTES = 255

# How many `name (n).ext` variants to try before giving up. Exhaustion is a
# real answer, not a state to engineer around with timestamps or UUIDs: after
# this many collisions, guessing again is more likely to hit yet another
# existing file than to find a free slot, and the whole point of this module is
# to not overwrite files the user never named.
MAX_CANDIDATE_ATTEMPTS = 100


class UnsafeOutputPath(Exception):
    """A candidate path escaped the intended directory.

    A dedicated type rather than ValueError: the caller catches this around a
    block that also runs decryption and CFP1 parsing, and those raise
    ValueError for their own reasons (malformed JSON, bad lengths). Catching
    ValueError there would report an unrelated bug as a containment violation
    and hide the real error.
    """


class OutputNameExhausted(Exception):

    """No acceptable, non-colliding output name was found.

    Raised BEFORE anything is written, so nothing has been created or
    overwritten. Recovery is trivial and lossless: the `.cesvu` and the
    passphrase are both still in hand, so `-o PATH` reproduces the file
    immediately. This is why aborting here is preferable to falling back to a
    fixed constant — after a bounded search has already failed, a constant is
    the candidate MOST likely to collide, which would turn the "safe fallback"
    into the thing that destroys a file.
    """

    def __init__(self, directory: Path, attempts: int) -> None:
        super().__init__(
            f"could not find an unused output name in {directory} after "
            f"{attempts} attempts; re-run with -o PATH to choose one explicitly"
        )
        self.directory = directory
        self.attempts = attempts


def rejection_reason(name: str) -> Optional[str]:
    """Return a human-readable reason `name` is unusable as a single output
    component, or None if it is acceptable.

    A returned reason means "fall back to a derived name", not "fail the
    decrypt". Refusing to write a file we already decrypted would be a far
    worse outcome than writing it under a different name.
    """
    if not name:
        return "empty"
    if name in (".", ".."):
        return f"reserved name {name!r}"

    # Separators and drive/root syntax. Checked with BOTH flavours of PurePath
    # rather than the host's, so a Windows-shaped name is caught on POSIX and
    # vice versa.
    if "/" in name or "\\" in name:
        return "contains a path separator"
    for flavour in (PureWindowsPath, PurePosixPath):
        pure = flavour(name)
        if pure.drive or pure.root:
            return "is absolute, rooted or drive-qualified"
        # `len(parts) != 1` catches anything that still decomposes, which is
        # the general form of the separator check above.
        if len(pure.parts) != 1:
            return "is not a single path component"

    bad = sorted(set(name) & WINDOWS_FORBIDDEN_CHARS)
    if bad:
        return "contains reserved character(s) " + " ".join(repr(c) for c in bad)
    if set(name) & _CONTROL_CHARS:
        return "contains control characters"

    # Trailing dots/spaces are silently DROPPED by Win32, which is how
    # 'trailing.' becomes 'trailing' and how two distinct names collapse onto
    # one entry and overwrite each other.
    if name[-1] in (".", " "):
        return "ends with a dot or space"

    if _device_stem(name) in RESERVED_DEVICE_STEMS:
        return "is a reserved Windows device name"

    # Must be encodable as strict UTF-8. This is what catches lone surrogates
    # (a real hazard for emoji mangled by a Windows console), which cannot be
    # encoded at all and would otherwise raise deep inside the write.
    #
    # Deliberately does NOT consult sys.getfilesystemencoding(). An earlier
    # version encoded through it as well, which made this rule depend on the
    # ENVIRONMENT rather than on the destination: on Linux that value comes from
    # the locale, so under `LC_ALL=C` without C.UTF-8 coercion — a minimal
    # container, a cron job, a systemd unit with an empty environment — it is
    # 'ascii', and a perfectly storable name like `契約書.pdf` was rejected as
    # unrepresentable and silently renamed. ext4 stores arbitrary bytes, so the
    # rejection was false, and it made the output name vary with environment
    # variables: honored in the user's terminal, renamed under cron. Strict
    # UTF-8 is locale-independent and already covers the surrogate case this
    # check exists for.
    try:
        name.encode("utf-8", errors="strict")
    except UnicodeEncodeError:
        return "cannot be encoded as UTF-8 (contains unpaired surrogates)"


    if len(name.encode("utf-8", errors="surrogatepass")) > MAX_COMPONENT_BYTES:
        return f"is longer than {MAX_COMPONENT_BYTES} bytes"

    return None


def _device_stem(name: str) -> str:
    """The portion Win32 uses for device-name resolution: everything before the
    first dot, with trailing spaces/dots ignored, superscript digits folded,
    upper-cased."""
    stem = name.split(".", 1)[0]
    stem = stem.rstrip(" .")
    return stem.translate(_SUPERSCRIPT_DIGITS).upper()


def is_acceptable_component(name: str) -> bool:
    return rejection_reason(name) is None


def escape_for_display(name: str) -> str:
    """Render a name safely for a terminal.

    Escaping, not stripping — the user needs to see that something odd is
    present, and the escaped form is still recognisable. This is the ONLY
    defence against the bidi/homoglyph class: `a\u202Eb.txt` is stored
    faithfully by the filesystem and passes every post-write check, because the
    target of that attack is the human reading the output, not the disk. Also
    neutralises ANSI escape sequences, which would otherwise let a filename
    repaint the terminal.
    """
    out = []
    for ch in name:
        # Cc = control, Cf = format (bidi overrides/isolates live here),
        # Cs = surrogate, Co = private use, Cn = unassigned.
        if unicodedata.category(ch) in ("Cc", "Cf", "Cs", "Co", "Cn"):
            out.append(f"\\u{ord(ch):04x}")
        else:
            out.append(ch)
    return "".join(out)


def assert_contained(directory: Path, candidate: Path) -> None:
    """Verify `candidate` resolves inside `directory`.

    This is the one check that CANNOT be deferred to post-write verification:
    discovering afterwards that attacker-named bytes landed outside the
    intended directory is not a control, it is a post-mortem. Called again
    immediately before the rename so the window between validation and the
    destructive step is as small as the platform allows.
    """
    parent = os.path.realpath(directory)
    resolved = os.path.realpath(candidate)
    if os.path.dirname(resolved) != parent:
        raise UnsafeOutputPath(
            f"refusing to write outside {directory}: {escape_for_display(str(candidate))}"
        )



def _split_stem_suffix(name: str) -> tuple:
    """Split into (stem, suffix) preserving a leading-dot name intact, so
    '.pdf' and '..pdf' keep their full name and only a real extension is
    treated as one."""
    idx = name.rfind(".")
    if idx > 0:
        return name[:idx], name[idx:]
    return name, ""


def force_text_extension(name: str) -> str:
    """Replace `name`'s extension (if any) with `.txt`.

    Used when the content actually being written is extracted plain text —
    not the original binary file — even though the ORIGINAL file's name
    (and therefore its real extension, e.g. '.pdf'/'.docx'/'.xlsx') is what
    lives in the untrusted metadata. Writing that original name unchanged
    would hand back a file whose extension lies about its own format: an
    OS/associated app opens "contract-final.pdf" expecting real PDF bytes,
    finds plain text instead, and reports it as corrupted -- turning a
    successful, honest decrypt into what looks like data loss.

    Applied only to AUTOMATICALLY chosen output names (see cli.py's
    cmd_decrypt): a name the caller typed explicitly via -o/--output is
    their own literal choice and is left alone, on the theory that
    silently rewriting a path someone typed is a worse surprise than a
    clearly-explained warning.

    Uses the same `_split_stem_suffix` leading-dot-preserving split as
    `candidate_names`, so a leading-dot name like '.pdf' (whose "suffix"
    is actually its whole name) becomes '.pdf.txt' rather than losing its
    name entirely, and a stem with no extension at all
    (e.g. 'README') becomes 'README.txt'.
    """
    stem, _suffix = _split_stem_suffix(name)
    return f"{stem}.txt"


def candidate_names(name: str) -> Iterable[str]:

    """`name`, then `name (1)`, `name (2)`, … keeping any extension last so
    'report.pdf' yields 'report (1).pdf' rather than 'report.pdf (1)'."""
    yield name
    stem, suffix = _split_stem_suffix(name)
    for n in range(1, MAX_CANDIDATE_ATTEMPTS):
        yield f"{stem} ({n}){suffix}"


def find_existing_entry(directory: Path, name: str) -> Optional[str]:
    """The directory entry `name` would collide with, as it ACTUALLY appears on
    disk, or None.

    `lexists()` decides collision because it applies the filesystem's own
    folding — case-insensitivity on NTFS/APFS, NFD normalization on HFS+ — so
    we never have to reimplement those rules and get them subtly wrong.
    Enumeration is used only to recover the real spelling for display, which is
    the part `lexists()` cannot tell us. Best-effort and racy by nature: it
    informs the decision, it does not authorize the write.
    """
    if not os.path.lexists(directory / name):
        return None
    try:
        folded = name.casefold()
        normalized = unicodedata.normalize("NFC", folded)
        for entry in os.listdir(directory):
            if entry == name:
                return entry
            entry_folded = unicodedata.normalize("NFC", entry.casefold())
            if entry_folded == normalized:
                return entry
    except OSError:
        pass
    # lexists() said yes but enumeration could not confirm which entry (or
    # failed). The collision is still real; report the requested spelling.
    return name


def choose_output_name(
    directory: Path,
    preferred: str,
    fallback: str,
    *,
    warn=None,
    never_overwrite: bool = True,
) -> str:
    """Pick a validated single component inside `directory`.

    `preferred` is the untrusted metadata name; `fallback` is the name derived
    from the input file, itself only as trustworthy as whoever named the
    `.cesvu`, so it is validated by the SAME policy rather than assumed safe.

    VALIDATION and OVERWRITE POLICY are separate decisions, and `never_overwrite`
    is what keeps them separate. Every automatically-chosen name must be
    validated — that is not negotiable, because the name reaches a filesystem
    call either way. But "may this replace an existing file?" depends on who
    chose the name:

      * `never_overwrite=True` (metadata-derived): the user has never seen this
        name, so consent to overwrite cannot be inferred from `-y`. Colliding
        names advance to `name (1)`, `name (2)`, … and the substitution is
        reported. Raises OutputNameExhausted if the search runs out.
      * `never_overwrite=False` (derived from the input filename the user typed
        on the command line): return the validated name as-is and let the caller
        apply its own overwrite prompt. Collision is the CALLER's decision here,
        so silently advancing to `report (1)` would be wrong — it would break
        idempotent re-decrypts, and break them quietly, which is the failure
        mode this module exists to avoid.

    Either way, nothing is written or modified before this function returns.
    """

    base = preferred
    reason = rejection_reason(preferred)
    if reason is not None:
        if warn is not None and preferred:
            warn(
                f"ignoring the filename stored in this file "
                f"({escape_for_display(preferred)}): {reason}"
            )
        base = fallback
        # The fallback gets no free pass: it is derived from the on-disk name,
        # which is equally attacker-chosen.
        fallback_reason = rejection_reason(base)
        if fallback_reason is not None:
            raise OutputNameExhausted(directory, 0)

    # Validated, and that is all that was asked for. The caller owns the
    # collision decision (see the docstring), so return before the candidate
    # search rather than silently choosing a different file than the one the
    # caller is about to prompt the user about.
    if not never_overwrite:
        return base

    attempts = 0

    for candidate in candidate_names(base):
        attempts += 1
        # Every generated candidate is re-validated, not just the first. The
        # " (n)" suffix cannot introduce a forbidden character, but it CAN push
        # a name past the byte limit, and a validator that only ran once would
        # miss that.
        if rejection_reason(candidate) is not None:
            continue
        existing = find_existing_entry(directory, candidate)
        if existing is None:
            if candidate != preferred and warn is not None:
                warn(
                    f"writing as {escape_for_display(candidate)} "
                    f"(requested name was unavailable)"
                )
            return candidate
        if warn is not None:
            warn(
                f"{escape_for_display(existing)} already exists; "
                f"not overwriting a name that came from file metadata"
            )
    raise OutputNameExhausted(directory, attempts)


def describe_write_discrepancies(path: Path, expected_size: int) -> list:
    """Compare what is on disk against what we believe we wrote.

    DIAGNOSTICS ONLY. This runs after a successful `os.replace()` and must
    never delete, re-replace or retry anything: at this point `path` most
    likely holds the correctly decrypted file, and "cleaning up" on the basis
    of a cosmetic mismatch would convert a warning into data loss. A non-empty
    result means exit non-zero and claim nothing — not repair.

    Size is checked because it catches the device case (`NUL` accepts writes
    and stores nothing), but it is a weak signal and known to be insufficient
    on its own: an overwritten file may coincidentally match, and a zero-length
    plaintext written to a device gives 0 == 0. The real protection is the
    pre-write policy; this is the second line, not the first.
    """
    problems = []
    try:
        st = os.stat(path, follow_symlinks=False)
    except OSError as err:
        return [f"expected output {escape_for_display(str(path))} is not there: {err}"]

    import stat as _stat

    if not _stat.S_ISREG(st.st_mode):
        problems.append(
            f"{escape_for_display(str(path))} is not a regular file "
            f"(mode {st.st_mode:#o}) — the write may have gone to a device"
        )
    if st.st_size != expected_size:
        problems.append(
            f"{escape_for_display(str(path))} is {st.st_size} bytes but "
            f"{expected_size} were written"
        )

    # Did the filesystem store the name we asked for? This is what catches a
    # trailing-dot rewrite after the fact.
    #
    # Compared under NFC, NOT byte-for-byte. A byte comparison would report
    # every accented filename on macOS as "rewritten", because HFS+/APFS
    # legitimately store `café.pdf` decomposed — turning a completely correct
    # decrypt into a non-zero exit. Normalization is a documented, harmless
    # property of the filesystem; a dropped trailing dot is not, and still
    # fails this check because it changes the characters rather than their
    # composition.
    try:
        entries = os.listdir(path.parent)
    except OSError:
        entries = []
    if entries:
        wanted = unicodedata.normalize("NFC", path.name)
        if not any(unicodedata.normalize("NFC", entry) == wanted for entry in entries):
            problems.append(
                f"requested {escape_for_display(path.name)} but the directory entry "
                f"is not spelled that way — the filesystem rewrote the name"
            )
    return problems


