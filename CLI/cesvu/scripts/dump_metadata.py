#!/usr/bin/env python3
"""
dump_metadata.py — diagnose a .cesvu file by printing its embedded metadata.

Reads a .cesvu file with a streaming decrypt (no full-file buffering), pulls
the metadata out of the first encrypted chunk, and prints it as JSON to stdout.

The plaintext body is NOT written to disk — this is a pure diagnostic tool.
Useful for:
  - Verifying that the metadata is correctly preserved during export
  - Debugging "lost extension" reports — the metadata carries the real
    extension even though the outer filename is `Myfile.cesvu`
  - Inspecting a file's passProfile (diceware / emoji / raw) without
    fully decrypting the body
  - Confirming the file is well-formed and the passphrase is correct

Usage:
  python dump_metadata.py file.cesvu
  python dump_metadata.py file.cesvu -p "rocket garden candle apple wolf mirror"
  python dump_metadata.py file.cesvu --password-file pw.txt
"""
from __future__ import annotations

import argparse
import getpass
import json
import sys
from pathlib import Path
from typing import Iterator, Optional

# Allow running this script directly from the repo root without installing.
_SCRIPT_DIR = Path(__file__).resolve().parent
_SRC_DIR = _SCRIPT_DIR.parent / "src"
if str(_SRC_DIR) not in sys.path:
    sys.path.insert(0, str(_SRC_DIR))

from cesvu import cesvu_crypto as cc  # noqa: E402


_READ_CHUNK_SIZE = 1 << 20  # 1 MiB — wide enough to hold the full header
# in one read, narrow enough to keep the streaming promise honest on multi-GB
# files. The header is at most 10 + 4096 + 105 = 4211 bytes, so a 1 MiB
# first read is vastly over-budget; the remaining bytes are simply ignored
# after we've extracted the metadata.


def _read_passphrase_file(path: str) -> str:
    """Read a passphrase/password from a file as UTF-8 text.

    Mirrors cli.py's _read_passphrase_file — same rationale for the UTF-8 BOM
    strip and the single-trailing-newline trim (typing/pasting emoji into a
    Windows console can silently corrupt them; reading from a UTF-8 file
    sidesteps that entirely).
    """
    raw = Path(path).read_bytes()
    if raw.startswith(b"\xef\xbb\xbf"):
        raw = raw[3:]
    text = raw.decode("utf-8")
    if text.endswith("\r\n"):
        return text[:-2]
    if text.endswith("\n"):
        return text[:-1]
    return text


def _resolve_passphrase(args: argparse.Namespace) -> str:
    if args.password_file:
        return _read_passphrase_file(args.password_file)
    if args.password:
        return args.password
    return getpass.getpass("Passphrase: ")


def _stream_file(path: Path, chunk_size: int) -> Iterator[bytes]:
    """Yield `chunk_size`-sized raw bytes from `path`. STOP-marked at exactly
    one chunk after the metadata is parsed — we don't read the rest of the
    file, since the diagnostic only needs the metadata (which lives in the
    first encrypted chunk). The caller is responsible for NOT pulling more
    than it needs from this iterator.
    """
    with open(path, "rb") as f:
        while True:
            chunk = f.read(chunk_size)
            if not chunk:
                return
            yield chunk


def _profile_name(profile: int) -> str:
    if profile == cc.PASS_PROFILE_EMOJI:
        return "emoji"
    if profile == cc.PASS_PROFILE_RAW:
        return "raw"
    return "text/diceware"


def _cipher_mode_name(mode: str) -> str:
    return cc.CIPHER_MODE_NAMES.get(mode, str(mode))


def _validate_utf8_encodable(passphrase: str, source: str) -> None:
    """Fail fast on a passphrase that contains lone UTF-16 surrogates — the
    telltale sign of corrupted emoji typed into a Windows console. Mirrors
    cli.py's _validate_utf8_encodable but lives here so this script is
    self-contained."""
    try:
        passphrase.encode("utf-8")
    except UnicodeEncodeError:
        print(
            f"dump_metadata: the passphrase from {source} contains invalid/corrupted "
            "characters. Save the passphrase as a UTF-8 text file and pass it with "
            "--password-file instead of -p or the interactive prompt.",
            file=sys.stderr,
        )
        raise SystemExit(1)


