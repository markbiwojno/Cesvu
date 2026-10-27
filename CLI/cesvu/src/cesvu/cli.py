"""cli.py — `cesvu encrypt` / `cesvu decrypt` command-line entry points.

See CLI/CLI commands.txt for the target UX and .cesvu SPEC/README.md for the
wire format. Custom passwords (`-p/--password`) are a Python-CLI-only
feature — the web app never offers them on the encrypt side, but fully
supports decrypting/importing files that use them (passProfile=3). The
preamble is not customizable or displayed anywhere in this CLI — every file
it produces carries the canonical DEFAULT_PREAMBLE, and its content is
skipped as opaque bytes on decrypt (only its declared length matters).
"""

from __future__ import annotations

import argparse
import getpass
import os
import sys
import time
from pathlib import Path
from typing import Optional

from tqdm import tqdm

from . import cesvu_crypto as cc
from . import output_names
from .atomic_io import InsufficientDiskSpaceError, atomic_writer, check_disk_space

from .document import (
    UnrestorableExtras,
    build_cfp1_document_plaintext,
    detect_document_source_type,
    unwrap_cfp1_plaintext,
)


from .passphrase import generate_diceware_passphrase, generate_emoji_passphrase


READ_CHUNK_SIZE = 1 << 20  # 1 MiB read granularity (independent of the
# on-disk secretstream chunk size, which cli.py leaves at the crypto
# module's default).

PASSPHRASE_ENV_VAR = "CESVU_PASSPHRASE"


def _eprint(*args, **kwargs) -> None:
    print(*args, file=sys.stderr, **kwargs)


def _configure_utf8_output() -> None:
    """Make stdout/stderr UTF-8 so emoji print through the NORMAL text layer.

    This is the primary fix for the raw-byte fallback in _safe_print below.
    Without it, on a default Windows console `sys.stdout.encoding` is a
    legacy code page (cp1252), `print()` of an emoji raises
    UnicodeEncodeError, and we drop to writing UTF-8 bytes straight at the
    underlying binary buffer. That "works" only in the sense that the
    glyphs appear:

      - The console still interprets those bytes under the legacy code
        page, so an 8-emoji passphrase sends 32 bytes where 16 display
        cells were expected and the cursor over-advances by 16 columns.
        That is the large gap printed after an emoji passphrase.
      - Writing at `.buffer` bypasses the buffered text layer, so the
        passphrase line can be flushed AHEAD of output printed before it
        (visibly wrong when stdout is redirected to a file).

    Reconfiguring the text layer to UTF-8 means `print()` simply succeeds
    and neither problem can arise. Best-effort: `reconfigure` needs
    Python 3.7+ and a real TextIOWrapper, and pytest's capture objects
    (and some embedded hosts) provide neither, so failures are ignored --
    _safe_print remains as the backstop.
    """
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is None:
            continue
        try:
            reconfigure(encoding="utf-8", errors="replace")
        except (ValueError, OSError, AttributeError, TypeError):
            pass

    # Tell the Windows console to INTERPRET those bytes as UTF-8 too.
    # Reconfiguring Python's side alone fixes what we emit; this fixes how
    # the console counts columns, which is what actually removes the gap.
    # Purely best-effort.
    #
    # "Is a console attached?" is tested via GetConsoleOutputCP() returning
    # non-zero, NOT via GetConsoleWindow() != 0. An earlier version used the
    # latter and was thereby a silent no-op on every modern terminal:
    # GetConsoleWindow() returns a WINDOW handle, and a ConPTY pseudoconsole
    # -- what Windows Terminal, VS Code's integrated terminal and any SSH
    # session use -- has no window, so it returns 0 even though a perfectly
    # functional console IS attached. Measured directly on this machine:
    # GetConsoleWindow() -> 0 while GetConsoleOutputCP() -> 437 and
    # SetConsoleOutputCP(65001) -> success. GetConsoleOutputCP() returns 0
    # only when there is genuinely no console (a service, a detached
    # process, a pipe-only parent), which is exactly the condition we want
    # to skip on.
    #
    # RESTORED ON EXIT, deliberately.
    #
    # The console code page is a property of the CONSOLE, not of this
    # process: it outlives us, so without an atexit hook `cesvu` would
    # permanently mutate the user's shell for every later command in that
    # window. Changing global state we don't own and not putting it back is
    # the kind of side effect that surfaces months later as a baffling bug
    # in an unrelated program, so we restore it.
    #
    # Known cost, accepted: emoji the user TYPES or PASTES at the prompt
    # after we exit are rendered by the shell under the restored (legacy)
    # code page, so on a default cp437 PowerShell console they may still
    # show as boxes with mis-measured widths. That is the shell's own input
    # rendering, which we could only "fix" by leaving the console modified
    # behind us. Users who want emoji to render at the prompt should run
    # `chcp 65001` themselves, or use Windows Terminal -- both are durable
    # session-level choices, which is the right level for this, rather than
    # something a single command silently imposes.
    #
    # Only registered when we actually changed the code page, and restores
    # exactly the value we found.
    if sys.platform == "win32":
        try:
            import atexit
            import ctypes

            kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
            previous_cp = kernel32.GetConsoleOutputCP()
            if previous_cp and previous_cp != 65001:
                if kernel32.SetConsoleOutputCP(65001):
                    atexit.register(kernel32.SetConsoleOutputCP, previous_cp)
        except Exception:
            pass


