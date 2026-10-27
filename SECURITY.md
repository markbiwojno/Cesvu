# Security model

This document describes what Cesvu's document encryption actually
protects, what it does not, and how to report a vulnerability. If
you're evaluating Cesvu for a compliance program (HIPAA, SOC 2, etc.),
read this section before relying on it for anything.

We are seeking community review of our code to ensure it does not have 
flaws with the crypographic implementation or other cybersecurity flaws 
that could leak user data unexpectedly. 

The authoritative byte-level specification of the `.Cesvu` envelope
is `.cesvu SPEC/README.md`. This file is a security-reviewer-facing
summary, not the spec.

## What it defends against

The `.cesvu` envelope (implemented in `src/lib/crypto/Cesvu-crypto.ts`,
the Python CLI's `CLI/Cesvu/src/Cesvu/Cesvu_crypto.py`, and the Node.js
package's `NPM/src/cesvu-crypto.ts`) is designed for the following model:


  - **Local or in transit file copying.** A `.cesvu` file copied from a 
    user's device (stolen backup, compromised server, sync compromise) 
    does not reveal the document contents without the passphrase. The
    passphrase is *never* stored on the device, *never* transmitted by
    Cesvu, and *never* recoverable from the file — it travels
    out-of-band (shared verbally, in a separate message, etc.) and is
    the user's responsibility to protect.

  - **File extension metadata inference.** A `.cesvu` file could store a
    source file of any fileformat whatsover. Any file can be encrypted,
    and will decrypt in it's original filename and fileformat extension. 

  - **Damage from a corrupted or tampered ciphertext.** Every
    secretstream chunk is independently MAC-authenticated. A conforming
    reader rejects any file whose ciphertext has been tampered with or
    maliciously constructed, with a categorised error code (see
    `.cesvu SPEC/README.md` § "Decrypt error codes").

  - **"Parameter substitution" downgrade attacks.** The entire
    unencrypted header (KDF parameters, salt, passProfile, stream
    header) is bound as Associated Data on the first secretstream
    chunk. An attacker who rewrites the KDF memory / time-cost fields
    to cheaper values is detected by the chunk-1 MAC and rejected —
    the cheap pre-auth `keyCheck` would match, but the authenticated
    decrypt does not.

  - **Memory-pressure attacks on mobile browsers.** The format is
    streaming: a conforming reader never holds the whole plaintext in
    memory (`O(chunk)` memory, not `O(plaintext)`). A 100 MB PDF
    does not allocate 100 MB of JS heap — it allocates one chunk
    worth (1 MiB by default). This is the single most important
    reason the format is a streaming secretstream and not a single
    AES-GCM operation.

  - **Passphrase-typing mistakes.** The 6-word Diceware / 8-emoji
    passphrase defaults are entropy-equivalent (~77 bits), and the
    import UX validates each typed token against the canonical
    wordlist (EFF large wordlist, curated 800-emoji wordlist) in
    real time, so a sender cannot accidentally send a passphrase the
    recipient typo'd.

  - **Format-length-confusion attacks.** The plaintext payload uses
    the **CFP1 framing** (`[CFP1 magic 4][uint32 BE docJsonLen][JSON][raw bytes...]`)
    — the original source file travels as raw bytes after the JSON,
    not as a base64-encoded string inside it. This avoids the
    "RangeError: Invalid string length" failure mode that a base64
    approach would hit on a 100+ MB file, which a hostile producer
    could otherwise trigger to cause a denial-of-service crash.

- **Quantum computing decryption - "store now, decrypt later".** Among the format's design goals is to eliminate the quantum attack surface that *is* practical soon (public-key crypto, via Shor's) entirely by not using any, and to make the remaining theoretical quantum attack surface (Grover's against the passphrase KDF) require quantum hardware that isn't on any credible roadmap. 


## What it DOES NOT protect

This is the part a compliance reviewer actually needs. The following
are all true of Cesvu v1 and a security reviewer should treat them
as intended, not as bugs:

  - **In-browser plaintext is attackable.** Once a `.cesvu` file is
    decrypted in the browser, the plaintext document lives in the
    JS heap as a normal string until the tab is closed. Anything
    that can read the page's memory can read it: a compromised
    browser extension, a same-origin XSS, a malicious dependency,
    a host-OS memory-acquisition tool, a debugger. Cesvu's
    encryption protects the *file* and the *export*, not the
    *plaintext state inside the browser*. A user handling truly
    sensitive material should close the tab when finished.

  - **The "Send Back" session key is a plain JS variable, held for up
    to 15 minutes of inactivity.** To reply to a `.cesvu` sender
    without re-typing the passphrase, the passphrase used to unlock
    the original file is kept in memory (as a `Uint8Array`, not a
    string, so it can be zeroized) for up to 15 minutes of user
    inactivity, or until the document is closed, whichever comes
    first. It carries the same "in-browser plaintext is attackable"
    exposure as the rest of the app's state during that window. See
    "Send Back session key" below for the full mechanics.

  - **The local AI model sees plaintext.** The on-device LLM

    (Transformers.js / WebGPU) consumes the same plaintext to
    produce summaries, profiles, etc. The model runs in the
    browser process and inherits the same trust boundary as the
    rest of the page. This is not a security issue as the local
    LLM does not make external API calls nor store data.

-    **No audit / event log.** Cesvu v1 does not include a local audit or event log, device-signing keys, or an evidence trail for in-app events. Organizations evaluating Cesvu for use in a compliance program should therefore not assume that these capabilities are provided by the application. This is particularly relevant in regulated industries such as healthcare, where HIPAA requires covered entities to implement audit controls for systems containing electronic protected health information (ePHI) and to record and examine relevant system activity. An application-level audit logging capability could help organizations meet these requirements and reduce the compliance burden associated with implementing and maintaining their own logging and monitoring controls.

  - **No password recovery.** There is no password reset, no
    recovery key, no escrow. Lost passphrase = unrecoverable file.
    This is intentional — any recovery mechanism is also an
    attack surface — and is consistent with the
    zero-knowledge design.

  - **No forward secrecy between files.** Each `.cesvu` file is
    encrypted independently with its own random salt. The same
    passphrase applied to two different files produces two
    different ciphertexts (correct), but compromise of the
    passphrase at any point compromises every file ever
    encrypted with it. This is normal for a passphrase-based
    format and is not a defect, but a reviewer should know it.

  - **The `.cesvu` envelope is authenticated, not confidential,
    in metadata.** The header (which is public, unencrypted by
    design — must be parseable before the passphrase is known) does
    NOT include the filename or any identifying metadata. The
    *encrypted* metadata (filename, MIME type, etc.) lives inside
    the AEAD-protected payload and is authenticated by the
    secretstream, but see `.cesvu SPEC/README.md` for the normative
    "filename is AUTHENTICATED, not TRUSTED" rules — the recipient
    should validate, not just display, any filename derived from
    the metadata.

  - **`passProfile = 3` (raw passphrase) is device-dependent.**
    Because the raw profile applies identity normalization
    (no NFC, no lowercasing, no whitespace handling), the same
    password typed on different devices (e.g. macOS NFD vs Windows
    NFC) is a *different* passphrase and derives a different key.
    `.cesvu` files produced with a raw profile are openable on
    the same device but may not be portable across devices. A
    security reviewer should flag this for any compliance
    workflow that expects cross-device passphrase portability.
    This is intentional, and follows convention. In order to 
    have interdevice operability of (raw passphrases) one must
    copy/paste, rather than type such passphrases.

  - **The `keyCheck` field is a UX hint, not authorization.** A
    `keyCheck` mismatch is conclusive (wrong passphrase: reject),
    but a *match* does **not** prove the file is authentic \u2014 see
    the "keyCheck" warning in `.cesvu SPEC/README.md`. An attacker
    who can rewrite the file can rewrite `keyCheck` consistently
    with their own attacker-chosen password. The only
    authorization primitive is the secretstream's per-chunk MAC
    authenticated by the first chunk's full-header AAD.



### Known limitations / design tradeoffs

**No padding — file size leaks document size.** This means the exact size of the original document (plus its notes/metadata) is directly inferable from the encrypted file's size on disk. An attacker who intercepts a `.cesvu` file (e.g., in transit or sitting on a shared drive) can't read its contents, but they *can* estimate what kind of document it likely is just from its byte count — a one-page NDA and a 40-page contract look very different in size, even fully encrypted. This is a deliberate tradeoff for format simplicity and filesize efficiency.

 Cesvu's is designed for confidentiality between professionals (and their clients) not resistance to traffic analysis (can an attacker infer facts about a document they can't read?). Padding schemes are out of scope for this format and introduce unused filespace. If file-size correlation is a concern for your use case, pad your document yourself before encrypting, or use a transport that already normalizes size (e.g., deriving the `.cesvu` file from a fixed-size .zip container).


