"""Round-trip check for the post-auth error-code split (Item 8 / Item 7).

Exercises every code the Python decrypt paths can now raise, in BOTH the
one-shot and streaming implementations, and asserts the pre-auth ambiguity
between "wrong passphrase" and "tampered header" is preserved.

Run: python scripts/verify_error_codes.py
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

import json  # noqa: E402
import struct  # noqa: E402
import time  # noqa: E402

from cesvu.cesvu_crypto import (  # noqa: E402
    FIXED_PREFIX,
    CesvuError,
    CesvuMetadata,
    decrypt_cesvu,
    decrypt_cesvu_stream,
    decrypt_cesvu_stream_full,
    encrypt_cesvu,
    pack_metadata,
    parse_header,
    unpack_metadata,
    verify_passphrase,
)

PASS = "correct horse battery staple forest ranger"
# Fast-but-legal KDF params, and a small chunk so multi-segment files are cheap.
KDF = dict(memory_kib=65536, time_cost=1, chunk_shift=16)
META = CesvuMetadata(filename="doc.txt", mimeType="text/plain", createdAt=1)

_failures = []


def check(label, fn, expected):
    """Assert fn() raises CesvuError with `expected` code."""
    try:
        fn()
    except CesvuError as err:
        if err.code == expected:
            print(f"  ok   {label}: {err.code}")
        else:
            print(f"  FAIL {label}: expected {expected}, got {err.code}")
            _failures.append(label)
        return
    except Exception as err:  # noqa: BLE001
        print(f"  FAIL {label}: expected {expected}, got {type(err).__name__}: {err}")
        _failures.append(label)
        return
    print(f"  FAIL {label}: expected {expected}, but no error was raised")
    _failures.append(label)


def check_true(label, value):
    if value:
        print(f"  ok   {label}")
    else:
        print(f"  FAIL {label}")
        _failures.append(label)


def drain_stream(data):
    return b"".join(decrypt_cesvu_stream([data], PASS))


def body_offset(data):
    return parse_header(data).ciphertext_offset


# One segment (small payload) and several segments (payload > chunk_size).
small = encrypt_cesvu(b"hello world", PASS, META, **KDF)
big_plain = bytes(range(256)) * 1500  # ~384 KiB => multiple 64 KiB segments
big = encrypt_cesvu(big_plain, PASS, META, **KDF)

print("\n== happy path ==")
one = decrypt_cesvu(small, PASS)
check_true("one-shot round-trips", one.plaintext == b"hello world")
check_true("one-shot metadata", one.metadata.filename == "doc.txt")
check_true("streaming round-trips", drain_stream(small) == b"hello world")
check_true("multi-segment round-trips", decrypt_cesvu(big, PASS).plaintext == big_plain)
check_true("multi-segment streaming", drain_stream(big) == big_plain)

print("\n== pre-auth: MUST stay ambiguous ==")
check(
    "one-shot wrong passphrase",
    lambda: decrypt_cesvu(small, "totally different words go here now"),
    "WRONG_PASSPHRASE_OR_HEADER_TAMPER",
)
check(
    "streaming wrong passphrase",
    lambda: b"".join(decrypt_cesvu_stream([small], "totally different words go here now")),
    "WRONG_PASSPHRASE_OR_HEADER_TAMPER",
)

# Flip one of the salt slot's RESERVED bytes. The parser ignores them (per
# README.md) so the keyCheck still matches and the header still parses
# — but they ARE inside the chunk-1 associated data, so the MAC catches it.
# Doubles as proof that "consumers MUST ignore" means "don't validate", not
# "don't authenticate".
tampered = bytearray(small)
_salt_reserved = body_offset(small) - 105 + 7 + 16  # base + 7 + SALTBYTES
tampered[_salt_reserved] ^= 0xFF
check(
    "one-shot tampered header",
    lambda: decrypt_cesvu(bytes(tampered), PASS),
    "WRONG_PASSPHRASE_OR_HEADER_TAMPER",
)
check(
    "streaming tampered header",
    lambda: drain_stream(bytes(tampered)),
    "WRONG_PASSPHRASE_OR_HEADER_TAMPER",
)

# Corruption inside the FIRST segment is also pre-auth: nothing verified yet.
first_bad = bytearray(small)
first_bad[body_offset(small) + 1] ^= 0xFF
check(
    "one-shot first-segment corruption",
    lambda: decrypt_cesvu(bytes(first_bad), PASS),
    "WRONG_PASSPHRASE_OR_HEADER_TAMPER",
)
check(
    "streaming first-segment corruption",
    lambda: drain_stream(bytes(first_bad)),
    "WRONG_PASSPHRASE_OR_HEADER_TAMPER",
)

print("\n== post-auth: must NOT blame the passphrase ==")
seg_size = (1 << KDF["chunk_shift"]) + 17
off = body_offset(big)

# Corrupt the SECOND segment — segment 1 already authenticated.
mid_bad = bytearray(big)
mid_bad[off + seg_size + 5] ^= 0xFF
check("one-shot CIPHERTEXT_CORRUPT", lambda: decrypt_cesvu(bytes(mid_bad), PASS), "CIPHERTEXT_CORRUPT")
check("streaming CIPHERTEXT_CORRUPT", lambda: drain_stream(bytes(mid_bad)), "CIPHERTEXT_CORRUPT")

# Truncate after a verified segment but before TAG_FINAL.
truncated = big[: off + seg_size]
check("one-shot TRUNCATED", lambda: decrypt_cesvu(truncated, PASS), "TRUNCATED")
check("streaming TRUNCATED", lambda: drain_stream(truncated), "TRUNCATED")

# TRAILING_DATA requires the junk to land in a segment AFTER a TAG_FINAL that
# already verified. If it falls inside the SAME segment as real ciphertext,
# the first pull just fails and the result is (correctly) the ambiguous
# pre-auth code — same rule the TS suite documents. So build a file whose
# payload is an exact multiple of chunk_size: every segment is full, and the
# appended bytes therefore start a segment of their own.
chunk_size = 1 << KDF["chunk_shift"]
exact_plain = b"E" * (chunk_size * 3 - len(pack_metadata(META)))
exact = encrypt_cesvu(exact_plain, PASS, META, **KDF)
assert (len(exact) - body_offset(exact)) % seg_size == 0, "test setup: body not segment-aligned"
appended = exact + b"\x00" * seg_size

# Junk sharing a segment with real ciphertext stays pre-auth (not TRAILING_DATA).
check(
    "junk inside final segment stays pre-auth",
    lambda: decrypt_cesvu(small + b"\x00" * 64, PASS),
    "WRONG_PASSPHRASE_OR_HEADER_TAMPER",
)
check("one-shot TRAILING_DATA", lambda: decrypt_cesvu(appended, PASS), "TRAILING_DATA")
check("streaming TRAILING_DATA", lambda: drain_stream(appended), "TRAILING_DATA")

print("  (METADATA_CORRUPT_POST_AUTH needs a hand-forged payload; the mapping")
print("   from unpack_metadata's codes is covered by the unit tests)")

print("\n== structural ==")
header_only = small[: body_offset(small)]
check("streaming TOO_SHORT (no ciphertext)", lambda: drain_stream(header_only), "TOO_SHORT")
check("one-shot TOO_SHORT (no ciphertext)", lambda: decrypt_cesvu(header_only, PASS), "TOO_SHORT")

# A body too short to hold even one MAC must be rejected BEFORE the KDF runs.
# Timing is the only way to observe "before": a real Argon2id run at 64 MiB is
# far slower than the generous ceiling below, so a regression that reinstates
# the derivation will blow through it.
short_body = small[: body_offset(small) + 5]
check("one-shot TOO_SHORT (body < ABYTES)", lambda: decrypt_cesvu(short_body, PASS), "TOO_SHORT")
check("streaming TOO_SHORT (body < ABYTES)", lambda: drain_stream(short_body), "TOO_SHORT")

_t0 = time.perf_counter()
try:
    drain_stream(short_body)
except CesvuError:
    pass
_elapsed = time.perf_counter() - _t0
check_true(f"short body rejected pre-KDF ({_elapsed * 1000:.1f} ms)", _elapsed < 0.25)

# The preamble is now skipped as OPAQUE padding on parse (never decoded or
# validated — see cesvu_crypto.parse_header), so a file with invalid UTF-8
# bytes in that field is NOT rejected; the header still parses fine as long
# as the declared preamble LENGTH is honored. Confirm that directly: garbage
# bytes in the preamble field must NOT raise.
garbage_preamble = bytearray(small)
(_pl,) = struct.unpack_from(">H", garbage_preamble, 8)
assert _pl > 0, "test setup: default preamble is empty"
garbage_preamble[FIXED_PREFIX] = 0xFF  # lone continuation-illegal start byte
try:
    parse_header(bytes(garbage_preamble))
    check_true("invalid UTF-8 preamble bytes are accepted (opaque, unvalidated)", True)
except CesvuError as err:
    check_true(f"invalid UTF-8 preamble bytes are accepted (opaque, unvalidated) [got {err.code}]", False)

print("\n== metadata schema: validate, never coerce ==")


def _meta_blob(obj):
    """Length-prefixed metadata JSON, bypassing pack_metadata's own checks."""
    raw = json.dumps(obj).encode("utf-8") if not isinstance(obj, bytes) else obj
    return struct.pack(">H", len(raw)) + raw


