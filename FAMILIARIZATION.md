# Cesvu — Familiarization Guide

> **Purpose:** Load this single file to get a new developer or an AI agent
> up to speed on the Cesvu codebase fast. It summarizes the architecture,
> file layout, key subsystems, and the non-negotiable rules. Pair it with
> `.cesvu SPEC/README.md` (the authoritative wire format spec) and the
> `CLI/cesvu/README.md` (CLI documentation) when in doubt.

---

## 1. Big Picture

How it Works:

📁 Select a file by drag-and-drop or file browser — CSV, XLSX, PDF, DOCX, TXT, or MD.

⚙️ Cesvu parses, profiles, and analyzes it — all locally, inside your browser. A compact on-device language model (Transformers.js v4 with WebGPU acceleration) does the interpretive work, right on your hardware - if you choose to use it.

🔀 Smart routing — not every question needs a language model. Cesvu routes simple queries through regex when that's all that's required, saving compute and time.

📝 Annotate freely — add notes to any browser-supported document with full editing capabilities. Securely share your annotated document with colleagues and partners worldwide, who can add their own notes, edit yours, and send it back.

🌐 The only network call? Model weights — and only once.

📦 The runtime makes a single network request: fetching model weights from the Hugging Face Hub, pinned to a specific commit SHA for reproducibility and security. Once loaded, they're cached locally. After that, you're fully offline. Cesvu even visually indicates when it has everything it needs to operate without a connection — so you know with confidence that air-gapped mode is active.

🔒 Built for the regulated. Usable by anyone.

🏥 Cesvu was designed for the professionals who carry the heaviest privacy burdens — doctors, lawyers, their clients, and anyone navigating industry data privacy regulations. But the interface is simple enough that no technical expertise is required. If you can drag a file, you can use it.

🚫 No servers. No uploads. No compromise. Just intelligent document analysis that respects the walls your industry requires.

📄 Cesvu never edits your original documents — instead, it lets you export a derivative work containing your document and any notes, or use it as an encrypted wrapper for secure file transfer, after which recipients can download an exact copy of the original. Use it to annotate documents back and forth with colleagues, each adding, editing, or deleting notes in the export process. Sharing is file-based: you export an XChaCha20-Poly1305-encrypted .cesvu file (a new open standard) and send it alongside the relevant randomly generated passphrase through a separate channel. Both of our supported passphrase types — 6-word Diceware and 8-emoji — offer similar levels of high cryptographic security while giving you two human usable, yet secure by default choices.

The project ships **three peer implementations** that share one wire format:

- **Web app** (`src/`) — Svelte 5, in-browser analysis, drag-and-drop UX.
- **Python CLI** (`CLI/cesvu/`) — terminal-first, scriptable, headless.
- **NPM package** (`NPM/`) — `@cesvu/crypto`, a Node.js library for
  server-side encrypt/decrypt (no browser, no terminal UX).

All three produce and consume the same `.cesvu` v1 envelope. A file
encrypted in the browser opens in the CLI or the NPM package and vice
versa. The format is specified at `.cesvu SPEC/README.md`; passphrase
normalization is pinned by `shared/passphrase-vectors.json`, a 148-vector
fixture consumed directly by the web app and CLI test suites. The NPM
package is packaged fully standalone for npm, so it keeps its own
byte-identical copy at `NPM/tests/passphrase-vectors.json` rather than
importing the shared file directly — any normalization change must update
all three.


### Architecture

| Layer | Tech | Notes |
|-------|------|-------|
| Frontend | **Svelte 5 (runes)** + Tailwind, bundled by **Vite** | Static output served by **Cloudflare Pages**. No SSR, no Node runtime in prod. |
| Inference | **Transformers.js v4** + WebGPU, in a **Web Worker** | Models on Hugging Face by default for evaluation; production deployments self-host. See MODELS.md. |
| Crypto (web) | **libsodium-wrappers-sumo** (XChaCha20-Poly1305 secretstream) with default (Argon2id KDF), in a **Web Worker** | `.cesvu` binary envelope. Streaming, O(one chunk) memory. |
| Crypto (CLI) | **pynacl** (XChaCha20-Poly1305 secretstream) + **argon2-cffi** | Same wire format, no web stack. Pure-Python libsodium-backed, runs on any host with a Python interpreter. |
| Crypto (NPM) | **libsodium-wrappers-sumo** (XChaCha20-Poly1305 secretstream) + Argon2id | Same wire format, Node-only (`>=18`). Packaged standalone as `@cesvu/crypto` for server-side use — no browser, no DOM. |
| Backend | **None** in v1 — file-based sharing only | Users export `.cesvu` and send the file + passphrase out-of-band. |
| Offline | **@vite-pwa/sveltekit** | Service worker precaches the static shell; see `src/lib/stores/offlineReady.svelte.ts`. |


