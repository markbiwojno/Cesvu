# SPDX-License-Identifier: Apache-2.0
"""encrypt_file.py — minimal, hardcoded example of encrypting a single file
with a freshly GENERATED 8-emoji passphrase (passProfile = 2), using the
`cesvu` Python library directly (not the `cesvu` CLI command itself).

This mirrors what `cesvu encrypt --emoji` does internally — useful if you
want to call cesvu's crypto from your own Python code/scripts rather than
shelling out to the CLI.

Setup:
    pip install -e ../../cesvu

Usage:
    Edit PLAINTEXT_PATH / ENCRYPTED_PATH below if needed, then:
    python encrypt_file.py

    There is no PASSPHRASE constant to edit here: a fresh 8-emoji
    passphrase is generated from the curated 800-emoji wordlist using a
    CSPRNG every time this script runs, and printed to stdout. WRITE IT
    DOWN (or copy it somewhere durable) — it is the only copy; cesvu never
    stores a passphrase anywhere. Then edit emoji/decrypt_file.py's
    PASSPHRASE constant with exactly what was printed, to decrypt.

    PLAINTEXT_PATH is the file to encrypt (read); ENCRYPTED_PATH is the
    .cesvu file to write. Both may be relative or absolute. If relative,
    they are resolved against this script's own directory (CLI/example/emoji/)
    — NOT whatever directory you happen to run `python` from — so this
    script behaves the same no matter where it's invoked from.

── Why this is passProfile = 2, not RAW ──────────────────────────────────
Emoji passphrases are normalized on both encrypt and decrypt (NFC, plus
deletion of variation selectors/ZWSP/ZWJ/BOM/bidi-control code points and
all whitespace) — see .cesvu SPEC/README.md, "Profile 2 — emoji". That
normalization is what makes an 8-emoji passphrase copy/paste-safe across
apps and OSes that may silently insert an invisible variation selector
(U+FE0F) or ZWJ next to an emoji, unlike the RAW profile (see ../raw/),
which preserves every code point byte-for-byte and has no such tolerance.

`passphrase_type="emoji"` is what selects this profile below — matching
`raw/`'s `passphrase_type="raw"`, but unlike `diceware/`, which leaves
`passphrase_type` at its default (`None` → profile 1).

── Document (CFP1) vs. raw/vault framing ────────────────────────────────
By default, `cesvu encrypt` (and this script) auto-detects a recognized
plain-text extension (.txt / .md / .csv) and wraps its content in the same
CFP1 document framing the web app's own Export button produces (see
cesvu.document). That makes the resulting .cesvu file open directly in
the cesvu.com viewer on import, instead of landing as a plain "download
this blob" prompt. Every other file type (.pdf, .docx, .xlsx, images,
.zip, etc.) always encrypts as a plain/raw file, exactly as before.

To force the old raw/vault behavior for a .txt/.md/.csv file (equivalent
to the CLI's `--download` flag), set FORCE_RAW = True below.

See ../../cesvu/README.md ("Viewer vs. download") and
../../cesvu/src/cesvu/document.py for the full explanation.
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

from cesvu import cesvu_crypto as cc
from cesvu.atomic_io import atomic_writer
from cesvu.document import build_cfp1_document_plaintext, detect_document_source_type
from cesvu.passphrase import generate_emoji_passphrase

# On a default Windows console, sys.stdout.encoding is a legacy code page
# (e.g. cp1252) that cannot represent emoji, and print() would raise
# UnicodeEncodeError right as we try to show the generated passphrase --
# the one thing this script absolutely must not fail to display. Mirrors
# _configure_utf8_output() in cesvu/cli.py. Best-effort: ignored if the
# stream doesn't support reconfigure() (e.g. under pytest's capture).
for _stream in (sys.stdout, sys.stderr):
    _reconfigure = getattr(_stream, "reconfigure", None)
    if _reconfigure is not None:
        try:
            _reconfigure(encoding="utf-8", errors="replace")
        except (ValueError, OSError, AttributeError, TypeError):
            pass


# ── Edit these ────────────────────────────────────────────────────────────
PLAINTEXT_PATH = "sample.txt"
ENCRYPTED_PATH = "sample.cesvu"
FORCE_RAW = False  # True == the CLI's `--download` flag (always raw/vault body)
# ────────────────────────────────────────────────────────────────────────

# Directory this script lives in, so relative PLAINTEXT_PATH/ENCRYPTED_PATH
# above are resolved consistently regardless of the caller's working
# directory.
SCRIPT_DIR = Path(__file__).resolve().parent


def main() -> int:
    source_path = (SCRIPT_DIR / PLAINTEXT_PATH).resolve()
    dest_path = (SCRIPT_DIR / ENCRYPTED_PATH).resolve()

    if not source_path.is_file():
        print(f"encrypt_file: {source_path}: no such file")
        return 1

    passphrase = generate_emoji_passphrase()

    # ── Document (CFP1) vs. raw/vault framing ────────────────────────────
    # Mirrors cmd_encrypt() in cesvu/cli.py: a recognized plain-text
    # extension is wrapped in CFP1 document framing unless FORCE_RAW is set,
    # so the file opens directly in the cesvu.com viewer on import.
    plaintext: bytes
    source_type = None if FORCE_RAW else detect_document_source_type(source_path)
    is_document = False

    if source_type is not None:
        try:
            plaintext = build_cfp1_document_plaintext(source_path, source_type)
            is_document = True
        except UnicodeDecodeError:
            # Not valid UTF-8 text despite the extension — fall back to
            # raw/vault framing rather than failing outright.
            plaintext = source_path.read_bytes()
    else:
        plaintext = source_path.read_bytes()

    metadata = cc.CesvuMetadata(
        filename=source_path.name,
        # Matches the CLI: a document gets 'application/json' (the CFP1
        # envelope's real content type); everything else gets
        # 'application/octet-stream'.
        mimeType="application/json" if is_document else "application/octet-stream",
        createdAt=int(time.time() * 1000),
    )

    try:
        with atomic_writer(dest_path) as write:
            # passphrase_type="emoji" selects passProfile = 2, the correct
            # profile for a curated-wordlist emoji passphrase like this one.
            for chunk in cc.encrypt_cesvu_stream(
                [plaintext], passphrase, metadata, passphrase_type="emoji"
            ):
                write(chunk)
    except cc.CesvuError as err:
        print(f"encrypt_file: encrypt failed [{err.code}]: {err}")
        return 1
    except OSError as err:
        print(f"encrypt_file: encrypt failed: {err}")
        return 1

    print(f"Wrote {dest_path}")
    print()
    print("Generated passphrase (WRITE THIS DOWN — it is the only copy):")
    print(f"    {passphrase}")
    print()
    print("Paste it into emoji/decrypt_file.py's PASSPHRASE constant to decrypt.")
    if is_document:
        print(f"Encrypted as a document (sourceType={source_type!r}) — opens in the cesvu.com viewer.")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