**Passphrase type metadata leak.** Depending upon how the .cesvu file was created and the user preferences, it is known from the plaintext header (Passphrase Profile) what type of passphrase will unlock it: 1 = Diceware passphrase, 2 = Emoji passphrase, and 3 = Custom (raw) passphrase. Is a deliberate tradeoff helps to process file unlocks quicker, otherwise all 3 types would need to be tried and the resulting increase in latency and poorer user experience when unlocking files.

**Plaintext preamble.** Not really a security tradeoff, but the Python CLI provides a way to create a plaintext preamble (up to 4096 bytes) that appears at the beginning of an encrypted .cesvu document which contains instructions, information, etc. This feature is only available in the included Python CLI and NPM package. 

**Unenforced entropy requirements for CLI "RAW PASSPHRASE" generation.** The Python CLI provides a way to create an arbitrary password from 1 - 512 bytes when generating .cesvu files. This is designed for power users, and as such not enforce passphrase entropy. Thus, even a single letter passphrase could be a valid, unlocking passphrase. This is deliberate, as there are situations whereby insecure passphrase (e.g. "password") may be desireable over secure passwords (demos, teaching purposes).

**OPFS scratch files during chunked streaming.** For large files, both encryption and decryption stream in bounded chunks (~1 MiB) rather than loading the entire file into memory — this is what lets Cesvu handle multi-gigabyte files without crashing the browser tab. On browsers/paths that require staging the output (the OPFS scratch-file fallback tier, used when the File System Access API's direct-to-disk streaming isn't available), the decrypted or encrypted bytes are written incrementally to a scratch file in the browser's Origin Private File System — a sandboxed, per-origin disk area not visible in the OS file browser or accessible to other websites, but still local disk storage outside the browser's JS heap. This scratch file is deleted on success, on error (partial writes are cleaned up immediately), and at session end — but it does mean plaintext bytes touch disk during processing rather than living only in memory for that window. This is a deliberate tradeoff: the alternative (buffering the entire file in memory) would cap the maximum file size Cesvu can process to whatever fits in available RAM, defeating the "any file, any size" promise. If your device's disk itself isn't encrypted at rest, this OPFS window is the same exposure any other local disk write during that session would carry.


