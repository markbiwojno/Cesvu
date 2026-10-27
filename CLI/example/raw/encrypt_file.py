# SPDX-License-Identifier: Apache-2.0
"""encrypt_file.py — minimal, hardcoded example of encrypting a single file
with a custom RAW passphrase (passProfile = 3), using the `cesvu` Python
library directly (not the `cesvu` CLI command itself).

This mirrors what `cesvu encrypt --password '...'` does internally — useful
if you want to call cesvu's crypto from your own Python code/scripts rather
than shelling out to the CLI.

Setup:
    pip install -e ../../cesvu

Usage:
    Edit PLAINTEXT_PATH / ENCRYPTED_PATH / PASSPHRASE below, then:
    python encrypt_file.py

    PLAINTEXT_PATH is the file to encrypt (read); ENCRYPTED_PATH is the
    .cesvu file to write. Both may be relative or absolute. If relative,
    they are resolved against this script's own directory
    (CLI/example/raw/) — NOT whatever directory you happen to run `python`
    from — so this script behaves the same no matter where it's invoked
    from.

── Why passphrase_type="raw" matters ─────────────────────────────────────
`encrypt_cesvu_stream()`'s `passphrase_type` parameter defaults to `None`,
which maps to `passProfile = 1` (diceware/text) — meaning PASSPHRASE would
be silently NFC-normalized, ASCII-lowercased, and whitespace-collapsed
before use, exactly as if it were a 6-word Diceware phrase. That is almost
never what someone supplying their own arbitrary password wants: a
custom/RAW password must be passed through with `passphrase_type="raw"` so
it round-trips byte-for-byte (passProfile = 3, identity normalization,
1–512 UTF-8 bytes) — matching what the real CLI's `--password` /
`--password-file` / `$CESVU_PASSPHRASE` flags do (see cli.py). Forgetting
this flag is a silent correctness bug: encryption and decryption both
still "work" as long as you always pass the same PASSPHRASE, but the file
on disk is NOT the passphrase-preserving RAW format the "custom password"
feature promises, and a passphrase like " correct horse " would be
collapsed to "correct horse" instead of kept verbatim.

── Document (CFP1) vs. raw/vault framing ────────────────────────────────
By default, `cesvu encrypt` (and this script) auto-detects a recognized
plain-text extension (.txt / .md / .csv) and wraps its content in the same
CFP1 document framing the web app's own Export button produces (see
cesvu.document). That makes the resulting .cesvu file open directly in
the cesvu.com viewer on import, instead of landing as a plain "download
this blob" prompt. Every other file type (.pdf, .docx, .xlsx, images,
.zip, etc.) always encrypts as a plain/raw file, exactly as before.

To force the old raw/vault behavior for a .txt/.md/.csv file (equivalent
to the CLI's `--download` flag), set FORCE_RAW = True below. (Not to be
confused with the RAW *passphrase* profile this script demonstrates —
"RAW" here means two unrelated things: an unwrapped file body, and an
unnormalized passphrase.)

See ../../cesvu/README.md ("Viewer vs. download") and
../../cesvu/src/cesvu/document.py for the full explanation.
"""

from __future__ import annotations

import time
from pathlib import Path

from cesvu import cesvu_crypto as cc
from cesvu.atomic_io import atomic_writer
from cesvu.document import build_cfp1_document_plaintext, detect_document_source_type

# ── Edit these ────────────────────────────────────────────────────────────
PLAINTEXT_PATH = "sample.txt"
ENCRYPTED_PATH = "sample.cesvu"
PASSPHRASE = "correct horse battery staple"
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
            # passphrase_type="raw" is the whole point of this example: it
            # is what makes PASSPHRASE a passProfile=3 (identity-normalized)
            # custom password instead of silently falling back to
            # passProfile=1 (diceware normalization). See module docstring.
            for chunk in cc.encrypt_cesvu_stream(
                [plaintext], PASSPHRASE, metadata, passphrase_type="raw"
            ):
                write(chunk)
    except cc.CesvuError as err:
        print(f"encrypt_file: encrypt failed [{err.code}]: {err}")
        return 1
    except OSError as err:
        print(f"encrypt_file: encrypt failed: {err}")
        return 1

    print(f"Wrote {dest_path}")
    print("Encrypted with a custom RAW passphrase (passProfile = 3).")
    if is_document:
        print(f"Encrypted as a document (sourceType={source_type!r}) — opens in the cesvu.com viewer.")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