check_true(
    "valid metadata still parses",
    unpack_metadata(_meta_blob({"filename": "a.txt", "createdAt": 0})).meta.filename == "a.txt",
)
check_true(
    "absent mimeType defaults (Zod .default)",
    unpack_metadata(_meta_blob({"filename": "a.txt", "createdAt": 0})).meta.mimeType == "text/plain",
)
check_true(
    "unknown keys are STRIPPED, not rejected (Zod strip mode)",
    unpack_metadata(_meta_blob({"filename": "a.txt", "createdAt": 0, "zzz": 1})).meta.filename == "a.txt",
)

for _label, _obj in [
    ("numeric filename is not coerced", {"filename": 42, "createdAt": 0}),
    ("missing filename", {"createdAt": 0}),
    ("null filename", {"filename": None, "createdAt": 0}),
    ("overlong filename", {"filename": "x" * 256, "createdAt": 0}),
    ("null mimeType (default is for ABSENT only)", {"filename": "a", "createdAt": 0, "mimeType": None}),
    ("overlong mimeType", {"filename": "a", "createdAt": 0, "mimeType": "m" * 128}),
    ("missing createdAt", {"filename": "a"}),
    ("bool createdAt (isinstance(True, int) trap)", {"filename": "a", "createdAt": True}),
    ("float createdAt", {"filename": "a", "createdAt": 1.5}),
    ("negative createdAt", {"filename": "a", "createdAt": -1}),
    ("string createdAt is not coerced", {"filename": "a", "createdAt": "0"}),
    ("null template", {"filename": "a", "createdAt": 0, "template": None}),
    ("overlong template", {"filename": "a", "createdAt": 0, "template": "t" * 64}),
    ("top level is an array", ["filename"]),
]:
    check(_label, lambda o=_obj: unpack_metadata(_meta_blob(o)), "METADATA_CORRUPT")

