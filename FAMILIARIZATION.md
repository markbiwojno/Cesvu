# Cesvu — Familiarization Guide

> **Purpose:** Load this single file to get a new developer or an AI agent
> up to speed on the Cesvu codebase fast. It summarizes the architecture,
> file layout, key subsystems, and the non-negotiable rules. Pair it with
> `.cesvu SPEC/README.md` (the authoritative wire format spec) when in doubt.

---

## 1. Big Picture

How it Works:

📁 Select a file by drag-and-drop or file browser — CSV, XLSX, PDF, DOCX, TXT, or MD.

⚙️ Cesvu parses, profiles, and analyzes it — all locally, inside your browser. A compact on-device language model (Transformers.js v4 with WebGPU acceleration) does the interpretive work, right on your hardware - if you choose to use it.

🔀 Smart routing — not every question needs a language model. Cesvu routes simple queries through regex when that's all that's required, saving compute and time.

📝 Annotate freely — add notes to any browser-supported document with full editing capabilities, then export and share with colleagues and partners worldwide, who can add their own notes and edit yours.

🌐 The only network call? Model weights — and only once.

📦 The runtime makes a single network request: fetching model weights from the Hugging Face Hub, pinned to a specific commit SHA for reproducibility and security. Once loaded, they're cached locally. After that, you're fully offline. Cesvu even visually indicates when it has everything it needs to operate without a connection — so you know with confidence that air-gapped mode is active.

🔒 Built for the regulated. Usable by anyone.

🏥 Cesvu was designed for the professionals who carry the heaviest privacy burdens — doctors, lawyers, their clients, and anyone navigating industry data privacy regulations. But the interface is simple enough that no technical expertise is required. If you can drag a file, you can use it.

🚫 No servers. No uploads. No compromise. Just intelligent document analysis that respects the walls your industry requires.

📄 Cesvu never edits your original documents — instead, it lets you export a derivative work containing your document and any notes, after which recipients can open an exact copy of the original plus everything you added. Use it to annotate documents back and forth with colleagues, each adding, editing, or deleting notes in the export process. Sharing is file-based: you export a `.cesvu` file and send it to the recipient through any channel you like.

This repository contains **only the web app** (`src/`) — a Svelte 5,
in-browser document analysis tool with drag-and-drop UX. It produces and
consumes a **plain, SHA-256-checksummed** `.cesvu` v2 container (see
"Export container" under Key Subsystems below, and `.cesvu SPEC/README.md`
for the normative wire format).

**No encryption.** `.cesvu` files produced by this app carry no
passphrase and no encryption — the SHA-256 checksum only guards against
accidental corruption (a bad download, a flaky drive), not against a
motivated adversary. Do not represent the format as confidential or
tamper-proof. (A separate, encrypted `.cesvu` v1 format with its own
Python CLI and Node.js/NPM package implementations previously existed;
those packages have been fully removed from this repository and are no
longer part of this project.)


### Architecture

| Layer | Tech | Notes |
|-------|------|-------|
| Frontend | **Svelte 5 (runes)** + Tailwind, bundled by **Vite** | Static output served by **Cloudflare Pages**. No SSR, no Node runtime in prod. |
| Inference | **Transformers.js v4** + WebGPU, in a **Web Worker** | Models on Hugging Face by default for evaluation; production deployments self-host. See MODELS.md. |
| Export | **Web Crypto** (`crypto.subtle.digest('SHA-256', …)`) | Plain, checksummed `.cesvu` v2 container — no encryption, no passphrase. Integrity only (corruption detection), not confidentiality. See `src/lib/export/cesvu-export.ts`. |
| Backend | **None** — file-based sharing only | Users export `.cesvu` and send the file out-of-band through any channel. |
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
│       ├── export/              cesvu-export.ts (plain, checksummed .cesvu
│       │                        v2 container) + tests
│       ├── parsers/             csv, xlsx, pdf, docx, txt, md, excel.worker
│       ├── pipeline/            engine, analysis, filter, operations, query
│       ├── llm/                 inference, worker, worker-client
│       ├── stores/              workspace, contract-store, clauseStore, notesStore,
│       │                        analysis, annotations, templates, offlineReady
│       ├── utils/               cesvu-filename.ts (untrusted-name policy), drag-drop
│       ├── data/                flag dictionaries
│       ├── models/, types/, visuals/, workers/
│       ├── templates/           general/financial/legal/sales/research/executive (.json)
│       └── components/
│           ├── ExportModal.svelte, ImportModal.svelte
│           ├── workspace/       Workspace, DocumentPane, ChatPane, InsightsPanel, FilterBar
│           ├── viewer/          PdfViewer, DocumentHighlighter, etc.
│           ├── dashboard/       DashboardPane, KpiStrip, ColumnCard, ...
│           ├── lenses/          ClauseHighlighter, ClauseSplitter, NotesPane, ...
│           ├── annotations/     AnnotationOverlay, AnnotationInput
│           ├── templates/       TemplateSelector
│           └── common/, ui/, visuals/

