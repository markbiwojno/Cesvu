<script lang="ts">
	/**
	 * SecureSaveModal.svelte — encrypt a file the in-app viewer can't open
	 * (see vault-constants.ts's isVaultCandidate) into a `.cesvu` vault file,
	 * streamed straight to disk.
	 *
	 * Mirrors ExportModal.svelte's choose-type → generating → show-words →
	 * done flow, but operates directly on a raw `File` (via vault-io.ts's
	 * generateVaultPassphrase / writeVaultFile) instead of a stored
	 * CesvuDocument — there's no "include source" choice here since the
	 * WHOLE file is always the payload, and no viewer to hand the result to
	 * afterward.
	 *
	 * IMPORTANT (mobile Safari/Chrome): the words are generated and shown
	 * FIRST (a cheap, I/O-free step), and the actual encrypt+save/download —
	 * which can trigger a disruptive native "Save/Download" interstitial —
	 * only happens once the user clicks "I've stored these …" in the
	 * show-words phase. Doing it the other way around (as this component
	 * used to) let that native dialog race the emoji `<img>` tiles' loads on
	 * iOS, permanently breaking their rendering. See vault-io.ts's
	 * `writeVaultFile` doc comment.
	 *
	 * ── "Shared Passcode" (third option) ────────────────────────────────────
	 * The choose-type screen also offers a third path for a passphrase the
	 * user ALREADY has (e.g. one they share with a recipient and reuse for
	 * replies) instead of generating a fresh one. This is NOT a separate
	 * crypto profile — it's still exactly PASS_PROFILE_TEXT (diceware) or
	 * PASS_PROFILE_EMOJI, auto-detected from what's typed and validated
	 * against the same EFF wordlist / curated emoji list `ImportModal.svelte`
	 * uses on the decrypt side (via `isDicewareWord` / `isCuratedEmoji`), and
	 * rendered with the SAME chip-row validator UI `ImportModal.svelte` uses
	 * for its unlock input, so the two screens feel identical. Because the
	 * user already knows this passphrase, there is nothing to write down: a
	 * valid entry skips `generate()`/`show-words` entirely and goes straight
	 * to `saveFile()`.
	 */
	import { onMount } from 'svelte';
	import Modal from '$lib/components/common/Modal.svelte';
	import {
		generateVaultPassphrase,
		writeVaultFile,
		VaultCancelledError,
		saveFilePickerAvailable,
		type VaultProgress
	} from '$lib/crypto/vault-io.js';
	import { workspace } from '$lib/stores/workspace.svelte.js';

	import { emojiSvgUrl } from '$lib/utils/emoji-helpers.js';
	import { copyTextToClipboard } from '$lib/utils/clipboard.js';
	import {
		type PassphraseType,
		isDicewareWord,
		isCuratedEmoji
	} from '$lib/crypto/index.js';
	import { isDismissiblePhase } from '$lib/utils/vault-modal-phases.js';


	interface Props {
		file: File;
		onclose: () => void;
		/**
		 * When set (together with `presetPassphraseType`), this is a "Send
		 * file back" request — the passphrase is ALREADY known (the one the
		 * user just unlocked a DIFFERENT .cesvu with — see
		 * ImportModal.svelte's "Choose a file to send back") — so the
		 * choose-type / shared-passcode screen is skipped entirely in favor
		 * of a single lightweight confirm step (see the 'confirm-preset'
		 * phase below) before encryption starts. Mirrors the "Shared
		 * Passcode" path's `encryptShared()` below; the only difference is
		 * WHERE the passphrase comes from (a caller prop vs. a typed-in
		 * field).
		 */
		presetPassphrase?: string;
		presetPassphraseType?: PassphraseType;
	}
	let { file, onclose, presetPassphrase, presetPassphraseType }: Props = $props();

	type Phase =
		| 'choose-type'
		| 'confirm-preset'
		| 'generating'
		| 'show-words'
		| 'saving'
		| 'done'
		| 'error';
	// A preset passphrase (see Props doc comment above) skips the
	// choose-type/shared-passcode screen in favor of 'confirm-preset' — a
	// single-button confirm screen. This CANNOT auto-advance to 'saving' via
	// onMount: `writeVaultFile`'s Tier 1 path calls the File System Access
	// API's `showSaveFilePicker()`, which Chromium refuses to open unless it
	// is invoked synchronously inside a real user-gesture event handler
	// (click/keydown/etc). onMount fires on a reactivity tick that is NOT
	// itself a user gesture (even though it was triggered by one, e.g. the
	// file-input's change event), so calling saveFile() from onMount throws
	// "Must be handling a user gesture to show a file picker." The fix is
	// the same rule this file's top-of-file doc comment already documents
	// for the normal flow's 'show-words' → 'saving' transition: the actual
	// encrypt call must be wired to a real onclick handler (see the
	// 'confirm-preset' footer button below), never to onMount or any other
	// deferred callback.
	let phase = $state<Phase>(presetPassphrase && presetPassphraseType ? 'confirm-preset' : 'choose-type');


	let passphraseType = $state<PassphraseType>('diceware');
	let words = $state<string[]>([]);
	let passphrase = $state('');
	let error = $state('');
	let copied = $state(false);
	let copyFailed = $state(false);
	let progress = $state<VaultProgress | null>(null);

	let copyTimer: ReturnType<typeof setTimeout> | null = null;


	const progressPct = $derived(
		progress && progress.totalBytes > 0
			? Math.min(100, Math.round((progress.bytesProcessed / progress.totalBytes) * 100))
			: 0
	);

	/** Human-readable file size for the intro copy. */
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

	onMount(() => {
		// Preset-passphrase ("send file back") path — see Props doc comment.
		// Populate the same state saveFile() reads, but do NOT call
		// saveFile() here — see the 'confirm-preset' phase's doc comment
		// above for why that would break showSaveFilePicker(). The actual
		// encrypt is deferred to a real click on the 'confirm-preset'
		// footer button below.
		if (presetPassphrase && presetPassphraseType) {
			passphraseType = presetPassphraseType;
			passphrase = presetPassphrase;
		}
		return () => {
			if (copyTimer) clearTimeout(copyTimer);
		};
	});



	function chooseType(type: 'diceware' | 'emoji') {
		passphraseType = type;
		void generate();
	}

	/**
	 * Step 1: generate the passphrase and show it to the user. Deliberately
	 * does NO encryption or I/O — this is the cheap, near-instant step, so
	 * the emoji/word tiles are guaranteed to be fully rendered before any
	 * native save/download dialog can possibly appear (see this file's top
	 * doc comment).
	 */
	async function generate() {
		phase = 'generating';
		error = '';
		try {
			const result = await generateVaultPassphrase(passphraseType);
			words = result.words;
			passphrase = result.passphrase;
			phase = 'show-words';
		} catch (e) {
			error = e instanceof Error ? e.message : 'Unable to generate a passphrase.';
			phase = 'error';
		}
	}

	/**
	 * Step 2: the actual streaming encrypt + save/download. Only invoked
	 * once the user has confirmed (in the show-words phase) that they've
	 * stored the passphrase — see `finish()` below — OR immediately, for the
	 * "Shared Passcode" path (see `encryptShared()`), since there's nothing
	 * new to confirm there.
	 */
	async function saveFile() {
		phase = 'saving';
		progress = null;
		// See workspace.svelte.ts's `activeVaultOperations` doc comment — marks
		// this encrypt as active for Modal's `dismissible` guard and the
		// workspace-level beforeunload warning.
		workspace.beginVaultOperation();
		try {
			await writeVaultFile(file, passphrase, passphraseType, (p) => {
				progress = p;
			});
			phase = 'done';
		} catch (e) {
			if (e instanceof VaultCancelledError) {
				// User backed out of the native save dialog — return to the
				// show-words screen (the passphrase is already generated and
				// still valid) rather than the choice screen. For the Shared
				// Passcode path (which never visits show-words), fall back to
				// the choice screen instead so the typed passcode isn't lost
				// silently in a phase with no footer action to retry from.
				phase = sharedPasscode.length > 0 && passphrase === sharedPasscode
					? 'choose-type'
					: 'show-words';
				return;
			}
			error = e instanceof Error ? e.message : 'Unable to encrypt this file.';
			phase = 'error';
		} finally {
			workspace.endVaultOperation();
		}
	}




	async function copyWords() {
		const text = passphraseType === 'emoji' ? words.join('') : words.join(' ');
		const ok = await copyTextToClipboard(text);
		if (ok) {
			copied = true;
			copyFailed = false;
			if (copyTimer) clearTimeout(copyTimer);
			copyTimer = setTimeout(() => (copied = false), 2000);
		} else {
			// Both the Clipboard API and the execCommand fallback failed —
			// don't leave the click looking like a dead end (this is what
			// mobile Safari/Chrome-for-iOS users were hitting).
			copyFailed = true;
		}
	}

	function finish() {
		void saveFile();
	}

	// ── "Shared Passcode" — encrypt to a pre-existing diceware/emoji passphrase ──
	// Same auto-detect + per-token validation pattern as ImportModal.svelte's
	// unlock input, just used on the encrypt side. No new crypto profile: the
	// detected mode maps directly to the existing 'diceware' | 'emoji'
	// PassphraseType values.

	/** The raw text typed/pasted into the Shared Passcode field. */
	let sharedPasscode = $state('');
	let showSharedPasscode = $state(false);
	let sharedInputEl = $state<HTMLInputElement | null>(null);

	/** Detects the Unicode `Extended_Pictographic` property — true for
	 *  essentially every emoji character. Sole signal for which validation
	 *  UI/mode to use, mirroring ImportModal.svelte exactly. */
	const SHARED_EMOJI_TEST = /\p{Extended_Pictographic}/u;

	const sharedMode = $derived<'diceware' | 'emoji'>(
		SHARED_EMOJI_TEST.test(sharedPasscode) ? 'emoji' : 'diceware'
	);

	const sharedWords = $derived(
		sharedPasscode.trim().length === 0 ? [] : sharedPasscode.trim().split(/\s+/)
	);
	const sharedWordCount = $derived(sharedWords.length);

	const sharedEmojis = $derived(Array.from(sharedPasscode.replace(/\s/g, '')));
	const sharedEmojiCount = $derived(sharedEmojis.length);

	/** Per-word validation cache, keyed by lowercase word. */
	let sharedWordValidations = $state<Record<string, boolean | null>>({});
	/** Per-emoji validation cache, keyed by the emoji character itself. */
	let sharedEmojiValidations = $state<Record<string, boolean | null>>({});

	$effect(() => {
		if (sharedMode !== 'diceware') return;
		const seen = new Set<string>();
		for (const w of sharedWords) {
			const key = w.toLowerCase();
			seen.add(key);
			if (sharedWordValidations[key] === undefined) {
				sharedWordValidations[key] = null;
				isDicewareWord(w).then((result) => {
					sharedWordValidations[key] = result;
				});
			}
		}
		for (const key of Object.keys(sharedWordValidations)) {
			if (!seen.has(key)) delete sharedWordValidations[key];
		}
	});

	$effect(() => {
		if (sharedMode !== 'emoji') return;
		const seen = new Set<string>();
		for (const e of sharedEmojis) {
			seen.add(e);
			if (sharedEmojiValidations[e] === undefined) {
				sharedEmojiValidations[e] = null;
				isCuratedEmoji(e).then((result) => {
					sharedEmojiValidations[e] = result;
				});
			}
		}
		for (const key of Object.keys(sharedEmojiValidations)) {
			if (!seen.has(key)) delete sharedEmojiValidations[key];
		}
	});

	/** How many of the first-6 word slots are NOT in the EFF list (excludes extras). */
	const sharedInvalidWordCount = $derived(
		sharedWords.slice(0, 6).filter((w) => sharedWordValidations[w.toLowerCase()] === false).length
	);
	/** How many of the first-8 emoji slots are NOT in the curated list (excludes extras). */
	const sharedInvalidEmojiCount = $derived(
		sharedEmojis.slice(0, 8).filter((e) => sharedEmojiValidations[e] === false).length
	);

	/** Diceware gate: exactly 6 EFF-valid words. Emoji gate: at least 8
	 *  curated-valid emoji. Mirrors ImportModal.svelte's `canSubmit`. */
	const canEncryptShared = $derived(
		sharedMode === 'emoji'
			? sharedEmojiCount >= 8 && sharedInvalidEmojiCount === 0
			: sharedWordCount === 6 && sharedInvalidWordCount === 0
	);

	function handleSharedKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			e.preventDefault();
			if (canEncryptShared) encryptShared();
		}
	}

	/**
	 * The user already knows this passphrase — unlike `chooseType()`/`generate()`,
	 * there's nothing to show/confirm, so this goes straight to the actual
	 * encrypt + save/download.
	 */
	function encryptShared() {
		if (!canEncryptShared) return;
		passphraseType = sharedMode;
		words = sharedMode === 'emoji' ? sharedEmojis : sharedWords;
		passphrase = sharedPasscode;
		void saveFile();
	}

	/**
	 * Populates the Shared Passcode field with a freshly-generated,
	 * crypto-random passphrase — the SAME generator (`generateVaultPassphrase`,
	 * backed by `generateDicewarePassphrase`/`generateEmojiPassphrase` in
	 * cesvu-crypto.ts) used by the "Word Passcode"/"Emoji Passcode" cards
	 * above, just routed into this input instead of the show-words screen.
	 * Reveals the field afterward (`showSharedPasscode = true`) so the user
	 * can actually see what was generated, rather than a row of masked dots
	 * right after generating it — and because it's freshly generated it's
	 * already guaranteed valid, so the chip row will show all-green instantly.
	 */
	let generatingShared = $state(false);
	async function generateShared(type: 'diceware' | 'emoji') {
		generatingShared = true;
		try {
			const result = await generateVaultPassphrase(type);
			sharedPasscode = result.passphrase;
			showSharedPasscode = true;
			sharedInputEl?.focus();
		} finally {
			generatingShared = false;
		}
	}