def _safe_print(text: str, stream=None) -> None:
    """Print `text`, tolerating a stdout/stderr stream whose encoding can't
    represent it (e.g. Windows consoles defaulting to cp1252, which can't
    encode emoji). Falls back to writing UTF-8 bytes directly to the
    stream's underlying buffer so the text is never silently lost or
    mangled, and the process never crashes just because it's printing an
    emoji passphrase.

    NOTE: _configure_utf8_output() should make the fallback unreachable in
    normal CLI use. It is kept as a backstop for hosts where reconfigure()
    is unavailable.
    """
    stream = stream or sys.stdout
    try:
        print(text, file=stream)
    except UnicodeEncodeError:
        buffer = getattr(stream, "buffer", None)
        if buffer is not None:
            # ORDERING: flush the text layer FIRST. Writing at `.buffer`
            # skips the TextIOWrapper's own buffer, so without this any
            # pending `print()` output would surface AFTER this line even
            # though it was emitted before it.
            try:
                stream.flush()
            except (ValueError, OSError):
                pass
            buffer.write(text.encode("utf-8") + b"\n")
            buffer.flush()
        else:
            # Last resort: no binary buffer to fall back to, so the text
            # must be made encodable in ANY byte-oriented codec -> plain
            # ASCII. Note the previous formulation here,
            #   text.encode("utf-8", "replace").decode("ascii", "replace")
            # did NOT achieve that: decoding UTF-8 bytes as ASCII yields
            # U+FFFD REPLACEMENT CHARACTERs, which cp1252 cannot encode
            # either, so this branch still raised UnicodeEncodeError --
            # exactly the crash the function exists to prevent.
            # `backslashreplace` is pure ASCII by construction and, unlike
            # "?", keeps the passphrase recoverable (\U0001f50d etc.).
            print(text.encode("ascii", errors="backslashreplace").decode("ascii"), file=stream)



def _read_file_chunks(path: Path, total_size: int, quiet: bool, desc: str):
    with open(path, "rb") as f, tqdm(
        total=total_size, unit="B", unit_scale=True, desc=desc, disable=quiet
    ) as bar:
        while True:
            chunk = f.read(READ_CHUNK_SIZE)
            if not chunk:
                return
            bar.update(len(chunk))
            yield chunk


# NOTE: `_safe_basename()` used to live here and has been DELETED, not moved.
# It reduced an untrusted `CesvuMetadata.filename` to its last path segment,
# which is a weaker policy than the one that replaced it in two ways: it
# salvaged the basename out of a name that had already proven hostile (so
# `../../etc/passwd` still got written, as `passwd`), and it had no notion of
# Win32 device names, trailing dots, reserved characters or collisions. It is
# removed rather than kept unused because a superseded sanitizer sitting in the
# file is what a future edit reaches for. All output-name decisions now go
# through output_names.choose_output_name(); see output_names.py for the policy
# and README.md, "`metadata.filename` is AUTHENTICATED, not TRUSTED".



def _confirm_overwrite(path: Path, assume_yes: bool) -> None:


    if assume_yes or not path.exists():
        return
    answer = input(f"cesvu: {path} already exists. Overwrite? [y/N] ").strip().lower()
    if answer not in ("y", "yes"):
        raise SystemExit("cesvu: aborted (not overwriting existing file)")


def _read_passphrase_file(path: str) -> str:
    """Read a passphrase/password from a file as UTF-8 text.

    This exists because typing or pasting an emoji passphrase directly into
    a terminal (especially Windows' `cmd.exe`/`PowerShell` consoles) can
    silently mangle astral-plane characters (emoji live outside the Basic
    Multilingual Plane and are represented as UTF-16 surrogate pairs) into
    unpaired/lone surrogate code points — which are structurally invalid
    Unicode and can never be UTF-8 encoded. Reading the exact same
    characters from a file saved as UTF-8 text (e.g. from a text editor,
    or wherever the emoji were originally copied from) sidesteps the
    console entirely and avoids that corruption.
    """
    p = Path(path)
    if not p.is_file():
        raise SystemExit(f"cesvu: --password-file {path!r} is not a file")
    raw = p.read_bytes()
    # Strip a UTF-8 BOM if present (common when saved from Notepad).
    if raw.startswith(b"\xef\xbb\xbf"):
        raw = raw[3:]
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as err:
        raise SystemExit(f"cesvu: --password-file {path!r} is not valid UTF-8: {err}")
    # Trim exactly one trailing newline (LF or CRLF) — a common artifact of
    # saving a passphrase with a text editor — but preserve everything else
    # (including internal whitespace) exactly.
    if text.endswith("\r\n"):
        text = text[:-2]
    elif text.endswith("\n"):
        text = text[:-1]
    return text


