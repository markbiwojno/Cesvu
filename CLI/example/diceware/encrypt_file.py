# SPDX-License-Identifier: Apache-2.0
"""encrypt_file.py — minimal, hardcoded example of encrypting a single file
with a freshly GENERATED 6-word Diceware passphrase (passProfile = 1),
using the `cesvu` Python library directly (not the `cesvu` CLI command
itself).

This mirrors what `cesvu encrypt --diceware` does internally — useful if
you want to call cesvu's crypto from your own Python code/scripts rather
than shelling out to the CLI.

Setup:
    pip install -e ../../cesvu

Usage:
    Edit PLAINTEXT_PATH / ENCRYPTED_PATH below if needed, then:
    python encrypt_file.py

    There is no PASSPHRASE constant to edit here: a fresh 6-word passphrase
    is generated from the EFF large wordlist (7,776 words) using a CSPRNG
    every time this script runs, and printed to stdout. WRITE IT DOWN — it
    is the only copy; cesvu never stores a passphrase anywhere. Then edit
    diceware/decrypt_file.py's PASSPHRASE constant with exactly what was
    printed, to decrypt.

    PLAINTEXT_PATH is the file to encrypt (read); ENCRYPTED_PATH is the
    .cesvu file to write. Both may be relative or absolute. If relative,
    they are resolved against this script's own directory
    (CLI/example/diceware/) — NOT whatever directory you happen to run
    `python` from — so this script behaves the same no matter where it's
    invoked from.

── Why this is passProfile = 1, not RAW ──────────────────────────────────
Diceware passphrases are normalized on both encrypt and decrypt (NFC,
ASCII-lowercased, whitespace collapsed to single spaces, leading/trailing
whitespace trimmed) — see .cesvu SPEC/README.md, "Profile 1 —
text/diceware". That normalization is exactly why this profile tolerates
a pasted passphrase with an extra space or different line-ending safely,
unlike the RAW profile (see ../raw/), which preserves whitespace
byte-for-byte and would treat " correct horse " as a different password
from "correct horse".

`passphrase_type=None` (the default, left unset below) is what selects
this profile — no explicit flag is needed, unlike `raw/`'s
`passphrase_type="raw"` or `emoji/`'s `passphrase_type="emoji"`.

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

import time
from pathlib import Path

from cesvu import cesvu_crypto as cc
from cesvu.atomic_io import atomic_writer
from cesvu.document import build_cfp1_document_plaintext, detect_document_source_type
from cesvu.passphrase import generate_diceware_passphrase

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

    passphrase = generate_diceware_passphrase()

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
            # passphrase_type left as the default (None) => passProfile = 1
            # (text/diceware normalization), the correct profile for a
            # wordlist-derived passphrase like this one.
            for chunk in cc.encrypt_cesvu_stream([plaintext], passphrase, metadata):
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
    print("Paste it into diceware/decrypt_file.py's PASSPHRASE constant to decrypt.")
    if is_document:
        print(f"Encrypted as a document (sourceType={source_type!r}) — opens in the cesvu.com viewer.")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