**Build is developer-machine only:** `pnpm install` / `pnpm build` → static files
→ Cloudflare Pages. **No Node on the server.**

### Pipeline (Data → Insight)

```
PARSE → PROFILE → EXTRACT SIGNALS → SMART SAMPLE → COMPRESS → LLM → RENDER
```

1. **PARSE** — Auto-detect by extension + MIME, route to the correct parser
   (CSV / XLSX / PDF / DOCX / TXT / MD).
2. **PROFILE** (`profileColumns`) — Classify columns as numeric (mean/min/max/std)
   or categorical (unique count, top values).
3. **EXTRACT SIGNALS** (`extractSignals`) — Trend direction, spike rows (>2σ),
   key sentences/entities/dates.
4. **SMART SAMPLE** (`smartSample`) — Deterministic, evenly-spaced rows + extremes
   + spikes + boundaries. **Not random.**
5. **COMPRESS** (`compress`) — Tight ~2000-char structured summary.
   **The LLM never sees raw data.**
6. **LLM** — Compressed summary + template system prompt → **structured JSON only**.
   Never HTML/CSS/JS.
7. **RENDER** — `ReportRenderer` maps `section.type` → Svelte component.

> **Note:** earlier drafts of this doc included a `TOKEN BUDGET` step between
> COMPRESS and LLM; that work is folded into `compress` now. Single source of
> truth for the pipeline is `src/lib/pipeline/`.

---

## 2. Project Layout

```
cesvu/
├── FAMILIARIZATION.md           Codebase summary for new developer
├── LICENSE                      Apache-2.0 for the codebase
├── SECURITY.md                  Vulnerability disclosure policy
├── TRADEMARKS.md                Reserved trademark legal info
├── MODELS.md                    How to host the LLM model weights (default: Hugging Face)
├── package.json, vite.config.ts, svelte.config.js, tailwind.config.ts,
│   tsconfig.json, eslint.config.js, pnpm-workspace.yaml
├── scripts/                     freeze.mjs (integrity + SRI), sync-cdn.mjs, r2-uploads/
├── src/                         The Svelte 5 web app (static build, Cloudflare Pages)
│   ├── app.html, app.css
│   ├── routes/                  +layout.svelte, +page.svelte, workspace/, test/, v/[shareId]/
│   └── lib/
│       ├── schema.ts            SINGLE source of truth for CesvuDocument
│       ├── types.ts, config.ts
│       ├── crypto/              cesvu-crypto.ts (envelope) + vault-io.ts + tests
│       ├── parsers/             csv, xlsx, pdf, docx, txt, md, excel.worker
│       ├── pipeline/            engine, analysis, filter, operations, query
│       ├── llm/                 inference, worker, worker-client
│       ├── stores/              workspace, contract-store, clauseStore, notesStore,
│       │                        analysis, annotations, templates, offlineReady,
│       │                        + vault-{download-stream, opfs-scratch}.ts
│       ├── utils/               cesvu-filename.ts (untrusted-name policy), drag-drop
│       ├── data/                EFF wordlist, emoji wordlist, flag dictionaries
│       ├── models/, types/, visuals/, workers/
│       ├── templates/           general/financial/legal/sales/research/executive (.json)
│       └── components/
│           ├── ExportModal.svelte, ImportModal.svelte, SendBackModal.svelte,
│           │   SecureOpenModal.svelte, SecureSaveModal.svelte (vault flows)
│           ├── workspace/       Workspace, DocumentPane, ChatPane, InsightsPanel, FilterBar
│           ├── viewer/          PdfViewer, DocumentHighlighter, etc.
│           ├── dashboard/       DashboardPane, KpiStrip, ColumnCard, ...
│           ├── lenses/          ClauseHighlighter, ClauseSplitter, NotesPane, ...
│           ├── annotations/     AnnotationOverlay, AnnotationInput
│           ├── templates/       TemplateSelector
│           └── common/, ui/, visuals/

├── static/                      eff_word_list.txt, emoji wordlist, ORT wasm bundles
│                                (simd + jsep + asyncify), vault-download-sw.js,
│                                models.json, logo files, noto-svg/
├── .cesvu SPEC/                 Authoritative wire format spec (shared by all 3 impls)
│   ├── README.md         The wire format spec itself — canonical source of truth
│   └── CESVU_FORMAT_RAISON_D'ETRE.txt  Design-rationale companion doc
├── CLI/                         The Python CLI (peer implementation, same .cesvu format)
│   ├── CLI commands.txt         CLI UX target notes
│   ├── cesvu/                  The `cesvu` Python package (pip install -e .)
│   │   ├── pyproject.toml
│   │   ├── README.md
│   │   ├── src/cesvu/          cli.py, cesvu_crypto.py, document.py, atomic_io.py,
│   │   │                        output_names.py, passphrase.py, wordlists/
│   │   ├── tests/               pytest suite (incl. test_passphrase_vectors.py —
│   │   │                        consumes shared/passphrase-vectors.json)
│   │   └── scripts/             verify_error_codes.py
│   └── example/                 4 minimal hardcoded encrypt/decrypt script pairs
│                                (raw/, diceware/, emoji/, preamble/) showing how
│                                to call the `cesvu` package's modules directly,
│                                instead of shelling out to the `cesvu` command
├── NPM/                         The Node.js package (peer implementation, same .cesvu format)
│   ├── package.json             Published as @cesvu/crypto
│   ├── README.md, CHANGELOG.md, TRADEMARKS.md, THIRD_PARTY_LICENSES.md
│   ├── tsconfig.json, tsup.config.ts, vitest.config.ts
│   ├── src/                     index.ts, cesvu-crypto.ts (mirror of src/lib/crypto/cesvu-crypto.ts),
│   │                            stream-constants.ts, atomic-io.ts, file-io.ts,
│   │                            document.ts (CFP1 framing, port of CLI's document.py),
│   │                            passphrase-helpers.ts, output-names.ts, wordlists/
│   ├── tests/                    Vitest suite, incl. passphrase-vectors.test.ts
│   │                            (consumes its own byte-identical copy of
│   │                            shared/passphrase-vectors.json) and document.test.ts
│   └── example/                 Zero-dependency Node.js web app (node:http only)
│                                exercising the full @cesvu/crypto API surface,
│                                incl. CFP1 framing, through a single-page UI
│                                mirroring SecureSaveModal/SecureOpenModal.svelte

├── shared/                      Cross-implementation test fixtures
│   ├── passphrase-vectors.json  148-vector passphrase normalization fixture
│   │                            (consumed directly by web + CLI suites; mirrored
│   │                            byte-for-byte into NPM/tests/ for the npm package)
│   └── generate_passphrase_vectors.py  Regenerate the vectors
├── tests/                       Vitest fixtures + mocks (test files live next to source
│                                as *.test.ts siblings; this dir holds shared test data only)

├── _headers                     Cloudflare Pages security headers (CSP, HSTS, etc.)
├── _redirects                   Cloudflare Pages HTTPS-force + SPA fallback
└── eslint.config.js
```