def build_argparser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="dump-metadata",
        description=(
            "Prints the encrypted metadata of a .cesvu file as JSON. "
            "The plaintext body is NEVER written to disk."
        ),
    )
    parser.add_argument("file", help="Path to the .cesvu file")
    parser.add_argument(
        "-p",
        "--password",
        help="Passphrase as a string (skips the interactive prompt).",
    )
    parser.add_argument(
        "--password-file",
        help=(
            "Read the passphrase from a UTF-8 text file. Recommended for emoji "
            "passphrases, since typing/pasting emoji directly into a terminal "
            "(esp. on Windows) can corrupt them."
        ),
    )
    parser.add_argument(
        "--no-color",
        action="store_true",
        help="Reserved for future use; no effect today.",
    )
    return parser


def main(argv: Optional[list] = None) -> int:
    args = build_argparser().parse_args(argv)

    input_path = Path(args.file)
    if not input_path.is_file():
        print(f"dump_metadata: {input_path}: no such file", file=sys.stderr)
        return 1

    passphrase = _resolve_passphrase(args)
    if not passphrase:
        print("dump_metadata: passphrase is empty", file=sys.stderr)
        return 1
    _validate_utf8_encodable(
        passphrase,
        "--password-file" if args.password_file is not None else "-p/prompt",
    )

    # Use the streaming API so we don't buffer the entire ciphertext into
    # memory (the user's actual scenario is multi-GB files). The streaming
    # path populates `header_info["metadata"]` as soon as the first chunk's
    # plaintext has been parsed — so we just need to pull a single item from
    # the plaintext iterator to force that parse, then we can stop reading.
    ciphertext_chunks = _stream_file(input_path, _READ_CHUNK_SIZE)
    try:
        plaintext_iter, header_info = cc.decrypt_cesvu_stream_full(
            ciphertext_chunks, passphrase
        )
    except cc.CesvuError as err:
        print(f"dump_metadata: decrypt failed [{err.code}]: {err}", file=sys.stderr)
        return 1
    except ValueError as err:
        print(f"dump_metadata: {err}", file=sys.stderr)
        return 1

    # Pull just enough of the plaintext iterator to force the metadata parse
    # to complete (it lands in header_info["metadata"] after the first chunk
    # is consumed) — then close the generator so the rest of the file is
    # never read. We discard the yielded plaintext bytes; this script is
    # metadata-only.
    try:
        for _ in plaintext_iter:
            break
    finally:
        # Python generator close: the encrypt-side libsodium state is
        # finalized inside the generator's finally block, so closing here is
        # safe.
        plaintext_iter.close()

    metadata = header_info.get("metadata")
    if metadata is None:
        print(
            "dump_metadata: no metadata parsed (file may be truncated or corrupted)",
            file=sys.stderr,
        )
        return 1

    out = {
        "input_file": str(input_path),
        "input_size_bytes": input_path.stat().st_size,
        "outer_filename": input_path.name,
        "pass_profile": _profile_name(header_info["pass_profile"]),
        "kdf_memory_kib": header_info["kdf_memory_kib"],
        "kdf_time_cost": header_info["kdf_time_cost"],
        "cipher_mode": _cipher_mode_name(header_info["mode"]),
        "metadata": {
            "filename": metadata.filename,
            "mimeType": metadata.mimeType,
            "createdAt": metadata.createdAt,
            "template": metadata.template,
        },
    }

    # ensure_ascii=False keeps non-ASCII characters (emoji, accented text,
    # etc.) as literal UTF-8 instead of \uXXXX escapes — easier to read when
    # the filename itself contains emoji.
    print(json.dumps(out, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
