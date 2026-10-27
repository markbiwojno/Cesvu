# Cesvu™

> **Your own private, zero-knowledge document analysis application.**
>Cesvu is a local-first, zero-knowledge document analysis app — built upon one simple counter-cultural premise: your data never leaves your device.

Welcome!

You're a doctor bound by HIPAA. A litigator bound by attorney-client privilege — now with new urgency after United States v. Heppner, where a federal court ruled that using a cloud AI tool can destroy privilege because the provider's data policies amount to a third-party disclosure. The clock is ticking. You need to send a settlement proposal you just reviewed over to your client after 8 years of fighting — securely, but to their insecure personal email account. One leak and the settlement's void — and gone is everything you worked so hard for. Your firm spends more on IT every quarter than most people earn in a year, yet every vendor seems clueless on solutions. So how — and using a technology that's interoperable and usable by anyone? You need speed, but not at the expense of privacy.

You're an engineer, architect, or accountant bound by the data privacy regulations of your industry. You're a public company CEO annotating a merger agreement with your global team weeks before it's announced, with a billion-dollar breakup fee on the line. You're an independent consultant who just spent months building a multi-gigabyte report your best client is paying six figures for — and need a seamless handoff that gives ruthless competitors no chance to misappropriate it. Every tool you've tried — even the formerly staid ones — has, overnight, turned into a data mop that quietly uploads your sensitive information to a server you don't control.

Cesvu is the solution.

Select a CSV, PDF, DOCX, XLSX, or text file and everything that follows — parsing, profiling, AI-powered analysis — runs entirely in your browser. A browser-side LLM generates insights without a single byte touching a remote server. The only data of yours that is designed to ever leave your machine is an encrypted `.cesvu` file export, and only if you choose to share it. By design, it is saved to your disk and a securely generated passphrase is provided without your data even traversing the internet. The server never sees your plaintext. Never sees your keys. Never sees your analysis. It can't.

>Cesvu was designed around one simple use case: you need to send a sensitive document to someone who doesn't know the first thing about cybersecurity or software — and you want them to be able access it without calling for IT help, annotate it and send it back to you if needed, with the lowest chance of a leak of any software stack on the planet.

Cesvu can encrypt and decrypt any file type, of any file size, using an offline browser streaming API — still local, still zero-knowledge. Protecting not just documents, but any and all data. It ships with advanced Excel parsing and LLM-driven summarization. Designed for professionals working with data in any industry, with an open `.cesvu` specification that allows for you to integrate it's filetype into your own projects. Export from your end, open on ours. Free, interoperable, and auditable. 

> ### 🔎 Contract Lens: AI-assisted legal review.
> 
> ⚖️ For legal professionals, Cesvu offers a dedicated Contract Lens view that automatically detects and segments contract language clause-by-clause, powered by the `teimurjan/legal-clause-classifier` model. You can then:
> 
> - 📋 Review each clause in isolation.
> - ✏️ Edit & save key parties and dates.
> - 📌 Annotate individually — attach notes to specific clauses, not just the whole document.
> 
> 🤝 It's a true hybrid AI/human editing mode — the AI does the tedious segmentation and surfacing; you stay in control of every word that matters.

## Secure File Encryption - Drag, Drop & Download

Drop your file onto Cesvu.

