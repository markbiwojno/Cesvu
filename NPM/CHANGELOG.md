# Changelog

All notable changes to `@cesvu/crypto` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - Unreleased

### Added

- Initial release: Node.js port of the cesvu web app's zero-knowledge
  `.cesvu` v1 file format (XChaCha20-Poly1305 secretstream + Argon2id via
  `libsodium-wrappers-sumo`), byte-identical with the web app and Python CLI.
- In-memory API: `encryptCesvu` / `decryptCesvu`.
- File API with atomic (write-temp-then-rename) output:
  `encryptCesvuFile` / `decryptCesvuFile`.
- `decryptCesvuFileToDirectory`: safe decrypt-to-directory that derives the
  output filename from the file's own (authenticated-but-untrusted)
  `metadata.filename`, filtered through a ported, byte-for-byte-preserving
  filename-safety policy (`src/output-names.ts`, adapted from the Python
  CLI's `output_names.py`) — rejects path separators, absolute/drive-
  qualified forms, Win32-reserved characters/device names (incl.
  superscript-digit variants), control characters, trailing dots/spaces,
  non-UTF-8/lone-surrogate names, and >255-byte names; falls back to a
  validated name derived from the source path on rejection; never
  overwrites an existing file (advances through `name (1)`, `name (2)`, …
  or throws `OutputNameExhausted` with zero filesystem mutations). This
  filtering is mandatory and has no bypass — contrast with
  `decryptCesvuFile`, where the caller supplies the complete destination
  path themselves and the embedded filename is purely informational.
- Streaming API for large payloads: `encryptCesvuStream` /
  `decryptCesvuStream`.
- Support for `diceware`, `emoji`, and `raw` passphrase profiles.
- Canonical preamble (plaintext, unencrypted header note, matching the web
  app's `DEFAULT_PREAMBLE` exactly) written on encrypt. There is no
  customization option — the preamble is not read, returned, or displayed
  on decrypt (skipped as opaque bytes).
- Dual ESM + CJS build output with generated `.d.ts`/`.d.cts` via `tsup`.
- Server-side passphrase helpers (`src/passphrase-helpers.ts`, re-exported
  from the package root): `generatePassphrase` (encrypt-side generate/
  validate), `peekPassProfile` (decrypt-side header peek to discover which
  passphrase profile a file expects), and shape-only pre-validators
  `validateRawPassphrase` / `validateDicewareWords` / `validateEmojiPassphrase`
  / `profileRequiresValidator`, for wiring `.cesvu` encrypt/decrypt into a
  server's own HTTP handlers without DOM/terminal assumptions.
- Test suite (289 tests) including the shared cross-language
  `passphrase-vectors.json` interop contract, atomic-io tests, full
  encrypt/decrypt round-trip tests, filename-safety policy tests
  (`output-names.test.ts`), coverage for the new passphrase helpers, and
  direct/adversarial coverage (`keycheck.test.ts`) for the `keyCheck`
  fast-wrong-passphrase-detection tag and the KDF domain-separation step —
  including the "wholesale header swap" attack test proving
  `matchesUnauthenticatedHeaderKeyCheck` can be fooled by a forged header
  but `verifyPassphrase` (which authenticates real ciphertext) cannot.

- `THIRD_PARTY_LICENSES.md` documenting bundled runtime dependency licenses
  (`zod` — MIT, `libsodium-wrappers-sumo`/`libsodium-sumo` — ISC).
- CFP1 document framing parity with the Python CLI and web app
  (`src/document.ts`): `encryptCesvuFile` now auto-detects `.txt`/`.md`/
  `.csv` source files and wraps them in the same CFP1 envelope the web
  app's Export button produces (magic + JSON `CesvuDocument` header +
  optional raw section), so files encrypted with this package open
  directly in the cesvu.com viewer instead of the "raw vault"
  download-only path — matching the CLI's default `cesvu encrypt`
  behavior. `decryptCesvuFile`/`decryptCesvuFileToDirectory` symmetrically
  unwrap CFP1 framing (from this package, the CLI, or the web app) back to
  plain content by default, and report `isDocument`, `isTextFallback`, and
  an `extras: UnrestorableExtras` count (notes/marked clauses/chat
  messages/manual clause splits) of any user-authored structured data that
  has no representation in the plain output file. `rawOnly: true` opts out
  on either side (equivalent to the CLI's `--download` flag on encrypt).
  Includes a dedicated `tests/document.test.ts` covering
  `detectDocumentSourceType`, `stripMarkdown`, `buildCfp1DocumentPlaintext`/
  `unwrapCfp1Plaintext` round-trips per source type, malformed/adversarial
  CFP1 passthrough cases, and `UnrestorableExtras`/`countUnrestorableExtras`,
  plus new `file-roundtrip.test.ts` coverage for the auto-framing behavior
  end-to-end through `encryptCesvuFile`/`decryptCesvuFile`/
  `decryptCesvuFileToDirectory`.


### Fixed

- `encryptCesvuFile`'s default `metadata.createdAt` (used when no
  `metadata` option is passed) was computed as
  `Math.floor(Date.now() / 1000)` — **seconds** since the Unix epoch —
  disagreeing with both the web app (`Date.now()`, milliseconds) and the
  Python CLI (`int(time.time() * 1000)`, milliseconds). `createdAt` is now
  written as `Date.now()` directly, matching the other two implementations.
  This did not affect decryption (the field round-trips as whatever integer
  was written), but any consumer treating `createdAt` as milliseconds — e.g.
  `new Date(createdAt)` — would have rendered files created via this
  package's `encryptCesvuFile` default metadata as dated near 1970. See
  `.cesvu SPEC/README.md`, "Metadata field length limits" section, which now
  normatively pins `createdAt` as milliseconds since epoch.
- `decryptCesvuFileToDirectory` (and the Python CLI's equivalent
  `--out-dir` decrypt path) would write a CFP1 `pdf`/`docx`/`excel` document
  that was exported *without* its original file (i.e. the sender excluded
  the underlying binary, leaving only extracted `text`) using the
  envelope's embedded `name` verbatim — e.g. `contract-final.pdf` — even
  though the bytes actually being written were plain extracted text, not a
  real PDF. The resulting file's extension lied about its contents and
  would appear "corrupted" to any PDF/Word/Excel-associated application,
  despite the decrypt itself having succeeded correctly. Both
  implementations now detect this `isTextFallback` case and force a `.txt`
  extension on the chosen output name instead (new `forceTextExtension()` in
  `src/output-names.ts`, and the matching change in the Python CLI's
  `output_names.py`) — `contract-final.pdf` → `contract-final.txt`. Regular
  documents (raw section present, or `txt`/`md` where `text` is the native,
  complete representation) are unaffected. Covered by a new regression test
  in `tests/file-roundtrip.test.ts` and unit tests for `forceTextExtension`
  in `tests/output-names.test.ts` (plus the Python CLI's
  `test_output_names.py`/`test_document.py`).
