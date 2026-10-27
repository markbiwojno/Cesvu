# .cesvu v1 wire format — spec for the Python CLI, web app, and NPM package

This is the single source of truth all three reference implementations MUST
match, byte for byte: the Python `cesvu` CLI, the web app's TypeScript
implementation (`src/lib/crypto/cesvu-crypto.ts`), and the NPM package
(`NPM/src/cesvu-crypto.ts`, which the web app's implementation was itself
extracted/published from). Any drift makes files produced by one tool
undecryptable by another.

This specification is licensed under Apache 2.0; see
[`../LICENSE.md`](../LICENSE.md) for the full license text. The Apache 2.0
commitment applies to *implementers* of this format in any language, not
just to *this* implementation — anyone may write a .cesvu reader or
writer for any purpose without attribution, royalty, or restriction.

## Cipher / KDF

- **KDF:** Argon2id (libsodium `crypto_pwhash`, `ALG_ARGON2ID13`) followed by a
  domain-separation step.
  - `time_cost` (opsLimit) is stored per-file as a single **uint8** byte
    (see header), range **1..10**, default **3** (`OPSLIMIT_MODERATE`). It
    MUST be range-checked BEFORE Argon2id runs (same fail-closed pattern as
    `memory_cost` below) — this is attacker-controlled input read from an
    untrusted header before the header itself can be authenticated.
  - `memory_cost` is stored per-file in KiB (see header) as a **uint32 BE**
    (4 bytes), range **65536..262144** KiB (64–256 MiB). A uint32 KiB field
    addresses up to ~4 TiB of memory (2^32 KiB), comfortably beyond any
    realistic Argon2id memory-cost policy. libsodium wants BYTES → multiply
    by 1024.
  - salt length = `crypto_pwhash_SALTBYTES` — **16 bytes** with standard
    libsodium, NOT 32. The header's salt *slot* is a fixed 32 bytes (see
    below); the salt itself occupies only the first `SALTBYTES` of it. 128
    bits of salt is ample; the slot is oversized purely for forward-compat.
    **Salt generation is normative, not merely a length constraint:** the
    salt MUST be generated fresh, per encryption, by a CSPRNG (e.g.
    libsodium `randombytes_buf`, or Web Crypto `crypto.getRandomValues`),
    and MUST NOT be reused across files/encryptions even when the
    passphrase is the same. Salt reuse does not break Argon2id itself, but
    it leaks that two ciphertexts share a passphrase, and lets an attacker
    amortize a single Argon2id brute-force run across every file that
    shares a salt.
  - Argon2id output = 32 bytes (the "raw key").
  - **Parallelism (lanes) is fixed at 1.** libsodium's `crypto_pwhash` does
    not expose an Argon2id parallelism/lanes parameter at all — it is
    hardcoded internally, and the high-level API only lets callers tune
    `opslimit`/`memlimit`. Because different lanes values with the same
    `memory_cost`/`time_cost` produce different keys, this spec normatively
    fixes **`lanes = 1`** for all conforming implementations regardless of
    the underlying library. A non-libsodium implementation (e.g. Rust's
    `argon2` crate, Go's `golang.org/x/crypto/argon2`, or any library that
    exposes parallelism directly) MUST set parallelism to `1` explicitly —
    getting this wrong produces files that are silently non-interoperable,
    with nothing in the header to detect the mismatch.

  - **Domain separation (REQUIRED):** the raw Argon2id output is NEVER used
    directly as the secretstream key. It is used as the KEY to a keyed
    BLAKE2b hash (`crypto_generichash`) of the fixed, app-specific context
    string below, and THAT 32-byte output is the actual stream key:
    ```
    STREAM_KEY_CONTEXT = b"cesvu.com/v1/stream-key"
    stream_key = crypto_generichash_blake2b(
                     message=STREAM_KEY_CONTEXT,
                     digest_size=32,
                     key=raw_key)   # raw_key = crypto_pwhash(...) output
    ```
    This guarantees the derived key can never be reused as-is by another
    application/protocol that happens to run Argon2id with the same
    passphrase, salt, and parameters. `raw_key` MUST be discarded/zeroized
    immediately after this step — it is never used for anything else
    (not even `keyCheck`, which is keyed by `stream_key`, see below).

    Python reference (PyNaCl):
    ```python
    import nacl.bindings as b

    STREAM_KEY_CONTEXT = b"cesvu.com/v1/stream-key"

    def derive_stream_key(raw_key: bytes) -> bytes:
        return b.crypto_generichash_blake2b_salt_personal(
            STREAM_KEY_CONTEXT, digest_size=32, key=raw_key
        )
    ```

- **Cipher:** XChaCha20-Poly1305 secretstream
  (`crypto_secretstream_xchacha20poly1305_*`). Each chunk is
  `ciphertext || 17-byte MAC`.
- **AEAD binding:** the ENTIRE file header (offsets 0 .. `ciphertextOffset`) is
  passed as the `ad` (associated data) on the FIRST secretstream chunk only.

## Header layout (v1)

```
0        6   magic '.CESVU'
6        2   version (uint16 BE) = 1
8        2   preamble length PL (uint16 BE, 0..4096)
10       PL  preamble (UTF-8)


Post-preamble, base = 10 + PL:
base+0   1   cipherMode (1 = secretstream_xchacha20poly1305)
base+1   4   KDF memory KiB (uint32 BE, 65536..262144)
base+5   1   KDF time_cost (uint8, 1..10, default 3)
base+6   1   passProfile (1 = text/diceware, 2 = emoji, 3 = raw)
base+7   32  salt slot  (first crypto_pwhash_SALTBYTES bytes are the salt;
             remainder is RESERVED — see "Reserved slot bytes" below)
base+39  2   chunkShift (uint16 BE, 16..24 → chunkSize = 1 << chunkShift)
base+41  32  streamHeader slot (first HEADERBYTES are the secretstream
             header; remainder is RESERVED — see below)
base+73  32  keyCheck   ← field added for fast wrong-passphrase detection
```

- **ciphertextOffset = base + 105** (`POST_PREAMBLE_FIXED = 105`).

- The ciphertext body (all secretstream chunks) begins at `ciphertextOffset`.

### Reader field-check order and unknown-version handling

Both reference implementations perform a fixed sequence of cheap,
pre-authentication checks on a freshly-opened file, in this exact order,
before any Argon2id run:

