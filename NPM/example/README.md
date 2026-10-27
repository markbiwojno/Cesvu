# @cesvu/crypto — example app

A minimal, **zero-dependency** Node.js web app that exercises the full
`@cesvu/crypto` API surface: encrypt/decrypt `.cesvu` files in-memory or
streaming, with diceware / emoji / custom passphrases, through a single-page
UI that mirrors the conventions of the cesvu.com web app's
`SecureSaveModal.svelte` (encrypt) and `SecureOpenModal.svelte` (decrypt).

Built on nothing but Node's built-in `node:http` / `node:fs` / `node:crypto`
— no Express, no multer, no bundler, no framework on the frontend either
(plain HTML/CSS/vanilla JS).

## Setup

```bash
# from NPM/ — build the library this example depends on
npm run build

# from NPM/example/
npm install
npm start
```

Then open http://localhost:8787.

## Feature coverage

| UI control | `@cesvu/crypto` export exercised |
|---|---|
| Encrypt → file picker + "In-memory" mode | `encryptCesvuFile` (auto CFP1-frames `.txt`/`.md`/`.csv`) |
| Encrypt → "Streaming" mode | `encryptCesvuStream` (true O(chunk) memory; always raw/vault framing) |
| Encrypt → "Generate" (diceware/emoji) | `generatePassphrase` |
| Encrypt → custom password + byte counter | `validateRawPassphrase` / `RAW_PASSPHRASE_MAX_BYTES` |
| Decrypt → file picker (auto label/counter switch) | `peekPassProfile` |
| Decrypt → "In-memory" mode | `decryptCesvuFile` (auto CFP1-unwrap, `isDocument`/`isTextFallback`/`extras`) |
| Decrypt → "Streaming" mode | `decryptCesvuStream` + `withAtomicWriter` (safe temp-file commit) |
| Any encrypt/decrypt error | `CesvuError` (`code` + `message` surfaced verbatim) |

## How uploads work (no multipart parser)

Since this app deliberately has **zero dependencies**, file bytes are sent
as a raw POST body (not `multipart/form-data`) — the browser does
`fetch(url, { method: 'POST', body: file })` directly, and all other
parameters (mode, passphrase, filename) travel in the query string. This
avoids needing a multipart parser (which would otherwise be the one
justification for adding a dependency).

## CFP1 document framing, demonstrated

Encrypt a `.txt`, `.md`, or `.csv` file in **in-memory** mode: the library
automatically wraps it in CFP1 document framing (see `NPM/src/document.ts`)
— the same framing the cesvu.com web app's own "Export" button produces —
so the resulting `.cesvu` file opens directly in the web app's document
viewer instead of the raw vault download prompt. Decrypting that same file
back (in-memory mode) reports `isDocument: true` in the status panel, plus
any `extras` (notes/marked clauses/chat/manual splits) that have no
representation outside the full app.

**Streaming mode never produces CFP1 framing** — building the CFP1 JSON
envelope requires the whole plaintext up front, which contradicts
streaming's whole point (bounded memory for arbitrarily large files). This
is an accurate limitation of streaming encrypt, not a bug — the UI's mode
description calls it out directly.

## Differences from the cesvu.com web app

- **No framework.** Plain DOM manipulation instead of Svelte runes/stores.
- **No multi-tab / `beforeunload` guards.** The web app warns before
  closing a tab with unsaved encrypt state; this example does not.
- **Streaming encrypt is always raw/vault framing** (see above) — the web
  app's browser-side export flow always has the whole plaintext in memory
  already, so this limitation doesn't apply there the same way.
- **The 3-strikes/5-second cooldown on failed decrypt attempts is
  client-side UX only.** It matches `SecureOpenModal.svelte`'s numbers for
  parity, but (per `@cesvu/crypto`'s own README) a stateless crypto
  library — and by extension this local demo server — deliberately does
  NOT implement real rate limiting. A production/multi-tenant server
  MUST add server-side, per-IP/per-session throttling of decrypt attempts
  (Argon2id derivations are expensive; that expense is exactly what an
  attacker would try to abuse).

## Security notes

This is a **local development/demo tool**, not a production server:

- No authentication, no HTTPS termination, no request size limits beyond
  a generous in-memory sanity cap.
- Temporary files are written to `os.tmpdir()` and best-effort cleaned up;
  a crash mid-request can leave stray temp files behind.
- Do not expose this server to the public internet as-is.