def _validate_utf8_encodable(passphrase: str, source: str) -> None:
    """Fail with a clear, actionable error instead of a raw traceback when a
    passphrase contains lone/unpaired UTF-16 surrogate code points — the
    telltale sign of console-level Unicode corruption (see
    `_read_passphrase_file`'s docstring). Without this check, the failure
    would otherwise surface deep inside libsodium/Argon2id as an opaque
    `UnicodeEncodeError`.
    """
    try:
        passphrase.encode("utf-8")
    except UnicodeEncodeError:
        raise SystemExit(
            f"cesvu: the passphrase from {source} contains invalid/corrupted characters "
            "(likely emoji mangled by the terminal — this is common on Windows consoles "
            "when typing or pasting emoji directly). Save the passphrase as a UTF-8 text "
            "file and pass it with --password-file instead of -p or the interactive prompt."
        )



# ── encrypt ─────────────────────────────────────────────────────────────


def cmd_encrypt(args: argparse.Namespace) -> int:

    input_path = Path(args.file)
    if not input_path.is_file():
        _eprint(f"cesvu: {input_path}: no such file")
        return 1

    # Strip the original extension before appending ".cesvu" (default
    # naming only — -o/--output always overrides this). The outer filename
    # is unencrypted and unauthenticated: anyone who merely sees it sitting
    # in a downloads folder, inbox, or shared drive can read it, so keeping
    # the original extension (e.g. "quarterly-report.pdf.cesvu") leaks the
    # file type even though the passphrase-protected contents never do.
    # `Path.stem` strips exactly one suffix, matching the same "strip one
    # extension, keep the base name" behavior as the web app's
    # ExportModal.svelte and vault-io.ts (see cesvu-filename.ts).
    output_path = Path(args.output) if args.output else input_path.with_name(input_path.stem + ".cesvu")
    _confirm_overwrite(output_path, args.yes)


    generated_type: Optional[str] = None
    if args.diceware:
        passphrase = generate_diceware_passphrase()
        passphrase_type = "text"
        generated_type = "diceware"
    elif args.emoji:
        passphrase = generate_emoji_passphrase()
        passphrase_type = "emoji"
        generated_type = "emoji"
    elif args.password_file is not None:
        passphrase = _read_passphrase_file(args.password_file)
        passphrase_type = "raw"
    elif args.password is not None:
        passphrase = args.password
        passphrase_type = "raw"
    elif os.environ.get(PASSPHRASE_ENV_VAR):
        passphrase = os.environ[PASSPHRASE_ENV_VAR]
        passphrase_type = "raw"
    else:
        passphrase = getpass.getpass("Passphrase: ")
        confirm = getpass.getpass("Confirm passphrase: ")
        if passphrase != confirm:
            _eprint("cesvu: passphrases did not match")
            return 1
        passphrase_type = "raw"

    if len(passphrase) == 0:
        _eprint("cesvu: passphrase is empty")
        return 1
    _validate_utf8_encodable(
        passphrase, "--password-file" if args.password_file is not None else "-p/prompt/env var"
    )


    total_size = input_path.stat().st_size
    try:
        check_disk_space(output_path, total_size)
    except InsufficientDiskSpaceError as err:
        _eprint(f"cesvu: {err}")
        return 1

    # ── Document (CFP1) vs. raw/vault framing ────────────────────────────
    # By default, a recognized plain-text extension (.txt/.md/.csv) is
    # wrapped in the same CFP1 document framing the web app's own Export
    # button produces, so the file opens directly in cesvu.com's viewer on
    # import instead of falling into the "raw vault" download-only path
    # (see RawVaultPayloadError in contract-store.svelte.ts). Pass
    # `--download` to force the old raw/vault behavior (recipient always
    # gets a plain download) even for a recognized type. Unsupported types
    # (pdf/docx/xlsx/images/zips/etc.) always use raw/vault framing — this
    # flag is a no-op for them since there is nothing to opt out of.
    document_plaintext: Optional[bytes] = None
    source_type = None if args.download else detect_document_source_type(input_path)
    if source_type is not None:
        try:
            document_plaintext = build_cfp1_document_plaintext(input_path, source_type)
        except UnicodeDecodeError:
            # Not valid UTF-8 text despite the extension — fall back to
            # raw/vault framing rather than failing the whole command.
            document_plaintext = None

    if document_plaintext is not None:
        metadata = cc.CesvuMetadata(
            filename=input_path.name,
            mimeType="application/json",
            createdAt=int(time.time() * 1000),
        )

        def _document_chunks():
            yield document_plaintext

        source_chunks = _document_chunks()
    else:
        metadata = cc.CesvuMetadata(
            filename=input_path.name,
            mimeType="application/octet-stream",
            createdAt=int(time.time() * 1000),
        )
        source_chunks = _read_file_chunks(input_path, total_size, args.quiet, desc="Encrypting")


    try:
        with atomic_writer(output_path) as write:
            for out_chunk in cc.encrypt_cesvu_stream(
                source_chunks, passphrase, metadata, passphrase_type=passphrase_type
            ):
                write(out_chunk)
    except cc.CesvuError as err:
        _eprint(f"cesvu: encrypt failed [{err.code}]: {err}")
        return 1
    except OSError as err:
        _eprint(f"cesvu: encrypt failed: {err}")
        return 1

    if not args.quiet:
        print(f"Wrote {output_path}")
        if document_plaintext is not None:
            print(f"Encrypted as a document (sourceType={source_type!r}) — opens in the cesvu.com viewer.")
        if generated_type == "diceware":
            _safe_print(f"Diceware Passphrase: {passphrase}")
        elif generated_type == "emoji":
            _safe_print(f"Emoji Passphrase: {passphrase}")


    return 0