1. **`magic`** (offset 0, 6 bytes) — MUST equal `.CESVU` exactly, or reject
   with `BAD_MAGIC`.
2. **`version`** (offset 6, uint16 BE) — MUST equal the implementation's
   supported version (**`1`**, currently the only version this spec
   defines) by **strict equality**, or reject with `UNSUPPORTED_VERSION`.
   This is not a minimum-version or range check: a `version` of `0`, `2`,
   or any other value is rejected identically to a `version` of, say,
   `65535`. There is no partial or best-effort parsing of a header
   declaring an unrecognized version — a reader MUST NOT attempt to
   interpret any byte after the version field once this check fails,
   because a future version is free to redefine the entire post-`version`
   layout (field order, widths, offsets) with no compatibility
   obligation to v1 readers. This strictness is what makes future format
   evolution safe: a v2 reader can always tell a v1 file from a v2 file
   before parsing anything version-specific, and a v1 reader can never be
   tricked into misinterpreting v2 bytes as v1 fields.
3. **`cipherMode`** (offset `base+0`, 1 byte) — MUST equal `1`
   (`secretstream_xchacha20poly1305`, the only mode this spec defines),
   or reject with `UNSUPPORTED_CIPHER_MODE`.
4. **KDF `memory_cost`/`time_cost` range checks**, then **`chunkShift`
   range check** (see "Practical limits" above) — both MUST be
   range-checked before Argon2id runs, since they are attacker-controlled
   header fields read before the header itself can be authenticated (see
   "Argon2 params are attacker-controlled" in the implementation's module
   docstring).

Only after all of the above pass does key derivation begin. None of
`BAD_MAGIC`, `UNSUPPORTED_VERSION`, or `UNSUPPORTED_CIPHER_MODE` say
anything about the supplied passphrase — a reader MUST NOT prompt the
user to re-enter their passphrase for any of these three, since no
passphrase-dependent operation has been attempted yet.

**This also rules out version-downgrade attacks.** Because `version` sits
inside the AD-bound header (see "AEAD binding" above), an attacker cannot
take a genuine v2 (or later) file, rewrite its `version` field to `1`, and
have a v1 reader silently misinterpret v2-layout bytes as v1 fields: the
header no longer matches what was authenticated at encryption time, so
chunk 1's MAC fails and the reader gets `WRONG_PASSPHRASE_OR_HEADER_TAMPER`
rather than a successful decrypt. The strict-equality check above prevents
*misparsing*; AEAD binding prevents *forging* the field to enable that
misparse in the first place — both are required together.

### File extension convention

A conforming writer SHOULD name its output file with a `.cesvu`
extension — all three reference implementations do this by default (CLI:
`<stem>.cesvu`; web app: `buildCesvuDownloadName()`; NPM: the same
convention via `file-io.ts`). Identity as a valid .cesvu v1 file is
established entirely by the 6-byte `.CESVU` magic at offset 0 (see above),
never by filename — the extension is a naming convention, not a format
requirement.

**This is not applied uniformly across the three implementations, and the
divergence has a real practical consequence, not just a cosmetic one.**
The CLI and NPM package validate a file solely via its magic bytes: they
will decrypt a `.cesvu`-format file under any filename or extension,
including none at all. The web app is different: its drop/pick handlers
(`DocumentPane.svelte`, `Workspace.svelte`) decide whether to route a file
into the decrypt/unlock flow versus the normal document-parsing pipeline
by checking the `.cesvu` extension on the filename FIRST — before any
magic-byte read — with no fallback sniff if the extension doesn't match.
This routing is deliberate (there is an explicit mobile-Safari workaround
in `DocumentPane.svelte` because `accept=".cesvu"` doesn't filter picker
results there, backed by a manual extension check and an explicit "Please
select a .cesvu file." rejection), but its cross-implementation
consequence does not appear to have been evaluated against the other two
tools' extension-agnostic behavior. **Practical consequence:** a valid
.cesvu file renamed to a different or missing extension remains fully
decryptable via the CLI or the NPM package, but will not be offered the
web app's unlock flow at all — the web app has no magic-byte-sniffing
fallback for this case today.

### Reserved slot bytes




The `salt` and `streamHeader` fields are fixed 32-byte **slots** that hold a
value shorter than the slot (`crypto_pwhash_SALTBYTES` = 16 and
`crypto_secretstream_xchacha20poly1305_HEADERBYTES` = 24 respectively). The
leftover bytes in each slot are RESERVED.

- Producers SHOULD write zero into the reserved bytes.
- **Consumers MUST ignore them.** Both reference implementations slice exactly
  the constant's worth out of the slot and never look at the remainder, so a
  consumer MUST NOT reject a file over their contents.

Note this is a *parsing* rule, not a security one: the reserved bytes sit
inside the header, which is bound as associated data on the first secretstream
chunk, so altering them still breaks the chunk-1 MAC and fails the decrypt.
Ignoring them means "don't validate them", not "don't authenticate them".

An earlier revision of this document said the reserved bytes "MUST be zero".
That was wrong: no parser on either side enforced it, so the requirement
described a rule nothing implemented — and a consumer that started enforcing
it would have rejected files the other implementation happily produces.

### Practical limits (chunk size vs. total stream length)

`chunkShift`'s allowed range (16..24) bounds only the **per-chunk** size —
64 KiB at the low end, 16 MiB at the high end (plus a 17-byte MAC per
chunk). It places **no limit on total file size or chunk count**: the
secretstream construction underneath (`crypto_secretstream_xchacha20poly1305`)
has no practical ceiling on stream length at any chunk size — libsodium
documents essentially unbounded total stream length, with per-message
limits (~256 GB) that are moot at these chunk sizes. This spec does not
impose an additional cap of its own.

A conforming reader MUST be prepared to buffer at least one full chunk —
up to `1 << 24` bytes (16 MiB) plus the 17-byte MAC — in memory before it
can yield any decrypted output for that chunk, regardless of overall file
size. Both reference implementations decrypt chunk-by-chunk (streaming),
so their memory ceiling is one chunk's worth, not the whole file — but a
naive or buggy reader that tries to buffer the *entire* ciphertext body
before decrypting has no protection from this spec against an
attacker-supplied file with an enormous total length; that concern is an
implementation/DoS-hardening detail outside the wire format itself, not a
gap in the format.

### KDF memory KiB is a uint32 BE


Both the TypeScript and Python sides write/read the 4-byte big-endian value
directly — no `bigint`/64-bit handling is needed:

```python
import struct

# Write (big-endian uint32):
header_bytes += struct.pack('>I', memory_kib)

# Read:
(memory_kib,) = struct.unpack_from('>I', header_bytes, offset)
```

## keyCheck (32 bytes @ base+73)

Purpose: let a client detect a **wrong passphrase** using only the header —
one Argon2id run + one constant-time compare — WITHOUT reading/decrypting any
ciphertext chunk (critical for large streamed files).

Definition (keyed BLAKE2b via libsodium `crypto_generichash`):

```javascript
KEYCHECK_CONTEXT = b"cesvu/keycheck/v1"
keyCheck = crypto_generichash_blake2b_salt_personal(
               message=KEYCHECK_CONTEXT,
               digest_size=32,
               key=derived_key,
               salt=b"", personal=b"")     // salt = empty, personal = empty
```

- Write it into the header at `base+73` on encrypt.

- On decrypt/verify: derive the key from the entered passphrase + header salt,
  recompute `keyCheck`, and `sodium_memcmp` (constant time) against the stored
  32 bytes. Mismatch ⇒ wrong passphrase (reject before touching the body).

### ⚠️ `keyCheck` is an OPTIMIZATION, never proof

`keyCheck` lives in the **public, unauthenticated** header. It is covered by
the first chunk's MAC (the whole header is that chunk's associated data), but
only once you actually pull that chunk — the field is not self-authenticating.

