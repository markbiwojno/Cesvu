<script lang="ts">
	/**
	 * ImportModal.svelte — unlock a .cesvu file with its passphrase.
	 *
	 * The file is chosen BEFORE this modal opens (file input or drag-drop) and
	 * handed in via the `file` prop. The user pastes or types the full
	 * passphrase into ONE masked input — a single paste fills it, whether the
	 * sender shared a 6-word diceware phrase or an 8-emoji passphrase.
	 *
	 * ── Unified word/emoji flow ────────────────────────────────────────────
	 * We don't ask the user up front which passphrase TYPE they have, and we
	 * no longer expose a manual toggle either — both confused users who
	 * didn't know which "page" to use. Instead the input auto-detects mode
	 * from what's actually been typed/pasted: if it contains any emoji
	 * character (tested via the Unicode `Extended_Pictographic` property),
	 * we're in emoji mode; otherwise we're in word mode (the default/empty
	 * state). This detected `mode` does double duty:
	 *   1. It picks the right per-token validation feedback below (word
	 *      chips vs. emoji chips).
	 *   2. It's passed to `importFromCesvu` as a `preferredType` hint,
	 *      which tells `decryptCesvu` which normalization to try FIRST
	 *      (see cesvu-crypto.ts) — purely a performance optimization.
	 *      `decryptCesvu` ALWAYS still falls back to the other
	 *      normalization on failure regardless of this hint, so a wrong
	 *      guess here never produces a wrong result, it just costs one
	 *      extra ~0.6–2s Argon2id derivation.
	 *
	 * Below the input, a chip row shows position + the actual token + a
	 * validity color, for BOTH modes:
	 *   - green  ✓  token is in the relevant curated list
	 *              (EFF diceware wordlist, or the 800-emoji wordlist)
	 *   - red    ✗  token is non-empty but NOT in the list (typo/substitution
	 *              caught early)
	 *   - muted  —  empty slot, or list still loading
	 * Submit is enabled only when all required slots are valid (exactly 6
	 * words for diceware, at least 8 emoji for the emoji path).
	 *
	 * If the user pastes more tokens than required: diceware is fixed at 6
	 * words, so extras render as additional red chips (warning: "remove the
	 * extras"). Emoji passphrases, however, support extra emoji beyond 8 for
	 * additional entropy per the .cesvu spec (up to 100) — so a valid extra
	 * emoji renders in a distinct "extra entropy" style instead of red, and
	 * only a genuinely non-curated extra emoji is flagged as an error.
	 *
	 * The passphrase lives only in component memory — never localStorage /
	 * sessionStorage.
	 *
	 * ── Raw vault files (non-document payloads) ────────────────────────────
	 * Not every .cesvu wraps a document. The "vault" flow (see
	 * src/lib/crypto/vault-io.ts's exportRawFileToVault, used for files the
	 * in-app viewer can't open, e.g. images/zips) encrypts RAW file bytes
	 * with no document framing at all. `importFromCesvu` recognizes this
	 * case (decryption succeeded and authenticated the bytes, they just
	 * aren't a document) and throws `RawVaultPayloadError` instead of
	 * treating it as corruption. We catch that below and trigger a normal
	 * browser download of the decrypted bytes instead of opening a viewer.
	 *
	 * ── "File decrypted" success screen (stays open) ────────────────────────
	 * Previously the success screen auto-closed itself via a 1s setTimeout,
	 * which meant it "flashed" past before most users could read it. It now
	 * stays open until the user takes an explicit action (View file) or
	 * dismisses it themselves (backdrop click / Escape / ✕ — all handled by
	 * Modal.svelte already). The screen also offers a "send a file back to
	 * the sender" shortcut: since the sender's passphrase is already sitting
	 * in memory (captured below, right alongside the sessionKeyStore write),
	 * a reply can be encrypted with the SAME passphrase without asking the
	 * user to type or generate a new one. See `handleSendBackFileChosen`'s
	 * doc comment for the split:
	 *   - a type the in-app viewer can't open at all (isVaultCandidate) reuses
	 *     SecureSaveModal verbatim (its `presetPassphrase`/
	 *     `presetPassphraseType` props) for an identical raw-file encrypt UX
	 *     to every other "secure this file" flow in the app;
	 *   - a viewer-supported type (pdf/docx/csv/xlsx/txt/md) is re-parsed and
	 *     reuses SendBackModal instead, so the reply is CFP1-framed and
	 *     reopens in the recipient's viewer rather than just downloading.
	 */
	import { onMount } from 'svelte';
	import Modal from '$lib/components/common/Modal.svelte';
	import {
		importFromCesvu,
		RawVaultPayloadError,
		createDocument,
		deleteDocument
	} from '$lib/stores/contract-store.svelte.js';
	import { sessionKeyStore } from '$lib/stores/sessionKey.svelte.js';
	import SecureSaveModal from '$lib/components/SecureSaveModal.svelte';
	import SendBackModal from '$lib/components/SendBackModal.svelte';
	import { isVaultCandidate } from '$lib/crypto/vault-constants.js';
	import { parseFile } from '$lib/parsers/index.js';
	import { parsedFileToDocumentInit } from '$lib/utils/parsed-file-to-document.js';
	import {
		isDicewareWord,
		isCuratedEmoji,
		parseHeader,
		PASS_PROFILE_RAW,
		RAW_PASSPHRASE_MAX_BYTES,
		rawPassphraseByteLength,
		CesvuError,
		type PassphraseType
	} from '$lib/crypto/index.js';
	import type { CesvuDocument } from '$lib/schema.js';



	interface Props {
		file: File;
		onclose: () => void;
		onimported: (doc: CesvuDocument) => void;
	}
	let { file, onclose, onimported }: Props = $props();

	type Phase = 'input' | 'unlocking' | 'success' | 'raw-saved';
	let phase = $state<Phase>('input');
	/** Set only when phase === 'raw-saved' — the original filename of the
	 *  raw (non-document) file we just downloaded via the browser. */
	let savedRawName = $state('');

	// ── "File decrypted" success screen state ──────────────────────────────
	/** The just-unlocked document — captured in `unlock()` so the success
	 *  screen can show its name/size without re-reading anything. */
	let unlockedDoc = $state<CesvuDocument | null>(null);
	/** The passphrase (+ type) just used to unlock, reused verbatim for the
	 *  "Choose a file to send back" flow so the recipient can reply with the
	 *  SAME passcode without retyping it. Mirrors sessionKeyStore's copy —
	 *  kept locally too since sessionKeyStore may be cleared/rekeyed by the
	 *  time the user clicks the send-back button. */
	let unlockedPassphrase = $state('');
	let unlockedPassphraseType = $state<PassphraseType>('diceware');
	let moreOptionsOpen = $state(false);
	let showFileInfo = $state(false);
	/**
	 * File chosen via the hidden picker for "Choose a file to send back",
	 * ONLY when it's a type the in-app viewer can't open at all (see
	 * `isVaultCandidate`) — e.g. an image or zip. That file is routed through
	 * `SecureSaveModal`'s raw-vault encrypt (no document framing), which is
	 * correct here since there's no viewer to reopen it in anyway.
	 */
	let sendBackFile = $state<File | null>(null);
	/**
	 * Set instead of `sendBackFile` when the chosen reply file IS a
	 * viewer-supported type (pdf/docx/csv/xlsx/txt/md — same check
	 * `Workspace.svelte`/`DocumentPane.svelte` use for uploads/drops). The
	 * file is re-parsed and turned into an ephemeral CesvuDocument (via
	 * `parsedFileToDocumentInit`) so `SendBackModal` can CFP1-frame it through
	 * the SAME `sendBackAsCesvu` path a normal "Send Back" reply uses — the
	 * recipient's viewer can then reopen it, instead of it just downloading
	 * as a raw file (which is what the vault path above would have produced
	 * for a type the viewer actually supports).
	 */
	let sendBackDocId = $state<string | null>(null);
	let sendBackInputEl = $state<HTMLInputElement | null>(null);
	/** Best-effort error surfaced when re-parsing a viewer-supported reply
	 *  file fails — we fall back to the raw vault path rather than dead-ending
	 *  the send-back flow entirely, so this is informational only. */
	let sendBackParseError = $state('');

	/** Best-effort decrypted size for the success screen's "2.4 MB" line —
	 *  the raw source bytes when present (pdf/docx/csv/excel), otherwise the
	 *  UTF-8 byte length of the extracted text (txt/md). */
	function decryptedByteSize(doc: CesvuDocument): number {
		if (doc.rawContent instanceof Uint8Array) return doc.rawContent.length;
		if (typeof doc.rawContent === 'string' && doc.rawContent.length > 0) {
			// base64 → byte length without decoding the whole thing.
			const s = doc.rawContent.replace(/=+$/, '');
			return Math.floor((s.length * 3) / 4);
		}
		return new TextEncoder().encode(doc.text ?? '').length;
	}

	function formatBytes(n: number): string {
		if (n < 1024) return `${n} B`;
		const units = ['KB', 'MB', 'GB', 'TB'];
		let v = n / 1024;
		let i = 0;
		while (v >= 1024 && i < units.length - 1) {
			v /= 1024;
			i++;
		}
		return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
	}

	/** Trigger a normal browser download of the decrypted document's bytes,
	 *  under its real name — the "Download file" item buried under More
	 *  options. Mirrors ExportModal.svelte's downloadSource(). */
	function downloadDecrypted() {
		const doc = unlockedDoc;
		if (!doc) return;
		let bytes: Uint8Array;
		if (doc.rawContent instanceof Uint8Array && doc.rawContent.length > 0) {
			bytes = doc.rawContent;
		} else if (typeof doc.rawContent === 'string' && doc.rawContent.length > 0) {
			const bin = atob(doc.rawContent);
			bytes = new Uint8Array(bin.length);
			for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
		} else {
			bytes = new TextEncoder().encode(doc.text ?? '');
		}
		const blob = new Blob([bytes as BlobPart], { type: 'application/octet-stream' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = doc.name || 'document';
		document.body.appendChild(a);
		a.click();
		a.remove();
		URL.revokeObjectURL(url);
	}

	function openSendBackPicker() {
		sendBackInputEl?.click();
	}

	/**
	 * Route the chosen reply file to the right encrypt path:
	 *   - Viewer-UNSUPPORTED type (isVaultCandidate) → raw vault encrypt via
	 *     SecureSaveModal (sendBackFile). Correct as-is: there's no viewer to
	 *     reopen it in anyway, so a plain-download-on-decrypt reply is fine.
	 *   - Viewer-SUPPORTED type (pdf/docx/csv/xlsx/txt/md) → re-parse it with
	 *     the SAME parseFile() router the normal upload path uses, wrap the
	 *     result in an ephemeral CesvuDocument, and hand it to SendBackModal
	 *     (sendBackDocId) so the reply is CFP1-framed and reopens in the
	 *     recipient's viewer — matching every other "Send Back" reply in the
	 *     app instead of silently downgrading to a raw file.
	 * A parse failure on a nominally viewer-supported file (corrupt upload,
	 * unexpected content, etc.) falls back to the raw vault path rather than
	 * dead-ending the whole flow — the reply still gets sent, just without
	 * viewer framing.
	 */
	async function handleSendBackFileChosen(e: Event) {
		const input = e.currentTarget as HTMLInputElement;
		const chosen = input.files?.[0];
		input.value = ''; // allow re-picking the same file later
		if (!chosen) return;

		sendBackParseError = '';

		if (isVaultCandidate(chosen)) {
			sendBackFile = chosen;
			return;
		}

		try {
			const parsed = await parseFile(chosen);
			const doc = await createDocument({
				name: chosen.name,
				...parsedFileToDocumentInit(parsed)
			});
			sendBackDocId = doc.id;
		} catch (err) {
			sendBackParseError =
				err instanceof Error ? err.message : 'Could not read that file — sending as-is instead.';
			sendBackFile = chosen;
		}
	}

	/** SecureSaveModal (send-back flow, viewer-unsupported type) finished —
	 *  close BOTH modals rather than returning to the "File decrypted"
	 *  screen, which would be a step backward once the reply has already
	 *  been sent. */
	function handleSendBackDone() {
		sendBackFile = null;
		onclose();
	}

	/** SendBackModal (send-back flow, viewer-supported type) finished —
	 *  same "close both modals" behavior as handleSendBackDone(), plus
	 *  deletes the ephemeral document: it only ever existed to be
	 *  CFP1-framed and sent back, never to live on in the "resume" list. */
	async function handleSendBackDocDone() {
		const id = sendBackDocId;
		sendBackDocId = null;
		if (id) {
			try {
				await deleteDocument(id);
			} catch {
				/* best-effort cleanup — never block closing on this */
			}
		}
		onclose();
	}

	/**
	 * Whether this file's header declares `PASS_PROFILE_RAW` (a custom
	 * user-chosen password, see ExportModal/SecureSaveModal's "Custom
	 * Password" option) — peeked from the file's own bytes at mount, BEFORE
	 * the user types anything, so we can show a plain password field
	 * instead of the diceware/emoji chip UI. `null` while still peeking or
	 * if the header couldn't be parsed (falls back to the auto-detect UI;
	 * the actual unlock attempt below is unaffected either way since
	 * decryptCesvu's own header parse is authoritative).
	 */
	let isRawProfile = $state<boolean | null>(null);


	/** The raw passphrase string — what the user types or pastes. */
	let passphrase = $state('');
	let error = $state('');
	let failedAttempts = $state(0);
	let cooldown = $state(0);

	// Words are masked (•••) by default for shoulder-surfing protection; the
	// "Show" checkbox reveals them. The chips below the input ALWAYS show
	// the actual token so the user can see which slot is wrong.
	let showPassphrase = $state(false);

	let inputEl = $state<HTMLInputElement | null>(null);
	let cooldownTimer: ReturnType<typeof setInterval> | null = null;

	/** Detects the Unicode `Extended_Pictographic` property — true for
	 *  essentially every emoji character, false for plain ASCII/Latin text.
	 *  This is the sole signal used to auto-detect which validation UI to
	 *  show; it needs no state of its own, it's derived fresh from the
	 *  current passphrase on every change. */
	const EMOJI_TEST = /\p{Extended_Pictographic}/u;

	/** Auto-detected mode. Empty input defaults to `'diceware'` (the more
	 *  common case) until the user types/pastes something that reveals
	 *  which kind of passphrase they have. */
	const mode = $derived<'diceware' | 'emoji'>(
		EMOJI_TEST.test(passphrase) ? 'emoji' : 'diceware'
	);

	/** Split on any whitespace run; drop empties. Mirrors the canonical
	 *  form the KDF sees (post-`normalizeDicewarePassphrase`). Only
	 *  meaningful in diceware mode. */
	const words = $derived(
		passphrase.trim().length === 0 ? [] : passphrase.trim().split(/\s+/)
	);
	const wordCount = $derived(words.length);
	const locked = $derived(cooldown > 0);

	/**
	 * UTF-8 BYTE length of a custom (PASS_PROFILE_RAW) password — the unit
	 * RAW_PASSPHRASE_MAX_BYTES is expressed in, so it is the unit both the
	 * counter and the submit gate must use.
	 *
	 * Was `passphrase.length` (UTF-16 code units), which was wrong in both
	 * directions: it over-counts astral characters (256 emoji reads as 512,
	 * blocking a valid password at half the limit while showing a count the
	 * user cannot reconcile with what they typed) and under-counts
	 * everything above ASCII (512 CJK characters reads as 512 but is 1536
	 * bytes, enabling submit on a password preparePassphrase then rejects
	 * with PASSPHRASE_TOO_LONG). Counting bytes makes the number displayed
	 * the number actually enforced.
	 *
	 * Only meaningful when `isRawProfile` — profiles 1 and 2 have no byte
	 * cap, per .cesvu SPEC/README.md.
	 */
	const rawBytes = $derived(rawPassphraseByteLength(passphrase));

	/** Emoji-mode tokens. `Array.from` (not `.split('')`) so surrogate-pair
	 *  emoji count as ONE character each, matching how
	 *  `generateEmojiPassphrase` counts emoji. Whitespace is stripped first
	 *  since `normalizeEmojiPassphrase` strips it too — a pasted string with
	 *  incidental spaces shouldn't under-count or create bogus empty slots. */
	const emojis = $derived(Array.from(passphrase.replace(/\s/g, '')));
	const emojiCount = $derived(emojis.length);

	/** Per-word validation cache, keyed by lowercase word.
	 *  `null` = not yet validated, `true` = in EFF list, `false` = not in list. */
	let wordValidations = $state<Record<string, boolean | null>>({});

	/** Per-emoji validation cache, keyed by the emoji character itself
	 *  (emoji have no case, so no normalization is needed for the key). */
	let emojiValidations = $state<Record<string, boolean | null>>({});

	$effect(() => {
		// Never treat a raw/custom password as diceware — even if a token
		// within it happens to match a real EFF word, this must be a no-op
		// (see the auto-space effect below for why this guard matters).
		if (isRawProfile || mode !== 'diceware') return;
		// Re-validate whenever the typed words change. Re-running on every
		// keystroke is fine — `isDicewareWord` is O(1) against a cached Set
		// after the first call.
		const seen = new Set<string>();
		for (const w of words) {

			const key = w.toLowerCase();
			seen.add(key);
			if (wordValidations[key] === undefined) {
				wordValidations[key] = null;
				isDicewareWord(w).then((result) => {
					wordValidations[key] = result;
				});
			}
		}
		// Garbage-collect entries for words that are no longer in the input,
		// so the cache stays bounded during long editing sessions.
		for (const key of Object.keys(wordValidations)) {
			if (!seen.has(key)) delete wordValidations[key];
		}
	});

	$effect(() => {
		if (mode !== 'emoji') return;
		// Same re-validate-on-change pattern as words, but keyed by the raw
		// emoji character (no case-folding — emoji have no case) and backed
		// by `isCuratedEmoji` (the 800-emoji curated wordlist) instead of
		// the EFF diceware list.
		const seen = new Set<string>();
		for (const e of emojis) {
			seen.add(e);
			if (emojiValidations[e] === undefined) {
				emojiValidations[e] = null;
				isCuratedEmoji(e).then((result) => {
					emojiValidations[e] = result;
				});
			}
		}
		for (const key of Object.keys(emojiValidations)) {
			if (!seen.has(key)) delete emojiValidations[key];
		}
	});

	/**
	 * Auto-insert a space after each word becomes EFF-valid, so the user
	 * never has to type a space between words. The trailing space also
	 * visually separates words in the masked/unmasked view (per the spec:
	 * "all valid diceware words be spaced in the viewer"). Diceware-mode
	 * only — emoji passphrases have no separator by design (see
	 * `normalizeEmojiPassphrase`, which strips ALL whitespace).
	 *
	 * Guards (all required):
	 *   1. Skip if not in diceware mode.
	 *   2. Skip if the input is empty.
	 *   3. Skip if the user is editing in the middle of the input — we
	 *      must NOT yank their cursor to the end mid-edit. We only act
	 *      when the cursor is at the very end.
	 *   4. Skip if the last word is not yet EFF-valid (still loading or
	 *      genuinely not in the list — e.g. a typo).
	 *   5. Skip if the passphrase already ends with a space (idempotent).
	 *
	 * After appending the space, restore the cursor to the end of the
	 * input via `queueMicrotask` so the next keystroke lands in the new
	 * word slot, not at the position of the typed letter that triggered
	 * the auto-space.
	 */
	$effect(() => {
		// Guard on isRawProfile too — a custom password must never be
		// silently mutated, even if one of its whitespace-separated tokens
		// happens to coincide with a real EFF diceware word (this was the
		// root cause of a bug where a trailing space got auto-appended to
		// custom passwords, silently breaking decryption).
		if (isRawProfile || mode !== 'diceware') return;
		if (passphrase.length === 0) return;
		// Only auto-space when the user is actively typing at the end.
		if (inputEl && inputEl.selectionStart !== inputEl.value.length) return;
		const splitWords = passphrase.split(/\s+/).filter(Boolean);
		if (splitWords.length === 0) return;
		const lastWord = splitWords[splitWords.length - 1];
		if (wordValidations[lastWord.toLowerCase()] !== true) return;
		if (passphrase.endsWith(' ')) return;
		passphrase = passphrase + ' ';

		// Restore cursor at the end after `bind:value` updates the DOM.
		queueMicrotask(() => {
			inputEl?.setSelectionRange(passphrase.length, passphrase.length);
		});
	});

	/** How many of the first-6 word slots are NOT in the EFF list (excludes extras). */
	const invalidWordCount = $derived(
		words.slice(0, 6).filter((w) => wordValidations[w.toLowerCase()] === false).length
	);
	/** How many of the first-8 emoji slots are NOT in the curated list (excludes extras). */
	const invalidEmojiCount = $derived(
		emojis.slice(0, 8).filter((e) => emojiValidations[e] === false).length
	);

	/** Diceware gate: exactly 6 EFF-valid words. Emoji gate: at least 8
	 *  curated-valid emoji. Raw (custom password) gate: any non-empty
	 *  password up to the app-level length cap. */
	const canSubmit = $derived(
		isRawProfile
			? passphrase.length > 0 &&
					rawBytes <= RAW_PASSPHRASE_MAX_BYTES &&
					!locked &&
					phase !== 'unlocking'
			: mode === 'emoji'
				? emojiCount >= 8 && invalidEmojiCount === 0 && !locked && phase !== 'unlocking'
				: wordCount === 6 && invalidWordCount === 0 && !locked && phase !== 'unlocking'
	);

	/** Read just enough of the file's header to learn its `passProfile`
	 *  BEFORE the user types anything, so a custom-password (`PASS_PROFILE_RAW`)
	 *  vault shows a plain password field instead of the diceware/emoji chip
	 *  UI. Grows the peeked slice and retries on `TOO_SHORT` (the header's
	 *  declared preamble length can vary), capped at `file.size` so we never
	 *  request more bytes than exist. Purely a UX nicety — never blocks
	 *  input, and any parse failure here just leaves the auto-detect UI in
	 *  place; the real header parse inside `decryptCesvu` is authoritative. */
	async function peekPassProfile() {
		let peekLen = Math.min(4096, file.size);
		for (let attempt = 0; attempt < 4; attempt++) {
			try {
				const slice = file.slice(0, peekLen);
				const bytes = new Uint8Array(await slice.arrayBuffer());
				const { passProfile } = await parseHeader(bytes);
				isRawProfile = passProfile === PASS_PROFILE_RAW;
				return;
			} catch (e) {
				const isTooShort = e instanceof CesvuError && e.code === 'TOO_SHORT';
				if (!isTooShort || peekLen >= file.size) return;
				peekLen = Math.min(peekLen * 4, file.size);
			}
		}
	}

	onMount(() => {
		inputEl?.focus();
		void peekPassProfile();
		return () => {
			if (cooldownTimer) clearInterval(cooldownTimer);
		};
	});


	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			e.preventDefault();
			if (canSubmit) void unlock();
		}
	}

	function startCooldown(seconds: number) {
		cooldown = seconds;
		if (cooldownTimer) clearInterval(cooldownTimer);
		cooldownTimer = setInterval(() => {
			cooldown -= 1;
			if (cooldown <= 0) {
				cooldown = 0;
				failedAttempts = 0;
				if (cooldownTimer) clearInterval(cooldownTimer);
				cooldownTimer = null;
			}
		}, 1000);
	}

	/** Trigger a normal browser download of an in-memory Blob. Used only for
	 *  the raw-vault-payload path below — this is already the "under 256MB,
	 *  fits comfortably in memory" case (anything larger is routed to
	 *  SecureOpenModal's streaming decrypt-to-disk before we ever get here). */
	function triggerBlobDownload(blob: Blob, filename: string): void {
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = filename;
		document.body.appendChild(a);
		a.click();
		a.remove();
		URL.revokeObjectURL(url);
	}

	async function unlock() {
		if (!canSubmit) return;
		phase = 'unlocking';
		error = '';
		try {
			// Pass the UI's already-detected mode as a pure performance hint —
			// it only decides which normalization decryptCesvu tries FIRST.
			// Both are always attempted regardless (see cesvu-crypto.ts's
			// decryptCesvu doc comment), so a wrong guess here just costs an
			// extra fallback derivation, never a wrong result.
			const doc = await importFromCesvu(file, passphrase, isRawProfile ? 'raw' : mode);

			// Capture the passphrase for a possible later "Send Back" reply —
			// this is the ONLY in-memory unlock path (never the oversized
			// decrypt-to-disk or raw-vault-payload paths, neither of which
			// ever reach here), so this is the single correct call site. See
			// sessionKey.svelte.ts's doc comment for the full clearing story.
			const resolvedType: PassphraseType = isRawProfile ? 'raw' : mode;
			sessionKeyStore.setKey(doc.id, passphrase, resolvedType);

			// Also keep a local copy for the "Choose a file to send back"
			// button on the success screen below — see that state's doc
			// comment for why this can't just re-read sessionKeyStore later.
			unlockedDoc = doc;
			unlockedPassphrase = passphrase;
			unlockedPassphraseType = resolvedType;

			phase = 'success';
			onimported(doc);
			// NOTE: deliberately no auto-close timer here anymore. The
			// success screen now stays open until the user clicks "View
			// file", dismisses the modal themselves, or completes the
			// send-back flow (see handleSendBackDone()).
		} catch (e) {
			if (e instanceof RawVaultPayloadError) {
				// Not a document — a raw file encrypted via the vault flow
				// (e.g. an image). Decryption already succeeded and
				// authenticated the bytes; just hand it to the user as a
				// normal download instead of trying to open a viewer.
				const filename = e.metadata.filename || file.name.replace(/\.cesvu$/i, '');
				// SECURITY: the blob type is deliberately hard-coded and must NEVER be
				// taken from `e.metadata.mimeType`. That field is authenticated (it lives
				// inside the AEAD-protected metadata) but authentication only proves the
				// producer held the passphrase — it does NOT make the value trustworthy.
				// Anyone who can hand a user a `.cesvu` chooses it freely.
				//
				// A real, "viewable" MIME type (text/html, image/svg+xml, …) can make
				// Firefox/Safari treat an <a download> as a navigation rather than a
				// save, and a blob: URL inherits THIS origin — so an attacker-chosen
				// type is a route to script execution on the cesvu origin, where
				// decrypted documents and the passphrase field live. See the matching
				// note in vault-io.ts's Tier 3 branch, which hard-codes this for the
				// same reason; this call site had diverged from that rule.
				//
				// The filename is passed through untouched on purpose: restoring the
				// user's real name is the feature here. Do NOT route it through
				// sanitizeBaseName() from cesvu-filename.ts — that helper builds the
				// OUTER .cesvu name and strips the extension by design, so it would
				// turn "quarterly-report.pdf" into "quarterly-report". `a.download` is
				// sanitized by the browser and confined to the downloads directory.
				const blob = new Blob([e.plaintext as BlobPart], {
					type: 'application/octet-stream'
				});

				triggerBlobDownload(blob, filename);
				savedRawName = filename;
				phase = 'raw-saved';
				return;
			}
			error = e instanceof Error ? e.message : 'Unable to import this file.';
			failedAttempts += 1;
			phase = 'input';
			// 3 failures → 5-second cooldown (UX friction; not a real security control).
			if (failedAttempts >= 3) startCooldown(5);
		}
	}