├── static/                      ORT wasm bundles (simd + jsep + asyncify),
│                                models.json, logo files
├── .cesvu SPEC/                 Authoritative wire format spec
│   └── README.md         The .cesvu v2 wire format spec — canonical source of truth
├── tests/                       Vitest fixtures + mocks (test files live next to source
│                                as *.test.ts siblings; this dir holds shared test data only)
│
├── _headers                     Cloudflare Pages security headers (CSP, HSTS, etc.)
├── _redirects                   Cloudflare Pages HTTPS-force + SPA fallback
└── eslint.config.js
```

> **Note:** this repository previously also contained a Python CLI
> (`CLI/`), an NPM package (`NPM/`), and cross-implementation
> passphrase-normalization fixtures (`shared/`) implementing a separate,
> encrypted `.cesvu` v1 format. **All three have been deleted from this
> repository** — the web app's unencrypted `.cesvu` v2 container (below)
> is now the only format this project produces or consumes.


---

## 3. Key Subsystems

### Export container (`src/lib/export/cesvu-export.ts`)
- **Single source of truth** for the `.cesvu` binary format.
- **No encryption.** The `.cesvu` export is a plain, SHA-256-checksummed
  container (`crypto.subtle.digest('SHA-256', …)` — Web Crypto, no WASM, no
  third-party crypto dependency). Anyone with the file can read its contents;
  the checksum only detects accidental corruption/truncation (bad download,
  flaky drive), not tampering by a motivated adversary.
- Format: `magic ".CESVU"` + version(2, currently `2`) + preambleLen(2) +
  preamble + metaLen(2) + metadata JSON + checksum(32, SHA-256) + CFP1
  payload. `buildCesvuFile()` / `parseCesvuFile()` are the only entry points.
- A reader encountering a different version (e.g. the old encrypted v1
  format from the now-deleted CLI/NPM packages) rejects it with
  `UNSUPPORTED_VERSION` — v1 and v2 are distinct formats that happen to
  share the same magic/extension, not two revisions of one format.
- The normative byte-level spec is `.cesvu SPEC/README.md`; this module is
  the reference implementation of it.

### Storage model
- **Live session, parsed documents:** in-memory only, in `contract-store.svelte.ts`
  as a `Map`. No IndexedDB, no localStorage.
- The `.cesvu` export is the only durable, portable form the app produces.

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
- ❌ No IndexedDB at rest — in-memory only for the live session.
- ✅ All persisted fields must be JSON-serializable.
- ✅ Models on R2, version-pinned by exact path (no `latest`).
- ✅ `.cesvu` export format logic only via `src/lib/export/` module — never
  reimplement the container format elsewhere.
- ✅ The `.cesvu` export is **plain, not encrypted** — do not represent it
  as confidential or tamper-proof in UI copy or docs; it is
  integrity-checked (SHA-256) against accidental corruption only.

---

## 7. Build / Verify

```bat
cd cesvu <- Project folder

npx sv check                  :: svelte-check + typescript (run after any change)
pnpm build                    :: vite build && freeze && sri:inject
pnpm verify                   :: re-hash dist/ vs integrity.json (deploy gate)
pnpm sri:verify               :: re-parse dist/*.html, assert integrity attrs present
pnpm test                     :: Vitest
```

The `_headers` and `_redirects` files are read by Cloudflare Pages on every
deploy — no extra config needed. Inspect a preview URL with `curl -I` to
verify the headers ship correctly.

---

## 8. Deferred (do NOT build in v1 unless asked)

- PWA/offline support is wired but features (sharing queue, SW release pinning)
  are v1.1+ polish.
- Passkey/WebAuthn PRF, enterprise recovery key, `.cesvu` recovery block (v1.1+).
- Server-based sharing (share URLs, expiry, PBKDF2) — v1.1+.
- Enterprise inference server / `ServerBackend` (v2.5) — but keep the
  `InferenceBackend` interface abstraction in the codebase from v1.

---

## 9. Where to Dig Next (not yet fully read)

- `src/lib/schema.ts` — exact `CesvuDocument` shape + `createCesvuDocument()`.
- `src/lib/stores/contract-store.svelte.ts` — store internals & export/import.
- `src/lib/stores/workspace.svelte.ts` — `perDocumentTeardowns`, lifecycle owners.
- `src/lib/pipeline/engine.ts` — dashboard operation dispatch.
- The 6 template definitions in `src/lib/templates/*.json`.
- `src/lib/llm/inference.ts` — model loading + hash-check logic.
- `.cesvu SPEC/README.md` — the normative `.cesvu` v2 wire format spec; the
  file format is **defined here**, not in any TS source file.
- `src/lib/export/cesvu-export.ts` — the reference implementation of that
  spec (the format source of truth for byte offsets in code).

---