The asymmetry is what matters:

- **Mismatch is conclusive.** The passphrase is wrong; reject immediately.
- **A match proves nothing on its own.** An attacker who can modify the file
  can rewrite `salt`, the KDF params, `passProfile`, `streamHeader` *and*
  `keyCheck` together as a self-consistent set — for example by re-encrypting
  any content under a password they choose and grafting that whole header onto
  the victim's ciphertext body. A `keyCheck`-only comparison then returns
  "valid" for the **attacker's** password, even though the body will never
  decrypt.

Therefore a conforming implementation MUST NOT answer "is this passphrase
correct?" from `keyCheck` alone. It must additionally `init_pull` with
`streamHeader` and successfully `pull` **at least the first ciphertext
segment**, passing the full header as associated data. Only that MAC binds the
passphrase to the actual file.

Implementations SHOULD expose these as two clearly distinct calls, so the weak
one cannot be reached for by accident:

| Call | Reads | Guarantee |
| --- | --- | --- |
| `matches_unauthenticated_header_key_check()` | header only | none — UX hint only, never for authorization |
| `verify_passphrase()` | header + first segment | authenticated (first segment only) |

All three implementations follow this split — the TypeScript
`cesvu-crypto.ts` (in both the web app and the NPM package, which share
the same source) and the Python `cesvu_crypto.py` — and `verify_passphrase()`
raises `TOO_SHORT` on header-only input rather than silently degrading to
the unauthenticated answer.

**Postcondition — what a `true` actually promises.** `verify_passphrase()`
authenticates the FIRST ciphertext segment and nothing else, so `true` means
"this passphrase decrypts this file's first segment". It is NOT an integrity
statement about the rest of the body: a file whose later chunks are corrupted,
or that is truncated, still returns `true` here and only fails later in the
decrypt, with `CIPHERTEXT_CORRUPT` or `TRUNCATED` respectively.

**Appended data is NOT in that list — the answer depends on framing.** The
"first segment" is a fixed-size slice, `cipherBody[:chunkSize+ABYTES]`. When
the body is not segment-aligned (the common case, since the final segment is
usually short), appended bytes land INSIDE that slice, the first segment's MAC
fails, and `verify_passphrase()` returns `false`. Only when the body happens
to be exactly segment-aligned do the appended bytes fall outside the slice,
giving `true` here and `TRAILING_DATA` later during a full decrypt. An
appended-to file may therefore produce either answer, decided by its segment
framing rather than by anything semantically meaningful; implementations MUST
NOT rely on `true` for such files. (An earlier revision of this document
claimed `true` unconditionally for appended data — that was incorrect.)

That division is deliberate — the cheap call answers "is the passphrase right?" in
constant time regardless of file size, and the decrypt answers "is the whole
file intact?".

- It is one-way (keyed hash of a fixed constant), so publishing it leaks
  nothing about the key.
- Tampering with it *in an otherwise untouched file* is caught, because the
  header is the first chunk's associated data — but that detection only
  happens when the first chunk is actually pulled, which is exactly the step
  a `keyCheck`-only check skips. See the warning above.


### Python reference (PyNaCl)

```python
import nacl.bindings as b

KEYCHECK_CONTEXT = b"cesvu/keycheck/v1"

def compute_key_check(derived_key: bytes) -> bytes:
    # BLAKE2b keyed hash, 32-byte digest.
    return b.crypto_generichash_blake2b_salt_personal(
        KEYCHECK_CONTEXT, digest_size=32, key=derived_key
    )

# ⚠️ Unauthenticated. A False result is conclusive; a True result is NOT.
# Named to make misuse obvious at the call site.
def matches_unauthenticated_header_key_check(
    derived_key: bytes, stored_key_check: bytes
) -> bool:
    return b.sodium_memcmp(compute_key_check(derived_key), stored_key_check)


# The real check: cheap reject on keyCheck, then AUTHENTICATE by pulling the
# first ciphertext segment with the full header as associated data.
def verify_passphrase(
    derived_key: bytes,
    stored_key_check: bytes,
    stream_header: bytes,
    header_bytes: bytes,
    first_segment: bytes,
) -> bool:
    if not matches_unauthenticated_header_key_check(derived_key, stored_key_check):
        return False  # conclusive: wrong passphrase
    state = b.crypto_secretstream_xchacha20poly1305_state()
    try:
        b.crypto_secretstream_xchacha20poly1305_init_pull(
            state, stream_header, derived_key
        )
        # Raises nacl.exceptions.CryptoError if the MAC does not verify.
        b.crypto_secretstream_xchacha20poly1305_pull(
            state, first_segment, header_bytes
        )
    except Exception:
        return False
    return True
```


## Metadata field length limits (and the unit they are measured in)

The encrypted payload begins with a length-prefixed JSON metadata object.
Its string fields are bounded:

| field | limit | required |
| --- | --- | --- |
| `filename` | 255 | yes |
| `mimeType` | 127 | no — defaults to `text/plain` |
| `template` | 63 | no |