# json.loads accepts these by default; JSON.parse and z.number().int() do not.
for _label, _raw in [
    ("NaN createdAt", b'{"filename":"a","createdAt":NaN}'),
    ("Infinity createdAt", b'{"filename":"a","createdAt":Infinity}'),
    ("-Infinity createdAt", b'{"filename":"a","createdAt":-Infinity}'),
]:
    check(_label, lambda r=_raw: unpack_metadata(_meta_blob(r)), "METADATA_CORRUPT")

check(
    "invalid UTF-8 in metadata JSON",
    lambda: unpack_metadata(_meta_blob(b'{"filename":"\xff\xfe","createdAt":0}')),
    "METADATA_CORRUPT",
)

print("\n== verify_passphrase scope ==")
check_true("verify_passphrase true on good file", verify_passphrase(small, PASS))
check_true("verify_passphrase false on wrong pass", not verify_passphrase(small, "nope nope nope nope nope"))
# Documented postcondition: true even though the file is damaged past seg 1.
# `appended` is SEGMENT-ALIGNED, so the extra bytes fall outside the first
# segment's slice and the MAC over it still verifies.
check_true("verify_passphrase true on appended SEGMENT-ALIGNED file", verify_passphrase(appended, PASS))
# The corrected postcondition: when the body is NOT segment-aligned (the usual
# case), appended bytes land inside the first segment and the MAC fails. The
# old docs claimed true unconditionally here — this pins the real behaviour.
check_true(
    "verify_passphrase FALSE on appended non-aligned file",
    not verify_passphrase(small + b"\x00" * 64, PASS),
)
check_true("verify_passphrase still true on truncated file", verify_passphrase(truncated, PASS))
check_true("verify_passphrase still true on late-corrupted file", verify_passphrase(bytes(mid_bad), PASS))

