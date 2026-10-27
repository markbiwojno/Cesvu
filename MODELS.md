# LLM model hosting

> **`static/models.json` ships with URLs pointing at Hugging Face
> (huggingface.co) by default**, so cloning the repo and clicking
> around works out of the box for local dev, demos, and code
> review. **Production deployments SHOULD self-host** the model
> weights on their own origin. The default is fine for evaluation;
> it is wrong for anything your users will see.

## ⚠ First thing that breaks: CORS

If the model fails to load, the **#1 cause is missing CORS on the
host serving the model files**. The browser blocks the cross-origin
request before the model even starts downloading. The error in the
console looks like a generic "Failed to fetch" or "CORS policy"
but it's a host-config issue.

The exact CORS headers the host must send:

```
Cross-Origin-Resource-Policy: cross-origin
Access-Control-Allow-Origin: https://your-app-origin.com
Access-Control-Allow-Methods: GET
Vary: Origin
```

Hugging Face's `resolve/main` URLs already send these (which is
why the default works out of the box). For forks self-hosting on
their own bucket, the same rules apply. For Cloudflare R2, set this
in the bucket's CORS policy in the dashboard. For S3, configure the
bucket's CORS rule. For your own Caddy/nginx, send these as response
headers on the served files.

The runtime (`looksLikeCorsError` in `src/lib/llm/inference.ts`)
detects CORS errors specifically and surfaces a clear message
pointing at this section. The build (`checkCorsSetup` in
`scripts/freeze.mjs`) warns when the manifest URLs are cross-origin
to the configured app origin (set `CESVU_APP_ORIGIN=https://app.your-domain.com`
in CI to opt in).

See the "Self-hosting" walkthrough below for step-by-step
instructions on configuring CORS for each common host (R2, S3, B2,
Caddy, Hugging Face Spaces).

## Default host policy

**Short answer: Hugging Face is the convenience default. It is NOT
production-suitable.**

The repo's `static/models.json` ships pointing at
`https://huggingface.co/<org>/<repo>/resolve/main/<file>` for each
model so cloning the project and clicking around works out of the
box. That's a courtesy for evaluation. If you fork this and deploy
for actual users without changing the URLs:

  - **You route every user's model fetch through Hugging Face.** A
    privacy-first app that says "your data never leaves your device"
    while every browser fetches ~1.4–4 GB of weights from
    huggingface.co is at least *cosmetically* mismatched with that
    promise. The fetch itself doesn't leak document content
    (Hugging Face serves only the ONNX weights), but the principle
    holds.

  - **You depend on Hugging Face's reliability and rate limits.** A
    Hugging Face outage, a model-file takedown, or a rate-limit on
    downloads will break your app for every active user
    simultaneously. There is no SLA on a public model hub.

  - **Your users see "huggingface.co" in the network tab.** Branding
    and ownership leak. A fork calling itself "<X>, the privacy-first
    analyzer" whose models are fetched from someone else's origin is
    a marketing-vs-engineering mismatch.

  - **Hugging Face may take down a specific model.** If a model
    author pulls a repo (e.g. for licensing reasons), every active
    user of your app breaks simultaneously and there's nothing you
    can do about it.

**The default is fine for**: local dev, evaluation, demos, code
review. **The default is wrong for**: anything your users will see.
Self-host before you go public.

The build warns if you ship with the default host still in
`static/models.json` — see "Build-time check" below.

## TL;DR

| Scenario | What to do |
|---|---|
| **Local dev / evaluation / code review** | Use the default. `static/models.json` points at Hugging Face. The browser fetches from there. CORS works out of the box. |
| **Production deployment (any scale)** | Self-host. Update `static/models.json` to point at your own origin. See "Self-hosting" below. |
| **Offline / air-gapped** | Self-host. The default won't be reachable. |
| **Adding a new model** | Drop the ONNX files into your bucket, add a manifest under `scripts/r2-uploads/manifests/`, add a row to `CDN_ENTRIES` in `scripts/freeze.mjs`, run `pnpm models:build`. |