</script>


<Modal open={true} title="Secure this file" {onclose} dismissible={isDismissiblePhase(phase)}>


	{#if phase === 'choose-type'}
		<div class="space-y-4">
			<p class="flex items-center gap-1.5 text-xs font-medium text-gray-500 dark:text-gray-400">
				<span aria-hidden="true">🔒</span>
				<span>Anyone with the passcode can open it — share it carefully — or don't</span>
			</p>


			<p class="text-sm text-gray-700 dark:text-gray-300">
				<span class="font-medium text-gray-900 dark:text-gray-100">{file.name}</span>

				({formatBytes(file.size)}) isn't a format this app can open in the viewer (supported:
				XLSX, CSV, PDF, DOCX, TXT, MD). We can still encrypt a copy for secure
				filesharing or safekeeping.
			</p>

			<div class="flex items-center gap-3" role="separator" aria-label="Choose how to unlock it later">
				<div class="h-px flex-1 bg-gray-200 dark:bg-slate-700"></div>
				<span class="text-sm font-medium text-gray-800 dark:text-gray-200 whitespace-nowrap">Choose how to unlock it later:</span>
				<div class="h-px flex-1 bg-gray-200 dark:bg-slate-700"></div>
			</div>


			<div class="grid grid-cols-2 gap-3">
				<button
					onclick={() => chooseType('diceware')}
					class="flex flex-col items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-4 py-6 text-center transition-colors hover:border-blue-400 hover:bg-blue-100 dark:border-slate-700 dark:bg-slate-800/40 dark:hover:border-blue-600 dark:hover:bg-slate-800/70"
				>
					<span class="text-2xl" aria-hidden="true">🔤</span>
					<span class="text-sm font-medium text-gray-900 dark:text-gray-100">Word Passcode</span>
					<span class="text-xs text-gray-500 dark:text-gray-400">6 diceware words</span>
				</button>
				<button
					onclick={() => chooseType('emoji')}
					class="flex flex-col items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-4 py-6 text-center transition-colors hover:border-blue-400 hover:bg-blue-100 dark:border-slate-700 dark:bg-slate-800/40 dark:hover:border-blue-600 dark:hover:bg-slate-800/70"
				>
					<span class="text-2xl" aria-hidden="true">🦏</span>
					<span class="text-sm font-medium text-gray-900 dark:text-gray-100">Emoji Passcode</span>
					<span class="text-xs text-gray-500 dark:text-gray-400">8 emoji</span>
				</button>
			</div>

			<!-- "or" divider, matching the common divider-with-centered-label pattern. -->
			<div class="flex items-center gap-3" role="separator" aria-label="or">
				<div class="h-px flex-1 bg-gray-200 dark:bg-slate-700"></div>
				<span class="text-xs font-medium text-gray-400 dark:text-gray-500">or</span>
				<div class="h-px flex-1 bg-gray-200 dark:bg-slate-700"></div>
			</div>

			<div class="space-y-3 rounded-lg border border-blue-200 bg-blue-50 dark:border-slate-700 dark:bg-slate-800/40 px-4 py-3">
				<div class="flex items-start gap-3">
					<span class="text-2xl" aria-hidden="true">🔑</span>
					<div class="min-w-0 flex-1">
						<span class="block text-sm font-medium text-gray-900 dark:text-gray-100">Already have a shared passcode?</span>

						<span class="block text-xs text-gray-500 dark:text-gray-400">
							Use a passcode you and your recipient already know. No need to share a
							new one — they can reply with it too.
						</span>
					</div>
				</div>

				<div class="space-y-3">
						<!-- Generates a fresh crypto-random passphrase straight into the
						     field below via generateShared(), reusing the exact same
						     generator as the Word/Emoji Passcode cards above. -->
						<div class="flex gap-2">
							<button
								type="button"
								onclick={() => generateShared('diceware')}
								disabled={generatingShared}
								class="flex-1 rounded-lg border border-blue-200 bg-blue-100/60 px-2 py-1.5 text-xs font-medium text-gray-700 transition-colors hover:border-blue-400 hover:text-gray-900 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-700 dark:bg-slate-800/60 dark:text-gray-300 dark:hover:border-blue-600 dark:hover:text-gray-100"
							>
								🎲 Generate diceware
							</button>
							<button
								type="button"
								onclick={() => generateShared('emoji')}
								disabled={generatingShared}
								class="flex-1 rounded-lg border border-blue-200 bg-blue-100/60 px-2 py-1.5 text-xs font-medium text-gray-700 transition-colors hover:border-blue-400 hover:text-gray-900 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-700 dark:bg-slate-800/60 dark:text-gray-300 dark:hover:border-blue-600 dark:hover:text-gray-100"
							>
								🎲 Generate emoji
							</button>
						</div>

						<div class="space-y-1.5 rounded-lg border border-amber-300 bg-amber-50 dark:border-amber-900/50 dark:bg-amber-950/30 px-3 py-2.5">
							<p class="flex items-start gap-2 text-xs text-amber-800 dark:text-amber-200">
								<span aria-hidden="true">⚠️</span>
								<span>Save this passcode — no one can read this file without it, not even us. If you lose it, this file cannot be recovered.</span>
							</p>
							<p class="flex items-start gap-2 text-xs text-amber-800 dark:text-amber-200">
								<span aria-hidden="true">💡</span>
								<span>Keep your original file. If the recipient loses the passcode, just re-encrypt and resend — it takes seconds.</span>
							</p>
							<p class="flex items-start gap-2 text-xs text-amber-800 dark:text-amber-200">
								<span aria-hidden="true">💡</span>
								<span>For best protection, generate your passcode randomly rather than making one up.</span>
							</p>
						</div>

						<!-- Single masked passphrase input — same auto-detect pattern as


						     ImportModal.svelte's unlock input, just used on the encrypt side. -->
						<input

							bind:this={sharedInputEl}
							bind:value={sharedPasscode}
							onkeydown={handleSharedKeydown}
							type={showSharedPasscode ? 'text' : 'password'}
							autocomplete="off"
							autocapitalize="off"
							autocorrect="off"
							spellcheck="false"
							data-1p-ignore
							data-form-type="other"
							aria-label="Shared passcode — 6 diceware words or 8 emoji"
							aria-describedby="shared-passcode-help"
							placeholder="6 words or 8 emoji…"
							class="w-full rounded-lg border border-blue-200 bg-white px-3 py-2 font-mono text-sm text-gray-900 outline-none placeholder:text-gray-400 focus:border-blue-600 focus:ring-1 focus:ring-blue-600 dark:border-slate-700 dark:bg-slate-800/60 dark:text-gray-100 dark:placeholder:text-gray-600"

						/>

						{#if sharedMode === 'diceware'}
							<!-- Per-word validity chips — identical pattern to ImportModal.svelte. -->
							<div class="flex flex-wrap items-center gap-2 text-xs" aria-live="polite">
								{#each Array.from({ length: Math.max(6, sharedWordCount) }) as _, i}
									{@const w = sharedWords[i] ?? ''}
									{@const v = w === '' ? null : (sharedWordValidations[w.toLowerCase()] ?? null)}
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
															: 'border-blue-200 bg-blue-100/60 text-gray-600 dark:border-slate-700 dark:bg-slate-800/40 dark:text-gray-400'
										]}
									>
										<span class="text-gray-500 tabular-nums">{i + 1}:</span>
										<span>{w === '' ? '——' : showSharedPasscode ? w : '•'}</span>
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

							<p
								id="shared-passcode-help"
								class={[
									'text-xs',
									sharedWordCount === 6 && sharedInvalidWordCount === 0
										? 'text-green-600 dark:text-green-300'
										: sharedWordCount > 6 || sharedInvalidWordCount > 0
											? 'text-red-600 dark:text-red-300'
											: 'text-gray-400 dark:text-gray-500'
								]}
							>
								{#if sharedWordCount === 0}
									0/6 words — type or paste your passphrase above
								{:else if sharedWordCount > 6}
									{sharedWordCount} words — expected 6, remove the extras
								{:else if sharedWordCount === 6 && sharedInvalidWordCount === 0}
									6/6 words — ready to encrypt
								{:else if sharedInvalidWordCount > 0}
									{sharedWordCount}/6 words — {sharedInvalidWordCount} word{sharedInvalidWordCount === 1 ? '' : 's'} not in the diceware list
								{:else}
									{sharedWordCount}/6 words
								{/if}
							</p>
						{:else}
							<!-- Per-emoji validity chips — identical pattern to ImportModal.svelte. -->
							<div class="flex flex-wrap items-center gap-2 text-sm" aria-live="polite">
								{#each Array.from({ length: Math.max(8, sharedEmojiCount) }) as _, i}
									{@const e = sharedEmojis[i] ?? ''}
									{@const v = e === '' ? null : (sharedEmojiValidations[e] ?? null)}
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
										<span class="text-gray-500 text-xs tabular-nums">{i + 1}:</span>
										<span>{e === '' ? '——' : showSharedPasscode ? e : '•'}</span>
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

							{@const extraCount = Math.max(0, sharedEmojiCount - 8)}
							{@const invalidExtraCount = sharedEmojis
								.slice(8)
								.filter((e) => sharedEmojiValidations[e] === false).length}
							<p
								id="shared-passcode-help"
								class={[
									'text-xs',
									sharedInvalidEmojiCount > 0 || invalidExtraCount > 0
										? 'text-red-600 dark:text-red-300'
										: sharedEmojiCount >= 8
											? 'text-green-600 dark:text-green-300'
											: 'text-gray-400 dark:text-gray-500'
								]}
							>
								{#if sharedEmojiCount === 0}
									0/8 emoji — paste your emoji passphrase above
								{:else if sharedInvalidEmojiCount > 0}
									{sharedEmojiCount}/8 emoji — {sharedInvalidEmojiCount} emoji not in our curated list
								{:else if invalidExtraCount > 0}
									{sharedEmojiCount}/8 emoji — {invalidExtraCount} extra emoji not in our curated list
								{:else if extraCount > 0}
									{sharedEmojiCount}/8 emoji — {extraCount} extra for entropy, ready to encrypt
								{:else if sharedEmojiCount >= 8}
									{sharedEmojiCount}/8 emoji — ready to encrypt
								{:else}
									{sharedEmojiCount}/8 emoji
								{/if}
							</p>
						{/if}

					<label class="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400 select-none cursor-pointer">
						<input
							type="checkbox"
							bind:checked={showSharedPasscode}
							class="h-3.5 w-3.5 rounded border-gray-300 bg-white text-blue-600 focus:ring-blue-500 focus:ring-offset-white dark:border-gray-600 dark:bg-slate-800 dark:focus:ring-offset-gray-900"
						/>
						<span>{sharedMode === 'emoji' ? 'Show emoji' : 'Show words'}</span>
					</label>
				</div>
			</div>

			{#if !saveFilePickerAvailable()}


				<p class="text-xs text-gray-400 dark:text-gray-500">
					This browser will save the encrypted file via a normal download instead of letting
					you pick a folder up front.
				</p>
			{/if}
		</div>
	{:else if phase === 'confirm-preset'}
		<!-- "Send file back" path — the passphrase is already known (see
		     Props doc comment); this is the one required user click so the
		     eventual writeVaultFile() → showSaveFilePicker() call happens
		     inside a real gesture handler (see the Phase declaration's doc
		     comment for why this screen must exist at all). -->
		<div class="space-y-4">
			<p class="flex items-center gap-1.5 text-xs font-medium text-gray-500 dark:text-gray-400">
				<span aria-hidden="true">🔒</span>
				<span>Encrypted with the same passphrase you just used to unlock the original file</span>
			</p>
			<p class="text-sm text-gray-700 dark:text-gray-300">
				<span class="font-medium text-gray-900 dark:text-gray-100">{file.name}</span>
				({formatBytes(file.size)}) will be encrypted and ready to send back — no new passphrase
				to create or share.
			</p>
			{#if !saveFilePickerAvailable()}
				<p class="text-xs text-gray-400 dark:text-gray-500">
					This browser will save the encrypted file via a normal download instead of letting
					you pick a folder up front.
				</p>
			{/if}
		</div>
	{:else if phase === 'generating'}


		<div class="flex flex-col items-center justify-center gap-3 py-10 text-center">
			<div class="h-8 w-8 animate-spin rounded-full border-2 border-gray-200 dark:border-slate-700 border-t-blue-500"></div>
			<p class="text-sm text-gray-500 dark:text-gray-400">Generating your passphrase…</p>
		</div>

	{:else if phase === 'error'}
		<div class="space-y-4 py-4">
			<p class="text-sm text-red-600 dark:text-red-300">{error}</p>
			<button
				onclick={() => (words.length && passphrase ? saveFile() : generate())}
				class="rounded-lg bg-gray-100 px-3 py-1.5 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-200 dark:bg-slate-800 dark:text-gray-200 dark:hover:bg-slate-700"
			>
				Try again
			</button>
		</div>
	{:else if phase === 'saving'}
		<div class="flex flex-col items-center justify-center gap-3 py-10 text-center">
			<div class="h-8 w-8 animate-spin rounded-full border-2 border-gray-200 dark:border-slate-700 border-t-blue-500"></div>
			<p class="text-sm text-gray-500 dark:text-gray-400">Encrypting your file…</p>
			{#if progress && progress.totalBytes > 0}
				<div class="w-full max-w-xs">
					<div class="h-1.5 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-slate-800">
						<div
							class="h-full rounded-full bg-blue-600 transition-all"
							style="width: {progressPct}%"
						></div>
					</div>
					<p class="mt-1 text-xs text-gray-400 dark:text-gray-500 tabular-nums">
						{formatBytes(progress.bytesProcessed)} / {formatBytes(progress.totalBytes)}
					</p>
				</div>
			{/if}
		</div>
	{:else if phase === 'show-words'}
		<div class="space-y-4">
			{#if passphraseType === 'emoji'}
				<p class="text-sm text-gray-700 dark:text-gray-300">
					Store these 8 emoji somewhere safe. You'll need them to unlock this file later.
				</p>
				<div class="grid grid-cols-4 gap-2" aria-label="Recovery emoji">
					{#each words as emoji, i (i)}
						<div
							class="flex flex-col items-center gap-1 rounded-lg border border-blue-200 bg-blue-50 dark:border-slate-700 dark:bg-slate-800/60 px-2 py-2"
						>
							<span class="text-xs tabular-nums text-gray-400 dark:text-gray-600">{i + 1}</span>
							<img src={emojiSvgUrl(emoji)} alt={emoji} width="64" height="64" />
						</div>
					{/each}
				</div>
			{:else}
				<p class="text-sm text-gray-700 dark:text-gray-300">
					Store these 6 words somewhere safe. You'll need them to unlock this file later.
				</p>
				<div class="grid grid-cols-2 gap-2" aria-label="Recovery words">
					{#each words as word, i (i)}
						<div
							class="flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 dark:border-slate-700 dark:bg-slate-800/60 px-3 py-2"
						>
							<span class="w-4 text-right text-xs tabular-nums text-gray-400 dark:text-gray-600">{i + 1}</span>
							<span class="font-mono text-sm text-gray-900 dark:text-gray-100">{word}</span>
						</div>
					{/each}
				</div>
			{/if}

			<div class="flex items-center gap-2">
				<button
					onclick={copyWords}
					class="rounded-lg bg-gray-100 px-3 py-1.5 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-200 dark:bg-slate-800 dark:text-gray-200 dark:hover:bg-slate-700"
					aria-live="polite"
				>
					{copied ? 'Copied!' : passphraseType === 'emoji' ? 'Copy emoji' : 'Copy words'}
				</button>
			</div>

			{#if copyFailed}
				<p class="text-xs text-amber-700 dark:text-amber-200" role="alert">
					Couldn't copy automatically. Select the {passphraseType === 'emoji' ? 'emoji' : 'words'} above
					and copy manually.
				</p>
			{/if}

			<div class="space-y-1.5 rounded-lg border border-amber-300 bg-amber-50 dark:border-amber-900/50 dark:bg-amber-950/30 px-3 py-2.5">
				<p class="flex items-start gap-2 text-xs text-amber-800 dark:text-amber-200">
					<span aria-hidden="true">⚠️</span>
					<span>Save this passcode — no one can read this file without it, not even us. If you lose it, this file cannot be recovered.</span>
				</p>
				<p class="flex items-start gap-2 text-xs text-amber-800 dark:text-amber-200">
					<span aria-hidden="true">⚠️</span>
					<span>Send the file and the {passphraseType === 'emoji' ? 'emoji' : 'words'} through different channels. Phone call, text message, or in person — never the same channel as the file.</span>
				</p>
				<p class="flex items-start gap-2 text-xs text-amber-800 dark:text-amber-200">
					<span aria-hidden="true">💡</span>
					<span>Keep your original file. If the recipient loses the passcode, just re-encrypt and resend — it takes seconds.</span>
				</p>

			</div>
		</div>
	{:else}
		<!-- done -->
		<div class="flex flex-col items-center justify-center gap-3 py-8 text-center">
			<div class="flex h-12 w-12 items-center justify-center rounded-full bg-green-100 dark:bg-green-900/40 text-2xl">
				✓
			</div>
			<p class="text-sm font-medium text-gray-900 dark:text-white">Your encrypted file has been saved.</p>
			<p class="text-xs text-gray-500 dark:text-gray-400">
				{#if sharedPasscode.length > 0 && passphrase === sharedPasscode}
					Anyone who already knows your shared passcode can open it.
				{:else}
					Remember: keep the {passphraseType === 'emoji' ? '8 emoji' : '6 words'} somewhere
					separate from the file.
				{/if}
			</p>
		</div>
	{/if}

	{#snippet footer()}
		{#if phase === 'confirm-preset'}
			<div class="flex justify-end gap-2">
				<button
					onclick={onclose}
					class="rounded-lg px-3 py-1.5 text-xs font-medium text-gray-500 transition-colors hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200"
				>
					Cancel
				</button>
				<button
					onclick={saveFile}
					class="rounded-lg bg-blue-700 px-4 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-blue-600"
				>
					Encrypt & Send
				</button>
			</div>
		{:else if phase === 'choose-type'}

			<div class="flex justify-end gap-2">
				<button
					onclick={onclose}
					class="rounded-lg px-3 py-1.5 text-xs font-medium text-gray-500 transition-colors hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200"
				>
					Cancel
				</button>
				<button
					onclick={encryptShared}
					disabled={!canEncryptShared}
					class="rounded-lg bg-blue-700 px-4 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-40"
				>
					Encrypt & Share
				</button>
			</div>
		{:else if phase === 'show-words'}
			<div class="flex justify-end gap-2">
				<button
					onclick={finish}
					class="rounded-lg bg-blue-700 px-4 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-blue-600"
				>
					Encrypt & Save

				</button>
			</div>

		{:else if phase === 'done'}
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