# ── decrypt ─────────────────────────────────────────────────────────────


# Where a passphrase came from. This decides WHICH advice is useful after a
# failed decrypt, not whether to give any (see _raw_passphrase_advice).
SOURCE_PROMPT = "prompt"
SOURCE_ARG = "password-arg"
SOURCE_ENV = "env"
SOURCE_FILE = "password-file"


# The one property that makes profile 3 unlike every other profile, and the
# reason the rest of this advice exists. Stated first because it is
# unconditionally true: it describes the FORMAT, so it cannot be wrong no
# matter why the decrypt failed.
RAW_EXACT_USE_NOTE = (
    "note: this file uses a custom password (passProfile 3), which is used EXACTLY as "
    "provided -- no trimming, no normalization, no case folding. A leading or trailing "
    "space, an invisible character, or an accent composed differently (macOS may produce "
    '"e" + a combining accent where Windows produces one precomposed character) is '
    "therefore a DIFFERENT password, with nothing on screen to show it."
)

# For every source that passed through a shell or a console.
RAW_SHELL_ADVICE = (
    "hint: prefer not to pass a custom password through a shell. cmd.exe expands %VAR% "
    "inside arguments, PowerShell reapplies its own quoting rules, an unquoted argument "
    "loses leading and trailing spaces, and the interactive prompt on Windows reads input "
    "one UTF-16 code unit at a time -- which splits emoji into unusable halves. Saving the "
    "exact password to a UTF-8 text file and passing --password-file avoids all of these."
)

# Correctness aside, -p is the one source that PUBLISHES the password.
RAW_ARG_VISIBILITY_NOTE = (
    "note: -p/--password also leaves the password in your shell history and in this "
    "process's command line, where other users and processes on this machine can read it."
)

# "Use --password-file" is useless advice to someone already using it. Point
# at what can still be wrong inside a file instead.
RAW_FILE_ADVICE = (
    "hint: --password-file strips a UTF-8 BOM and ONE trailing newline, but nothing else. "
    "A second trailing newline, a trailing space, or a CRLF inside the text is part of the "
    "password."
)

# CESVU_PASSPHRASE has its own exposure surface, distinct from -p's shell
# history/process-list visibility: any process running as the same or root
# user can read another process's environment (e.g. /proc/<pid>/environ on
# Linux), many CI/CD systems (GitHub Actions, GitLab CI, Jenkins) echo env
# vars into build logs unless explicitly masked, and child processes inherit
# the full parent environment by default -- unlike a scoped -p argument, a
# passphrase set via CESVU_PASSPHRASE is silently visible to every
# subprocess spawned afterward in the same shell session.
RAW_ENV_ADVICE = (
    "note: CESVU_PASSPHRASE also has its own exposure surface: any process running as the "
    "same or root user can read another process's environment (e.g. /proc/<pid>/environ on "
    "Linux), many CI/CD systems echo environment variables into build logs unless explicitly "
    "masked as a secret, and child processes inherit the full environment -- so a passphrase "
    "set this way is visible to every subprocess spawned afterward in the same session, not "
    "just to cesvu."
)



# Reuse the crypto module's explicit 30-code-point table rather than
# str.isspace()/str.strip(), whose notions of whitespace both differ from the
# format's (str.strip() does not strip U+FEFF, which the table includes).
# Accepts ints or 1-character strs so this cannot silently degrade to an
# empty set if the table's representation ever changes.
_EDGE_WHITESPACE = frozenset(
    ch if isinstance(ch, str) else chr(ch) for ch in cc.CANONICAL_WHITESPACE
)


def _describe_edge_whitespace(passphrase: str) -> Optional[str]:
    """Report leading/trailing whitespace in the password actually received.

    An OBSERVATION, not a guess: a checkable fact about the input, invisible
    by every other means, and decisive against a profile-3 file because
    nothing trims it. It is also the likeliest way a shell-supplied password
    differs from the one the user believes they gave.

    Names the code point, since U+0020, U+00A0 and U+FEFF are
    indistinguishable on screen, but never echoes the password itself --
    that would put a secret into terminal scrollback and any redirected log.
    """
    if not passphrase:
        return None
    leading = passphrase[0] if passphrase[0] in _EDGE_WHITESPACE else None
    trailing = passphrase[-1] if passphrase[-1] in _EDGE_WHITESPACE else None
    if leading is None and trailing is None:
        return None

    if leading is not None and trailing is not None:
        where = (
            f"begins with whitespace (U+{ord(leading):04X}) and ends with whitespace "
            f"(U+{ord(trailing):04X})"
        )
    elif leading is not None:
        where = f"begins with whitespace (U+{ord(leading):04X})"
    else:
        where = f"ends with whitespace (U+{ord(str(trailing)):04X})"

    return (
        f"note: the password this program received {where}. For this file that is part of "
        "the password -- if you did not intend it, remove it and try again."
    )