## Send Back session key: in-memory passphrase reuse for replies

The "Send Back" feature (reply to a `.cesvu` sender using a document you
received, re-encrypted with notes/annotations added) needs the exact same
passphrase the sender already has, so the reply can be encrypted with it
without asking the recipient to re-type or re-share anything. This means
the passphrase the recipient typed to unlock the original file has to be
held in memory for the duration of that browser session — a genuinely more
sensitive piece of state than the document's own plaintext, and it gets its
own dedicated lifecycle (`src/lib/stores/sessionKey.svelte.ts`) rather than
living alongside the rest of the workspace state.

**Scope.** The session key is only ever captured on the small-file,
in-memory unlock path (`ImportModal.svelte`) — the path that actually opens
a document in the workspace. It is never captured for the oversized
"decrypt straight to disk" path or the raw-vault-payload download path,
neither of which ever materializes a document in the workspace and neither
of which has any use for a "Send Back" key.

**Storage.** The passphrase is kept as UTF-8 bytes (`Uint8Array`), never as
a lingering JS string. Strings are immutable in JS/V8 — there is no API to
force a string's backing memory to zero — so a byte array is the only
representation that can actually be wiped on demand. The string form is
reconstituted only transiently, at the single call site that needs it
immediately before an encrypt, and the caller is required to not retain it
beyond that one call.

