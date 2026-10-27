<script lang="ts">
	/**
	 * SendBackModal.svelte — re-encrypt a document as a "Send Back" reply,
	 * reusing the SAME passphrase the recipient unlocked it with (captured at
	 * unlock time — see sessionKey.svelte.ts). Unlike ExportModal, there is no
	 * "choose a passphrase type" step and no "show these words" step: the
	 * passphrase already exists and is never re-displayed here — the sender
	 * already has it (that's the whole point of "Send Back").
	 *
	 * Flow:
	 *   1. "options" — the sender chooses whether the ORIGINAL SOURCE FILE is
	 *      embedded in the reply (same "Include the original file" checkbox as
	 *      ExportModal, but default CHECKED here — see sendBackAsCesvu's doc
	 *      comment for why the default differs).
	 *   2. "generating" — encrypt with the passphrase already known
	 *      (sendBackAsCesvu draws a FRESH random salt automatically, so this
	 *      reply's ciphertext can't be linked to any other file encrypted
	 *      under the same passphrase).
	 *   3. "done" — the file has already started downloading; "Download
	 *      again" / "Done".
	 *
	 * ── `subject` prop (title/copy variant) ─────────────────────────────────
	 * This component has two distinct callers:
	 *   1. Workspace.svelte's own "Send Back" button — re-encrypts the
	 *      CURRENTLY OPEN document (the one the user has been annotating) as
	 *      a reply. `subject` defaults to `'notes'` here, preserving this
	 *      flow's original "Reply with your notes" framing untouched.
	 *   2. ImportModal.svelte's "Choose a file to send back" (viewer-supported
	 *      type path) — the user picks a FRESH, unrelated file from disk to
	 *      encrypt to the same passcode; there are no "notes" or
	 *      "annotations" involved at all. That caller passes `subject="file"`
	 *      to swap in file-appropriate title/button/done-screen copy instead.
	 */
	import { onMount } from 'svelte';
	import Modal from '$lib/components/common/Modal.svelte';
	import {
		sendBackAsCesvu,
		getDocument,
		describeExportError
	} from '$lib/stores/contract-store.svelte.js';
	import { workspace } from '$lib/stores/workspace.svelte.js';
	import { DEFAULT_CESVU_DOWNLOAD_NAME } from '$lib/utils/cesvu-filename.js';
	import type { PassphraseType } from '$lib/crypto/index.js';
	import type { SourceType } from '$lib/schema.js';
	import { isDismissiblePhase } from '$lib/utils/vault-modal-phases.js';


	interface Props {
		documentId: string;
		/** The passphrase captured at unlock time (sessionKeyStore.getPassphrase()). */
		passphrase: string;
		/** The passphrase profile it was unlocked with (diceware / emoji / raw). */
		passphraseType: PassphraseType;
		/**
		 * Copy variant — see this file's top doc comment. `'notes'` (default)
		 * is the original "reply with your annotations" framing used by
		 * Workspace.svelte's own Send Back button; `'file'` is used by
		 * ImportModal.svelte for a freshly-picked, unrelated file.
		 */
		subject?: 'notes' | 'file';
		onclose: () => void;
	}
	let { documentId, passphrase, passphraseType, subject = 'notes', onclose }: Props = $props();

	type Phase = 'options' | 'generating' | 'done' | 'error';
	let phase = $state<Phase>('options');
	let error = $state('');

	let blob: Blob | null = null;

	// ── Source-inclusion choice ────────────────────────────────────────────────
	// `excludeSource` is the user-facing opt-out state (checked box = include).
	// Defaults to INCLUDED (excludeSource = false) — see sendBackAsCesvu's doc
	// comment for why this default differs from ExportModal's.
	let sourceType = $state<SourceType | null>(null);
	let excludeSource = $state(false);
	/** This session's document actually carries the original bytes. */
	let hasSource = $state(false);

	const isTabular = $derived(sourceType === 'csv' || sourceType === 'excel');
	const noSourceConcept = $derived(sourceType === 'txt' || sourceType === 'md');
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
	});

	/** Inspect the document purely to drive the "Include the original file"
	 *  copy (whether there's actually a source to include at all). */
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
	}

	function download() {
		if (!blob) return;
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = DEFAULT_CESVU_DOWNLOAD_NAME;
		document.body.appendChild(a);
		a.click();
		a.remove();
		URL.revokeObjectURL(url);
	}

	async function send() {
		phase = 'generating';
		// Same guard rails as ExportModal: mark the operation active so
		// Modal's `dismissible` and the workspace-level beforeunload warning
		// both engage while the encrypt is in flight.
		workspace.beginVaultOperation();
		try {
			const result = await sendBackAsCesvu(documentId, passphrase, passphraseType, {
				includeSource
			});
			blob = result.blob;
			phase = 'done';
			// Auto-download the instant we reach "done" — the recipient
			// already knows the passphrase, so there's nothing further to
			// show/confirm before handing them the file.
			download();
		} catch (e) {
			error = e instanceof Error ? e.message : describeExportError(e);
			phase = 'error';
		} finally {
			workspace.endVaultOperation();
		}
	}
