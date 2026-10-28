# .cesvu v2 wire format — plain, checksummed container

This is the single source of truth that implementations MUST match, byte for
byte: the reference implementation in this repository
(`src/lib/export/cesvu-export.ts`). Any drift makes files produced by one
tool unreadable by another.

This specification is licensed under Apache 2.0; see
[`../LICENSE.md`](../LICENSE.md) for the full license text. The Apache 2.0
commitment applies to *implementers* of this format in any language, not
just to *this* implementation — anyone may write a .cesvu reader or
writer for any purpose without attribution, royalty, or restriction.

## Scope and security model

**This format provides integrity, not confidentiality.**

- **NO confidentiality.** There is no encryption, no passphrase, no key, no
  secret of any kind anywhere in this format. Anyone who possesses a
  `.cesvu` file can read its entire contents with a text editor. This is
  the defining characteristic of v2 and MUST NOT be described otherwise.
- **YES, integrity (against accident).** A SHA-256 checksum over the
  payload lets a reader detect **accidental** corruption or truncation —
  a bad download, a flaky USB drive, a copy interrupted mid-transfer, a
  partially-flushed write.
- **NOT tamper-evidence.** The checksum is **unkeyed**. An attacker who
  can modify the file can recompute a matching checksum trivially. Do not
  represent this format as tamper-proof or as protecting against a
  motivated adversary. It guards against bit-rot, nothing more.

If you need confidentiality for a file, encrypt it with a real tool before
wrapping it in a `.cesvu` container.

### Relationship to v1

A previous, **encrypted** `.cesvu` v1 envelope existed (Argon2id KDF +
XChaCha20-Poly1305 secretstream). It was implemented by standalone Python
CLI and Node.js/NPM packages that are no longer part of this project.