---

## 3. Key Subsystems

### Crypto envelope (`src/lib/crypto/cesvu-crypto.ts`)
- **Single source of truth** for the `.cesvu` binary format + KDF.
- `crypto_secretstream_xchacha20poly1305_*` from **libsodium-wrappers-sumo**
  (XChaCha20-Poly1305 secretstream) and Argon2id KDF with 64mb default memory hardness.
- **Streaming, not whole-file atomic.** Each chunk authenticates as it's
  decrypted; truncation is detected (`TRUNCATED` error); tampering is caught
  by the per-chunk MAC (`CIPHERTEXT_CORRUPT`).
- Format: `magic ".CESVU"` + version(2) + preambleLen(2) + preamble + salt(32)
  + KDF memory(4) + iterations(3) + parallelism(2) + chunkShift(2) + streamHeader(32)
  + keyCheck(32) + 17-byte Poly1305 per-chunk MACs (from the secretstream).
- **Never call on libsodium directly anywhere else.**

### Three passphrase profiles

The format pins three, selected by `passProfile` in the header:

| Profile | ID | Generation | Normalization |
|---------|----|-----------|---------------|
| Diceware | 1 | 6 words from the EFF large wordlist (~77.5 bits) | whitespace-collapsed, case-folded |
| Emoji | 2 | 8 emoji from a curated emoji wordlist (~77 bits) | none — used exactly as generated |
| Raw | 3 | custom (CLI only — `-p`, `--password`, `--password-file`) | **identity** — no trimming, no case folding, no normalization |