</script>

<Modal
	open={true}
	title={subject === 'file' ? 'Send file back' : 'Reply with your notes'}
	{onclose}
	dismissible={isDismissiblePhase(phase)}
>

	{#if phase === 'options'}
		<div class="space-y-4">
			<!-- Info banner: the recipient already holds this passphrase, we're
			     just reusing it (with a fresh salt) rather than generating a
			     new one the sender would need to be told about. -->
			<div class="flex items-start gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2.5 dark:border-slate-700 dark:bg-slate-800/40">
				<span aria-hidden="true">🔒</span>
				<p class="text-xs text-gray-700 dark:text-gray-300">
					<span class="font-medium text-gray-900 dark:text-gray-100">Same passcode</span> — the sender already has it.
				</p>
			</div>

			{#if subject !== 'file'}
				<!-- This choice only makes sense for the "notes" subject
				     (Workspace's own Send Back button), where the currently
				     open document has real substance beyond the raw file —
				     annotations, extracted text, analysis — so "just my
				     notes vs. the full file" is a genuine option. For the
				     "file" subject (ImportModal's "Choose a file to send
				     back"), the document exists ONLY to carry this one raw
				     file back to the sender (see parsedFileToDocumentInit);
				     unchecking "Include the original file" there would ship
				     an empty/lossy reply with no file in it at all, which is
				     never what the user wants — so the option is hidden
				     entirely rather than offering a self-defeating choice. -->
				<p class="text-sm text-gray-700 dark:text-gray-300">Choose what to include below.</p>


				{#if !noSourceConcept && hasSource}
					<!-- Checked by default — see sendBackAsCesvu's doc comment. -->
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
				{/if}
			{/if}
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
				onclick={send}
				class="rounded-lg bg-gray-100 px-3 py-1.5 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-200 dark:bg-slate-800 dark:text-gray-200 dark:hover:bg-slate-700"
			>
				Try again
			</button>
		</div>
	{:else if subject === 'file'}
		<!-- done — "file" subject (ImportModal's "Choose a file to send back") -->
		<div class="flex flex-col items-center justify-center gap-3 py-8 text-center">
			<p class="text-sm font-medium text-gray-900 dark:text-white">✓ Encrypted and ready to send</p>
			<p class="text-xs text-gray-500 dark:text-gray-400">Your file is downloaded. Send it back to the sender —</p>
			<p class="text-xs text-gray-500 dark:text-gray-400">they already have your passcode, so just attach and send.</p>
		</div>
	{:else}
		<!-- done — "notes" subject (Workspace's own Send Back button) -->
		<div class="flex flex-col items-center justify-center gap-3 py-8 text-center">
			<div class="flex h-12 w-12 items-center justify-center rounded-full bg-green-100 dark:bg-green-900/40 text-2xl">
				✓
			</div>
			<p class="text-sm font-medium text-gray-900 dark:text-white">
				Done! Your annotations are encrypted and ready to send back.
			</p>
			<p class="text-xs text-gray-500 dark:text-gray-400">The file has been downloaded to your browser.</p>
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
					onclick={send}
					class="rounded-lg bg-blue-700 px-4 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-blue-600"
				>
					{subject === 'file' ? 'Send File' : 'Send Reply'}
				</button>
			</div>
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