**v1 and v2 are distinct formats, not two revisions of one format.** They
happen to share the same magic bytes and the same `.cesvu` file extension,
but their layouts are unrelated. A v2 reader encountering a v1 file MUST
reject it (see [Versioning](#versioning)) rather than attempt to parse it.

## Container layout

All multi-byte integers are **unsigned, big-endian**.

| Offset | Size (bytes) | Field | Description |
|:------:|------------:|-------|-------------|
| `0` | `6` | Magic | ASCII `".CESVU"` |
| `6` | `2` | Version | `uint16` (Big Endian), currently `2` |
| `8` | `2` | Preamble Length | `uint16` (Big Endian), range `0–4096` |
| `10` | `PL` | Preamble | UTF-8 encoded text, exactly `PL` bytes |
| `10+PL` | `2` | Metadata Length | `uint16` (Big Endian), range `1–4096` |
| `12+PL` | `ML` | Metadata | UTF-8 JSON object, exactly `ML` bytes |
| `12+PL+ML` | `32` | Checksum | SHA-256 digest of the payload bytes |
| `44+PL+ML` | `*` | Payload | CFP1-framed document bytes (see below) |

Where:

- `PL` = Preamble Length (the uint16 at offset `8`)
- `ML` = Metadata Length (the uint16 at offset `10+PL`)

**The payload has no explicit length field.** Its length is implicit: the
payload runs from offset `44+PL+ML` to end-of-file. This means the file
length is the only thing bounding it, so a reader MUST treat the remainder
of the buffer as the payload and MUST NOT attempt to read a length prefix
that does not exist.

**Checksum coverage:** the SHA-256 digest covers **only the payload bytes** —
from offset `44+PL+ML` to end-of-file. It does **not** cover the magic,
version, preamble, or metadata. A reader MUST verify the digest against
exactly that byte range.

## Reader validation order

A conforming reader MUST perform these checks **in this order**, and MUST
fail closed (reject the file) on the first failure. The order matters: it
keeps every subsequent step operating on already-validated, bounded input.

| # | Check | Error code |
|---|-------|-----------|
| 1 | File length `>= 10` (the fixed prefix) | `TOO_SHORT` |
| 2 | Bytes `0–5` equal `".CESVU"` | `BAD_MAGIC` |
| 3 | Version (bytes `6–7`) equals `2` | `UNSUPPORTED_VERSION` |
| 4 | Preamble Length `<= 4096` | `BAD_PREAMBLE_LENGTH` |
| 5 | File long enough to contain the preamble + its 2-byte metadata-length field | `METADATA_INCOMPLETE` |
| 6 | Metadata Length in range `1–4096` | `METADATA_CORRUPT` |
| 7 | File long enough to contain the metadata + the 32-byte checksum | `METADATA_INCOMPLETE` |
| 8 | Metadata parses as JSON **and** matches the metadata schema | `METADATA_CORRUPT` |
| 9 | SHA-256 of the payload matches the stored checksum | `CORRUPTED` |

Notes:

- Step 3 MUST come **before** any length-prefix arithmetic that depends on
  the version, because the layout above is version-specific.
- Steps 4 and 6 are range checks on attacker-controlled length prefixes.
  They MUST happen **before** the corresponding buffer is allocated or
  sliced, so a malicious file declaring a 65,535-byte preamble cannot
  cause an over-read.
- Step 9 MUST compare the digests in **constant time**. (A plain `===`
  on two byte arrays leaks timing information in principle. It is not a
  practical exploit against this format — the checksum is unkeyed, so
  there is no secret to leak — but constant-time comparison costs nothing
  and is the correct habit.)

### Error codes

| Code | Meaning |
|------|---------|
| `TOO_SHORT` | File is shorter than the fixed 10-byte prefix. |
| `BAD_MAGIC` | The leading 6 bytes are not `".CESVU"`. |
| `UNSUPPORTED_VERSION` | The version field names a format this reader does not implement. |
| `BAD_PREAMBLE_LENGTH` | The preamble length prefix exceeds the 4096-byte cap. |
| `METADATA_CORRUPT` | The metadata length prefix is out of range, or the metadata is not valid JSON, or it does not match the schema. |
| `METADATA_INCOMPLETE` | The file ends before the header/metadata/checksum section is fully present. |
| `CORRUPTED` | The payload's SHA-256 does not match the stored checksum. |

## Versioning

- The current version is **`2`**.
- A reader encountering any other version MUST reject the file with
  `UNSUPPORTED_VERSION`. It MUST NOT attempt to parse it under the v2
  layout, and MUST NOT "guess" a compatible interpretation.
- The reference implementation's message format is:

  ```
  This file is v{version}. Use another build of Cesvu that supports v{version} files.
  ```

- A future version MAY add fields, but MUST NOT reuse or repurpose the
  meaning of any field defined here, and MUST bump the version number so
  that older readers reject the file rather than mis-parse it.

## Preamble

The preamble is **purely informational**. It is never parsed for anything
structural — a conforming reader MAY display it, MAY ignore it, and MUST
NOT depend on its content for any parsing decision.

Its purpose is human-facing: someone who opens the raw file bytes in a
text editor, a hex viewer, `strings`, or an email client's preview pane
sees a plain-language explanation instead of silently-truncated binary
noise, and is warned against hand-editing a binary container.

- Maximum length: **4096 UTF-8 bytes** (the uint16 prefix can address
  65,535, but 4096 is a deliberate app-level sanity ceiling).
- A writer MUST NOT pad the preamble out to the cap — it writes exactly
  the number of bytes the preamble occupies.
- The default preamble written by the reference implementation is:

  ```
  <CRLF>This is a .cesvu file. Read it free at https://cesvu.com.<CRLF>Do not edit this file! Modifications will cause data loss.<CRLF>
  ```

  (where `<CRLF>` is a literal CR LF pair, `\r\n`.)

## Metadata

The metadata section is a **UTF-8 JSON object**. It is stored in the clear
— it is NOT encrypted, and because the format provides no confidentiality,
anyone can read it.

### Schema

```json
{
  "filename": "report.pdf",
  "mimeType": "application/pdf",
  "createdAt": 1767225600000,
  "template": "legal"
}
```

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `filename` | string | yes | max **255** |
| `mimeType` | string | yes (default `text/plain`) | max **127** |
| `createdAt` | number | yes | non-negative integer (Unix epoch milliseconds) |
| `template` | string | no | max **63** |

`createdAt` is Unix epoch **milliseconds**.

### Metadata length cap

The metadata JSON MUST be at most **4096 UTF-8 bytes**. The
`Metadata Length` prefix is a uint16, so it can address 65,535, but 4096
is a deliberate app-level sanity ceiling.

### ⚠️ String length limits are measured in UTF-16 code units, not bytes

The reference implementation validates the string fields with a schema
library whose `.max(n)` on a string counts **UTF-16 code units** (i.e.
`String.prototype.length`), **not** UTF-8 bytes and **not** code points.

This is not a nitpick — it is a real interoperability hazard:

- A string of 255 astral-plane characters (e.g. emoji) is 255 UTF-16 code
  units (510 UTF-8 bytes, 255 code points). It **passes** a 255-unit
  limit.
- A string of 200 astral-plane characters is 400 UTF-16 code units. It
  **fails** a 255-unit limit, even though it is only 200 characters and
  800 UTF-8 bytes.

A conforming implementation MUST pick one unit and document it. The
reference implementation uses **UTF-16 code units**; an implementation
choosing UTF-8 bytes or code points instead will disagree on the
boundary. If you implement in a language where strings are UTF-8 byte
arrays (e.g. Rust, Go), be deliberate about which you emulate.

### `metadata.filename` is TRUSTED-but-VALIDATED, not safe to render

**This is the most security-relevant rule in this specification.**

Because the format provides no confidentiality, `metadata.filename` is
readable by anyone who has the file — and it is **attacker-controlled**
content, exactly like the `filename` in a downloaded HTTP response or the
`filename` in a ZIP archive entry.

A conforming reader MUST therefore treat any filename derived from
`metadata.filename` as **untrusted input**, and MUST:

- **Validate** it before use — reject or sanitize path separators (`/`,
  `\`), drive letters, `..` segments, control characters, and NUL bytes.
- **Never** write it to a filesystem path without passing it through that
  validation first. A `.cesvu` file that names its payload
  `../../.bashrc` must not escape the target directory.
- **Never** render it in a context where it can execute (e.g. innerHTML)
  without escaping it for that context.
- Preserve the extension only for the purpose of choosing a parser or
  MIME type — never as a path component.

A reader that displays the filename SHOULD show it in a context that
cannot interpret it as markup.

### `metadata.mimeType` is likewise untrusted

The declared MIME type is a hint, not a fact. A reader MUST NOT use it to
decide that content is safe to render or execute. Prefer sniffing the
actual bytes where it matters, and treat the declared type as advisory.

## Checksum

- Algorithm: **SHA-256**.
- Computed over **the payload bytes only** (offset `44+PL+ML` to
  end-of-file). Not the header, not the metadata.
- Stored as the raw 32-byte digest (not hex-encoded) at offset
  `12+PL+ML`.
- The reference implementation computes it with the Web Crypto API
  (`crypto.subtle.digest('SHA-256', …)`) — a built-in, no third-party
  cryptographic dependency required.

### What the checksum guarantees

- The payload is **byte-for-byte** what the writer intended (modulo
  SHA-256 collision resistance).
- The file has **not** been truncated or corrupted in transit or at rest.

### What it does not guarantee

- **Not authenticity.** The checksum is unkeyed. Anyone who can modify
  the file can recompute a matching checksum. A file that passes the
  checksum check may have been deliberately altered.
- **Not header integrity.** The magic, version, preamble, and metadata
  are **not** covered by the digest. A reader that needs to detect
  modification of the metadata MUST use a different mechanism (e.g. a
  signature over the whole file, or a MAC with a key the reader holds).

## Payload framing (CFP1)

The payload is a **CFP1**-framed document. Framing exists so the original
source file travels as a raw binary section instead of base64-inside-JSON,
which would cost a 1.33× size inflation on top of `JSON.stringify`
duplicating a giant string.

| Offset | Size (bytes) | Field | Description |
|:------:|------------:|-------|-------------|
| `0` | `4` | Magic | ASCII `"CFP1"` |
| `4` | `4` | Document JSON Length | `uint32` (Big Endian) |
| `8` | `DL` | Document JSON | UTF-8 JSON, exactly `DL` bytes |
| `8+DL` | `*` | Raw source bytes | Implicit length = remainder of the payload |

- The **Document JSON** is the serialized `CesvuDocument` **with its
  `rawContent` field set to `null`** — the original source bytes ride in
  the raw section instead.
- The **Raw source bytes** section is **optional**. When the producer
  chose not to embed the original file, this section is **zero-length**
  and the payload ends at offset `8+DL`. A reader MUST determine its
  length as "the remainder of the payload", which is 0 in that case.
- The Document JSON Length is a **uint32**, so the document JSON may be
  up to 4 GiB. It is not the total file size; the total file size is
  bounded only by the storage medium.

## Writer requirements

A conforming writer MUST:

1. Write the magic `".CESVU"` at offset `0` and the version `2` at
   offset `6`, both as specified.
2. Write the preamble length prefix as the **exact** byte length of the
   UTF-8 encoded preamble — never padded, never rounded.
3. Write the metadata length prefix as the **exact** byte length of the
   UTF-8 encoded metadata JSON.
4. Serialize the metadata as a JSON object that matches the schema, and
   UTF-8 encode it.
5. Compute the SHA-256 digest over **exactly the payload bytes** it is
   about to write, and write that digest immediately before the payload.
6. Not read or write any field outside the layout defined above.

A conforming writer SHOULD:

- Range-check the preamble and metadata lengths against their caps
  **before** building the output buffer.
- Use the default preamble, or a preamble that serves the same
  human-facing purpose.

## Reference implementation

- `src/lib/export/cesvu-export.ts` — `buildCesvuFile()` (writer) and
  `parseCesvuFile()` (reader), plus the `CesvuError` type and the
  `CesvuErrorCode` union.
- `src/lib/export/cesvu-export.test.ts` — round-trip and
  corruption-detection tests.

Minimal writer, in JavaScript:

```js
async function buildCesvuFile(payload, metadata, preamble = DEFAULT_PREAMBLE) {
  const preambleBytes = new TextEncoder().encode(preamble);
  const metaBytes = new TextEncoder().encode(JSON.stringify(metadata));

  const checksum = new Uint8Array(
    await crypto.subtle.digest('SHA-256', payload)
  );

  const preambleEnd = 10 + preambleBytes.length;
  const metaStart = preambleEnd + 2;
  const metaEnd = metaStart + metaBytes.length;
  const checksumEnd = metaEnd + 32;

  const out = new Uint8Array(checksumEnd + payload.length);
  const dv = new DataView(out.buffer);
  out.set(new TextEncoder().encode('.CESVU'), 0);
  dv.setUint16(6, 2, false);
  dv.setUint16(8, preambleBytes.length, false);
  out.set(preambleBytes, 10);
  dv.setUint16(preambleEnd, metaBytes.length, false);
  out.set(metaBytes, metaStart);
  out.set(checksum, metaEnd);
  out.set(payload, checksumEnd);
  return out;
}
```

Minimal reader, in JavaScript:

```js
async function parseCesvuFile(bytes) {
  if (bytes.length < 10) throw new Error('TOO_SHORT');
  if (new TextDecoder().decode(bytes.subarray(0, 6)) !== '.CESVU') {
    throw new Error('BAD_MAGIC');
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = dv.getUint16(6, false);
  if (version !== 2) throw new Error('UNSUPPORTED_VERSION');

  const preambleLen = dv.getUint16(8, false);
  if (preambleLen > 4096) throw new Error('BAD_PREAMBLE_LENGTH');
  const preambleEnd = 10 + preambleLen;
  if (bytes.length < preambleEnd + 2) throw new Error('METADATA_INCOMPLETE');
  const preamble = new TextDecoder().decode(bytes.subarray(10, preambleEnd));

  const metaLen = dv.getUint16(preambleEnd, false);
  if (metaLen === 0 || metaLen > 4096) throw new Error('METADATA_CORRUPT');
  const metaStart = preambleEnd + 2;
  const metaEnd = metaStart + metaLen;
  if (bytes.length < metaEnd + 32) throw new Error('METADATA_INCOMPLETE');

  const metadata = JSON.parse(
    new TextDecoder().decode(bytes.subarray(metaStart, metaEnd))
  );
  const expected = bytes.subarray(metaEnd, metaEnd + 32);
  const payload = bytes.subarray(metaEnd + 32);
  const actual = new Uint8Array(await crypto.subtle.digest('SHA-256', payload));

  let diff = 0;
  for (let i = 0; i < 32; i++) diff |= actual[i] ^ expected[i];
  if (diff !== 0) throw new Error('CORRUPTED');

  return { metadata, preamble, payload };
}
```

## Conformance checklist

An implementation is conforming to this specification if it:

- [ ] Reads and writes the exact layout in [Container layout](#container-layout).
- [ ] Uses big-endian for every multi-byte integer.
- [ ] Validates in the order given in [Reader validation order](#reader-validation-order),
      and rejects on the first failure.
- [ ] Rejects an unknown version with `UNSUPPORTED_VERSION` rather than
      attempting a parse.
- [ ] Range-checks the preamble and metadata length prefixes before
      allocating or slicing.
- [ ] Computes the checksum over the payload bytes only.
- [ ] Compares the checksum in constant time.
- [ ] Treats `metadata.filename` as untrusted input and validates it before
      any filesystem write or HTML render.
- [ ] Measures string length limits in a documented unit (see the
      [UTF-16 code units](#-string-length-limits-are-measured-in-utf-16-code-units-not-bytes)
      caveat).
- [ ] Handles a zero-length raw source section in the CFP1 payload.
- [ ] Never claims the format provides confidentiality.

## License

This specification is licensed under Apache 2.0; see
[`../LICENSE.md`](../LICENSE.md). The Apache 2.0 commitment applies to
*implementers* of this format in any language, not just to *this*
implementation — anyone may write a .cesvu reader or writer for any
purpose without attribution, royalty, or restriction.





