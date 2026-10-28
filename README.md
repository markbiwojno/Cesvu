# Cesvu™

> **Your own private, local-first document analysis application.**
>Cesvu is a local-first document analysis app — built upon one simple counter-cultural premise: your data never leaves your device.

Welcome!

You're a doctor bound by HIPAA. A litigator bound by attorney-client privilege — now with new urgency after United States v. Heppner, where a federal court ruled that using a cloud AI tool can destroy privilege because the provider's data policies amount to a third-party disclosure. The clock is ticking. You need to send a settlement proposal you just reviewed over to your client after 8 years of fighting — securely, but to their insecure personal email account. One leak and the settlement's void — and gone is everything you worked so hard for. Your firm spends more on IT every quarter than most people earn in a year, yet every vendor seems clueless on solutions. So how — and using a technology that's interoperable and usable by anyone? You need speed, but not at the expense of privacy.

You're an engineer, architect, or accountant bound by the data privacy regulations of your industry. You're a public company CEO annotating a merger agreement with your global team weeks before it's announced, with a billion-dollar breakup fee on the line. You're an independent consultant who just spent months building a multi-gigabyte report your best client is paying six figures for — and need a seamless handoff that gives ruthless competitors no chance to misappropriate it. Every tool you've tried — even the formerly staid ones — has, overnight, turned into a data mop that quietly uploads your sensitive information to a server you don't control.

Cesvu is the solution.

Select a CSV, PDF, DOCX, XLSX, or text file and everything that follows — parsing, profiling, AI-powered analysis — runs entirely in your browser. A browser-side LLM generates insights without a single byte touching a remote server. The only data of yours that is designed to ever leave your machine is an exported `.cesvu` file, and only if you choose to share it. By design, it is saved to your disk. The server never sees your document, never sees your analysis, never sees your notes. It can't.

>Cesvu was designed around one simple use case: you need to send a sensitive document to someone who doesn't know the first thing about cybersecurity or software — and you want them to be able to access it without calling for IT help, annotate it and send it back to you if needed, with the lowest chance of a leak of any software stack on the planet.

Cesvu ships with advanced Excel parsing and LLM-driven summarization, and an open `.cesvu` file format so you can integrate the filetype into your own projects. Export from your end, open on ours. Free, interoperable, and auditable.

> ### 🔎 Contract Lens: AI-assisted legal review.
> 
> ⚖️ For legal professionals, Cesvu offers a dedicated Contract Lens view that automatically detects and segments contract language clause-by-clause, powered by the `teimurjan/legal-clause-classifier` model. You can then:
> 
> - 📋 Review each clause in isolation.
> - ✏️ Edit & save key parties and dates.
> - 📌 Annotate individually — attach notes to specific clauses, not just the whole document.
> 
> 🤝 It's a true hybrid AI/human editing mode — the AI does the tedious segmentation and surfacing; you stay in control of every word that matters.

## File Export - Drag, Drop & Download

Drop your file onto Cesvu.

When you click **Export** on a document, Cesvu:

1. Bundles your notes, annotations, and analysis results (clause marks, contract-lens classifications) into the export payload.
2. Optionally embeds the original source file bytes alongside the extracted text and analysis.
3. Writes a `.cesvu` file to your machine - a single, self-describing container holding the metadata, the payload, and a SHA-256 integrity checksum.

The recipient opens the `.cesvu` file in the Cesvu web app and the document is restored locally - same content, same name, same format. The file carries a **checksum**, so a corrupted or truncated download is detected on open rather than silently half-loading.

**What the `.cesvu` file is and is not:** it is **not encrypted**. There is no passphrase, no key, and no secrecy - anyone who has the file can read its contents. The SHA-256 checksum provides *integrity* (it catches accidental corruption from a bad download or a flaky drive), not *confidentiality*. If you need confidentiality for a file, encrypt it with a real tool before wrapping it in a `.cesvu` container.

No file type left behind. No size ceiling imposed by us. No data leaving the device.

## File Export Sharing Workflow - In Browser, Document Based

The exported `.cesvu` file is a flat container with a small, readable header and a binary payload:

```text
+-------------------------------------------+
|  .cesvu file (plain, checksummed)         |
|                                           |
|  - preamble banner (human text)           |
|  - metadata JSON (filename, type)         |
|  - SHA-256 checksum of payload            |
|  - CFP1-framed payload                    |
|    - the document + your notes            |
|    - optional original source             |
+-------------------------------------------+
```

Send the `.cesvu` file to the recipient through whatever channel suits you - email, a file share, a USB stick. There is no second channel and no second secret to manage, because there is no key to deliver.

---

## Special Note For US Healthcare Industry Deployment 

> ## 🏥 Healthcare: No BAA Required
>
> Deploying Cesvu in healthcare environments requires **no BAA (Business Associate Agreement)** — because no sensitive data ever touches our servers. That's not a feature layered on top. It's a **structural guarantee** built into the local-first architecture itself.