**Salt freshness (why reuse is safe).** Every `.cesvu` encrypt operation —
including a "Send Back" reply — draws a brand-new random salt (see
`cesvu-crypto.ts`'s `encryptCesvuStream`), so reusing the sender's
passphrase for the reply produces a completely different derived key and
unrelated ciphertext bytes. An attacker holding both the original file and
the reply cannot use salt or ciphertext similarity to conclude the two were
encrypted with the same passphrase; see the "two encryptions of the SAME
passphrase produce UNRELATED ciphertext bytes" regression test in
`cesvu-crypto.test.ts` for the guarantee this claim rests on.

**Clearing triggers.** The key is dropped — bytes zeroized, every reference
nulled, pending timer cancelled — on either of:

  - **15 minutes of inactivity.** No `mousemove`/`keydown`/`click`/`scroll`/
    `touchstart` anywhere in the window for 15 minutes clears the key. Any
    one of those events resets the clock. This is the ordinary "walked away
    from the laptop" case.
  - **The document is closed.** The ✕ button / any reset path clears the
    key via `workspace.svelte.ts`'s `perDocumentTeardowns`, the same
    mechanism that already tears down the notes/clause stores on close.

**Deliberately removed: `visibilitychange`-based clearing.** An earlier
revision also cleared the key the instant `document.visibilityState`
became `'hidden'`, on the theory that "user switched away from the tab" is
itself a safety-relevant event. This was removed after real-world use
showed the tradeoff wasn't worth it: the Page Visibility API cannot
distinguish "the user switched to a different browser tab" from "the user
minimized the entire browser window" — both fire the identical `hidden`
transition. In practice this meant a completely routine minimize/restore
of the whole application window (not just a tab-away moment) silently
dropped the key and greyed out the "Send Back" button, forcing a
re-unlock for no threat-relevant reason. The remaining two triggers
(inactivity timeout, explicit close) already cover the realistic
threat this was meant to address — an unattended, unlocked session — without
punishing normal window-management behavior. A security reviewer should
treat this as a deliberate usability/security tradeoff, not an oversight:
the key still cannot outlive 15 minutes of idle time or a closed document,
it just no longer reacts to OS-level window state it can't reliably
interpret.

**What this key is not.** It never leaves memory, is never persisted (no
`localStorage`/`sessionStorage`/IndexedDB), and is never sent anywhere. It
carries the exact same "in-browser plaintext is attackable" caveat as the
rest of the app's plaintext state (see "What it DOES NOT protect" above):
anything that can read the page's JS heap — a compromised extension,
same-origin XSS, a malicious dependency, host-level memory acquisition —
can read it for as long as it's held. The clearing triggers above bound
*how long* that exposure window can last; they do not eliminate the
underlying browser-trust-boundary caveat.

## How the file header is authenticated

The `.cesvu` file format treats its **unencrypted header** (the
`magic`, `version`, `preamble`, `cipherMode`, KDF parameters,
`passProfile`, `salt`, `chunkShift`, `streamHeader`, and `keyCheck`
fields) as **adversarial input**. It must be readable before the
passphrase is known, so anyone can parse it; but it must not be
modifiable without the key-holder noticing.

The format achieves this by binding the **entire header byte
sequence as Associated Data on the first secretstream chunk**.
Concretely: the XChaCha20-Poly1305 secretstream's first chunk is
authenticated with the header bytes as AAD, so any single-bit
change to any header field invalidates that chunk's Poly1305 MAC and
causes the decrypt to fail closed with `CIPHERTEXT_CORRUPT`. The
chunk body itself is also authenticated, so the AAD binding
extends the per-chunk guarantee to the header without leaking the
header into the ciphertext.

**The threat this specifically defeats** is the "parameter
substitution" downgrade attack: an attacker who can modify the
file in transit or at rest can rewrite the KDF memory / time-cost
fields to cheaper values, mounting a cheap offline brute-force
against the diceware passphrase while a legitimate recipient's
reader still "succeeds" (it just re-derives the key using whatever
weakened parameters the attacker left). Without the AAD binding,
GCM by default authenticates only the body and the attacker's
cheaper-header file would pass. With the AAD binding, any bit flip
in the header invalidates the first chunk's MAC and the file
decrypts to a category error before any KDF work is done.

**The `keyCheck` field is independent of this.** `keyCheck` is a
32-byte keyed BLAKE2b hash of a fixed string under the derived
stream key, sitting in the public header. It exists so a
*legitimate* reader can reject a wrong passphrase before pulling
any ciphertext chunk (saving a full Argon2id derivation on
every failed attempt). A `keyCheck` mismatch is conclusive (wrong
passphrase: reject); a `keyCheck` *match* is **not proof** that
the file is authentic. Authentication of the header happens only
on the first secretstream chunk, where the header bytes are bound
as AAD.

## Metadata filtering and display safety

A `.cesvu` file's encrypted metadata carries a `filename` (and
optionally `mimeType`, `template`) that the recipient NEVER chose. A
producer who learns that a particular victim has software that
auto-uses embedded filenames can drop a `.cesvu` whose metadata
"please open me" under a name that, on the victim's filesystem,
looks like something else, overwrites something important, or is
invisible. Both implementations refuse to use that filename as a
filesystem path until it has been validated against a fixed filter
set, and escape it for display. This is a deliberate, normative
part of the spec \u2014 not a "best effort" sanitization.