def _raw_passphrase_advice(code: str, pass_profile: int, passphrase: str, source: str) -> list:
    """Advice lines to print after a failed decrypt, or [] for none.

    Gated on exactly two things: the wrong-passphrase code, and profile 3.
    Deliberately NO inspection of the characters to decide WHETHER to speak.

    An earlier version tried to detect corruption (non-ASCII, '?', shell
    metacharacters) and spoke only when it believed it had found some. That
    approach is unfixable: every such test is a guess, and a wrong guess
    tells a user who merely mistyped that their terminal is broken. The way
    out is not a better heuristic but different CONTENT -- these lines
    describe a property of the format and of the input path, so they are
    accurate whether the password was altered or simply wrong, and none of
    them accuses the terminal of having done anything.

    Profile 3 only: profiles 1 and 2 normalize whitespace and variation
    selectors away, so RAW_EXACT_USE_NOTE would be a lie for them.
    """
    if code != "WRONG_PASSPHRASE_OR_HEADER_TAMPER":
        return []
    if pass_profile != cc.PASS_PROFILE_RAW:
        return []

    lines = [RAW_EXACT_USE_NOTE]

    observation = _describe_edge_whitespace(passphrase)
    if observation is not None:
        lines.append(observation)

    if source == SOURCE_FILE:
        lines.append(RAW_FILE_ADVICE)
    elif source == SOURCE_ENV:
        lines.append(RAW_ENV_ADVICE)
    else:
        lines.append(RAW_SHELL_ADVICE)
        if source == SOURCE_ARG:
            lines.append(RAW_ARG_VISIBILITY_NOTE)

    return lines