The metadata object also carries `createdAt`, a required non-negative
integer (`z.number().int().nonnegative()` / Python `int`, excluding
`bool`). **`createdAt` is normatively milliseconds since the Unix epoch**
— the same convention as JavaScript's `Date.now()`. All three reference
implementations MUST populate it this way:

- **Web app** (`src/lib/stores/vault-io.ts`): `Date.now()`.
- **Python CLI** (`CLI/cesvu/src/cesvu/cli.py`): `int(time.time() * 1000)`.
- **NPM package** (`NPM/src/file-io.ts`): `Date.now()`.

This is called out explicitly because the schema itself does not, and
cannot, enforce a unit — `z.number().int().nonnegative()` accepts seconds,
milliseconds, or any other scale equally. A producer emitting the wrong
scale does not break decryption (the field round-trips as whatever integer
it is), but it silently corrupts every consumer that assumes milliseconds
and renders the value as a human-readable date — e.g. `new Date(createdAt)`
in JavaScript — producing a date near the Unix epoch (1970) instead of the
file's actual creation time. Treat any new implementation's `createdAt`
value as **milliseconds**, not seconds, and verify against `Date.now()`'s
order of magnitude in tests.

**These limits were previously stated nowhere, and the two implementations
counted them in different units.** That ambiguity is the whole problem, so
the unit is now normative:


- **Readers** MUST accept any value within the limit measured in **Unicode
  code points**.
- **Writers** MUST additionally keep every value within the limit measured
  in **UTF-16 code units**.

### Why writers and readers use different measures

For every string, code points <= UTF-16 code units (an astral character —
emoji, rare CJK — is one code point but a surrogate PAIR in UTF-16). The two
reference implementations inherited whichever measure their language made
natural: Python's `len()` counts code points, and TypeScript's Zod
`z.string().max(n)` counts UTF-16 units. So the TypeScript reader is strictly
the stricter of the two.

A writer checking only code points can therefore emit metadata the TypeScript
reader refuses. A 200-emoji filename is 200 code points but 400 UTF-16 units:
accepted by Python, rejected by the web app. The rejection happens *after*
the payload has authenticated, so it surfaces as `METADATA_CORRUPT_POST_AUTH`
— the web app tells the user their passphrase is correct and still refuses to
recover the file.

This is the same invariant that pins the RAW passphrase byte cap: **the CLI
must never produce a file the web app cannot open.** Requiring both measures
on write, and only the looser one on read, satisfies it in both directions —
narrower writer, unchanged reader.

Tightening the *reader* to match would be the wrong repair. It cannot un-write
files that already exist; it can only turn files that open today into files
that do not, converting an interop wrinkle into data loss.

### Why not UTF-8 bytes

Bytes are the most portable measure and are what most filesystems actually
cap, so they are the obvious candidate — but adopting them here would be a
regression. CJK characters are 3 UTF-8 bytes each, so a 255-**byte** rule cuts
a CJK filename from 255 characters to 85, penalising non-Latin users to fix a
problem they never had. The code-point/UTF-16 pair leaves every BMP string —
including all CJK — at exactly the limit it has today, and constrains only
astral characters, which are the sole case where the two implementations ever
disagreed.

### Practical reachability

Low, and worth stating so the check is not mistaken for a live exploit. A
value that trips this divergence (code points <= 255 but UTF-16 units > 255)
necessarily exceeds 255 UTF-8 bytes, and Windows, macOS and Linux all cap a
filename component at or below that. So `metadata.filename` taken from a real
file on disk cannot reach the divergent range; only programmatic callers
setting metadata directly can. The check is cheap, exact, and removes the
ambiguity permanently — but it is defence in depth, not an incident.

Covered by `CLI/cesvu/tests/test_metadata_length_units.py`.

## `metadata.filename` is AUTHENTICATED, not TRUSTED

`filename` lives inside the AEAD-protected metadata, so it cannot be altered in
transit. That is a much weaker guarantee than it looks: authentication proves
only that whoever produced the file held the passphrase, and the producer is
precisely the party a reader must defend against when a `.cesvu` arrives from
someone else. **A reader MAY use `filename` to inform an output path; it MUST
NOT let it decide one.**

Normative requirements for any implementation that writes a decrypted file to a
name derived from `filename`:

1. **Validate before the destructive step, not after.** Post-write verification
   cannot be a control, because the damage is already done. Measured on
   Windows 11: requesting `trailing...` reports success and lands on
   `trailing`, *destroying whatever that entry already held*; requesting `NUL`
   reports success, 0 bytes, and stores nothing at all. Noticing either
   afterwards does not bring the file back.
2. **Reject as a unit; do not sanitize into submission.** Stripping "unusual"
   characters destroys the extension dot, mangles every non-ASCII name, and
   still does not stop `NUL`. Salvaging the basename out of `../../etc/passwd`
   is equally wrong: containment is satisfied, but the attacker still chose the
   name, and `passwd`/`.bashrc`/`config.json` are useful names to choose.
3. **Apply the Windows rules unconditionally, on every platform.** A file
   decrypted on Linux and copied to Windows meets Win32 semantics there. The
   set that MUST be refused: path separators, drive/rooted/UNC forms
   (including the separator-less drive-relative `C:evil.txt`), `.` and `..`,
   `<>:"/\|?*`, NUL and C0 controls, names ending in a dot or space, and the
   reserved device stems (`CON` `PRN` `AUX` `NUL` `COM1-9` `LPT1-9`) matched on
   the stem so `NUL.txt` is caught too — including the superscript digit forms
   `COM¹`/`LPT²`/`COM³`, which Win32 folds onto 1/2/3 during device
   resolution.
4. **A metadata-derived name MUST NOT overwrite an existing entry, in any
   mode.** The user did not choose this name, so consent to overwrite cannot be
   inferred from a `-y`/`--force` flag, which speaks only for a path the user
   typed themselves.
5. **Escape the name for display; never echo it raw.** `a<U+202E>b.txt` is
   stored faithfully and passes every filesystem-level check, because the
   target of that attack is the human reading the output. ANSI escape
   sequences in a name must likewise be neutralised.
6. **When the written content is `doc.text` because a CFP1 envelope's raw
   section is empty for a `pdf`/`docx`/`excel` document (the "text
   fallback" case — see `isTextFallback` / `is_text_fallback` from the CFP1
   unwrap step), the chosen output name MUST carry a `.txt` extension, not
   the envelope's original extension.** The bytes actually being written
   are plain extracted text, not the original binary format, so preserving
   e.g. `contract-final.pdf` unchanged on a plain-text write produces a
   file whose extension lies about its contents — it looks corrupted to
   any PDF-associated application even though the decrypt succeeded
   completely. `txt`/`md` are never affected by this rule: for those types
   `text` is the native, complete representation of the file (there is no
   "original binary" being silently dropped), so their extension is always
   correct as-is.