---

## What's bundled vs what's not

**Bundled in the repo** (works offline, SRI-covered, no setup):

```
static/
├── models.json                                      ← the manifest, points to URLs
├── ort-wasm-simd-threaded.jsep.mjs                  ← ONNX Runtime WASM (Chrome / WebGPU)
├── ort-wasm-simd-threaded.jsep.wasm
├── ort-wasm-simd-threaded.mjs                       ← ONNX Runtime WASM (Safari)
├── ort-wasm-simd-threaded.wasm
├── ort-wasm-simd-threaded.asyncify.mjs             ← ONNX Runtime WASM (Firefox)
├── ort-wasm-simd-threaded.asyncify.wasm
└── eff_word_list.txt                                ← 7,776-word EFF large wordlist (CC0)
```

**Not bundled** (~7 GB of binary weights, fetched at runtime):

| Model | Quant | Files | Total size |
|---|---|---|---|
| SmolLM2-1.7B-Instruct | q4 | `model_q4.onnx` | 1.4 GB |
| SmolLM3-3B-ONNX | q4 | `model_q4.onnx` + `model_q4.onnx_data` | 2.9 GB |
| OLMo-3-7B-Instruct | q4 | `model_q4.onnx` + 2× `model_q4.onnx_data_N` | 4.0 GB |
| teimurjan/legal-clause-classifier | fp32 | `model.onnx` + `model.onnx.data` | 280 MB |

We do **not** commit the `.onnx` weights to git. A 7 GB binary
blob in `main` is unworkable for clones, PRs, and CI. The manifests
under `scripts/r2-uploads/manifests/` carry the metadata (sha256,
size, source URL); the actual bytes live at your model host.

---

## The default setup: Hugging Face

`static/models.json` is committed to the repo with URLs pointing
at `https://huggingface.co/<org>/<repo>/resolve/main/<file>` for
each model. After `pnpm build`, the static site is served from
your app's origin and the browser fetches model weights from
Hugging Face at runtime.

If Hugging Face is reachable from your network and your deployment
is online, **no further setup is required**. The first time a user
sends a chat message, the browser:

1. Loads ONNX Runtime WASM from `/static/` (SRI-verified, served from your origin).
2. Reads `models.json` for the model URL + sha256.
3. Downloads the model file(s) from Hugging Face, verifying the
   sha256 mid-download.
4. Caches everything in the browser's Cache API.
5. Subsequent analyses load instantly from cache.

### What if Hugging Face is down or blocked

In an air-gapped or strictly-self-hosted deployment, the model
weights must be reachable from the user's network. The browser
will fail to load the model. The chat-pane will surface an error
like *"Failed to load model. Check your network or contact
support."* Workarounds:

- **Quick fix:** self-host the model weights (next section).
- **Long-term fix:** keep the model weights on your own CDN, set up
  CORS, update `static/models.json` to point to your URLs.

---

## Self-hosting: how to upload the LLM model weights

If you want to control your own model hosting — for compliance,
sovereignty, air-gapping, or simply not depending on a third-party
host — you need to put the ONNX weights somewhere the browser can
reach. This section walks through that. **For production
deployments, this is the only path.**

### 1. Choose a host

Any HTTPS static origin works. Common choices:

| Host | Cost | Notes |
|---|---|---|
| **Cloudflare R2** | $0.015/GB/mo, zero egress | Recommended. Cheap and fast. |
| AWS S3 | ~$0.023/GB/mo + egress | Works fine, egress adds up fast. |
| Backblaze B2 | $0.005/GB/mo, free egress to Cloudflare | Cheapest for low-traffic. |
| Hugging Face Spaces | Free tier | Acceptable; not first-party. |
| Your own Caddy + static dir | Free, you own it | Requires your own domain + TLS. |

Whatever you pick, the browser needs to fetch the files
cross-origin from your app's origin. That means **CORS** must be
configured.

### 2. Get the model files

The manifests under `scripts/r2-uploads/manifests/` list every
file you need, with sha256 and source URL. To download them:

```bash
# Install wrangler (only needed for the download step, not the runtime).
pnpm add -Dw wrangler

# Download all manifests' files. This populates the local copies of the
# manifests with sha256 + size and writes the binaries to a tmp dir.
pnpm sync:cdn

# Inspect what was downloaded.
ls -lh tmp/  # or wherever the script writes
```

Each `*.onnx` and `*.onnx_data` file is what's needed. For
OLMo-3-7B, you need **all three** files (graph + 2 weight chunks)
— they're split for upload-size reasons and the model is
incomplete without any one of them.

### 3. Upload to your host

Cloudflare R2 example (others are similar):

```bash
# Configure wrangler with your R2 credentials.
wrangler login
export CESVU_R2_BUCKET=your-bucket-name

# Push the files. The sync-cdn script handles the path layout.
pnpm sync:cdn:upload
```

Your R2 bucket should end up with this structure:

```
your-bucket/
├── smollm2-1.7b-instruct/v1/model_q4.onnx
├── smollm3-3b/v1/model_q4.onnx
├── smollm3-3b/v1/model_q4.onnx_data
├── olmo-3-7b-instruct/v1/model_q4.onnx
├── olmo-3-7b-instruct/v1/model_q4.onnx_data
├── olmo-3-7b-instruct/v1/model_q4.onnx_data_1
├── legal-clause-classifier/v1/model.onnx
└── legal-clause-classifier/v1/model.onnx.data
```

If you use a different host, mirror the same path layout.

### 4. Configure CORS

The browser fetches the models cross-origin. Your bucket / CDN
must allow:

```
Cross-Origin-Resource-Policy: cross-origin
Access-Control-Allow-Origin: https://app.your-domain.com
Access-Control-Allow-Methods: GET
Vary: Origin
```

For R2, set this in the bucket's CORS policy. For S3, configure
the bucket's CORS rule. For your own Caddy/nginx, send these as
response headers on the served files.

If your app is at a different domain (e.g. `app.example.com`),
replace `https://app.cesvu.com` with your origin.

### 5. Configure DNS

Point a custom domain at your bucket. The default is the
Hugging Face model host; your equivalent might be
`ai.example.com` or `models.example.com`. The custom domain must
be:

- HTTPS-only (no HTTP fallback).
- Served by a CDN that supports the CORS headers above.
- Available from your users' networks (i.e. not behind a corporate
  firewall blocking it).

### 6. Update `static/models.json`

Now point the manifest at your URLs:

```js
// In scripts/freeze.mjs, the CDN_ENTRIES array:
{
  kind: 'model',
  id: 'smollm2-q4',
  baseUrl: 'https://ai.example.com/smollm2-1.7b-instruct/v1',  // ← your URL
  file: 'model_q4.onnx',
  manifest: 'smollm2-1.7b-instruct-v1.json'
},
// ... repeat for every model
```

After editing, regenerate the manifest with the new sha256s from
your bucket:

```bash
pnpm models:build
```

This reads each manifest under `scripts/r2-uploads/manifests/`,
looks up the file, and writes `static/models.json` with the pinned
hashes. The build is fully offline — no HuggingFace, no jsDelivr
— so the output is reproducible.

Commit the updated `static/models.json` (and the sidecar manifests
if their content changed). Future deploys will use your URLs.

### 7. Verify

After `pnpm build` ships the updated `static/models.json`, verify
the runtime fetch works:

```bash
# 1. Check the manifest in the deployed bundle.
curl -s https://app.example.com/models.json | jq '.entries[0]'

# 2. Check the model URL is reachable from the deployed origin.
curl -I https://ai.example.com/smollm2-1.7b-instruct/v1/model_q4.onnx
# expect: HTTP/2 200 + the CORS headers you configured

# 3. Open the app, send a chat message, watch the network tab.
#    First message downloads ~1.4 GB; the browser console should report
#    "model loaded successfully" once done.
```

The browser validates the sha256 of every file as it streams. A
tampered or wrong-version file fails the integrity check and the
chat surface shows a clean error.

---