**Filename validation (the most important class).** A conforming
implementation refuses to use an encrypted-metadata filename as a
filesystem path until it satisfies ALL of:

  - No path separators, no drive/rooted/UNC forms (including the
    separator-less drive-relative `C:evil.txt`).
  - No `.` or `..` as a path component.
  - No `<>:"/\|?*` anywhere.
  - No NUL or other C0 control bytes.
  - No trailing dot or trailing space.
  - No reserved device stems (`CON`, `PRN`, `AUX`, `NUL`,
    `COM1-9`, `LPT1-9`) matched on the stem so `NUL.txt` is
    caught too \u2014 including the superscript digit forms
    `COM\u00b9`/`LPT\u00b2`/`COM\u00b3`, which Win32 folds to 1/2/3 during device
    resolution.
  - The Windows rule set is applied unconditionally on every
    platform, because a Linux-decrypted file can be copied to a
    Windows SMB share and inherits Win32 semantics there.

Rejection is the ONLY response \u2014 there is no "sanitize into
submission". Stripping "unusual" characters destroys the extension
dot, mangles every non-ASCII name, and still does not stop `NUL`.
Salvaging the basename out of `../../etc/passwd` is equally wrong:
containment is satisfied, but the attacker still chose the name,
and `passwd`/`.bashrc`/`config.json` are useful names to choose.

Validation happens BEFORE the destructive write step, not after,
because post-validation cannot recover a destroyed file. Measured on
Windows 11: requesting `trailing...` reports success and lands on
`trailing`, *destroying whatever that entry already held*; requesting
`NUL` reports success, 0 bytes, and stores nothing at all. Noticing
either afterwards does not bring the file back.

A metadata-derived name NEVER overwrites an existing entry, in any
mode. The user did not choose this name, so consent to overwrite
cannot be inferred from a `-y`/`--force` flag, which speaks only
for a path the user typed themselves.

Reference: `src/lib/utils/cesvu-filename.ts` (web),
`CLI/cesvu/src/cesvu/output_names.py` (CLI), and the "filename
is AUTHENTICATED, not TRUSTED" section of `.cesvu SPEC/README.md`.
The CLI's `test_output_names.py` pins the filter set so the web
and CLI implementations cannot drift.

**Display sanitization.** Even names that PASS the filesystem check
can carry Unicode right-to-left override (U+202E), ANSI escape
sequences, zero-width characters, or homoglyphs \u2014 all of which
target the *human reading the output*, not the filesystem. The
implementations escape these for display (the raw name is preserved
in storage; the display string is sanitized). The exact set of
names that MUST still be accepted byte-for-byte (the tradeoff,
because over-escaping would mangle legitimate names) is documented
in `.cesvu SPEC/README.md`.

**Other encrypted metadata fields.** `mimeType` (max 127 chars) and
`template` (max 63 chars) are validated for length only and used
as-is by the parsing pipeline. They are NOT shell-injected, NOT
used as file paths, NOT rendered as HTML. They are advisory
metadata \u2014 a malformed mime type degrades to a sensible default
(`text/plain`); it does not break the security model.

**The plain-text document body is a different attack surface.**
The document `text` (and any subsequent notes, chat messages, etc.)
is fed to the local LLM as part of the prompt. This is the *real*
prompt-injection attack surface \u2014 a malicious document can
include "ignore previous instructions and \u2026" text that the local
model will see. `.cesvu` encryption does NOT protect against
this; it only protects the file at rest. Mitigation is an LLM-side
prompt-hardening concern (deliberately out of scope for this spec)
and is handled by the model layer, not the format.