Names that MUST still be accepted byte-for-byte, because they all save
correctly and rejecting them is a bug: `..pdf`, `...pdf`, `.pdf`,
`.gitignore`, `report .txt` (space *before* the dot), `契約書.pdf`,
`Übersicht.docx`, `🎯.png`, `NULL.txt`, `CONTRACT.pdf`.

Reference implementation and rationale: `CLI/cesvu/src/cesvu/output_names.py`
(`force_text_extension`) and `NPM/src/output-names.ts` (`forceTextExtension`),
with the `isTextFallback`/`is_text_fallback` determination itself made in the
CFP1 unwrap logic — `CLI/cesvu/src/cesvu/document.py` (`unwrap_cfp1_plaintext`)
and `NPM/src/document.ts` (`unwrapCfp1Plaintext`). Covered by
`CLI/cesvu/tests/test_output_names.py` / `test_document.py` and
`NPM/tests/output-names.test.ts` / `document.test.ts` / `file-roundtrip.test.ts`.


## metadata.mimeType is AUTHENTICATED, not TRUSTED

Same caveat as `filename` above: `mimeType` lives inside the AEAD-protected
metadata, so it is authenticated but not trustworthy — the `.cesvu`
producer chooses it freely and is exactly who a reader must defend against.

**Normative:** any implementation serving/downloading decrypted bytes to a
browser (Blob URL, `<a download>`, etc.) MUST hard-code a non-viewable
`Content-Type`/Blob `type` (`application/octet-stream`) and MUST NOT use
`metadata.mimeType` — a viewable type (`text/html`, `image/svg+xml`) chosen
by an attacker-controlled producer can turn a same-origin Blob URL into a
navigation or script-execution vector. Not applicable to implementations
that write straight to disk (Python CLI, NPM package). Enforced in
`vault-io.ts` (Tier 3 branch) and `ImportModal.svelte`'s raw-download path.

**Writer convention (all three implementations):** CFP1 documents get
`application/json`; everything else ("raw vault" payloads) gets
`application/octet-stream`. In the CLI/NPM this is just a sensible default;
in the web app it's also enforced independently on read (above), regardless
of what a producer wrote.

**Future direction:** register a dedicated `.cesvu` MIME type with IANA
(RFC 6838 vendor tree, e.g. `application/vnd.cesvu`) so the outer container
has a real recognized type instead of the generic `octet-stream` catch-all —
aspirational, not yet implemented by any reference implementation. 


## Conforming writer passphrase requirements

A conforming .cesvu v1 writer MUST emit exactly one of these two
canonical passphrase shapes, declared in the header via `passProfile`:

- **profile 1 \u2014 text/diceware:** exactly **6 words** from the EFF
  large wordlist (7,776 words, indices 0..7775 inclusive). A writer
  MUST NOT emit a 5-word or 7-word Diceware passphrase. A reader
  MUST reject any Diceware-style passphrase that is not exactly 6
  words (post-normalization). The 6-word default is the only one the
  v1 spec supports; v2 may add configurability. Rationale - creating
  an arbitrary length diceware UX for readers is an unnecessary 
  complication for a rare and likely illusory security benifit. 
  If inadequate entropy becomes a concern eventually, then profile 2 or 
  profile 3 can be utilized instead. 

- **profile 2 \u2014 emoji:** at least **8 emoji** from the curated
  800-emoji wordlist (indices 0..799 inclusive). A writer MAY emit
  more than 8 emoji for additional entropy; a reader MUST accept
  any emoji passphrase of 8 or more emoji and MUST NOT reject a
  passphrase solely for exceeding 8. A reader MUST reject any
  character that is not in the curated 800-emoji wordlist.

Both profiles are equally canonical: a conforming writer MAY emit
either as the default, and a conforming reader MUST treat them as
fully equivalent. The two are approximately equipotent (~77.55 bits
for 6-word Diceware, ~77.15 bits for 8-emoji; the ~0.4-bit
difference is negligible).

**Random word/emoji selection MUST be free of modulo bias.** A
conforming writer generating a profile-1 or profile-2 passphrase MUST
select each word/emoji from its wordlist with uniform probability —
drawing a CSPRNG value and reducing it via `value % wordlistLength`
WITHOUT rejection sampling introduces modulo bias whenever
`wordlistLength` does not evenly divide the CSPRNG's output range,
silently weakening the entropy this format's security margin (see
below) depends on. Both reference implementations already do this
correctly: the TypeScript side (`cesvu-crypto.ts`, shared by the web
app and the NPM package) draws 16-bit values and discards any value at
or above the largest multiple of the wordlist length that fits in 16
bits (`LIMIT` = 62208 for the 7776-word EFF list, `EMOJI_LIMIT` = 65200
for the 800-entry emoji list) before reducing; the Python side
(`passphrase.py`) delegates to `secrets.choice`, which performs
equivalent rejection sampling internally. A new implementation MUST use
an equivalent unbiased-selection technique (rejection sampling, or a
CSPRNG source natively free of this bias) rather than plain modulo
reduction.


### Security margin: threat model, KDF ratcheting, and quantum posture

The ~77-bit entropy floor above is sized against a well-resourced modern
adversary, not merely "large enough to sound safe." Against Argon2id at
the format's default memory cost (64 MiB, `OPSLIMIT_MODERATE`), an
attacker running a large array of current-generation consumer GPUs would
require, in round numbers, many orders of magnitude longer than the age of
the universe to exhaust a 77-bit keyspace. Even decades of continued
hardware progress narrow that margin by only a small, bounded number of
bits — nowhere near enough to bring brute force into range on its own.

**Entropy is the primary defense; the KDF is a multiplier on top of it,
not a substitute for it.** Memory-hardness raises the cost of each guess,
but it cannot manufacture entropy that was never there — a weak passphrase
under a strong KDF is still a weak passphrase, only slower to check. This
is why the wordlist-derived passphrase profiles above are enforced
requirements on a conforming writer, not advisory guidance: the entropy
floor is the property that ultimately protects a file, and it is also the
one property that cannot be raised retroactively once a file has been
encrypted (see next).