## ONNX Runtime WASM is already bundled — no setup needed

Unlike the model weights, the ONNX Runtime WASM blobs are
**bundled in `static/`** and shipped with the app. The service
worker precaches them on first visit. The browser loads them from
`/ort-wasm-simd-threaded.{jsep,asyncify,}.{mjs,wasm}` — same
origin as the app, no cross-origin fetch, SRI-covered.

Rationale (from `scripts/r2-uploads/README.md`):

> For a privacy-first app, eliminating the User-Agent fingerprint at
> the ORT fetch is worth the +36 MB bundle cost (which the service
> worker caches after first analysis anyway).

If you fork the project, you don't need to mirror ORT WASM
anywhere. It's already in your build.

---

## Path versioning — read this before you rename anything

The model URLs use **path versioning**, not mutable pointers:

```
https://huggingface.co/<org>/<repo>/resolve/main/model_q4.onnx
                                                      ^^^^^^^^^^^^^^^^
                                                      mutable branch, NOT
                                                      recommended for prod
```

For self-hosted production URLs, the same pattern applies with
immutable version segments:

```
https://ai.example.com/smollm2-1.7b-instruct/v1/model_q4.onnx
                                       ^^^^^^^^^^^^^^^^ ^^^
                                       model stem       version
```

- A new model version = a new path segment (`/v2/`, `/v3/`). Old
  URLs never change.
- **No `latest`, no `main`, no version alias.** A user who fetched
  `/v1/` will always have `/v1/`, even after `/v2/` ships.
- The browser's Cache API is the upgrade path. New users get the
  new version; existing users keep what they cached until they
  clear browser storage.

This is deliberate. Mutable URLs (e.g. `latest`, or Hugging Face's
`main` branch) let a compromised upstream serve
attacker-controlled weights to existing users.
Path-versioned URLs don't.

When you upgrade a model:

1. Upload the new files to `your-bucket/<model-stem>/v2/`.
2. Add a new manifest at
   `scripts/r2-uploads/manifests/<model-stem>-v2.json`.
3. Add new `CDN_ENTRIES` rows in `scripts/freeze.mjs` pointing at
   `v2`.
4. Remove the old `v1` rows.
5. `pnpm models:build`, commit, deploy.

Existing users who already have `v1` cached will keep using it
until they clear browser storage. New users will get `v2` from
the start. No half-migrated state, no rollback drama.

**Note on the Hugging Face default**: Hugging Face's
`huggingface.co/<org>/<repo>/resolve/main/<file>` URL pattern
*is* mutable (the `main` branch can change), but the model
weights themselves are pinned to a specific git commit (the
sha256 in the manifest catches any drift). The runtime fetch
verifies sha256 mid-stream, so a compromised or updated `main`
branch would fail the integrity check and surface a clean error.
This is the safety net the Hugging Face default relies on; it's
NOT a substitute for self-hosting at production scale, but it
means the default is at least correct-vs-tampering, just
unreliable-vs-availability.

---

## File-size budget

7 GB of model weights is a lot to download on first use.
Realistic bandwidth expectations:

| Connection | Time to download SmolLM2-1.7B (1.4 GB) |
|---|---|
| 1 Gbps fiber | ~12 seconds |
| 100 Mbps cable | ~2 minutes |
| 25 Mbps DSL | ~8 minutes |
| 4G LTE (good signal) | ~5 minutes |
| 3G fallback | ~30 minutes |
| Mobile data on a slow day | "users will churn" |

For the larger models (SmolLM3-3B at 2.9 GB, OLMo-3-7B at 4.0 GB),
multiply by 2-3×.

If your user base is bandwidth-constrained, consider:

- **Shipping a "lite" mode** that uses only SmolLM2-1.7B (the
  smallest) and runs everything else deterministically.
- **Server-side pre-warming** — a marketing-page visit that
  silently pre-loads the model in the background. The first
  analysis still has to download, but the user's perceived wait is
  zero.
- **Tiered model selection** — give users a choice between "fast
  (1.4 GB, lower quality)" and "best (4.0 GB, higher quality)" before
  they send their first message.

