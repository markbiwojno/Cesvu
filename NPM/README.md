# @cesvu/crypto

Zero-knowledge `.cesvu` v1 file encryption/decryption for Node.js —
XChaCha20-Poly1305 secretstream + Argon2id (via `libsodium-wrappers-sumo`),
sharing a byte-identical wire format with the [cesvu.com](https://cesvu.com)
web app and its Python CLI. A file encrypted by any one of the three can be
decrypted by either of the other two, given the same passphrase.

## Install

```sh
npm install @cesvu/crypto
```

## Quick start (in-memory)

```ts
import { encryptCesvu, decryptCesvu } from '@cesvu/crypto';

const plaintext = new TextEncoder().encode('Hello, cesvu!');

const ciphertext = await encryptCesvu(plaintext, 'correct horse battery staple winter forest', {
  metadata: { filename: 'hello.txt', mimeType: 'text/plain', createdAt: Date.now() }
});

const result = await decryptCesvu(ciphertext, 'correct horse battery staple winter forest');
console.log(new TextDecoder().decode(result.plaintext)); // "Hello, cesvu!"
console.log(result.metadata.filename); // "hello.txt"
```

## Quick start (files, atomic write)

```ts
import { encryptCesvuFile, decryptCesvuFile } from '@cesvu/crypto';

await encryptCesvuFile('./report.csv', './report.cesvu', 'my passphrase words here');

const result = await decryptCesvuFile('./report.cesvu', './report.out.csv', 'my passphrase words here');
console.log(result.metadata.filename); // "report.csv"
```

`encryptCesvuFile`/`decryptCesvuFile` write their output via a
write-to-temp-then-rename strategy (see `src/atomic-io.ts`), so a killed
process never leaves a corrupted-but-plausible output file behind.

## Document (CFP1) framing — opening files in the cesvu.com viewer

By default, `encryptCesvuFile` recognizes `.txt`/`.md`/`.csv` source files
and wraps them in the same **CFP1 document framing** the web app's own
Export button produces (see `src/document.ts`), matching the Python CLI's
default `cesvu encrypt` behavior. This means a `.txt`/`.md`/`.csv` file
encrypted with this package lands directly in cesvu.com's full document
viewer (clauses, chat, editable text) when a recipient opens it there —
instead of falling into the "raw vault" download-only path.

```ts
import { encryptCesvuFile, decryptCesvuFile } from '@cesvu/crypto';

// note.txt is auto-framed as a CFP1 document — opens in the web app's
// viewer, not as a raw download.
await encryptCesvuFile('./note.txt', './note.cesvu', 'my passphrase words here');

// decryptCesvuFile unwraps CFP1 framing automatically (whether produced by
// this package, the Python CLI, or the web app itself), so destPath gets
// just the human content back.
const result = await decryptCesvuFile('./note.cesvu', './note.out.txt', 'my passphrase words here');
console.log(result.isDocument); // true
```

Per-type behavior (mirrors the web app's own parsers exactly):

- **`.txt`** — content is UTF-8 decoded, BOM-stripped, and trimmed.
- **`.md`** — content is markdown-stripped to plain text (headings, bold,
  links, etc. removed) — matching what the web app's viewer displays for a
  markdown import, not the raw markdown source.
- **`.csv`** — the raw CSV bytes are carried losslessly inside the CFP1
  envelope (no text extraction), so the web app's importer reconstructs a
  full interactive table on import, not a blank/broken viewer.

Pass `rawOnly: true` to `encryptCesvuFile` to opt out and always encrypt
the raw file bytes verbatim — the equivalent of the CLI's `--download`
flag — and `rawOnly: true` to `decryptCesvuFile`/`decryptCesvuFileToDirectory`
to skip unwrapping and write the decrypted plaintext (the raw CFP1 envelope,
if present) verbatim instead:

```ts
await encryptCesvuFile('./note.txt', './note.cesvu', passphrase, { rawOnly: true });
await decryptCesvuFile('./note.cesvu', './note.out.txt', passphrase, undefined, { rawOnly: true });
```

Unsupported extensions (`.pdf`, `.docx`, `.xlsx`, images, archives, etc.)
always use raw/vault framing regardless of `rawOnly` — there's nothing to
opt out of. A `.txt`/`.md` file that isn't valid UTF-8 text despite its
extension silently falls back to raw/vault framing rather than failing the
whole encrypt call.

`decryptCesvuFile`/`decryptCesvuFileToDirectory` also report:

- `isTextFallback` — `true` only when the recovered content came from the
  document's `text` field for a type that normally carries the original
  file as a raw section (csv/excel/pdf/docx) and that section was empty
  (i.e. the sender excluded the original file at export time).
- `extras` — an `UnrestorableExtras` instance counting user-authored
  structured data (notes, marked clauses, chat messages, manual clause
  splits) present in the document that has no representation in the plain
  output file — purely informational (`extras.total === 0` means nothing
  to warn about; `extras.describe()` gives a human-readable summary like
  `"3 notes and 1 marked clause"`).

## Safe decrypt-to-directory


`decryptCesvuFile`'s `destPath` is a complete file path **you** choose —
because you typed/constructed every character of it yourself, the file's
embedded `metadata.filename` never has to be trusted; it's returned as
informational metadata only (`result.metadata.filename`), with zero
influence over where bytes land.

That isn't true when you only want to say "put it somewhere in this
directory" rather than name the file yourself. For that case, use
`decryptCesvuFileToDirectory`, which derives the output filename from the
file's own metadata **under a strict safety filter**:

```ts
import { decryptCesvuFileToDirectory } from '@cesvu/crypto';

const result = await decryptCesvuFileToDirectory(
  './incoming/mystery.cesvu',
  './downloads',
  'my passphrase words here',
  { warn: (msg) => console.warn(msg) } // optional
);

console.log(result.destPath); // e.g. './downloads/quarterly-report.pdf'
```

`metadata.filename` lives inside the AEAD-authenticated envelope, so it
can't be tampered with in transit — but authentication only proves that
whoever produced the file held the passphrase, and *the producer is
exactly the party this filter defends against* when a `.cesvu` file
arrives from someone else. So the embedded name may **inform** the output
path; it may never **decide** it unchecked. `decryptCesvuFileToDirectory`
therefore (see `src/output-names.ts`, a port of the Python CLI's
`output_names.py`):

1. Validates `metadata.filename` against a rejection list covering path
   separators/absolute-or-drive-qualified forms, Win32-reserved characters
   and device names (`NUL`, `CON`, `COM1`, …, including superscript-digit
   variants), control characters, trailing dots/spaces (silently dropped
   by Win32 — the source of real "succeeds wrongly" data loss, not just a
   failed write), non-UTF-8/lone-surrogate names, and names over 255
   bytes. Everything else — including any non-ASCII filename — passes
   through byte-for-byte; this is a rejection list, not a sanitizer, so it
   won't mangle `契約書.pdf` or `café.pdf`.
2. Falls back to a name derived from `sourcePath`'s own basename if the
   metadata name is rejected — and validates *that* by the same policy
   too, since it's just as attacker-chosen as the metadata.
3. **Never overwrites** an existing file. A colliding name advances to
   `name (1)`, `name (2)`, … since you never saw/approved the original
   name, so there's no way to infer consent to overwrite it. If no free
   name is found, it throws `OutputNameExhausted` — leaving the directory
   completely untouched (the `.cesvu` and passphrase are still in hand,
   so recovery via an explicit `decryptCesvuFile(..., destPath, ...)`
   call is immediate and lossless).

There is no option to disable this filtering for `decryptCesvuFileToDirectory`
— if you need full control over the exact output path (including
overwriting an existing file on purpose, e.g. re-running a decrypt
idempotently), use `decryptCesvuFile` with an explicit `destPath` instead.

## Streaming large files


For payloads too large to hold twice in memory, use the streaming API
directly:

```ts
import { encryptCesvuStream, decryptCesvuStream } from '@cesvu/crypto';
```

See the doc comments on `encryptCesvuStream` / `decryptCesvuStream` in
`src/cesvu-crypto.ts` for the full streaming contract (chunk framing,
`ad`-bound header, prefix-authenticated decrypt caveats, etc).

## Preamble

Every `.cesvu` file has a plaintext, unencrypted "preamble" written before
the encrypted body — a human-readable note visible even to someone without
the passphrase (e.g. if the file is opened in a plain text editor). This
package always writes the same canonical preamble the web app uses
(`DEFAULT_PREAMBLE` in `src/cesvu-crypto.ts`) — there is no option to
customize it on encrypt, and this package does not read, return, or display
whatever preamble text is present in a file it decrypts (it's skipped as
opaque bytes; only its declared length matters for locating the rest of the
header).

## Passphrase types


Three passphrase "profiles" are supported, each with a fixed normalization
rule that MUST match exactly across all three implementations (web, CLI,
this package) — see `.cesvu SPEC/README.md` § "passProfile normalization" in
the main [cesvu](https://github.com/) repo for the full spec:

- `'diceware'` (default) — space-separated wordlist passphrase (e.g.
  generated via `generateDicewarePassphrase()`)
- `'emoji'` — emoji sequence passphrase (e.g. via `generateEmojiPassphrase()`)
- `'raw'` — an arbitrary user-chosen password, capped at 512 UTF-8 bytes

```ts
await encryptCesvu(plaintext, myPassword, {
  metadata: { filename: 'x', mimeType: 'text/plain', createdAt: 0 },
  passphraseType: 'raw'
});
```

## Server-side passphrase helpers

`src/passphrase-helpers.ts` (re-exported from the package root) adds a few
small conveniences for wiring `.cesvu` encrypt/decrypt into your own HTTP
handlers, mirroring the UX contract of the cesvu.com web app's
`SecureSaveModal` (encrypt) / `SecureOpenModal` (decrypt) — without any
DOM/terminal assumptions:

```ts
import {
  generatePassphrase,
  peekPassProfile,
  validateRawPassphrase,
  validateDicewareWords,
  validateEmojiPassphrase
} from '@cesvu/crypto';

// Encrypt-side: generate (diceware/emoji) or validate-and-pass-through (raw)
const { passphrase } = await generatePassphrase('diceware');

// Decrypt-side: given the first N bytes of an uploaded .cesvu file, find
// out which passphrase profile it expects, so your UI can ask for the
// right kind of input (words / emoji / a custom password) before the user
// even starts typing.
const profile = await peekPassProfile(uploadedBytes); // 1 | 2 | 3 | null

// Cheap shape pre-checks (word count, emoji count, byte-length cap) you can
// run before spending an Argon2id derivation on obviously-bad input:
validateRawPassphrase(userInput);
validateDicewareWords(userInput.split(' '));
validateEmojiPassphrase(userInput);
```

**Scope — what these helpers intentionally do NOT cover:**

- **Streaming large files without buffering the whole file in memory.**
  Use `encryptCesvuStream`/`decryptCesvuStream` directly for that; these
  helpers only touch the passphrase "front door", not payload streaming.
- **User-facing error-message mapping for `CesvuError` codes.** These
  helpers surface the same `CesvuError`/codes as the underlying encrypt/
  decrypt functions; turning a code into copy for your UI is left to the
  caller.
- **Progress reporting** during long encrypt/decrypt operations.
- **Rate limiting / failed-attempt cooldowns.** Argon2id is deliberately
  expensive, and `peekPassProfile`/decrypt attempts against untrusted
  uploads are a real DoS surface (see "Security notes" below). This
  belongs in your own session/auth layer — e.g. a Redis-backed
  per-IP/per-session attempt counter — not in a stateless crypto library.

All passphrase normalization is delegated to the existing shared
`preparePassphrase`/`normalizeForProfile` functions in `cesvu-crypto.ts`;
nothing in `passphrase-helpers.ts` reimplements normalization, so there is
no risk of drift between what these helpers accept and what encrypt/decrypt
actually do.

## Security notes


This package is a faithful port of the web app's `cesvu-crypto.ts` module.
Read the threat-model notes at the top of `src/cesvu-crypto.ts` before
using this in a multi-tenant or server-side context — in particular:

- Argon2id parameters are read from the (untrusted) file header **before**
  authentication is possible, so a hostile file can force an expensive KDF
  run. This is acceptable for local, single-user tooling; it is **not**
  safe to expose directly to untrusted uploads without your own rate
  limiting.
- Streaming decrypt is **prefix-authenticated**, not whole-file atomic —
  see the doc comment on `decryptCesvuStream`.

## License

Apache 2.0. See `LICENSE`.

This package's build output bundles the runtime dependencies `zod` (MIT) and
`libsodium-wrappers-sumo`/`libsodium-sumo` (ISC). Their license notices are
reproduced in `THIRD_PARTY_LICENSES.md`.

## Trademarks

"Cesvu" and its logo are trademarks of Gigperfect LLC and are not
covered by the Apache 2.0 license above. See `TRADEMARKS.md` for the
full policy, including what compatibility statements (e.g. "reads
`.cesvu` files") are explicitly permitted.


