# SPDX-License-Identifier: Apache-2.0
"""decrypt_file.py — minimal, hardcoded example of decrypting a single
.cesvu file that was encrypted with a custom RAW passphrase
(passProfile = 3), using the `cesvu` Python library directly (not the
`cesvu` CLI command itself).

Pair this with raw/encrypt_file.py.

Setup:
    pip install -e ../../cesvu

Usage:
    Edit ENCRYPTED_PATH / PLAINTEXT_PATH / PASSPHRASE below, then:
    python decrypt_file.py

    ENCRYPTED_PATH is the .cesvu file to decrypt (read); PLAINTEXT_PATH is
    the plain file to write. Both may be relative or absolute. If relative,
    they are resolved against this script's own directory
    (CLI/example/raw/) — NOT whatever directory you happen to run `python`
    from — so this script behaves the same no matter where it's invoked
    from.

── No passphrase_type needed here ────────────────────────────────────────
Unlike encrypt, decrypt does NOT take a passphrase_type/profile argument:
`decrypt_cesvu()` reads `passProfile` straight out of the file's own
header (see .cesvu SPEC/README.md, "Header layout") and normalizes the
supplied PASSPHRASE accordingly before deriving the key. So this script
works unmodified regardless of whether the source file was written with
`--raw`, `--diceware`, or `--emoji` — what matters is that PASSPHRASE here
is typed in *exactly* as it was supplied to the encrypt-side script,
since profile 3 (raw) does zero normalization: leading/trailing spaces,
case, and Unicode form are all significant.

── Document (CFP1) unwrapping ───────────────────────────────────────────
By default, `cesvu decrypt` (and this script) automatically detects CFP1
document framing — produced either by `cesvu encrypt` for a .txt/.md/.csv
file, or by the cesvu.com web app's own Export button for any of its six
source types — and unwraps it back to just the human content (plain text
or the original file's raw bytes), instead of writing the internal CFP1
envelope (magic bytes + JSON metadata) straight to disk.

To skip this and write the decrypted plaintext verbatim (equivalent to the
CLI's `--download`-forced files, i.e. never unwrap), set FORCE_RAW = True
below.

NOTE: unlike the real `cesvu decrypt` command, this example writes to a
path you chose yourself (PLAINTEXT_PATH), so it deliberately skips the
untrusted-filename safety validation in cesvu/output_names.py — that
machinery only matters when the destination name is derived from the
file's own (untrusted) embedded metadata, which happens only when no
explicit output path is given. See ../../cesvu/README.md and
../../cesvu/src/cesvu/document.py for the full explanation.
"""

from __future__ import annotations

from pathlib import Path

from cesvu import cesvu_crypto as cc
from cesvu.atomic_io import atomic_writer
from cesvu.document import unwrap_cfp1_plaintext

# ── Edit these ────────────────────────────────────────────────────────────
ENCRYPTED_PATH = "sample.cesvu"
PLAINTEXT_PATH = "sample.txt"
PASSPHRASE = "correct horse battery staple"
FORCE_RAW = False  # True == skip CFP1 unwrapping, write plaintext verbatim
# ────────────────────────────────────────────────────────────────────────

# Directory this script lives in, so relative ENCRYPTED_PATH/PLAINTEXT_PATH
# above are resolved consistently regardless of the caller's working
# directory.
SCRIPT_DIR = Path(__file__).resolve().parent


def main() -> int:
    source_path = (SCRIPT_DIR / ENCRYPTED_PATH).resolve()
    dest_path = (SCRIPT_DIR / PLAINTEXT_PATH).resolve()

    if not source_path.is_file():
        print(f"decrypt_file: {source_path}: no such file")
        return 1

    try:
        decrypted = cc.decrypt_cesvu(source_path.read_bytes(), PASSPHRASE)
    except cc.CesvuError as err:
        print(f"decrypt_file: decrypt failed [{err.code}]: {err}")
        return 1

    is_document = False
    is_text_fallback = False
    extras = None
    content = decrypted.plaintext

    if not FORCE_RAW:
        # unwrap_cfp1_plaintext() takes an iterable of chunks; a single
        # chunk is fine here since decrypt_cesvu() already buffered the
        # whole plaintext.
        is_document, is_text_fallback, extras, content_chunks = unwrap_cfp1_plaintext(
            [decrypted.plaintext]
        )
        content = b"".join(content_chunks)

    try:
        with atomic_writer(dest_path) as write:
            write(content)
    except OSError as err:
        print(f"decrypt_file: decrypt failed: {err}")
        return 1

    print(f"Wrote {dest_path}")
    print(f"passProfile = {decrypted.pass_profile} (3 = raw)")
    if is_document:
        print("Unwrapped from document framing (this file was encrypted for the cesvu.com viewer).")
    if is_text_fallback:
        print(
            "Note: this export did not include the original file — writing the "
            "extracted text instead of the original binary file. Open it with the "
            "cesvu.com web app to get the original file, if it was included."
        )
    if extras is not None and extras.total:
        print(
            f"Note: this file also contains {extras.describe()} that this example "
            "cannot restore — open it in the web app to see them."
        )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