---

## What the browser actually does at runtime

For the curious, here's the model-loading path traced through the
code:

1. User sends a chat message in
   `src/lib/components/workspace/ChatPane.svelte`.
2. `runLLMInference` calls `runChatInference` from
   `src/lib/pipeline/analysis.ts`.
3. The chat pipeline calls `runInference` from
   `src/lib/llm/inference.ts`, which:
   - Reads `static/models.json` for the chosen model's URL + sha256.
   - Configures Transformers.js with the configured `env.remoteHost`
     and `env.remotePathTemplate`.
   - Configures `env.backends.onnx.wasm.wasmPaths = '/'` (ORT WASM
     is local, not CDN).
   - Calls `pipeline()` with the model ID, which triggers the
     download.
4. Transformers.js fetches the ONNX files, verifies sha256, caches
   in the browser Cache API.
5. Subsequent runs hit the cache and load in <1 second.

If you change the model hosting URL, you change `env.remoteHost` in
`src/lib/llm/inference.ts` and
`src/lib/models/legal-classifier.ts`.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| "Failed to load model" in the chat | Hugging Face unreachable OR your self-host host unreachable OR CORS missing | Check the network tab; verify `Access-Control-Allow-Origin` header; check host CORS policy. |
| Model loads but produces nonsense | Wrong q4 variant OR sha256 mismatch | Re-run `pnpm models:build`; verify the file in your bucket sha256-matches the manifest. |
| Browser loops downloading the model | sha256 mismatch mid-stream | Check the model isn't being mutated in-flight; check no proxy is doing TLS MITM with a different cert chain. |
| Mobile users churn on first message | The 1.4 GB download is too slow for their network | Ship a lite mode; pre-warm; or accept the loss. |
| Model files missing in your bucket | Upload step skipped | Run `pnpm sync:cdn:upload` again; verify all 8 files are present. |
| Service worker doesn't precache the ORT WASM | Old service worker still active | Hard-refresh (Cmd-Shift-R / Ctrl-Shift-R); or bump `version` in `vite.config.ts` PWA config. |

---

## Build-time check

`pnpm models:build` (the build step that writes
`static/models.json`) scans the resulting manifest for entries
whose `baseUrl` still points at `huggingface.co` and prints a
warning when any are found. The warning is non-fatal by default
— you can still ship a build with the default host. To make it
fatal (CI-friendly), set
`CESVU_REQUIRE_NON_DEFAULT_HOST=1` in the build environment.

The check looks like this in the build output:

```
[models:build] ⚠ 8/8 entries still point at huggingface.co.
                  This is the courtesy default. Self-host before deploying
                  for real users — see MODELS.md → "Default host policy".
                  Set CESVU_REQUIRE_NON_DEFAULT_HOST=1 to fail the
                  build on this condition.
```

If you want to silence the warning entirely (e.g. for an
evaluation build you don't intend to deploy), set
`CESVU_ACCEPT_DEFAULT_MODEL_HOST=1`.

The variables:

| Env var | Effect |
|---|---|
| _unset_ | Warning printed, build succeeds. |
| `CESVU_ACCEPT_DEFAULT_MODEL_HOST=1` | Warning suppressed. |
| `CESVU_REQUIRE_NON_DEFAULT_HOST=1` | Build fails if any entry uses the default host. |

Most forks should set `CESVU_REQUIRE_NON_DEFAULT_HOST=1` in CI to
make the warning fatal. The Hugging Face default is for
evaluation; production forks MUST self-host.

## See also

- `scripts/r2-uploads/README.md` — the original (more verbose)
  deployment guide for the canonical setup
- `scripts/freeze.mjs` `models:build` subcommand — the build step
  that regenerates `static/models.json` from the sidecar manifests
- `src/lib/llm/inference.ts` — the runtime model loader
- `src/lib/models/legal-classifier.ts` — the contract-lens
  classifier loader
- `.clinerules/build_instructions.txt` — the authoritative spec
  for model hosting