**Header fields are not user-editable.** The protected preamble,
`keyCheck`, KDF parameters, salt, passProfile, etc. are validated
by the format itself (range checks, magic-byte checks, header AAD
binding) and never reach the FS or display layer in raw form. A
reviewer auditing "what does cesvu do with adversarial metadata?"
should focus on the `filename` path above \u2014 that is the only
field an attacker fully controls.

## CESVU_PASSPHRASE (CLI): a real credential path with its own exposure surface

The Python CLI accepts the encrypt/decrypt passphrase via the
`CESVU_PASSPHRASE` environment variable, in addition to `-p`/`--password`,
`--password-file`, and the interactive prompt (full precedence order:
`--diceware`/`--emoji` > `--password-file` > `-p` > `CESVU_PASSPHRASE` >
interactive prompt). This exists primarily for scripting and CI use, where
an interactive prompt isn't possible and a `-p` argument would be visible
in that process's command line and in shell history.

It is a legitimate, supported input path — not a workaround — but it has
its own exposure surface, distinct from `-p`'s shell-history/command-line
visibility, and worth understanding before relying on it in automation:

  - **Readable by other local processes.** Any process running as the
    same user (or root) can read another process's environment, e.g. via
    `/proc/<pid>/environ` on Linux. A `-p` argument is visible the same
    way (via the process list), so this is not strictly worse than `-p`
    — but it is easy to mistakenly assume an environment variable is
    "private" to the process that set it, when it is not.
  - **CI/CD log echoing.** Many CI/CD systems (GitHub Actions, GitLab CI,
    Jenkins, etc.) echo environment variables into build logs unless the
    variable is explicitly registered as a masked/protected secret.
    Setting `CESVU_PASSPHRASE` carelessly in a workflow file (e.g. as a
    plain `env:` value instead of a secrets-store reference) can leak it
    into plaintext, potentially long-retained CI logs.
  - **Child-process inheritance.** Child processes inherit the full
    parent environment by default, so a passphrase set via
    `CESVU_PASSPHRASE` is visible to every subprocess spawned afterward
    in the same shell session — not just to `cesvu` itself, unlike a
    scoped `-p` argument that only that one invocation receives.
  - **`.env` files are a common accidental-commit vector.** Sourcing a
    `.env` file containing `CESVU_PASSPHRASE=...` into a shell session is
    convenient, but `.env` files are one of the most frequently
    accidentally-committed credential leaks in the wild (`git add .env`).
    If you use one, make sure it's `.gitignore`d.

None of this makes `CESVU_PASSPHRASE` unsuitable for its intended use —
CI/automation contexts where the alternative (embedding `-p` directly in a
script or workflow file) has the same or worse exposure. It's documented
here so a security reviewer evaluating Cesvu's CLI for use in an
automated pipeline knows exactly what this credential path does and does
not protect against, rather than assuming an environment variable is
inherently more private than it is.

## NPM package (`@cesvu/crypto`): server-side credential hygiene is the caller's job

The Node.js package takes the passphrase as a plain JavaScript string
argument to its functions (`encryptCesvuFile(input, output, passphrase)`,
etc.) — it has no CLI flags, no environment-variable convention, and no
interactive prompt of its own. That's by design: it's a library, not an
application, so the calling backend decides how the passphrase reaches it
(request body, secrets manager, KMS-wrapped value, etc.), and the package
does not impose or assume a specific credential path.