def cmd_decrypt(args: argparse.Namespace) -> int:
    input_path = Path(args.file)
    if not input_path.is_file():
        _eprint(f"cesvu: {input_path}: no such file")
        return 1

    # Peek the header first (cheap — no passphrase, no Argon2id) so we know
    # the file is well-formed and can select the right passphrase prompt
    # (e.g. emoji vs. diceware) before asking the user for anything.
    with open(input_path, "rb") as f:
        head = f.read(cc.FIXED_PREFIX + cc.MAX_PREAMBLE_LEN + cc.POST_PREAMBLE_FIXED)
    try:
        parsed_head = cc.parse_header(head)
    except cc.CesvuError as err:
        _eprint(f"cesvu: not a valid .cesvu file [{err.code}]: {err}")
        return 1

    is_emoji_file = parsed_head.pass_profile == cc.PASS_PROFILE_EMOJI
    # The console-corruption issue this all works around (see
    # _read_passphrase_file's docstring) is, in practice, essentially a
    # Windows-only problem: cmd.exe/PowerShell default to a legacy
    # non-UTF-8 code page, whereas Linux/macOS terminals are overwhelmingly
    # UTF-8 by default. So we only force the --password-file-style prompt
    # (and disallow -p) for emoji-profile files on Windows. Elsewhere, -p
    # and the normal getpass prompt are allowed as usual; the
    # _validate_utf8_encodable() check below still catches and reports any
    # corruption that manages to happen anyway (e.g. a `LANG=C` locale).
    is_windows = sys.platform == "win32"

    # Kept as a hard block, deliberately, though NOT for the reason an
    # earlier version of this message gave. Measured on this machine: an
    # emoji passed via -p arrives byte-perfect, because Python builds
    # sys.argv from GetCommandLineW (a wide API) -- code points 1F3AF/1F44B/
    # 2649+FE0F/1F628/1F3B5 all survived intact, no lone surrogates. So argv
    # does NOT corrupt characters and claiming it does would be false.
    #
    # It stands on two other grounds:
    #   1. -p PUBLISHES the passphrase -- shell history plus this process's
    #      command line, readable by other users and processes (tasklist,
    #      WMI, /proc). For a shared emoji passphrase that is a real leak.
    #   2. argv construction being lossless does not make every route TO
    #      that command line lossless (clipboard handlers, older conhost
    #      paste, non-standard shells).
    # Emoji-profile passphrases come from a fixed generator and
    # --password-file always works, so refusing costs the user very little.
    if is_emoji_file and is_windows and args.password is not None:
        _eprint(
            "cesvu: this file requires an emoji passphrase. -p/--password is disallowed for "
            "emoji-profile files on Windows: it would leave the passphrase in your shell "
            "history and in this process's command line, where other users and processes can "
            "read it. Save the passphrase to a UTF-8 text file and use --password-file instead."
        )
        return 1

    # Which input path the passphrase took. Used only to pick the most
    # useful advice if the decrypt fails (see _raw_passphrase_advice) --
    # recommending --password-file to someone already using it, or warning
    # about shell rewriting for a passphrase that never touched a shell,
    # would both be noise.
    passphrase_source = SOURCE_PROMPT

    if args.password_file is not None:
        passphrase = _read_passphrase_file(args.password_file)
        passphrase_source = SOURCE_FILE
    elif args.password is not None:
        passphrase = args.password
        passphrase_source = SOURCE_ARG
    elif os.environ.get(PASSPHRASE_ENV_VAR):
        passphrase = os.environ[PASSPHRASE_ENV_VAR]
        passphrase_source = SOURCE_ENV
    elif is_emoji_file and is_windows:
        print("This file requires an emoji passphrase.")
        print(
            "Typing or pasting emoji directly into a terminal can silently corrupt them, "
            "so please save the emoji passphrase into a UTF-8 text file first."
        )
        path = input("Path to the passphrase file: ").strip()
        passphrase = _read_passphrase_file(path)
        passphrase_source = SOURCE_FILE
    else:
        passphrase = getpass.getpass("Passphrase: ")
        passphrase_source = SOURCE_PROMPT


    if len(passphrase) == 0:
        _eprint("cesvu: passphrase is empty")
        return 1
    _validate_utf8_encodable(
        passphrase, "--password-file" if args.password_file is not None else "-p/prompt/env var"
    )

    # Fallback output name, used only when -o/--output isn't given AND the
    # embedded metadata filename (see below) turns out to be missing/empty
    # — just strips a literal ".cesvu" suffix off whatever the ENCRYPTED
    # file happens to be named on disk, which is often NOT the original
    # file's name/extension (e.g. a .cesvu downloaded under a generic name,
    # or the web app's ExportModal, which deliberately names every download
    # "cesvu-document.cesvu" so the outer filename never leaks the real
    # document name before decryption).
    explicit_output = args.output is not None
    fallback_name = args.file[: -len(".cesvu")] if args.file.endswith(".cesvu") else args.file + ".out"
    output_path = Path(args.output) if explicit_output else Path(fallback_name)

    total_size = input_path.stat().st_size

    try:
        check_disk_space(output_path, total_size)
    except InsufficientDiskSpaceError as err:
        _eprint(f"cesvu: {err}")
        return 1

    def file_chunks():
        yield from _read_file_chunks(input_path, total_size, args.quiet, desc="Decrypting")

    is_document = False
    is_text_fallback = False
    extras = UnrestorableExtras()
    # Two DIFFERENT questions, deliberately tracked separately — conflating
    # them is what let the bypass below exist in the first place:
    #
    #   automatic_output — was this path chosen by us rather than typed by the
    #       user? If so it must be validated and contained, regardless of which
    #       string it was derived from.
    #   metadata_derived — did the name come from the file's encrypted metadata,
    #       i.e. from a name the user has never laid eyes on? Only this one
    #       decides that `-y` cannot authorize an overwrite.
    #
    # The fallback name is automatic but NOT metadata-derived: the user typed
    # the input filename it is derived from, so `-y` keeps its ordinary meaning
    # for it, while it still gets the full name policy applied.
    automatic_output = False
    metadata_derived = False

    # Counted as we stream so the post-write check has something concrete to
    # compare against. `output_path.stat().st_size` alone proves nothing.
    written_bytes = 0


    try:
        plaintext_iter, header_info = cc.decrypt_cesvu_stream_full(file_chunks(), passphrase)
        # Files encrypted via the "document" path — either this CLI's own
        # build_cfp1_document_plaintext (.txt/.md/.csv) or the web app's own
        # Export button (any of the 6 SourceTypes: txt/md/csv/pdf/docx/excel)
        # — decrypt to a CFP1 envelope (magic bytes + JSON metadata +
        # optional raw section), not the original human-readable/binary
        # content. unwrap_cfp1_plaintext() detects that envelope (with
        # strict structural validation, so a raw/vault file that merely
        # happens to start with the same 4 magic bytes is never
        # misinterpreted) and yields just the underlying content instead —
        # everything else (raw/vault files, --download-forced files) passes
        # through byte-for-byte unchanged.
        is_document, is_text_fallback, extras, content_chunks = unwrap_cfp1_plaintext(
            plaintext_iter
        )

        # By this point unwrap_cfp1_plaintext() has already pulled at
        # least the first byte(s) out of `plaintext_iter` (needed for its
        # own CFP1-magic/header check) — and since
        # decrypt_cesvu_stream_full's generator always fully parses and
        # strips the metadata prefix before it can yield ANY plaintext (or
        # raise), `header_info['metadata']` is now guaranteed to be
        # populated. Unless the caller passed -o/--output explicitly,
        # prefer the REAL original filename (and therefore its real
        # extension — e.g. ".xlsx"/".pdf"/".docx") embedded in that
        # authenticated metadata over the naive "strip .cesvu off the
        # on-disk name" fallback: the on-disk name of a shared .cesvu very
        # often doesn't match the original file at all (renamed downloads,
        # the web app's deliberately-generic "cesvu-document.cesvu", a
        # forwarded email attachment, etc.) — the embedded filename does.
        # An embedded name is an UNTRUSTED suggestion. See output_names.py for
        # why it is validated here, BEFORE the rename, rather than checked
        # afterwards: the destructive step cannot be un-done, and measured
        # Windows behaviour includes names that "succeed" while silently
        # overwriting a different file or discarding the data entirely.
        # NOTE the absence of an `if embedded_name:` guard around this block.
        # There used to be one, and it was a hole: when the metadata carried no
        # filename, `output_path` kept its initial value and BOTH
        # rejection_reason() and assert_contained() were skipped entirely, so
        # the one name that reached the filesystem completely unchecked was the
        # fallback — the very name choose_output_name()'s own docstring says is
        # "only as trustworthy as whoever named the `.cesvu`". An empty
        # metadata filename is trivially attacker-arranged, so the guard made
        # the hardening opt-out at the attacker's discretion. Every automatic
        # name now goes through the same policy; `choose_output_name` already
        # treats an empty `preferred` as a rejection and falls through to the
        # fallback, so no special case is needed here.
        if not explicit_output:
            embedded_meta = header_info.get("metadata")
            embedded_name = embedded_meta.filename if embedded_meta else ""
            metadata_derived = bool(embedded_name)
            preferred_name = embedded_name
            fallback_basename = Path(fallback_name).name
            # A text-fallback document (see unwrap_cfp1_plaintext) writes
            # EXTRACTED TEXT, not the original binary file — even though
            # `embedded_name` is still the ORIGINAL file's name (e.g.
            # "contract-final.pdf"). Only rewriting the extension for an
            # AUTOMATICALLY chosen name (this branch, guarded by
            # `not explicit_output`): `-o path.pdf` is the user's own literal
            # choice and is left alone below, with just the warning.
            # Applied before choose_output_name so the candidate-collision
            # search (`name (1).txt`, `name (2).txt`, …) and the
            # already-.txt fallback both operate on the corrected name from
            # the start, rather than something needing to be patched
            # afterwards.
            if is_text_fallback:
                if preferred_name:
                    preferred_name = output_names.force_text_extension(preferred_name)
                fallback_basename = output_names.force_text_extension(fallback_basename)
            # Same DIRECTORY as the input .cesvu file (not the process's
            # current working directory) — matches the fallback naming's
            # behavior of writing alongside the input file. Passing
            # `Path(fallback_name).name` keeps that equivalence exact:
            # fallback_name retains the input's directory components, so
            # `input_path.parent / basename` resolves to the same place the
            # unhardened path used to write to.
            chosen = output_names.choose_output_name(
                input_path.parent,
                preferred_name,
                fallback_basename,
                warn=lambda message: _eprint(f"cesvu: {message}"),
                # Only a metadata name gets the never-overwrite treatment. The
                # fallback is derived from the filename the user typed, so `-y`
                # keeps its ordinary meaning for it and _confirm_overwrite
                # below stays in charge — silently writing `report (1)` instead
                # would break idempotent re-decrypts, and break them quietly.
                never_overwrite=metadata_derived,
            )
            output_path = input_path.parent / chosen
            automatic_output = True


        # Containment is asserted for every AUTOMATIC name, not just the
        # metadata-derived one, and as late as possible. `-o` is a path the USER
        # typed, so it is authorized by definition and only gets operational
        # validation (its parent is created by atomic_writer, and a directory
        # target fails loudly there).
        if automatic_output:
            output_names.assert_contained(input_path.parent, output_path)
        if not metadata_derived:
            # `-y` remains a genuine "yes, overwrite" here, because this name
            # came from the user — either typed as `-o` or derived from the
            # input filename they typed. It deliberately does NOT carry that
            # meaning for a metadata-derived name, which never overwrites at all.
            _confirm_overwrite(output_path, args.yes)


        with atomic_writer(output_path) as write:
            for chunk in content_chunks:
                written_bytes += len(chunk)
                write(chunk)

    except cc.CesvuError as err:
        _eprint(f"cesvu: decrypt failed [{err.code}]: {err}")
        for line in _raw_passphrase_advice(
            err.code, parsed_head.pass_profile, passphrase, passphrase_source
        ):
            _eprint(f"cesvu: {line}")
        return 1
    except output_names.OutputNameExhausted as err:
        # Deliberately an ABORT, not a fall back to a fixed constant. Nothing
        # has been created or overwritten at this point, and nothing is lost:
        # the .cesvu and the passphrase are both still in hand, so `-o PATH`
        # recovers the file immediately. After a bounded search has already
        # failed, a constant name is the candidate MOST likely to collide,
        # which would make the "safe fallback" the thing that destroys a file.
        _eprint(f"cesvu: {err}")
        _eprint("cesvu: nothing was written; the destination directory is unchanged.")
        return 1
    except output_names.UnsafeOutputPath as err:
        # Containment violation from assert_contained — raised before the
        # rename, so again nothing has been touched. Deliberately NOT
        # `except ValueError`: this block also runs decryption and CFP1
        # parsing, which raise ValueError for their own reasons, and catching
        # that here would report an unrelated bug as a containment violation.

        _eprint(f"cesvu: refusing to write this file: {err}")
        return 1
    except OSError as err:
        # Covers a failing os.replace() inside atomic_writer. The temp file is
        # removed on that path and `output_path` is NEVER touched, so an
        # existing file at the destination is still whatever it was before.
        _eprint(f"cesvu: decrypt failed: {err}")
        return 1

    # ── Post-write verification: DIAGNOSTICS ONLY ────────────────────────
    # This cannot authorize the write — the rename already happened. Its only
    # job is to avoid CLAIMING success when the filesystem did something other
    # than what we asked (a device swallowing the bytes, a trailing-dot rewrite,
    # a normalization alias). On a mismatch we report and exit non-zero and
    # otherwise DO NOT TOUCH the destination: it most likely holds the correctly
    # decrypted file, and "repairing" it on a cosmetic mismatch would turn a
    # warning into data loss.
    problems = output_names.describe_write_discrepancies(output_path, written_bytes)
    if problems:
        for problem in problems:
            _eprint(f"cesvu: {problem}")
        _eprint(
            "cesvu: the output could not be verified, so no success is being claimed. "
            "Nothing was changed in response to this — inspect the destination yourself, "
            "then re-run with -o PATH if needed."
        )
        return 1

    if not args.quiet:
        # Escaped, not stripped: the name is untrusted and may contain bidi
        # overrides or ANSI sequences aimed at the person reading this line.
        # The name goes to STDOUT (it is the result, and scripts pipe it);
        # every adjustment/warning went to STDERR as it was decided.
        print(f"Wrote {output_names.escape_for_display(str(output_path))}")
        if is_document:

            print("Unwrapped from document framing (this file was encrypted for the cesvu.com viewer).")
        if is_text_fallback:
            if automatic_output:
                print(
                    "Note: this export did not include the original file — writing the "
                    "extracted text instead of the original binary file, so the extension was "
                    "changed to .txt to match. Open it with the cesvu.com web app to get the "
                    "original file, if it was included."
                )
            else:
                print(
                    "Note: this export did not include the original file — writing the "
                    "extracted text instead of the original binary file, even though the "
                    "output name you chose may still carry the original extension. Open it "
                    "with the cesvu.com web app to get the original file, if it was included."
                )

        # Counted, not hinted at. Silent unless the document actually
        # carries user-authored data — a merely-opened-and-exported web app
        # file has an auto-built `profile` and nothing else, and warning
        # about that fired on virtually every web-app file while telling the
        # user nothing they could act on (see count_unrestorable_extras).
        if extras.total:
            print(
                f"Note: this file also contains {extras.describe()} that cesvu's CLI "
                "cannot restore — open it in the web app to see them."
            )


    return 0