**KDF cost is designed to ratchet upward on a fixed review cadence, not
just reactively.** `memory_cost` and `time_cost` are stored per-file in
the header (see "Header layout" above) specifically so that future
encryptions can raise either parameter — as typical client hardware gains
RAM and compute — without breaking decryption of files already on disk;
each file simply carries the parameters it was actually encrypted with.
Maintainers of any conforming implementation SHOULD formally re-evaluate
the default `memory_cost`/`time_cost` **at least once every 2 years**,
independent of whether any specific attack has been demonstrated, and
raise the shipped default if commodity attacker hardware (GPU VRAM
capacity/bandwidth, in particular) has materially improved since the last
review. `memory_cost`'s current range cap (256 MiB) is a v1 policy choice,
not a wire-format ceiling, and MAY be raised in a future format revision
if a review concludes the existing cap is insufficient headroom. This
ratchet is why the KDF parameters are allowed to be modest defaults today:
they are the dial that is scheduled to be turned again, on a known
schedule, rather than left to erode silently. The passphrase entropy
floor is not such a dial — raising it in a future version protects only
newly-encrypted files, never files that already exist — which is precisely
why it is fixed generously today rather than deferred to the same cadence.

**Quantum computing does not materially change this calculus at present.**
A generic quantum search (Grover's algorithm) would, in principle, roughly
halve the effective entropy of an exhaustive search (~77 bits → ~38–39
bits). However, no cryptographically-relevant quantum computer capable of
mounting such a search exists as of this writing, none is credibly
projected within the near term, and Grover-style search does not
parallelize the way classical brute force does — nor does it bypass
Argon2id's memory-hardness, which constrains throughput on any execution
model, quantum or classical. The combination is judged adequate margin for
the foreseeable future, not a permanent guarantee, and is itself in scope
for the 2-year review above.

**When to revisit this outside the fixed cadence.** Two concrete,
falsifiable triggers should prompt an immediate out-of-cycle format
version bump with strengthened defaults, rather than waiting for the next
scheduled review: (1) a cryptographically-relevant quantum computer is
demonstrated, or (2) new analysis shows the effective entropy of a
canonical passphrase profile falls materially below its stated figure.
The per-file KDF parameter design (see above, and "Compatibility note"
below for its actual revision history) means either transition can be
gradual: files encrypted under today's parameters remain decryptable
under tomorrow's implementation, while new files adopt the strengthened
defaults immediately.

`passProfile = 3` (raw, identity normalization) is a separate
asymmetry between the web app and the other two reference
implementations — see "Custom password" below. The raw profile is
NOT a substitute for the two canonical passphrases above \u2014 it
exists for power users who want to supply an arbitrary non-wordlist
password, and the web app never writes raw-profile files. A
conforming reader MUST still accept and correctly decrypt any
`passProfile = 3` file produced by another tool.

The per-profile normalization rules (NFC, ASCII lowercase, whitespace
handling, the curated emoji deletions, etc.) are defined in the next
section. This section only establishes the conforming-writer
MINIMUM-LENGTH requirements; the cross-attempt Diceware-vs-emoji
dual-normalization requirement (
Applied in this exact order:

1. **Reject surrogates.** If any code point is in U+D800–U+DFFF, reject with
   `PASSPHRASE_INVALID_ENCODING`. This check MUST be explicit and MUST
   happen before encoding — the two runtimes disagree otherwise:
   Python's `str.encode('utf-8')` raises `UnicodeEncodeError`, while
   JavaScript's `TextEncoder` is required by WHATWG to silently substitute
   U+FFFD and never throw. Delegating to the encoder would let one side
   derive a key from bytes the user never typed.
2. **Normalize** per the profile rules below.
3. **Encode** the result as strict UTF-8.
4. **Reject if empty.** A zero-byte normalized passphrase is rejected for
   every profile.

### Profile 1 — text/diceware

1. Replace every CANONICAL_WHITESPACE code point with U+0020.
2. Collapse runs of U+0020 to a single U+0020; remove leading and trailing
   U+0020.
3. Apply **NFC** (*not* NFKC).
4. Lowercase **ASCII only**: U+0041–U+005A → U+0061–U+007A. No other code
   point is altered.

Note this is the **default** profile: any producer that does not specify a
passphrase type falls back to profile 1, so it must be well-defined for
arbitrary input, not merely for wordlist input.

### Profile 2 — emoji

1. Apply **NFC**.
2. Delete: U+FE0E, U+FE0F (variation selectors); U+200B–U+200D, U+FEFF
   (ZWSP/ZWNJ/ZWJ/BOM); U+202A–U+202E, U+2066–U+2069 (bidi controls).
3. Delete every CANONICAL_WHITESPACE code point.

### Profile 3 — raw

**Identity.** No normalization, trimming, lowercasing, whitespace
collapsing, or any other transformation is performed. Every code point,
including U+0020, is significant. The normalized form is the input,
unchanged.

Additionally, and **only** for this profile, the UTF-8 encoding MUST be
**1–512 bytes**; otherwise reject with `PASSPHRASE_TOO_LONG`. The limit is
measured in UTF-8 bytes, not characters — `String.prototype.length` counts
UTF-16 code units and Python's `len()` counts code points, so neither is a
portable measure. Profiles 1 and 2 have no upper byte limit.

> **Why 512, and the invariant behind it.** The web app's decrypt entry
> points (`SecureOpenModal.svelte`, `ImportModal.svelte`) refuse to submit a
> RAW passphrase longer than 512 **UTF-8 bytes** — the same unit and the
> same number as this cap. A CLI-written file therefore can never carry a
> passphrase the web app will not accept. The invariant to preserve whenever
> either number changes is:
>
> ```
> RAW byte cap <= the web app's RAW passphrase gate
> ```
>
> An earlier revision of this document specified 1024, which violates that
> invariant against the shipped UI gate. Both implementations
> (`RAW_PASSPHRASE_MAX_BYTES`) and `shared/passphrase-vectors.json`
> (`rawMaxBytes`) use 512; keep all of them in lockstep.
>
> **The UI counts bytes, not characters, and this matters.** That gate
> previously used JavaScript's `String.prototype.length` (UTF-16 code units)
> and labelled the result "characters". Because UTF-16 units <= UTF-8 bytes
> for every string (1:1 ASCII, 1:2 Cyrillic, 1:3 CJK, 2:4 astral), that was
> safe in the direction that matters — it could never admit a passphrase
> exceeding the byte cap — but it was wrong in both directions as a *number*:
>
> - **Over-counts astral characters.** 256 emoji is 512 UTF-16 units, so a
>   256-character password was blocked at half the real limit, while the
>   counter displayed "512/512 characters" — a figure the user cannot
>   reconcile with what they typed.
> - **Under-counts everything above ASCII.** 512 CJK characters is 512
>   UTF-16 units but 1536 bytes, so the submit button enabled and the crypto
>   layer then rejected the passphrase with `PASSPHRASE_TOO_LONG`.
>
> Implementations SHOULD count UTF-8 bytes in any passphrase-length UI, so
> the number shown to the user is the number actually enforced. The web app
> exposes `rawPassphraseByteLength()` from `cesvu-crypto.ts` for exactly
> this, and its former UTF-16 approximation constant has been removed.
>
> **The gate is a disabled submit button, not an `<input maxlength>`.** This
> is deliberate and SHOULD be matched: `maxlength` silently truncates a
> pasted password, so the user would submit a passphrase they never saw —
> failing as "wrong passphrase" on decrypt, or on an encrypt path producing
> a file whose real passphrase they do not know. A visible counter plus a
> disabled button reports the problem instead of hiding it.

> **Consequence, by design.** Because profile 3 applies no normalization, a
> password containing accented or composed characters is device-dependent:
> `"café"` typed on macOS is often NFD (`e` + U+0301) while the same
> password typed on Windows is NFC (U+00E9). They render identically in
> every font but are different passwords and derive different keys. This is
> deliberate — profile 3 accepts arbitrary input, so it applies zero
> transformation — but user-facing entry points for custom passwords SHOULD
> warn that non-ASCII characters may not transfer between devices.
>
> Profiles 1 and 2 keep NFC because their input comes from a fixed
> wordlist, where normalization cannot surprise the user.

### Why NFC is retained for profiles 1 and 2

NFC produced **zero** differences between Python 3.13 and Node 24 across
all 1,114,112 code points, whereas NFKC produced 37 and case mapping 55.
Unicode's Normalization Stability Policy guarantees that normalization is
identical across versions for characters assigned in both — so the residual
risk is limited to characters assigned only in the newer runtime, and
Unicode 16's additions carry compatibility decompositions and case mappings
but no canonical ones. That makes NFC materially safer than NFKC, though
the guarantee is empirical for new characters rather than absolute.

This profile 3 identity rule is used for the **custom password** option,
which is a Python CLI / NPM package feature (see below) — the web app
never writes `passProfile = 3`.


## Custom password: Python CLI / NPM package, not the web app

The web app (`ExportModal.svelte` and friends) only ever offers
**diceware** (`passProfile = 1`) and **emoji** (`passProfile = 2`)
passphrases when producing a `.cesvu` file. There is intentionally no
"custom password" (arbitrary user-supplied string, `passProfile = 3`)
option in the web UI's *export/encrypt* flow — that capability is reserved
for tooling better suited to power users who want to supply their own
password: the Python `cesvu` CLI (`--password` / raw-passphrase flag) and
the NPM package (`passphraseType: 'raw'` on `encryptCesvu`/
`encryptCesvuFile`, or `generatePassphrase('raw', rawPassphrase)` in
`passphrase-helpers.ts`). However, an option does exist to reply back
with a password already known to both parties (diceware or emoji), in
the web-app. The user is warned against creating their own password from
scratch here (such as all the same emoji type), and two buttons for random 
emoji and diceware generation are next to this.

As of this writing, the Python and NPM package do not enable arbitrary
encryption of `passProfile = 1` and `passProfile = 2` to a desired password.
These packages were designed with the thought they would be used for exporting
files for user opening on Cesvu, rather than part of the shared secret back and
forth flow (like the webapp), and for that reason this feature was omitted. 
Third parties could implement this feature if needed for their use case with 
minimal modifications, whilst being mindful of keeping the user's key secure.

However, the wire format's `passProfile = 3` (raw) is a first-class,
fully-supported profile, and the web app's **import/decrypt/open** flow
(`SecureOpenModal.svelte`, `ImportModal.svelte`, `decryptCesvu`/
`decryptCesvuStream`) MUST continue to accept and correctly decrypt any
file that declares `passProfile = 3`, exactly as it does for `passProfile`
1 and 2. In other words: files encrypted with a custom password via the CLI
or the NPM package must remain fully openable in the web app — only the
*encrypt*-side custom password entry point is unavailable in the web app,
not the format or the decrypt path.

## Preamble: not customizable by any of the three implementations

Every `.cesvu` file carries a plaintext, unauthenticated-by-itself
preamble field before the encrypted body (see layout above). All three
implementations — the web app, the Python `cesvu` CLI, and the NPM
package — always write the same canonical `DEFAULT_PREAMBLE` text on
encrypt; none of them expose an option to customize it. On decrypt, none
of the three implementations read, return, or display whatever preamble
text is present in a file's header — the field is skipped as OPAQUE bytes,
identified only by its declared `preambleLen`, which is all that's needed
to locate the rest of the header. (An earlier version of this spec
documented a Python-CLI/NPM-only custom-preamble feature; it has since
been removed from both packages.)


## Compatibility note


This is v1 (no version bump). Three fields have been added/widened since the
original v1 layout, in this order:

1. `keyCheck` was appended AFTER the `streamHeader` slot (offsets through
   `streamHeader` unchanged; total post-preamble size grew from 72 to 104
   bytes).
2. The KDF memory KiB field was widened from a 4-byte (`uint32`) to an
   8-byte (`uint64`) big-endian integer, shifting every field from
   `passProfile` onward by +4 bytes (total post-preamble size grew from
   104 to 108 bytes), and later **reverted back to a 4-byte `uint32`**
   (total post-preamble size returned to 104 bytes) once the extra
   headroom was determined to be unnecessary — see below.
3. A 1-byte KDF `time_cost` field was inserted immediately after the memory
   KiB field, shifting every field from `passProfile` onward by +1 byte
   (total post-preamble size grew from 104 to 105 bytes:
   `POST_PREAMBLE_FIXED = 105`). Previously `time_cost` was a fixed,
   unstored constant (`KDF_OPSLIMIT = 3`); it is now a per-file,
   range-checked ([1, 10], default 3) parameter, matching the existing
   `memory_cost` pattern — see "No Domain Separation in KDF" /
   configurable time_cost in the security review.

The current, authoritative layout is the uint32-memory-KiB version
documented above (`POST_PREAMBLE_FIXED = 105`, `memory KiB @ base+1` as a
4-byte field). The brief uint64 detour never shipped as a stable release
format and should be disregarded by new implementations.

### `MAX_PREAMBLE_LEN` raised 1024 → 4096

The app-level cap on the preamble field (`preambleLen`, uint16 @ offset 8)
was historically raised from **1024 to 4096 bytes** to give producer-side
preamble text room for a full short document rather than just a single
short paragraph. This is well in excess of today's preamble length but
is included in for future flexibility. 

This is NOT a wire format change: `preambleLen` was always a uint16 (max theoretical value 65535); only the enforced app-level
ceiling changed. It does not affect on-disk size for existing or shorter
preambles — the preamble field is always written as exactly `preambleLen`
bytes, never padded to the cap. This ceiling remains the shared parse-time
bound all three implementations enforce, independent of the fact that none
of them customize preamble content anymore (see above).

## Decrypt error codes

Both implementations classify decrypt failures by **whether any chunk's MAC
has already verified**, because that single bit determines whether the
passphrase can still be at fault:

| Code | Meaning | Passphrase implicated? |
| --- | --- | --- |
| `BAD_MAGIC` | first 6 bytes are not `.CESVU` | no — checked before `version` is even read |
| `UNSUPPORTED_VERSION` | `version` field is not exactly `1` (see "Reader field-check order" above) | no — checked before any KDF/passphrase work |
| `UNSUPPORTED_CIPHER_MODE` | `cipherMode` is not exactly `1` | no — checked before any KDF/passphrase work |
| `WRONG_PASSPHRASE_OR_HEADER_TAMPER` | pre-auth failure: keyCheck mismatch, or the first chunk's MAC failed | yes — **and deliberately ambiguous** |
| `CIPHERTEXT_CORRUPT` | a later chunk failed its MAC | no |

| `TRUNCATED` | stream ended without `TAG_FINAL` after ≥1 chunk verified | no |
| `TRAILING_DATA` | bytes present in a segment after a verified `TAG_FINAL` | no |
| `METADATA_CORRUPT_POST_AUTH` | payload authenticated but its metadata prefix is malformed | no |
| `TOO_SHORT` | structurally incomplete (e.g. header with no ciphertext, or a body shorter than one MAC) | no |
| `METADATA_CORRUPT` | metadata prefix malformed or failing the metadata schema, seen pre-auth | no |
| `STREAM_HEADER_INVALID` | `streamHeader` rejected by `init_pull` (malformed, wrong length) | no |
| `PASSPHRASE_INVALID_ENCODING` | the supplied passphrase contains a surrogate code point (U+D800–U+DFFF) | n/a — rejected before the KDF |
| `PASSPHRASE_TOO_LONG` | profile 3 only: normalized passphrase exceeds 512 UTF-8 bytes | n/a — rejected before the KDF |

The two `PASSPHRASE_*` codes describe the **caller's input**, not the file.
They are raised before Argon2id runs, on both encrypt and decrypt, and they
leak nothing about the file: a conforming producer cannot have written a file
whose passphrase violates them, so rejecting on decrypt can never refuse a
legitimate file — it only replaces a mystifying
`WRONG_PASSPHRASE_OR_HEADER_TAMPER` with an actionable message.



`TOO_SHORT` for a too-short body MUST be raised **before** the KDF runs. A body
smaller than one secretstream MAC cannot authenticate under any passphrase, so
deriving first would burn a full Argon2id run (up to 256 MiB) only to report
the ambiguous pre-auth code — blaming the user's passphrase for a file that is
merely truncated. Both the one-shot and streaming decrypt paths check this at
the point the body length first becomes known.

The Python CLI and NPM package both now treat the preamble field as OPAQUE
padding on decrypt — its bytes are never UTF-8 decoded or validated, only
its declared length is used to locate the rest of the header. Malformed or
non-UTF-8 bytes in that field therefore do not raise any error in either
implementation (there used to be a Python-only `BAD_PREAMBLE_ENCODING`
code for this; it has been removed, since there is no longer any decoding
step that could fail).

The ambiguity in `WRONG_PASSPHRASE_OR_HEADER_TAMPER` is **intentional and MUST
be preserved**. Before any MAC verifies there is no way to distinguish a wrong
passphrase from a tampered header, and inventing a distinction would leak
which one an attacker got right. Every code below it is only reachable after
authentication succeeded, so an implementation MUST NOT tell the user to
re-enter a passphrase that has already been cryptographically proven correct.

Note `TRAILING_DATA` requires the extra bytes to fall in a segment *after* the
final chunk. Junk appended inside the last (partial) segment simply makes that
segment's MAC fail, which — if nothing has authenticated yet — correctly
surfaces as the ambiguous pre-auth code instead.

## Secretstream tag policy

Producers MUST emit only `TAG_MESSAGE` (0x00) on non-final segments and
`TAG_FINAL` (0x03) on the last one. Consumers MUST reject any other tag
value with `CIPHERTEXT_CORRUPT`.

This is not a breaking change: the tag byte is covered by each segment's MAC,
so a non-conforming tag is only reachable *after* authentication succeeds, and
no reference implementation has ever emitted `TAG_PUSH` (0x01) or
`TAG_REKEY` (0x02). No conforming file can exist that this rule would reject.
All three implementations MUST adopt it together — a check in only one of
them would be exactly the kind of drift this document exists to prevent.

## The end result of all this complexity

It just works! Every byte is pinned — magic, version, header layout, KDF parameters, normalization, error codes — so a file encrypted on one platform, in one language, by one tool, opens correctly everywhere else, every time. No format guessing, no silent corruption, no "works on my machine."

That reliability pays off differently depending on who's holding the file. A non-technical recipient gets security with zero configuration: type words or copy/paste emojis correctly, click open, done — never having chosen a cipher, a KDF, or a chunk size. A developer building on the CLI or the NPM package gets the opposite: custom passwords, custom preambles, raw payloads, full control over every parameter this spec makes configurable. Neither audience compromises to get the other's benefit, and both land on files that open identically in the web app, the CLI, and any third-party implementation that follows this document.

That's the trade this spec is built around: absorb the complexity once, here, so that everyone downstream — casual user or protocol implementer — experiences something simpler than the problem actually is. Every normative "MUST" above exists to make a future implementer's file open on the first try, not the fifth.