This shifts credential-hygiene responsibility fully onto the integrating
application, with a few points worth calling out explicitly for a security
reviewer evaluating a server-side integration:

  - **The passphrase is a JS string in the host process's heap.** Same
    caveat as browser plaintext (see above), but on a server: whatever can
    read that process's memory (a compromised dependency, a debugger
    attached to production, a core dump) can read the passphrase while the
    encrypt/decrypt call is in flight. The package does not, and cannot,
    zero the string afterward — JS strings are immutable and garbage
    collected on the engine's own schedule, not on request.
  - **Don't log the passphrase, ever — including in error paths.** A
    thrown error that includes the full call arguments (common in some
    logging middleware / APM tooling) can leak the passphrase into log
    aggregation systems. Treat it the same as any other secret value in
    your logging redaction rules.
  - **Prefer a secrets manager / KMS over environment variables where
    possible** for the value passed in, for the same reasons documented
    above for `CESVU_PASSPHRASE` (env vars are inherited by child
    processes, readable via `/proc/<pid>/environ` by co-located
    processes, and commonly echoed into CI logs). The package itself is
    agnostic to where the string comes from — this is a recommendation
    for the integrating application, not a package feature.
  - **Same wire format, same normalization contract.** Whatever
    normalization rules apply to a given `passProfile` (see "Three
    passphrase profiles" above) apply identically here — a raw/custom
    passphrase generated or validated via `validateRawPassphrase` is
    identity-normalized (no trimming, no case-folding), exactly like the
    CLI's raw profile.

None of this is a defect in the package — a crypto library cannot enforce
credential hygiene in a caller it doesn't control. It's documented here so
integrators know exactly where the package's guarantees end and their own
operational responsibility begins.

## Build integrity (SRI)


Every shipped asset has a SHA-384 hash baked into its `<script>` / `<link>` tag so the browser can verify the file hasn't been tampered with between deploy and execution. The pipeline that maintains those hashes is four small commands, run in this order:

| Command           | When to run                  | What it does                                                                                                |
| ----------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `pnpm freeze`     | after `pnpm build`            | Walks `dist/`, hashes every file with SHA-256 + SHA-384, writes `dist/integrity.json`                        |
| `pnpm inject`     | after `pnpm freeze`          | Rewrites every local `<script>`/`<link>` in `dist/*.html` to add `integrity="sha384-…" crossorigin="anonymous"` |
| `pnpm sri:verify` | after `pnpm inject` (pre-deploy) | Re-parses `dist/*.html` and asserts every local tag has the right `integrity` attribute                       |
| `pnpm verify`     | anytime (CI)                 | Re-hashes every file in `dist/` and compares to `dist/integrity.json`; exits non-zero on any mismatch            |

The full pipeline is wired in `package.json`:

```json
"build": "svelte-kit sync && vite build && pnpm freeze && pnpm sri:inject"
```

`pnpm build` runs freeze + inject automatically. Run `pnpm sri:verify` before deploying. Run `pnpm verify` in CI to catch post-build tampering.

The Cloudflare Pages `_headers` file pins `Cross-Origin-Resource-Policy: cross-origin` and `Vary: Origin` on asset paths so the integrity check works correctly under CDN caching.

---

## Report a vulnerability - policy info


Email **security@cesvu.com** Please include:

  - A description of the issue and the impact.
  - A minimal reproduction (crash log, screen recording, or
    proof-of-concept).
  - The version affected (commit SHA, tag, or release).

Response windows:

  - **Investigate ASAP.**
  - **Triage within 10 business days** — confirmed, declined, or
    if we need more information.
  - **Fix or coordinated disclosure** for confirmed issues,
    timeline agreed case-by-case depending on severity and
    complexity. Arbitrary decryption of plaintext from within the
    .cesvu envelope will be pubicly disclosed, all else may not be.
  - **No response != unappreciated** for confidentiality reasons
    we may not be able to respond to your inquiry. This dosen't mean
    it was unappreciated nor is not factored into a future build update
    or roadmap.


Supported versions: the latest tagged release, plus the previous
one. Older versions are not patched — please upgrade.

We do **not** currently run a paid bug-bounty program. We may
acknowledge reporters in the fix commit and (with your permission)
in release notes.

**Out of scope for this disclosure channel:** non-security
bug reports (use the public issue tracker), feature requests,
support questions.

## Threat-model NOT optimized for

For completeness — these are real-world attacker capabilities we
considered and *did not* design against, because doing so would
have required server-side state or hardware-backed trust roots
that conflict with Cesvu's zero-knowledge / local-first posture:

  - **Compromise of the user's browser or device.** The plaintext
    is in the JS heap; nothing we do protects against a
    compromised browser binary, a malicious OS, or a
    compromised browser extension. Encryption at rest seemed
    to be over engineering. To guard against this however, filesystems
    which have encryption by default are more secure to run Cesvu
    on.
  - **SSL infrastructure level attack.** Cesvu does not
    control the physical network infrastructure between it 
    and it's servers. The main guard against such things is
    multiple deployments, and offline tooling such as the CLI.
  - **Sophisticated supply chain attacks.** Cesvu does not
    control distribution infrastructure of it's dependencies.
    In particular package manager attacks, or dependency attacks.

If any of these is in your threat model, Cesvu does not provide
that guarantee and you should not rely on it for that context.

## License

This document is licensed under Apache 2.0; see [`LICENSE`](LICENSE.md)
for the full license text.