print("\n== generator cleanup (item 7) ==")
# Abandon the stream after one chunk; the finally must close the inner
# generator rather than leave it suspended.
gen = decrypt_cesvu_stream([big], PASS)
next(gen)
gen.close()
print("  ok   abandoned stream closed without error")

it, _info = decrypt_cesvu_stream_full([big], PASS)
next(it)
it.close()
print("  ok   abandoned stream_full closed without error")

print("\n== stream_full context manager + lazy derivation ==")
# Tuple unpacking must keep working for existing callers.
_it, _info = decrypt_cesvu_stream_full([big], PASS)
check_true("legacy tuple unpacking still works", _info["mode"] and hasattr(_it, "__next__"))
_it.close()

# Creating the session must NOT derive the key — an un-iterated generator has
# no key material in flight. Again observed by timing against an Argon2id run.
_t0 = time.perf_counter()
_sess = decrypt_cesvu_stream_full([big], PASS)
_setup = time.perf_counter() - _t0
check_true(f"no KDF work before first next() ({_setup * 1000:.1f} ms)", _setup < 0.25)
check_true("header_info available before iterating", _sess.header_info["mode"] is not None)
_sess.close()  # never iterated: must close cleanly

with decrypt_cesvu_stream_full([big], PASS) as (_chunks, _hinfo):
    _acc = b"".join(_chunks)
check_true("context manager full drain round-trips", _acc == big_plain)
check_true("context manager exposes metadata", _hinfo["metadata"].filename == "doc.txt")

# Early break: __exit__ must close the iterator and run its key-wiping finally.
with decrypt_cesvu_stream_full([big], PASS) as _sess2:
    for _piece in _sess2.iterator:
        break
print("  ok   context manager closed after early break")

# An exception inside the with-body must still close cleanly and propagate.
try:
    with decrypt_cesvu_stream_full([big], PASS) as (_chunks3, _):
        next(_chunks3)
        raise RuntimeError("boom")
except RuntimeError:
    print("  ok   context manager propagated body exception after cleanup")
else:
    check_true("context manager propagated body exception after cleanup", False)

# Wrong passphrase now surfaces on the FIRST next(), not at call time.
_sess4 = decrypt_cesvu_stream_full([small], "totally different words go here now")
check("deferred wrong passphrase on first next()", lambda: next(_sess4.iterator), "WRONG_PASSPHRASE_OR_HEADER_TAMPER")

print()
if _failures:
    print(f"FAILED ({len(_failures)}): " + ", ".join(_failures))
    sys.exit(1)
print("All checks passed.")
