<script lang="ts">
	/**
	 * ExportModal.svelte — turn a saved document into a portable .cesvu file.
	 *
	 * Flow:
	 *   1. "options" — the sender chooses whether the ORIGINAL SOURCE FILE is
	 *      embedded in the .cesvu. Default is INCLUDE for every source-bearing
	 *      type (PDF/DOCX/CSV/XLSX): "Include the original file" is checked, and
	 *      the sender can opt out. Opting out still ships the extracted text +
	 *      analysis; for CSV/XLSX it also means the recipient can't rebuild the
	 *      interactive table (we say so). TXT/MD have no separate source, so the
	 *      step is skipped entirely.
	 *   2. "choose-type" — the sender picks the passphrase scheme: 6 Diceware
	 *      words, or 8 emoji. This is a purely additive UI split — the crypto
	 *      core doesn't care which the caller picks (see EncryptOptions.passphraseType).
	 *   3. "generating" — only AFTER both choices are locked in do we generate the
	 *      passphrase + encrypt the file (see exportAsCesvu).
	 *   4. "show-words" — the words/emoji are shown ONCE for the sender to write
	 *      down and pass along through a DIFFERENT channel than the file. Nothing
	 *      is persisted: they live only in component memory for the life of this
	 *      modal.
	 */
	import { onMount } from 'svelte';
	import Modal from '$lib/components/common/Modal.svelte';
	import ShareSheet from '$lib/components/ShareSheet.svelte';
	import {
		exportAsCesvu,
		getDocument,
		describeExportError
	} from '$lib/stores/contract-store.svelte.js';
	import { workspace } from '$lib/stores/workspace.svelte.js';

	import { emojiSvgUrl } from '$lib/utils/emoji-helpers.js';
	import { copyTextToClipboard } from '$lib/utils/clipboard.js';
	import { DEFAULT_CESVU_DOWNLOAD_NAME } from '$lib/utils/cesvu-filename.js';
	import type { PassphraseType } from '$lib/crypto/index.js';
	import type { SourceType } from '$lib/schema.js';
	import { isDismissiblePhase } from '$lib/utils/vault-modal-phases.js';




	interface Props {
		documentId: string;
		/**
		 * True when THIS session was opened by unlocking a .cesvu file. Kept as
		 * a prop for callers/tests that still pass it, but no longer drives any
		 * UI in this modal — the "recover original file" affordance that used
		 * to live here (gated on this + hasSource) has been removed.
		 */
		openedFromCesvu?: boolean;
		onclose: () => void;
	}
	let { documentId, openedFromCesvu = false, onclose }: Props = $props();


	type Phase =
		| 'options'
		| 'choose-type'
		| 'generating'
		| 'show-words'
		| 'sharing'
		| 'done'
		| 'error';
	let phase = $state<Phase>('options');
	let passphraseType = $state<PassphraseType>('diceware');
	let words = $state<string[]>([]);
	let error = $state('');
	let copied = $state(false);
	let copyFailed = $state(false);

	let blob: Blob | null = null;

	let copyTimer: ReturnType<typeof setTimeout> | null = null;

	// ── Source-inclusion choice ────────────────────────────────────────────────
	// `excludeSource` is the user-facing opt-out state (checked = "Don't include
	// source file"). It defaults to FALSE for every source-bearing type, so the
	// original file is INCLUDED by default and the sender can opt out. TXT/MD have
	// no separate source so the options step is skipped.
	let sourceType = $state<SourceType | null>(null);
	let excludeSource = $state(false);
	/** This session's opened doc actually carries the original bytes. */
	let hasSource = $state(false);

	/** CSV/XLSX rebuild their interactive viewer from the raw bytes; excluding the
	 *  source means the recipient only gets the extracted data (no live table). */
	const isTabular = $derived(sourceType === 'csv' || sourceType === 'excel');
	/** TXT/MD: the text IS the content, there's no separate binary to exclude. */
	const noSourceConcept = $derived(sourceType === 'txt' || sourceType === 'md');
	/** What we actually pass to the encoder — include by default, opt-out aware. */
	const includeSource = $derived(!excludeSource);



	/** Human label for the file kind, used in the helper text. */
	const typeLabel = $derived(
		sourceType === 'pdf'
			? 'PDF'
			: sourceType === 'docx'
				? 'Word'
				: sourceType === 'csv'
					? 'CSV'
					: sourceType === 'excel'
						? 'spreadsheet'
						: 'source'
	);


	onMount(() => {
		void init();
		return () => {
			if (copyTimer) clearTimeout(copyTimer);
		};
	});

	/** Inspect the document so we can pick the right options UI (or skip it). */
	async function init() {
		try {
			const doc = await getDocument(documentId);
			sourceType = doc?.sourceType ?? null;
			hasSource =
				(typeof doc?.rawContent === 'string' && doc.rawContent.length > 0) ||
				(doc?.rawContent instanceof Uint8Array && doc.rawContent.length > 0);

		} catch {
			sourceType = null;
		}

		// Skip the options step when there's no source choice to make:
		//   - TXT/MD have no separate source binary, and
		//   - any document re-exported WITHOUT its source bytes (e.g. opened from
		//     a .cesvu whose sender excluded the source) has nothing to include,
		//     so offering "Include original source file" would be redundant.
		// In both cases includeSource resolves to false, but we still ask which
		// passphrase type to use.
		phase = noSourceConcept || !hasSource ? 'choose-type' : 'options';
	}

	function chooseType(type: 'diceware' | 'emoji') {
		passphraseType = type;
		void prepare();
	}

	async function prepare() {
		phase = 'generating';
		// Mark the operation active so Modal's `dismissible` guard and the
		// workspace-level beforeunload warning both engage — see
		// workspace.svelte.ts's `activeVaultOperations` doc comment.
		workspace.beginVaultOperation();
		try {
			const result = await exportAsCesvu(documentId, {
				includeSource,
				passphraseType
			});
			words = result.words;
			blob = result.blob;
			phase = 'show-words';
		} catch (e) {
			error = e instanceof Error ? e.message : describeExportError(e);
			phase = 'error';
		} finally {
			workspace.endVaultOperation();
		}
	}






	async function copyWords() {
		// Diceware: space-joined words. Emoji: raw Unicode concatenation
		// with NO separator — matches exactly what encryptCesvu received.
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

	/** The exported .cesvu is ALWAYS named generically, never after the
	 *  document it came from.
	 *
	 *  This file is the artifact the sender hands to someone else, so its
	 *  outer name is the one part of the export that is readable by anyone
	 *  who merely sees it — in an inbox, a cloud drive, or a Finder window
	 *  — with no passphrase at all. Deriving it from the document (e.g.
	 *  "quarterly-layoffs-plan.cesvu") leaks the subject matter to exactly
	 *  those observers, which is precisely what a zero-knowledge product
	 *  promises not to do. Stripping just the extension isn't enough; the
	 *  base name is usually the more revealing half.
	 *
	 *  Nothing is lost by this. The real filename and extension travel
	 *  ENCRYPTED inside the envelope's metadata (exportAsCesvu sets
	 *  metadata.filename), and both the web importer and the Python CLI
	 *  restore from there — cmd_decrypt deliberately prefers the embedded
	 *  name over the on-disk one for this reason. The recipient still gets
	 *  the correct name; only passive observers are kept in the dark.
	 */
	function exportFileName(): string {
		return DEFAULT_CESVU_DOWNLOAD_NAME;
	}


	function download() {
		if (!blob) return;
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = exportFileName();
		document.body.appendChild(a);
		a.click();
		a.remove();
		URL.revokeObjectURL(url);
	}


	/**
	 * "I've stored these words" — the encrypted bytes exist in memory as
	 * `blob` at this point, so this is the hook point for the Web Share API
	 * flow (see ShareSheet.svelte). `shareFile` is built fresh each time
	 * this phase is entered, wrapping the same blob the "Download again"
	 * button already uses.
	 */
	let shareFile: File | null = $state(null);
	function confirmStored() {
		if (!blob) return;
		shareFile = new File([blob], DEFAULT_CESVU_DOWNLOAD_NAME, {
			type: 'application/octet-stream'
		});
		phase = 'sharing';
	}

	/** ShareSheet's fallback — restores the pre-Share-API default behavior
	 *  exactly (download the file, show the "done" screen). Reached when
	 *  the file is too large, canShare() reports unsupported, or
	 *  navigator.share() rejects with anything other than a user cancel. */
	function shareFallback() {
		download();
		phase = 'done';
	}

	/** The user cancelled the OS share sheet — silently return to the
	 *  words/emoji screen with no toast, no error, no fallback. */
	function shareCancelled() {
		phase = 'show-words';
	}
</script>


<Modal open={true} title="Share document" {onclose} dismissible={isDismissiblePhase(phase)}>


	{#if phase === 'options'}
		<div class="space-y-4">
			<p class="text-sm text-gray-700 dark:text-gray-300">
				Choose what to include, then we'll generate a one-time passphrase for the recipient.
			</p>

			<!-- Every source-bearing type (PDF / DOCX / CSV / XLSX) INCLUDES the
			     original file by default. Unchecking opts out and ships only the
			     extracted text + analysis. -->
			<label
				class="flex cursor-pointer items-start gap-3 rounded-lg border border-blue-200 bg-blue-50 px-3 py-3 dark:border-slate-700 dark:bg-slate-800/40"
			>
				<input
					type="checkbox"
					checked={includeSource}
					onchange={(e) => (excludeSource = !e.currentTarget.checked)}
					class="mt-0.5 h-4 w-4 rounded border-gray-300 bg-white text-blue-600 dark:border-gray-600 dark:bg-slate-800"
				/>

				<span class="space-y-1">
					<span class="block text-sm font-medium text-gray-900 dark:text-gray-100">
						Include the original file
					</span>
					<span class="block text-xs text-gray-500 dark:text-gray-400">
						{#if includeSource}
							The recipient can download the original {typeLabel} file.
							{#if isTabular}They can also reopen it as an interactive table.{/if}
						{:else}
							The recipient gets the extracted text and analysis, but cannot download the
							original {typeLabel} file{#if isTabular} or reopen the interactive table{/if}.
						{/if}
					</span>
				</span>
			</label>

		</div>
	{:else if phase === 'choose-type'}
		<div class="space-y-4">
			<p class="text-sm text-gray-700 dark:text-gray-300">
				Choose how the recipient will unlock this file.
			</p>
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
		</div>
	{:else if phase === 'generating'}



		<div class="flex flex-col items-center justify-center gap-3 py-10 text-center">
			<div class="h-8 w-8 animate-spin rounded-full border-2 border-gray-200 dark:border-slate-700 border-t-blue-500"></div>
			<p class="text-sm text-gray-500 dark:text-gray-400">Preparing your file…</p>
		</div>

	{:else if phase === 'error'}
		<div class="space-y-4 py-4">
			<p class="text-sm text-red-600 dark:text-red-300">{error}</p>
			<button
				onclick={prepare}
				class="rounded-lg bg-gray-100 px-3 py-1.5 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-200 dark:bg-slate-800 dark:text-gray-200 dark:hover:bg-slate-700"
			>
				Try again
			</button>
		</div>
	{:else if phase === 'show-words'}
		<div class="space-y-4">
			{#if passphraseType === 'emoji'}
				<p class="text-sm text-gray-700 dark:text-gray-300">
					Store these 8 emoji somewhere safe. The recipient needs them to open the file.
				</p>

				<!-- The 8 emoji, rendered via Noto SVGs for a consistent cross-platform
				     look. The passphrase itself is the raw Unicode characters — these
				     images are display-only. -->
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
					Store these 6 words somewhere safe. The recipient needs them to open the file.
				</p>

				<!-- The 6 words -->
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

			<!-- Warnings -->
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
	{:else if phase === 'sharing'}

		<!-- Web Share API flow — see ShareSheet.svelte. Handles size/canShare
		     gating, the iOS clipboard workaround, and the success banner
		     itself; falls back to the plain download ("done" screen) below
		     via shareFallback() whenever sharing isn't possible. -->
		{#if shareFile}
			<ShareSheet
				file={shareFile}
				onFallback={shareFallback}
				onCancel={shareCancelled}
				onDone={onclose}
			/>
		{/if}
	{:else}


		<!-- done -->
		<div class="flex flex-col items-center justify-center gap-3 py-8 text-center">
			<div class="flex h-12 w-12 items-center justify-center rounded-full bg-green-100 dark:bg-green-900/40 text-2xl">
				✓
			</div>
			<p class="text-sm font-medium text-gray-900 dark:text-white">Your file is downloading.</p>
			<p class="text-xs text-gray-500 dark:text-gray-400">
				Remember: send the {passphraseType === 'emoji' ? '8 emoji' : '6 words'} separately from the file.
			</p>
		</div>
	{/if}

	{#snippet footer()}
		{#if phase === 'options'}
			<div class="flex justify-end gap-2">
				<button
					onclick={onclose}
					class="rounded-lg px-3 py-1.5 text-xs font-medium text-gray-500 transition-colors hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200"
				>
					Cancel
				</button>
				<button
					onclick={() => (phase = 'choose-type')}
					class="rounded-lg bg-blue-700 px-4 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-blue-600"
				>
					Continue
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
			</div>
		{:else if phase === 'show-words'}


			<div class="flex justify-end gap-2">
				<button
					onclick={onclose}
					class="rounded-lg px-3 py-1.5 text-xs font-medium text-gray-500 transition-colors hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200"
				>
					Cancel
				</button>
				<button
					onclick={confirmStored}
					class="rounded-lg bg-blue-700 px-4 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-blue-600"
				>
					I've stored these {passphraseType === 'emoji' ? 'emoji' : 'words'}
				</button>
			</div>
		{:else if phase === 'sharing'}
			<!-- No footer buttons — ShareSheet.svelte renders its own
			     in-body actions (e.g. "Open share sheet →", "Encrypt
			     another file →") for each of its internal states. -->
		{:else if phase === 'done'}
			<div class="flex justify-end gap-2">
				<button
					onclick={download}
					class="rounded-lg px-3 py-1.5 text-xs font-medium text-gray-500 transition-colors hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200"
				>
					Download again
				</button>
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