</script>

<!-- Hidden file input for "Choose a file to send back" — click-triggered via
     openSendBackPicker(). Kept outside the Modal's dismissible-scoping logic
     since it's just an input, never itself rendered as a visible dialog. -->
<input
	bind:this={sendBackInputEl}
	type="file"
	class="hidden"
	onchange={handleSendBackFileChosen}
/>

{#if sendBackFile}
	<!-- Viewer-UNSUPPORTED reply type — reuses the exact same encrypt-to-disk
	     component (and therefore the exact same UX: streaming progress,
	     non-dismissible while saving, "Done" screen) as every other "secure
	     this file" flow in the app — see SecureSaveModal.svelte's
	     presetPassphrase/presetPassphraseType props doc comment. The
	     underlying ImportModal <Modal> is hidden below (open={false}) while
	     this is up, so only one backdrop shows at a time. -->
	<SecureSaveModal
		file={sendBackFile}
		presetPassphrase={unlockedPassphrase}
		presetPassphraseType={unlockedPassphraseType}
		onclose={handleSendBackDone}
	/>
{:else if sendBackDocId}
	<!-- Viewer-SUPPORTED reply type — reuses SendBackModal verbatim, the SAME
	     component Workspace.svelte's own "Send Back" button uses, so the
	     reply is CFP1-framed via sendBackAsCesvu and reopens correctly in the
	     recipient's viewer instead of just downloading. See
	     handleSendBackFileChosen's doc comment for the routing logic. -->
	<SendBackModal
		documentId={sendBackDocId}
		passphrase={unlockedPassphrase}
		passphraseType={unlockedPassphraseType}
		subject="file"
		onclose={handleSendBackDocDone}
	/>
{/if}

<Modal open={!sendBackFile && !sendBackDocId} title="Open shared document" {onclose}>
	{#if phase === 'success'}
		<div class="flex flex-col items-center gap-4 py-2 text-center">
			<div class="flex h-12 w-12 items-center justify-center rounded-full bg-green-100 dark:bg-green-900/40 text-2xl">
				✓
			</div>
			<div class="space-y-1">
				<p class="text-sm font-medium text-gray-900 dark:text-white">File decrypted</p>
				{#if unlockedDoc}
					<p class="font-mono text-sm text-gray-700 dark:text-gray-200">{unlockedDoc.name}</p>
					<p class="text-xs text-gray-500 dark:text-gray-500">
						{formatBytes(decryptedByteSize(unlockedDoc))} · Decrypted locally
					</p>
				{/if}
			</div>

			<!-- Primary action: the document is already open behind this
			     modal (onimported(doc) already fired in unlock()) — closing
			     just reveals it. -->
			<button
				onclick={onclose}
				class="w-full rounded-lg bg-blue-700 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-600"
			>
				📄 View file
			</button>

			<div class="flex w-full items-center gap-3" role="separator" aria-label="Need to send a file back to sender?">
				<div class="h-px flex-1 bg-gray-200 dark:bg-slate-700"></div>
				<span class="text-xs font-medium text-gray-500 dark:text-gray-400 whitespace-nowrap">
					Need to send a file back to sender?
				</span>
				<div class="h-px flex-1 bg-gray-200 dark:bg-slate-700"></div>
			</div>

			<p class="text-xs text-gray-500 dark:text-gray-500">Same passphrase · No account needed</p>

			<button
				onclick={openSendBackPicker}
				class="w-full rounded-lg border border-blue-300 bg-blue-50 px-4 py-2.5 text-sm font-semibold text-blue-700 transition-colors hover:bg-blue-100 dark:border-blue-700 dark:bg-blue-950/30 dark:text-blue-200 dark:hover:bg-blue-950/60"
			>
				Choose a file to send back
			</button>

			{#if sendBackParseError}
				<p class="text-xs text-amber-700 dark:text-amber-200" role="alert">{sendBackParseError}</p>
			{/if}

			<p class="text-xs text-gray-500 dark:text-gray-500">Any filesize, any filetype. Same encryption.</p>

			<button
				onclick={() => (moreOptionsOpen = !moreOptionsOpen)}
				class="text-xs font-medium text-gray-500 transition-colors hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200"
				aria-expanded={moreOptionsOpen}
			>
				⚙ More options
			</button>

			{#if moreOptionsOpen}
				<div class="w-full space-y-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-3 text-left dark:border-slate-700 dark:bg-slate-800/40">
					<button
						onclick={downloadDecrypted}
						class="block w-full rounded-md px-2 py-1.5 text-left text-xs font-medium text-gray-700 transition-colors hover:bg-gray-200 hover:text-gray-900 dark:text-gray-300 dark:hover:bg-slate-800 dark:hover:text-gray-100"
					>
						⬇ Download file
					</button>
					<button
						onclick={() => (showFileInfo = !showFileInfo)}
						class="block w-full rounded-md px-2 py-1.5 text-left text-xs font-medium text-gray-700 transition-colors hover:bg-gray-200 hover:text-gray-900 dark:text-gray-300 dark:hover:bg-slate-800 dark:hover:text-gray-100"
						aria-expanded={showFileInfo}
					>
						ℹ View file info
					</button>
					{#if showFileInfo && unlockedDoc}
						<div class="space-y-1 rounded-md bg-white px-2.5 py-2 text-xs text-gray-500 dark:bg-slate-900/60 dark:text-gray-400">
							<p>Name: <span class="font-mono text-gray-700 dark:text-gray-300">{unlockedDoc.name}</span></p>
							<p>Size: {formatBytes(decryptedByteSize(unlockedDoc))}</p>
							<p>Source type: {unlockedDoc.sourceType}</p>
							<p>Passphrase: {unlockedPassphraseType === 'emoji' ? 'Emoji (8+)' : unlockedPassphraseType === 'raw' ? 'Custom password' : 'Diceware (6 words)'}</p>
							<p>Decrypted locally — never uploaded.</p>
						</div>
					{/if}
				</div>
			{/if}
		</div>
	{:else if phase === 'raw-saved'}
		<div class="flex flex-col items-center justify-center gap-3 py-10 text-center">
			<div class="flex h-12 w-12 items-center justify-center rounded-full bg-green-100 dark:bg-green-900/40 text-2xl">
				✓
			</div>
			<p class="text-sm font-medium text-gray-900 dark:text-white">
				Decrypted <span class="font-mono">{savedRawName}</span> and started the download.
			</p>
			<p class="text-xs text-gray-500 dark:text-gray-400">
				This file isn't a document type cesvu can open in the viewer, so it was saved straight
				to your device's downloads.
			</p>
		</div>
	{:else}
		<div class="space-y-4">
			<p class="text-sm text-gray-700 dark:text-gray-300">
				{#if isRawProfile}
					Enter the password the sender gave you to open
					<span class="font-medium text-gray-900 dark:text-gray-100">{file.name}</span>.
				{:else}
					Enter the passphrase the sender gave you to open
					<span class="font-medium text-gray-900 dark:text-gray-100">{file.name}</span>
					— 6 words or 8 emoji.
				{/if}
			</p>

			<!-- Single masked passphrase input. PM-friendly: a single paste
			     fills the field, whether it's diceware words or an emoji
			     passphrase — mode is auto-detected from the content below.
			     The data-* attrs tell 1Password/Bitwarden/Dashlane/LastPass
			     "this is a diceware/emoji phrase, not a normal password" so
			     they don't try to autofill a stored credential. -->
			<input
				bind:this={inputEl}
				bind:value={passphrase}
				onkeydown={handleKeydown}
				type={showPassphrase ? 'text' : 'password'}
				autocomplete="off"
				autocapitalize="off"
				autocorrect="off"
				spellcheck="false"
				data-1p-ignore
				data-form-type="other"
				name="cesvu-passphrase"
				aria-label={isRawProfile
					? 'Custom password'
					: 'Six-word diceware or eight-emoji passphrase'}
				aria-describedby="cesvu-passphrase-help"
				placeholder={isRawProfile
					? 'Enter password'
					: 'rocket garden mirror forest candle window  or  🦏🐙🌵🚀🍄🔥🐝🌙'}
				class="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 font-mono text-sm text-gray-900 outline-none placeholder:text-gray-400 focus:border-blue-600 focus:ring-1 focus:ring-blue-600 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-800/60 dark:text-gray-100 dark:placeholder:text-gray-600"
				disabled={phase === 'unlocking' || locked}
			/>

			{#if isRawProfile}
				<!-- Custom password: no chip UI, no auto-detected word/emoji
				     mode — just a byte counter against the same app-level cap
				     enforced at encrypt time. BYTES, not characters: the cap
				     is a UTF-8 byte cap, so counting characters would both
				     block valid emoji passwords and let over-long CJK ones
				     through. See rawPassphraseByteLength. -->
				<p
					id="cesvu-passphrase-help"
					class={[
						'text-xs',
						rawBytes > RAW_PASSPHRASE_MAX_BYTES ? 'text-red-600 dark:text-red-300' : 'text-gray-500 dark:text-gray-500'
					]}
				>
					{#if rawBytes > RAW_PASSPHRASE_MAX_BYTES}
						{rawBytes}/{RAW_PASSPHRASE_MAX_BYTES} bytes — too long
					{:else}
						{rawBytes}/{RAW_PASSPHRASE_MAX_BYTES} bytes
					{/if}
				</p>
			{:else if mode === 'diceware'}

				<!-- Per-word validity chips. Always render 6 baseline slots; if
				     the user pastes 7+ words, render extras in red as a warning.
				     aria-live="polite" so screen readers announce changes. -->
				<div class="flex flex-wrap items-center gap-2 text-xs" aria-live="polite">
					{#each Array.from({ length: Math.max(6, wordCount) }) as _, i}
						{@const w = words[i] ?? ''}
						{@const v = w === '' ? null : (wordValidations[w.toLowerCase()] ?? null)}
						{@const isExtra = i >= 6}
						<span
							class={[
								'inline-flex items-center gap-1 rounded-md border px-2 py-1 font-mono',
								w === ''
									? 'border-gray-200 bg-gray-100 text-gray-400 dark:border-slate-700 dark:bg-slate-800/30 dark:text-gray-600'
									: isExtra
										? 'border-red-300 bg-red-100 text-red-700 dark:border-red-700 dark:bg-red-950/40 dark:text-red-300'
										: v === true
											? 'border-green-300 bg-green-100 text-green-700 dark:border-green-700 dark:bg-green-950/40 dark:text-green-300'
											: v === false
												? 'border-red-300 bg-red-100 text-red-700 dark:border-red-700 dark:bg-red-950/40 dark:text-red-300'
												: 'border-gray-200 bg-gray-100 text-gray-500 dark:border-slate-700 dark:bg-slate-800/40 dark:text-gray-400'
							]}
						>
							<span class="text-gray-500 dark:text-gray-500 tabular-nums">{i + 1}:</span>
							<span>{w === '' ? '——' : showPassphrase ? w : '•'}</span>
							{#if w !== '' && !isExtra}
								<span aria-hidden="true">
									{#if v === true}✓{:else if v === false}✗{:else}…{/if}
								</span>
							{/if}
							{#if isExtra}
								<span aria-hidden="true" title="Extra word — remove to continue">!</span>
							{/if}
						</span>
					{/each}
				</div>

				<!-- Status line: live word count + invalid count summary. -->
				<p
					id="cesvu-passphrase-help"
					class={[
						'text-xs',
						wordCount === 6 && invalidWordCount === 0
							? 'text-green-600 dark:text-green-300'
							: wordCount > 6 || invalidWordCount > 0
								? 'text-red-600 dark:text-red-300'
								: 'text-gray-400 dark:text-gray-500'
					]}
				>
					{#if wordCount === 0}
						0/6 words — type or paste your passphrase above
					{:else if wordCount > 6}
						{wordCount} words — expected 6, remove the extras
					{:else if wordCount === 6 && invalidWordCount === 0}
						6/6 words — ready to unlock
					{:else if invalidWordCount > 0}
						{wordCount}/6 words — {invalidWordCount} word{invalidWordCount === 1 ? '' : 's'} not in the diceware list
					{:else}
						{wordCount}/6 words
					{/if}
				</p>
			{:else}
				<!-- Per-emoji validity chips — same visual pattern as the word
				     chips above, but checked against the curated 800-emoji
				     wordlist via `isCuratedEmoji`. Always render 8 baseline
				     slots; extras beyond 8 render in red as a warning. -->
				<div class="flex flex-wrap items-center gap-2 text-sm" aria-live="polite">
					{#each Array.from({ length: Math.max(8, emojiCount) }) as _, i}
						{@const e = emojis[i] ?? ''}
						{@const v = e === '' ? null : (emojiValidations[e] ?? null)}
						{@const isExtra = i >= 8}
						{@const isExtraInvalid = isExtra && v === false}
						<span
							class={[
								'inline-flex items-center gap-1 rounded-md border px-2 py-1',
								e === ''
									? 'border-gray-200 bg-gray-100 text-gray-400 dark:border-slate-700 dark:bg-slate-800/30 dark:text-gray-600'
									: isExtraInvalid
										? 'border-red-300 bg-red-100 dark:border-red-700 dark:bg-red-950/40'
										: isExtra
											? v === true
												? 'border-indigo-300 bg-indigo-100 dark:border-indigo-700 dark:bg-indigo-950/40'
												: 'border-blue-200 bg-blue-100/60 dark:border-slate-700 dark:bg-slate-800/40'
											: v === true
												? 'border-green-300 bg-green-100 dark:border-green-700 dark:bg-green-950/40'
												: v === false
													? 'border-red-300 bg-red-100 dark:border-red-700 dark:bg-red-950/40'
													: 'border-blue-200 bg-blue-100/60 dark:border-slate-700 dark:bg-slate-800/40'
							]}
						>
							<span class="text-gray-500 dark:text-gray-500 text-xs tabular-nums">{i + 1}:</span>
							<span>{e === '' ? '——' : showPassphrase ? e : '•'}</span>
							{#if e !== '' && !isExtra}
								<span aria-hidden="true" class="text-xs">
									{#if v === true}✓{:else if v === false}✗{:else}…{/if}
								</span>
							{/if}
							{#if isExtraInvalid}
								<span aria-hidden="true" class="text-xs" title="Not in our curated emoji list">✗</span>
							{:else if isExtra}
								<span aria-hidden="true" class="text-xs" title="Extra emoji — adds entropy">
									{#if v === true}✦{:else}…{/if}
								</span>
							{/if}
						</span>
					{/each}
				</div>

				<!-- Status line: live emoji count + invalid count summary. Extras
				     (beyond the required 8) are valid per the .cesvu spec — up to
				     100 emoji are accepted for additional entropy — so a curated
				     extra is called out positively rather than flagged as an error.
				     Only a genuinely non-curated extra emoji is still an error. -->
				{@const extraCount = Math.max(0, emojiCount - 8)}
				{@const invalidExtraCount = emojis
					.slice(8)
					.filter((e) => emojiValidations[e] === false).length}
				<p
					id="cesvu-passphrase-help"
					class={[
						'text-xs',
						invalidEmojiCount > 0 || invalidExtraCount > 0
							? 'text-red-600 dark:text-red-300'
							: emojiCount >= 8
								? 'text-green-600 dark:text-green-300'
								: 'text-gray-400 dark:text-gray-500'
					]}
				>
					{#if emojiCount === 0}
						0/8 emoji — paste your emoji passphrase above
					{:else if invalidEmojiCount > 0}
						{emojiCount}/8 emoji — {invalidEmojiCount} emoji not in our curated list
					{:else if invalidExtraCount > 0}
						{emojiCount}/8 emoji — {invalidExtraCount} extra emoji not in our curated list
					{:else if extraCount > 0}
						{emojiCount}/8 emoji — {extraCount} extra for entropy, ready to unlock
					{:else if emojiCount >= 8}
						{emojiCount}/8 emoji — ready to unlock
					{:else}
						{emojiCount}/8 emoji
					{/if}
				</p>
			{/if}

			<!-- Masked by default (shoulder-surfing protection); toggle to reveal.
			     The chips above always show the actual token regardless of this
			     toggle, EXCEPT emoji chips (which honor it too, since a single
			     emoji glyph is much more recognizable/memorable than a masked
			     dot and is itself the "reveal"). -->
			<label class="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400 select-none cursor-pointer">
				<input
					type="checkbox"
					bind:checked={showPassphrase}
					disabled={phase === 'unlocking'}
					class="h-3.5 w-3.5 rounded border-gray-300 bg-white text-blue-600 focus:ring-blue-500 focus:ring-offset-white dark:border-gray-600 dark:bg-slate-800 dark:focus:ring-offset-gray-900"
				/>
				<span>{isRawProfile ? 'Show password' : mode === 'emoji' ? 'Show emoji' : 'Show words'}</span>
			</label>


			{#if error}
				<p class="text-xs text-red-600 dark:text-red-300" role="alert">{error}</p>
			{/if}

			{#if locked}
				<p class="text-xs text-amber-700 dark:text-amber-200" aria-live="polite">
					Too many attempts. Try again in {cooldown}s.
				</p>
			{/if}
		</div>
	{/if}


	{#snippet footer()}
		{#if phase !== 'success' && phase !== 'raw-saved'}
			<div class="flex justify-end gap-2">
				<button
					onclick={onclose}
					class="rounded-lg px-3 py-1.5 text-xs font-medium text-gray-500 transition-colors hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200"
				>
					Cancel
				</button>
				<button
					onclick={unlock}
					disabled={!canSubmit}
					class="rounded-lg bg-blue-700 px-4 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-40"
				>
					{#if phase === 'unlocking'}
						Unlocking…
					{:else if locked}
						Wait {cooldown}s
					{:else}
						Unlock
					{/if}
				</button>
			</div>
		{:else if phase === 'raw-saved'}
			<div class="flex justify-end gap-2">
				<button
					onclick={onclose}
					class="rounded-lg bg-blue-700 px-4 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-blue-600"
				>
					Done
				</button>
			</div>
		{/if}
	{/snippet}
</Modal>