Choose a six-word Diceware or eight-emoji passphrase (it's securely auto-generated). Done — the encrypted file is written to disk, ready to share or keep locally for safekeeping. When you or the recipient decides to decrypt it, Cesvu verifies file integrity to guarantee the original is restored byte-for-byte — same content, same name, same format.

If shared, the recipient opens the `.cesvu` file in the Cesvu web app, enters the passphrase, and the document decrypts locally — restored to its original name and extension, which were hidden inside the encrypted binary all along.

No file type left behind. No size ceiling imposed by us. No data leaving the device.

Guide to password entropy:
| Entropy | Security Level | Typical Use |
|---------:|----------------|-------------|
| 40–50 bits | Good | Short-term secrets, PINs |
| 64 bits | Very strong | Most user passwords |
| 80 bits | Excellent | Passwords, managers, passphrases |
| 96–128 bits | Exceptional | Cryptographic secrets |
| 128+ bits | Excessive for passwords | Encryption keys, master secrets |

| Property | 6-Word Diceware | 8-Emoji Passphrase |
|----------|----------------:|-------------------:|
| Pool size | 7,776 words | 800 emojis |
| Entropy per symbol | ~12.92 bits | ~9.64 bits |
| Total entropy | ~77.55 bits | ~77.15 bits |

Both formats provide approximately **77 bits of entropy**, making them comparably resistant to brute-force attacks while offering different usability tradeoffs. For example, Diceware passphrases may be preferable for formal usage and in particular communication via audio, while emoji passphrases are convenient for SMS messaging and more informal use. For the emoji format, we curated 800 emojis from a much larger set — both by hand and programmatically — specifically selecting those least likely to be visually confused with one another.


## Secure File Export for Sharing Workflow - In Browser, Document Based

When you click **Export** on a document, Cesvu:

1. Generates a random 256-bit __data-encryption key (DEK)__ and a random 6-word Diceware passphrase __or__ 8-emoji passphrase.
2. Derives a __key-encryption key (KEK)__ from the passphrase via Argon2id.
3. Bundles your notes, annotations, and analysis results (clause marks, contract-lens classifications) into the export payload.
4. Encrypts the export payload with the DEK using XChaCha20-Poly1305 secretstream.
5. Wraps the DEK with the KEK (so the passphrase is the only thing the recipient needs).
6. Saves the `.cesvu` file to your machine.
7. Shows the passphrase with cybersecurity best practices instructions.


```text
┌───────────────────────────────────────────────────────────┐
│  .cesvu SECURE FILE SHARING                              │
├───────────────────────────────────────────────────────────┤
│ Choose ONE format:                                        │
│                                                           │
│ 6 Words                                                   │
│ rocket garden mirror forest candle window                 │
│                                                           │
│ OR                                                        │
│                                                           │
│ 8 Emojis                                                  │
│ 🎳 🪸 🎽 🍔 🌻 🧋 🐃 🦣                               │
├───────────────────────────────────────────────────────────┤
│ The entire sequence is the passphrase.                    │
│ Send the encrypted file and the passphrase                │
│ through different communication channels.                 │
│ Example: email the file, text the passphrase.             │
└───────────────────────────────────────────────────────────┘

The recipient opens the .cesvu file in Cesvu, enters the
passphrase, and the document decrypts locally.
```

## CLI (Python)

For headless servers, scripting, and batch workflows, **`CLI/cesvu/`** is a
separate Python package that encrypts and decrypts the same `.cesvu` v1
format the web app uses. Install once, then `cesvu encrypt` and `cesvu
decrypt` from any terminal.

```bash
pip install cesvu  # use pip download to install
# or 
pip install -e ./CLI/cesvu # use our repo to install 

cesvu encrypt path/to/report.pdf              # uses --diceware by default
Terminal Outputs:
>Wrote report.cesvu
>Encrypted as a document (sourceType='pdf') — opens in the cesvu.com viewer.
>Diceware Passphrase: avatar droop denim equivocal sudoku december

cesvu encrypt path/to/report.txt --emoji      # 8-emoji passphrase 
Terminal Outputs:
>Wrote report.cesvu
>Encrypted as a document (sourceType='txt') — opens in the cesvu.com viewer.
>Emoji Passphrase: 🧡🙉🐇😥🥡🎬📡🤓

cesvu encrypt path/to/report.pdf -p "secret"  # CLI-only raw custom password. Env vars recommended for setting passwords to prevent passwords from being saved in shell history and scrollback exposure risk.

cesvu decrypt document.cesvu --password-file password.txt # Password files are manditory for opening files with Emoji passcodes on Windows due to character encoding drift on the Windows terminal. Not required for MacOS and Linux (as their terminals don't reliably corrupt the Emoji unicode)

```

**Passphrase profiles** the CLI offers the same two passphrase types as the
web app (Diceware and emoji) plus two CLI-only options for raw custom
passwords:

| Flag | Profile | Notes |
|---|---|---|
| `--diceware` | 6-word EFF wordlist | ~77.5 bits of entropy. Default if you don't say. |
| `--emoji` | 8 emoji | ~77 bits. **On Windows**, save the emoji to a UTF-8 text file and use `--password-file` instead of `-p`, since `cmd.exe`/PowerShell consoles can silently corrupt astral characters. |
| `-p` / `--password` | raw custom (CLI only) | Used **exactly as typed** no normalization, no trimming, no case folding. A leading or trailing space is part of the password. |
| `--password-file PATH` | raw custom from a file (CLI only) | Recommended for emoji on Windows. Strips a UTF-8 BOM and one trailing newline, nothing else. |

The CLI's raw profile (`passProfile = 3`) is read by the web app on import,
which displays it with a "this file uses a custom password" notice” the
web app never *generates* profile 3, only the CLI does.

**Three things to know about the CLI's view of files:**

1. **Document framing for `.txt`/`.md`/`.csv`.** When you encrypt a file
   with one of those extensions, the CLI wraps it in the same CFP1 document
   specification the web app's own **Export** button produces, so it opens
   directly in the cesvu.com viewer when imported there. Pass `--download`
   to opt out and force plain-file encryption (the recipient always gets a
   download, never the viewer).
2. **No browser parsing for `.pdf`/`.docx`/`.xlsx`.** Those types always encrypt 
   as plain files the recipients downloads. Adding CLI support for these files to 
   be natively parsed by the web application was added Python parser complexity that 
   did not  appear to be worth it. If you need this capability, use the web application
   to encrypt, rather than the CLI.
3. **Custom preamble.** `--desc` (inline) and `--desc-file` (path) override
   the default preamble shown before the passphrase prompt. Capped at 4096
   bytes (UTF-8). Stored **unencrypted** in the file header â€” anyone holding
   the file can read it. The web app displays whatever preamble is in the
   header before prompting, so a custom preamble set here will appear there
   too.

**Where the three implementations converge.** The `.cesvu` wire format
specification is in [`.cesvu SPEC/README.md`](.cesvu%20SPEC/README.md) (the canonical
source of truth) and the same file ships unchanged in all three checkouts.
Passphrase normalization is pinned by
[`shared/passphrase-vectors.json`](shared/passphrase-vectors.json), a
148-vector fixture consumed directly by both `pnpm test` (web app) and
`pytest` (CLI). The NPM package (`NPM/`) is a separately packaged, fully
independent implementation — its own `tests/passphrase-vectors.json` is
kept byte-identical to the shared fixture by hand/script rather than
importing it directly, since the package ships standalone to npm. Any
change to normalization rules requires regenerating
`shared/passphrase-vectors.json` and updating all three suites together.


See [`CLI/cesvu/README.md`](CLI/cesvu/README.md) for full CLI
documentation (install, every flag, edge cases).

## NPM Package (Node.js)

For server-side Node.js applications — encrypting/decrypting `.cesvu`
files inside your own backend, API routes, or scripts — **`NPM/`** is a
separate npm package, **`@cesvu/crypto`**, that speaks the exact same
`.cesvu` v1 wire format as the web app and the Python CLI. A file
produced by any one of the three can be opened by either of the other
two, given the same passphrase.

```bash
npm install @cesvu/crypto
```

```ts
import { encryptCesvuFile, decryptCesvuFile } from '@cesvu/crypto';

await encryptCesvuFile('./report.csv', './report.cesvu', 'my passphrase words here');

const result = await decryptCesvuFile('./report.cesvu', './report.out.csv', 'my passphrase words here');
console.log(result.metadata.filename); // "report.csv"
```

**What it offers beyond a minimal port:**

| Feature | Notes |
|---|---|
| In-memory API | `encryptCesvu` / `decryptCesvu` for buffers already in memory. |
| Atomic file I/O | `encryptCesvuFile` / `decryptCesvuFile` write via temp-file-then-rename, so a killed process never leaves a corrupted-but-plausible file behind. |
| Streaming API | `encryptCesvuStream` / `decryptCesvuStream` for payloads too large to hold twice in memory — `O(chunk)`, not `O(file)`. |
| Safe decrypt-to-directory | `decryptCesvuFileToDirectory` derives an output filename from the encrypted metadata under the same untrusted-filename rejection policy as the web app and CLI (see `src/output-names.ts`) — never overwrites, never trusts the embedded name unchecked. |
| Server-side passphrase helpers | `generatePassphrase`, `peekPassProfile`, `validateRawPassphrase`, `validateDicewareWords`, `validateEmojiPassphrase` — for wiring `.cesvu` encrypt/decrypt into your own HTTP handlers without any DOM/terminal assumptions. |
| Custom preambles | Same `preamble` option as the CLI's `--desc`, capped at 4096 UTF-8 bytes, readable/writable by all three implementations. |

Runtime dependencies are `libsodium-wrappers-sumo` (ISC) and `zod` (MIT),
bundled into the build output; their license notices are reproduced in
`NPM/THIRD_PARTY_LICENSES.md`. Requires Node.js 18+.

See [`NPM/README.md`](NPM/README.md) for full package documentation
(every export, streaming contract, security notes for multi-tenant use).

---


## Special Note For US Healthcare Industry Deployment 

> ## 🏥 Healthcare: No BAA Required
>
> Deploying Cesvu in healthcare environments requires **no BAA (Business Associate Agreement)** — because no sensitive data, encrypted or otherwise, ever touches our servers. That's not a feature layered on top. It's a **structural guarantee** built into the zero-knowledge architecture itself.

### This changes the deployment calculus entirely:

| Advantage | Why it matters |
|---|---|
| ⚡ **Faster rollout** | Skip months of legal review, vendor risk assessments, and BAA negotiations that typically gate healthcare IT projects. |
| 💰 **Lower cost** | Eliminate the compliance overhead, audit obligations, and liability premiums that cloud-based PHI handling demands. |
| 🔗 **Frictionless inter-institutional sharing** | The hardest problem in healthcare interoperability — securely exchanging medical records between competing institutions — is solved by not collecting the data in the first place. |

### 🚫 No cloud provider can offer this.

Their business model depends on your data residing on their infrastructure, which means the BAA, the breach risk, and the regulatory exposure are baked in. Cesvu's zero-knowledge design removes that dependency at the **architectural level** — not through policy promises, but through the simple fact that we physically cannot access what was never sent to us.

> 💡 That's not just a deployment advantage. It's a **fundamentally different trust model** for healthcare data.



> 🎉 **100% free. 100% yours. 100% customizable. 0% vendor lock-in. 0% stress.**

---

## Quick start

This is a SvelteKit project. The browser viewer is a static Svelte build served from any HTTP origin. So no Typescript/Javascript runs in the backend.

```sh
# Install dependencies (Node 20+)
pnpm install

# Run the dev server (http://localhost:5173)
pnpm dev

# Type-check
npx sv check

# Run the test suite (Vitest)
pnpm test

# Build the static site
pnpm build

# Test host it over your WiFi network (See it on your phone)
npm run dev -- --host 

```

The build output goes to `dist/` and is a fully static SPA. Node.js is not required in production - any server that can serve .js files is suitable. 

---

## The pipeline (data → insight)

```
PARSE → PROFILE → EXTRACT SIGNALS → SMART SAMPLE → COMPRESS → LLM → RENDER
```

1. **Parse** — auto-detect file type, route to the right parser (Papa Parse for CSV, SheetJS for XLSX, pdfjs-dist for PDF, mammoth for DOCX).
2. **Profile** — classify each column as numeric (mean / min / max / std) or categorical (unique count / top values).
3. **Extract signals** — detect trend direction via linear regression, flag spike rows (>2σ from the mean).
4. **Smart sample** — deterministic, evenly-spaced rows + extremes + spikes. Never random.
5. **Compress** — combine profile + signals + samples into a ~2000-char structured summary. **The LLM never sees raw data.**
6. **LLM** — feed the compressed summary + a template-specification system prompt. Note, template files are currently for reference only, as small LLMs do not respond particularly well to system prompts. Output is structured JSON only. Never HTML, CSS, or JavaScript.
7. **Render** — `ReportRenderer` maps `section.type` → Svelte component.

For tabular data, the primary analytical surface is a deterministic workbench: per-column statistics, Vega charts, click-to-filter. The LLM is invoked only when the user asks an interpretive question.

---

## The `.cesvu` specification

An encrypted, passpharase decrypted, binary format for securely sending or saving any file of any size. Selectively supports annotation metadata for certain file types if included.

## Cesvu File Header (v1)

| Offset | Size (bytes) | Field | Description |
|:------:|------------:|-------|-------------|
| `0` | `6` | Magic | ASCII `".CESVU"` |
| `6` | `2` | Version | `uint16` (Big Endian), currently `1` |
| `8` | `2` | Preamble Length | `uint16` (Big Endian), range `0–4096` |
| `10` | `PL` | Preamble | UTF-8 encoded text |

After the preamble:

```text
base = 10 + PL
```

| Offset | Size (bytes) | Field | Description |
|:------:|------------:|-------|-------------|
| `base + 0` | `1` | Cipher Mode | `1 = secretstream_xchacha20poly1305` |
| `base + 1` | `4` | KDF Memory | `uint32` (Big Endian), `65536–262144` KiB |
| `base + 5` | `1` | KDF Time Cost | `uint8`, range `1–10`, default `3` |
| `base + 6` | `1` | Passphrase Profile | `1 = Diceware`, `2 = Emoji`, `3 = Raw` |
| `base + 7` | `32` | Salt Slot | First `crypto_pwhash_SALTBYTES` bytes contain the salt; remaining bytes are **reserved** |
| `base + 39` | `2` | Chunk Shift | `uint16` (Big Endian), range `16–24`; `chunkSize = 1 << chunkShift` |
| `base + 41` | `32` | Stream Header Slot | First `HEADERBYTES` bytes contain the `secretstream` header; remaining bytes are **reserved** |
| `base + 73` | `32` | Key Check | Used for fast wrong-passphrase detection |

Encryption: Argon2id (64 MiB (64 - 256 MiB possible values), 3 iters (1-10 possible values), parallelism 4 <- NON CONFIGURABLE, HIDDEN BY WASM LIBSODIUM BINDINGS>) for key derivation, XChaCha20-Poly1305 secretstream (per-chunk AEAD) for the body. The full format is in `src/lib/crypto/cesvu-crypto.ts` and is the single source of truth for byte offsets.

The format is licensed under the **Apache License 2.0** (same as the codebase), so anyone can implement a reader or writer in any language with Apache's explicit patent grant for implementing the format. See [`LICENSE.md`](LICENSE.md) and the canonical spec at [`.cesvu SPEC/README.md`](.cesvu%20SPEC/README.md).

---

## Why open source

Simple. For maximum adoption, interoperability, decentralization and auditability from day 0. The whole project is licensed under the **Apache License 2.0** so:

- the source is open and auditable in any legal jurisdiction,
- the `.cesvu` v1 wire format carries Apache's explicit patent grant, so any language can ship a compatible reader or writer without patent-peace worries,
- downstream forks and commercial wrappers are welcome — there is no copyleft, no AGPL network clause, no Business Source License timetable, no "open core / paid premium" tier.

---

## License

This whole project — the Svelte/SvelteKit web app, the `src/lib/crypto/` library, the Python CLI under `CLI/cesvu/`, the Node.js package under `NPM/`, and the `.cesvu` v1 wire-format specification itself — is licensed under the **Apache License 2.0**.


- Source code: [`LICENSE.md`](LICENSE.md)
- `.cesvu` format specification: [`.cesvu SPEC/README.md`](.cesvu%20SPEC/README.md) (technical) and [`LICENSE.md`](LICENSE.md) (legal vehicle)

The "Cesvu" name and logo are trademarks — see [`TRADEMARKS.md`](TRADEMARKS.md) for the full policy. Forks are welcome but must not call themselves "Cesvu" or use its logo.

---

## Contributors

We're seeking public implementations of the v1 .cesvu specification to create an ecosystem to meet people where and how they work:

> If you're interested in contributing:
> - Language implementation infrastructure: PHP, Rust, Go, Ruby readers/writers
> - WordPress plugins, Quickbooks, LibreOffice support, native iOS/Android/macOS/Linux apps
> - Seeking export encryption utilities for QuickBooks Desktop, Xero, FreshBooks, Wave, and other accounting platforms using .cesvu
> - Any implementation ideas healthcare related! DICOM exports/imports, healthcare records export/import. Bring your creativity and skills. Let's make healthcare records more interoperable, by working together - no BAA (or BA) required!

This unlocks interoperability for the legal, healthcare, and finance professionals using Cesvu today.

Note, not currently accepting source code contributors to this repo, if that changes in the future, will update this readme. This would be other repos with their own maintainers and structure.