### This changes the deployment calculus entirely:

| Advantage | Why it matters |
|---|---|
| ⚡ **Faster rollout** | Skip months of legal review, vendor risk assessments, and BAA negotiations that typically gate healthcare IT projects. |
| 💰 **Lower cost** | Eliminate the compliance overhead, audit obligations, and liability premiums that cloud-based PHI handling demands. |
| 🔗 **Frictionless inter-institutional sharing** | The hardest problem in healthcare interoperability — securely exchanging medical records between competing institutions — is solved by not collecting the data in the first place. |

### 🚫 No cloud provider can offer this.

Their business model depends on your data residing on their infrastructure, which means the BAA, the breach risk, and the regulatory exposure are baked in. Cesvu's local-first design removes that dependency at the **architectural level** — not through policy promises, but through the simple fact that we physically cannot access what was never sent to us.

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

A plain, self-describing binary container for sending or saving any file of any size, with selective annotation metadata for certain file types.
 
**It is not encrypted.** The format provides *integrity* (a SHA-256 checksum that catches
accidental corruption or truncation), not *confidentiality*. See [`.cesvu SPEC/README.md`](.cesvu%20SPEC/README.md)
for the normative spec.

## Cesvu File Header (v2)

| Offset | Size (bytes) | Field | Description |
|:------:|------------:|-------|-------------|
| `0` | `6` | Magic | ASCII `".CESVU"` |
| `6` | `2` | Version | `uint16` (Big Endian), currently `2` |
| `8` | `2` | Preamble Length | `uint16` (Big Endian), range `0-4096` |
| `10` | `PL` | Preamble | UTF-8 encoded text (human-readable banner) |

After the preamble:

```text
base = 10 + PL
```

| Offset | Size (bytes) | Field | Description |
|:------:|------------:|-------|-------------|
| `base + 0` | `2` | Metadata Length | `uint16` (Big Endian), range `1-4096` |
| `base + 2` | `ML` | Metadata | UTF-8 JSON (filename, mimeType, createdAt, template?) |
| `base + 2 + ML` | `32` | Checksum | SHA-256 digest of the payload bytes |
| `base + 34 + ML` | `*` | Payload | CFP1-framed document bytes (implicit length = remainder of file) |

The payload has no length field of its own - it runs from its offset to end-of-file. The SHA-256
checksum covers **only the payload bytes**, not the header or metadata.
 
The full format is specified in [`.cesvu SPEC/README.md`](.cesvu%20SPEC/README.md) (the normative spec)
and implemented in `src/lib/export/cesvu-export.ts` (the reference implementation).

The format is licensed under the **Apache License 2.0** (same as the codebase), so anyone can implement a reader or writer in any language with Apache's explicit patent grant for implementing the format. See [`LICENSE.md`](LICENSE.md).
---

## Why open source

Simple. For maximum adoption, interoperability, decentralization and auditability from day 0. The whole project is licensed under the **Apache License 2.0** so:

- the source is open and auditable in any legal jurisdiction,
- the `.cesvu` v2 wire format carries Apache's explicit patent grant, so any language can ship a compatible reader or writer without patent-peace worries,
- downstream forks and commercial wrappers are welcome — there is no copyleft, no AGPL network clause, no Business Source License timetable, no "open core / paid premium" tier.

---

## License

This whole project — the Svelte/SvelteKit web app, the `src/lib/export/` library, and the `.cesvu` v2 wire-format specification itself — is licensed under the **Apache License 2.0**.


- Source code: [`LICENSE.md`](LICENSE.md)
- `.cesvu` format specification: [`.cesvu SPEC/README.md`](.cesvu%20SPEC/README.md) (technical) and [`LICENSE.md`](LICENSE.md) (legal vehicle)

The "Cesvu" name and logo are trademarks — see [`TRADEMARKS.md`](TRADEMARKS.md) for the full policy. Forks are welcome but must not call themselves "Cesvu" or use its logo.

---

## Contributors

We're seeking public implementations of the v2 .cesvu specification to create an ecosystem to meet people where and how they work:

> If you're interested in contributing:
> - Language implementation infrastructure: PHP, Rust, Go, Ruby readers/writers
> - WordPress plugins, Quickbooks, LibreOffice support, native iOS/Android/macOS/Linux apps
> - Seeking export utilities for QuickBooks Desktop, Xero, FreshBooks, Wave, and other accounting platforms using .cesvu
> - Any implementation ideas healthcare related! DICOM exports/imports, healthcare records export/import. Bring your creativity and skills. Let's make healthcare records more interoperable, by working together - no BAA (or BA) required!

This unlocks interoperability for the legal, healthcare, and finance professionals using Cesvu today.

Note, not currently accepting source code contributors to this repo, if that changes in the future, will update this readme. This would be other repos with their own maintainers and structure.