# ── argparse wiring ──────────────────────────────────────────────────────


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="cesvu", description="Encrypt/decrypt .cesvu v1 files.")
    sub = parser.add_subparsers(dest="command", required=True)

    enc = sub.add_parser(
        "encrypt",
        aliases=["-e"],
        help="Encrypt a file to .cesvu",
        epilog=(
            "The CESVU_PASSPHRASE environment variable is also accepted (checked after "
            "-p/--password and --password-file, before the interactive prompt) -- useful for "
            "scripting/CI. Note it has its own exposure surface (readable via /proc/<pid>/"
            "environ by other processes on the same machine, often echoed into CI build logs "
            "unless masked, and inherited by every child process) -- see SECURITY.md."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    enc.add_argument("file", help="Path to the file to encrypt")
    enc.add_argument(
        "-o",

        "--output",
        help=(
            "Output path (default: <file>.cesvu with the original extension stripped, "
            "e.g. report.pdf -> report.cesvu — avoids leaking the original file type via "
            "a doubled extension in the unencrypted outer filename)"
        ),
    )

    enc.add_argument("-p", "--password", help="Custom password (CLI-only; raw passProfile)")
    enc.add_argument(
        "--password-file",
        help=(
            "Read the password/passphrase from a UTF-8 text file instead of -p or the "
            "interactive prompt. Recommended for emoji passphrases, since typing/pasting "
            "emoji directly into a terminal (esp. on Windows) can corrupt them."
        ),
    )
    group = enc.add_mutually_exclusive_group()

    group.add_argument("--diceware", action="store_true", help="Generate a 6-word diceware passphrase")
    group.add_argument("--emoji", action="store_true", help="Generate an 8-emoji passphrase")
    enc.add_argument(
        "--download",
        action="store_true",
        help=(
            "Force plain file encryption (the recipient always gets a download, never the "
            "in-app viewer), even for a recognized text type (.txt/.md/.csv). Has no effect "
            "on other file types, which always encrypt this way already."
        ),
    )
    enc.add_argument("-y", "--yes", action="store_true", help="Overwrite output without prompting")
    enc.add_argument("-q", "--quiet", action="store_true", help="Suppress progress bar and status output")
    enc.set_defaults(func=cmd_encrypt)

    dec = sub.add_parser(
        "decrypt",
        aliases=["-d"],
        help="Decrypt a .cesvu file",
        epilog=(
            "The CESVU_PASSPHRASE environment variable is also accepted (checked after "
            "-p/--password and --password-file, before the interactive prompt) -- useful for "
            "scripting/CI. Note it has its own exposure surface (readable via /proc/<pid>/"
            "environ by other processes on the same machine, often echoed into CI build logs "
            "unless masked, and inherited by every child process) -- see SECURITY.md."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    dec.add_argument("file", help="Path to the .cesvu file to decrypt")

    dec.add_argument(
        "-o",
        "--output",
        help=(
            "Output path (default: the original filename embedded in the file's encrypted "
            "metadata, if present; otherwise strip the .cesvu suffix off the input filename)"
        ),
    )

    dec.add_argument("-p", "--password", help="Password/passphrase (skips the interactive prompt)")
    dec.add_argument(
        "--password-file",
        help=(
            "Read the password/passphrase from a UTF-8 text file instead of -p or the "
            "interactive prompt. Recommended for emoji passphrases, since typing/pasting "
            "emoji directly into a terminal (esp. on Windows) can corrupt them."
        ),
    )
    dec.add_argument("-y", "--yes", action="store_true", help="Overwrite output without prompting")

    dec.add_argument("-q", "--quiet", action="store_true", help="Suppress progress bar and status output")
    dec.set_defaults(func=cmd_decrypt)

    return parser


def main(argv: Optional[list] = None) -> int:
    _configure_utf8_output()
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except KeyboardInterrupt:
        _eprint("\ncesvu: interrupted")
        return 130



if __name__ == "__main__":
    raise SystemExit(main())