The web app and CLI consume `shared/passphrase-vectors.json` directly; the
NPM package keeps a byte-identical mirrored copy at
`NPM/tests/passphrase-vectors.json` (it's packaged standalone for npm, so
it can't reach outside its own directory at publish time). Any change to a
profile's normalization rules must regenerate the shared file and update
all three test suites together. The web app **generates** profiles 1 and 2
only; the CLI generates all three; the NPM package generates 1 and 2 (plus
accepts custom passwords via its passphrase-helpers API, analogous to the
CLI's raw profile).


### Vault feature (`src/lib/crypto/vault-io.ts` + `static/vault-download-sw.js`)

For files the in-app viewer can't open (PDF/DOCX/XLSX, images, ZIPs, etc.),
the user can encrypt them straight to disk with a fresh diceware/emoji
passphrase, and recipients decrypt them straight to disk on receipt.
Implemented as a three-tier routing decision in
`src/lib/crypto/vault-constants.ts`'s `VAULT_IMPORT_STREAM_THRESHOLD_BYTES`:

- **≤ 256 MB** — in-memory unlock + viewer (where applicable) or
  Save-As-dialog encryption.
- **> 256 MB** — streams straight to disk via OPFS scratch (`vault-opfs-scratch.ts`)
  + a service worker (`static/vault-download-sw.js`) that emits a real
  `Content-Disposition: attachment` response with the saved name embedded
  in the `filename*=` RFC 5987 form (CR/LF/quote stripped).
- **Above the browser's FileSystem Access API support** — falls back to OPFS
  + `<a download>` (no service worker), still O(chunk) JS-heap memory.

UI surfaces: `SecureSaveModal.svelte` (encrypt), `SecureOpenModal.svelte`
(decrypt), `ImportModal.svelte` (regular share files), `ExportModal.svelte`
(encrypt in-app documents), `SendBackModal.svelte` (reply to a `.cesvu` you
opened, re-encrypting with the SAME passphrase you unlocked it with, under
a fresh salt — see `sendBackAsCesvu`).

`SecureSaveModal.svelte` also offers a **"Shared Passcode"** option
alongside generating a fresh Diceware/Emoji passphrase: encrypt to a
passphrase the sender and recipient already share (e.g. one reused across
replies), typed/pasted into an auto-detecting field. It reuses the exact
per-token validity-chip UI `ImportModal.svelte` uses on its unlock screen
(`isDicewareWord` / `isCuratedEmoji`), just on the encrypt side — no new
crypto profile, still exactly `PASS_PROFILE_TEXT` or `PASS_PROFILE_EMOJI`.


### Storage model
- **Live session, parsed documents:** in-memory only, in `contract-store.svelte.ts`
  as a `Map`. No IndexedDB, no localStorage.
- **Vault streaming scratch:** OPFS, deleted on session end. Holds at most
  one chunk worth of plaintext, like every other layer.
- **Service-worker stream handoff for vault downloads:** the OS download
  manager, no staging on our side.
- The encrypted `.cesvu` export is the only durable, portable form.

### Document lifecycle (`src/lib/stores/workspace.svelte.ts`)
- **Single owner per action:**
  - open → `setFile()` / `openDocument()` set the file; `beginContract()` /
    `resumeContract()` set the binding (`activeContractId`).
  - close → `closeDocument()` (legacy alias `reset`).
- Per-document runtime stores (clauseStore, notesStore) register teardown in
  `perDocumentTeardowns`; `closeDocument()` loops it. Adding a new per-document
  runtime store is a **one-line change** there.
- **Never add a second writer of `activeContractId`.** `setFile()` must not touch it.
- Guarded by `src/lib/stores/document-lifecycle.test.ts` — keep green.

### Per-document data (persisting new features)
1. Extend `CesvuDocument` in `src/lib/schema.ts`.
2. Initialize in `createCesvuDocument()`.
3. Persist via `updateDocument()` from `contract-store`.
4. Per-document → top-level field; per-item → element of an existing array
   (annotations, messages, clauses).
5. **JSON-serializable only** (no Map/Set/File/Blob/ArrayBuffer/class instances) —
   must round-trip through the `.cesvu` envelope.
6. Per-device prefs → separate prefs store, **never** on `CesvuDocument`.

### Annotations
- Format-agnostic `CesvuAnnotation` with selectors: `TextSelector`,
  `CellSelector`, `RangeSelector`, `ColumnSelector`, `SheetSelector`.
- v1: **browser memory only** (no server-side annotation backend). The
  annotated share flow joins later in v1.1+.

### UI lenses/modes
- **Workspace** — split-pane Document / Chat / Insights shell.
- **Dashboard** — KPI strip + column cards for tabular data.
- **Contract lens** — clause splitter/highlighter/sidebar, red-flag badges,
  glossary tooltips, notes pane.

---

## 4. Templates & Monetization

- 6 JSON templates (all **free**): `general`, `financial`, `legal`, `sales`,
  `research`, `executive`. Each defines `id, name, description, icon, sections[],
  systemPrompt, tier`. Note: templates are not currently fed into LLM for v1,
  they are for references/demo purposes only.
- **Templates are JSON config, never generated code.**
- Models (all free/unlimited): `default` SmolLM2-1.7B, `standard` SmolLM3-3B,
  `expert` OLMo-3-7B.
---

## 5. Deployment Security (Cloudflare Pages)

### Edge headers — `_headers` at repo root
Applies to every response from the Cloudflare Pages deployment:

- **HSTS** with `preload` — force HTTPS for 2 years, eligible for browser preload list.
- **CSP** — strict default-src `'self'`, script-src `'self'` (with SRI providing
  defense-in-depth), no inline scripts, no eval, no foreign origins.
- **COOP/COEP/CORP** — cross-origin isolation for `SharedArrayBuffer` + WebGPU.
- **Permissions-Policy** — disables camera, mic, geolocation, payment, USB, etc.
- **X-Content-Type-Options: nosniff**, **X-Frame-Options: DENY**,
  **Referrer-Policy: no-referrer**.
- Per-path overrides for `/_app/immutable/*` (long-cache immutable),
  `/integrity.json` (no-cache), `/sw.js` (Service-Worker-Allowed: /).

### SRI (Subresource Integrity)
- `pnpm build` runs `vite build && freeze && sri:inject` (in that order).
- `freeze` writes `dist/integrity.json` with `{ sha256, sha384, size }` per file
  in the build. Backwards-compatible with the old string-only shape.
- `sri:inject` rewrites every `dist/*.html` to add `integrity="sha384-…"
  crossorigin="anonymous"` on every local `<script src>`, `<link rel="stylesheet">`,
  `<link rel="modulepreload">`, and `<link rel="preload" as="script|style">`.
  Idempotent. After injecting, it re-hashes the modified HTML and updates the
  manifest so `verify` is clean.
- `sri:verify` re-parses built HTML and asserts every local tag has the right
  integrity attribute.
- `verify` (the deploy gate) re-hashes every file in `dist/` and compares
  against `integrity.json`. Exits non-zero on mismatch.

### Self-hosted model hosting

The convenience default is now Hugging Face. Production forks self-host. R2 is one of several viable hosts — the configuration below is R2-specific but the path-versioning and CORS rules apply to any origin.
- `static/models.json` is the canonical source of truth for model identity.
- URLs are path-versioned (e.g. `/q4/`, `/v1/`); new model version = new URL.
- `Cross-Origin-Resource-Policy: cross-origin` on the bucket's custom domain.

---

## 6. Non-Negotiable Rules

- ❌ No Node.js server (no Express/Fastify), no SSR/SvelteKit server mode.
- ❌ No runtime CDN imports (jsDelivr/unpkg/HF). npm deps bundled by Vite only.
- ❌ LLM never generates HTML/CSS/JS — structured JSON only.
- ❌ No auth/login system (device ID is identity in v1).
- ❌ No IndexedDB at rest — in-memory for live session, OPFS only as streaming
  scratch for the vault path (single chunk worth, deleted when the download
  finishes).
- ❌ No plaintext export path — every document is encrypted.
- ✅ Libsodium only via `crypto/` module.
- ✅ All persisted fields must be JSON-serializable.
- ✅ Models on R2, version-pinned by exact path (no `latest`).
- ✅ Passphrase model is **explicit** (diceware / emoji / raw). The `raw`
  profile (`passProfile = 3`) is identity normalization — never strip,
  trim, lower-case, or NFKC it; document this anywhere the value crosses
  a code boundary.

---

## 7. Build / Verify

```bat
cd cesvu <- Project folder

:: Web app
npx sv check                  :: svelte-check + typescript (run after any change)
pnpm build                    :: vite build && freeze && sri:inject
pnpm verify                   :: re-hash dist/ vs integrity.json (deploy gate)
pnpm sri:verify               :: re-parse dist/*.html, assert integrity attrs present
pnpm test                     :: Vitest

:: CLI (Python)
cd CLI/cesvu
pip install -e .              :: editable install, dev mode
pytest                        :: all CLI tests (incl. test_passphrase_vectors.py
                              :: which consumes shared/passphrase-vectors.json)
pytest tests/test_output_names.py -v :: specific module, e.g.
python scripts/verify_error_codes.py :: standalone error-code sanity check
```

The `_headers` and `_redirects` files are read by Cloudflare Pages on every
deploy — no extra config needed. Inspect a preview URL with `curl -I` to
verify the headers ship correctly.

> **Cross-impl contract:** any change to a passphrase profile's normalization
> rules requires editing `shared/generate_passphrase_vectors.py`,
> regenerating `shared/passphrase-vectors.json`, and updating both
> `src/lib/crypto/passphrase-vectors.test.ts` and
> `CLI/cesvu/tests/test_passphrase_vectors.py`. Both suites read the same
> file; drift between them is a bug, not a feature.

---

## 8. Deferred (do NOT build in v1 unless asked)

- PWA/offline support is wired but features (sharing queue, SW release pinning)
  are v1.1+ polish.
- Passkey/WebAuthn PRF, enterprise recovery key, `.cesvu` recovery block (v1.1+).
- Server-based sharing (share URLs, expiry, PBKDF2) — v1.1+.
- Enterprise inference server / `ServerBackend` (v2.5) — but keep the
  `InferenceBackend` interface abstraction in the codebase from v1.
- The CLI is a separate Python project, **not** a `pnpm-workspace` member.
  Don't add it to `pnpm-workspace.yaml` without a strong reason.

---

## 9. Where to Dig Next (not yet fully read)

- `src/lib/schema.ts` — exact `CesvuDocument` shape + `createCesvuDocument()`.
- `src/lib/stores/contract-store.svelte.ts` — store internals & export/import.
- `src/lib/stores/workspace.svelte.ts` — `perDocumentTeardowns`, lifecycle owners.
- `src/lib/pipeline/engine.ts` — dashboard operation dispatch.
- The 6 template definitions in `src/lib/templates/*.json`.
- `src/lib/llm/inference.ts` — model loading + hash-check logic.
- `src/lib/crypto/cesvu-crypto.ts` — the format source of truth (also mirrored
  in `CLI/cesvu/src/cesvu/cesvu_crypto.py`; **both must agree byte-for-byte**).
- `.cesvu SPEC/README.md` — the wire format spec; the file format is **defined
  here**, not in any TS or Python source file.
- `CLI/cesvu/README.md` — full CLI documentation (every flag, every edge case).
- `NPM/src/cesvu-crypto.ts` — the format source of truth mirrored a third
  time for Node.js; **must agree byte-for-byte** with the other two.
- `NPM/README.md` — full package documentation (every export, streaming contract).
- `shared/passphrase-vectors.json` — the contract that binds all three impls together.


---

## 10. Python CLI (`CLI/cesvu/`) — Peer Implementation

The CLI is a real, supported peer of the web app. It is a separate Python
package — **not** in `pnpm-workspace.yaml`, **not** a node_module — installed
via `pip install -e ./CLI/cesvu`. It produces and consumes the same `.cesvu`
v1 envelope the web app does, with no web stack involved. A file encrypted in
the browser opens in the CLI, and vice versa.

### When to reach for the CLI

- **Headless servers** — no browser, no DOM. Cron jobs, batch pipelines.
- **Automation / scripting** — wrap `cesvu encrypt` in shell scripts.
- **CI / CD** — encrypt build artifacts or test fixtures as `.cesvu`.
- **On environments where the LLM weights can't load** (no WebGPU, no
  internet to fetch them) but encryption is still wanted.
- **Generating `.cesvu` for archival** — pure deterministic encryption, no
  AI/rendering involved, no in-browser UI.

### When NOT to use the CLI

- **Analyzing documents interactively.** No viewer, no profiling, no LLM.
- **Annotating documents.** Annotation requires the in-app lens UI.
- **Sharing in the sense of "send someone a link".** The CLI only does file-based
  sharing — same two-channel model as the web app (file + passphrase out-of-band).

### Module map

```
CLI/cesvu/src/cesvu/
├── __init__.py
├── cli.py             argparse wiring (cmd_encrypt, cmd_decrypt) + entry point
├── cesvu_crypto.py   pynacl secretstream + argon2-cffi — mirror of cesvu-crypto.ts
├── document.py        CFP1 document framing (.txt/.md/.csv → cesvu.com viewer)
├── atomic_io.py       atomic_writer + check_disk_space (temp file + os.replace)
├── output_names.py    untrusted-filename policy (mirrors vault behavior)
├── passphrase.py      generate_diceware_passphrase, generate_emoji_passphrase
└── wordlists/         bundled wordlist data (EFF + emoji)
```

### Test commands

```bash
cd CLI/cesvu
pytest                                            # full suite
pytest tests/test_passphrase_vectors.py -v       # shared 148-vector contract
pytest tests/test_output_names.py                # untrusted-name policy
pytest tests/test_document.py                    # CFP1 framing
python scripts/verify_error_codes.py             # standalone error-code check
```

### Contract with the web app

Two files bind the two implementations together. **Both must be updated in lockstep:**

1. **`.cesvu SPEC/README.md`** — the wire format spec. Authoritative source of
   truth for byte offsets, KDF params, tag policy, chunk framing. If you change
   the format, you change this file first, then port to both implementations.
2. **`shared/passphrase-vectors.json`** — 148-vector passphrase-normalization
   fixture. Consumed by `src/lib/crypto/passphrase-vectors.test.ts` (Vitest)
   AND `CLI/cesvu/tests/test_passphrase_vectors.py` (pytest). Any change to a
   profile's normalization requires regenerating this file via
   `shared/generate_passphrase_vectors.py` and updating both suites.

### Differences from the web app

- **No viewer.** The CLI never produces an in-app viewer for `.pdf`/`.docx`/
  `.xlsx` etc. — those always encrypt as plain files the recipient downloads.
- **Document framing for `.txt`/`.md`/`.csv`.** The CLI auto-wraps these in
  the same CFP1 envelope the web app's **Export** button produces, so they
  open in the cesvu.com viewer when imported there. `--download` opts out.
- **Custom preamble.** `--desc` (inline) or `--desc-file` (path). Capped at
  4096 bytes UTF-8. Stored **unencrypted** in the file header. The web app
  displays it before prompting, so a custom preamble set in the CLI shows up
  in the browser too.
- **Raw passphrase (`-p` / `--password` / `--password-file`).** CLI-only. The
  web app never generates profile 3; it only imports and decrypts files that
  carry it.
- **Three passphrase profiles on the encrypt side.** The web app encrypts
  with profiles 1 and 2; the CLI encrypts with all three.

### Reading order for a new CLI contributor

1. `CLI/cesvu/README.md` — the user-facing docs. Start here.
2. `.cesvu SPEC/README.md` — the wire format. Read in full once; refer to it
   every time you touch `cesvu_crypto.py`.
3. `CLI/cesvu/src/cesvu/cli.py` — the entry points. The surface area is
   small and the docstrings are extensive.
4. `CLI/cesvu/src/cesvu/cesvu_crypto.py` — the format implementation.
   Mirror image of `src/lib/crypto/cesvu-crypto.ts`.
5. `CLI/cesvu/src/cesvu/document.py` — the CFP1 framing. Mirrors the web
   app's `document.ts`.
6. `CLI/cesvu/src/cesvu/output_names.py` — untrusted-filename policy. The
   web app's `vault-io.ts` is the parallel policy; both share the same
   threat model.
7. `CLI/example/` — 4 minimal, hardcoded encrypt/decrypt script pairs
   showing how to call `cesvu`'s modules directly from your own code,
   instead of shelling out to the installed `cesvu` command. Good for
   seeing the passphrase-profile API surface and the CFP1
   document-framing default in isolation, without argparse/CLI plumbing
   in the way. See `CLI/example/README.md`.

---

## 11. NPM Package (`NPM/`) — Peer Implementation

`NPM/` is the third peer implementation, packaged and published to npm
as **`@cesvu/crypto`**. It's a Node.js library (not a CLI, not a web app) —
callers `import` it into their own Node.js backend, API route handler, or
script. It produces and consumes the exact same `.cesvu` v1 envelope as
the web app and CLI. It is **not** in `pnpm-workspace.yaml` — it has its
own `package.json`, its own build (`tsup`), and its own test runner
(`vitest`), and ships standalone to the npm registry independent of the
main app's release cycle.

### When to reach for the NPM package

- **Server-side encrypt/decrypt in a Node.js backend** — API routes, queue
  workers, serverless functions — where you want `.cesvu` files
  interoperable with the web app/CLI without shelling out to Python.
- **Programmatic integration** — when you need the encrypt/decrypt/passphrase
  logic as a library call, not a CLI subprocess or browser bundle.
- **Streaming large payloads server-side** — `encryptCesvuStream` /
  `decryptCesvuStream` keep memory at O(chunk), same streaming discipline
  as the web app's Web Worker and the CLI's file streaming.

### When NOT to use the NPM package

- **Browser code.** It targets Node.js (`>=18`) and is not built for/tested
  in a browser environment — use `src/lib/crypto/cesvu-crypto.ts` (the web
  app's own implementation) for in-browser work instead.
- **Interactive terminal use.** No CLI entry point — that's `CLI/cesvu/`.
- **Analyzing or annotating documents.** Encryption/decryption only, no
  parsing, profiling, viewer, or LLM.

### Module map

```
NPM/src/
├── index.ts                Public exports
├── cesvu-crypto.ts        libsodium-wrappers-sumo secretstream + Argon2id —
│                            mirror of src/lib/crypto/cesvu-crypto.ts
├── stream-constants.ts      Chunk size / shift constants — mirror of
│                            src/lib/crypto/stream-constants.ts
├── atomic-io.ts             Temp-file-then-rename writes (mirrors CLI's atomic_io.py)
├── file-io.ts               encryptCesvuFile / decryptCesvuFile /
│                            decryptCesvuFileToDirectory (Node fs wrappers)
├── document.ts              CFP1 document framing (.txt/.md/.csv → cesvu.com
│                            viewer) — port of CLI's document.py, wired into
│                            file-io.ts by default (opt out with `rawOnly`)
├── output-names.ts          Untrusted-filename policy (mirrors output_names.py /
│                            vault-io.ts)
├── passphrase-helpers.ts    generatePassphrase, peekPassProfile,
│                            validateRawPassphrase, validateDicewareWords,
│                            validateEmojiPassphrase
└── wordlists/               emoji-wordlist.ts (+ EFF wordlist data)
```

### Test commands

```bash
cd NPM
npm install                              # or pnpm install, from within NPM/
npm run test                             # vitest run (incl. tests/document.test.ts)
npm run test:watch                       # vitest, watch mode
npm run typecheck                        # tsc --noEmit
npm run build                            # tsup → dist/ (cjs + esm + .d.ts)

cd NPM/example                           # separate zero-dep demo app, own package.json
npm install
npm start                                # http://localhost:8787
```


### Contract with the web app and CLI

Same two-document contract as the CLI, plus one npm-specific wrinkle:

1. **`.cesvu SPEC/README.md`** — the wire format spec. Any format change is
   ported to `NPM/src/cesvu-crypto.ts` in lockstep with the web app and CLI.
2. **`shared/passphrase-vectors.json`** — the 148-vector fixture. The NPM
   package is published standalone to npm and cannot import a file that
   lives outside its own package directory at publish time, so it keeps a
   **byte-identical mirrored copy** at `NPM/tests/passphrase-vectors.json`,
   consumed by `NPM/tests/passphrase-vectors.test.ts`. Any change to
   normalization rules must be applied to `shared/passphrase-vectors.json`
   first, then copied byte-for-byte into `NPM/tests/passphrase-vectors.json`
   — verify with `fc` (Windows) / `diff` (macOS/Linux) that the two files
   are identical before committing.

### Differences from the web app and CLI

- **No viewer, no UI.** Pure library — the caller decides what to do with
  the decrypted bytes/metadata.
- **No terminal UX.** No prompts, no `argparse`/`click`-style CLI, no
  stdin/stdout conventions — everything is a function call returning a
  Promise.
- **Passphrase generation matches the web app, not the CLI.** Generates
  Diceware (profile 1) and Emoji (profile 2) passphrases via
  `generatePassphrase`; raw/custom passwords are supported by passing your
  own string plus `validateRawPassphrase`, conceptually parallel to the
  CLI's `-p`/`--password`, but the NPM package never assigns a hidden
  "profile 3 is CLI-only" restriction — any of the three profiles can be
  read or written by any of the three implementations; profile 3 is simply
  never auto-*generated* by the web app.
- **Document framing for `.txt`/`.md`/`.csv`, matching the CLI.**
  `NPM/src/document.ts` is a full port of the CLI's `document.py` (CFP1
  envelope: magic + JSON metadata + payload). `encryptCesvuFile` auto-wraps
  a recognized extension in it by default — same behavior as the CLI's
  default `cesvu encrypt` — so the resulting `.cesvu` file opens directly
  in the cesvu.com viewer, not a raw download prompt. Pass `rawOnly: true`
  to opt out (equivalent to the CLI's `--download`). Symmetrically,
  `decryptCesvuFile`/`decryptCesvuFileToDirectory` auto-unwrap CFP1 framing
  by default (from this package, the CLI, or the web app), reporting
  `isDocument`/`isTextFallback`/`extras` (unrestorable notes/marks/chat/
  splits counts) — same `rawOnly` opt-out on the decrypt side. Only
  `encryptCesvuStream`/`decryptCesvuStream` (the raw streaming API) never
  apply CFP1 framing, since building the envelope requires the whole
  plaintext up front.
- **Additive safety helpers beyond a minimal port** — atomic file I/O
  (temp-file-then-rename), a streaming API for large payloads, and
  `decryptCesvuFileToDirectory`'s untrusted-name policy — see
  `NPM/README.md` for the full feature table.

### Reading order for a new NPM package contributor

1. `NPM/README.md` — the user-facing docs and full API surface. Start here.
2. `.cesvu SPEC/README.md` — the wire format. Read in full once; refer to it
   every time you touch `cesvu-crypto.ts`.
3. `NPM/src/cesvu-crypto.ts` — the format implementation. Mirror image of
   `src/lib/crypto/cesvu-crypto.ts` and `CLI/cesvu/src/cesvu/cesvu_crypto.py`.
4. `NPM/src/file-io.ts` and `NPM/src/atomic-io.ts` — the safe-write layer
   built on top of the core crypto.
5. `NPM/src/document.ts` — the CFP1 framing. Mirrors the CLI's `document.py`
   and the web app's `document.ts`/`contract-store.svelte.ts` export path.
6. `NPM/src/output-names.ts` — untrusted-filename policy. Parallel to the
   web app's `vault-io.ts` and the CLI's `output_names.py`; same threat model.
7. `NPM/tests/passphrase-vectors.test.ts` and `NPM/tests/document.test.ts` —
   confirm this package's normalization and CFP1 framing match the other
   two byte-for-byte / behaviorally.
8. `NPM/example/` — a zero-dependency Node.js web app exercising the whole
   API surface (incl. CFP1 framing) through a UI that mirrors
   `SecureSaveModal.svelte`/`SecureOpenModal.svelte`. See `NPM/example/README.md`.



