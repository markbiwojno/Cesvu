<script lang="ts">
	/**
	 * SecureOpenModal.svelte — decrypt an oversized `.cesvu` (over
	 * VAULT_IMPORT_STREAM_THRESHOLD_BYTES, see vault-constants.ts) straight
	 * to a location the user picks, instead of loading it into memory and
	 * opening it in the in-app viewer (which ImportModal.svelte does for
	 * everything under that threshold).
	 *
	 * Passphrase entry mirrors ImportModal.svelte's single masked input with
	 * auto-detected diceware/emoji mode (used only as a `preferredType`
	 * performance hint to `importVaultFileToDisk` — a wrong guess just costs
	 * one extra fallback KDF derivation, never a wrong result), but drops
	 * ImportModal's live per-token wordlist validation chips since there's
	 * no viewer payoff at the end to justify the extra complexity here —
	 * this flow's only output is a file written to disk.
	 */
	import { onMount } from 'svelte';
	import Modal from '$lib/components/common/Modal.svelte';
	import { importVaultFileToDisk, VaultCancelledError, saveFilePickerAvailable, type VaultProgress } from '$lib/crypto/vault-io.js';
	import {
		parseHeader,
		PASS_PROFILE_RAW,
		RAW_PASSPHRASE_MAX_BYTES,
		rawPassphraseByteLength,
		CesvuError
	} from '$lib/crypto/index.js';
	import { workspace } from '$lib/stores/workspace.svelte.js';


	interface Props {
		file: File;
		onclose: () => void;
		onsaved?: (filename: string) => void;
	}
	let { file, onclose, onsaved }: Props = $props();

	type Phase = 'input' | 'unlocking' | 'success';
	let phase = $state<Phase>('input');
	let passphrase = $state('');
	let error = $state('');
	let failedAttempts = $state(0);
	let cooldown = $state(0);
	let showPassphrase = $state(false);
	let progress = $state<VaultProgress | null>(null);
	let savedName = $state('');

	/** Peeked from the file's own header at mount — see ImportModal.svelte's
	 *  identical `isRawProfile`/`peekPassProfile` for the full rationale. */
	let isRawProfile = $state<boolean | null>(null);

	let inputEl = $state<HTMLInputElement | null>(null);
	let cooldownTimer: ReturnType<typeof setInterval> | null = null;

	const EMOJI_TEST = /\p{Extended_Pictographic}/u;
	const mode = $derived<'diceware' | 'emoji'>(EMOJI_TEST.test(passphrase) ? 'emoji' : 'diceware');
	const words = $derived(passphrase.trim().length === 0 ? [] : passphrase.trim().split(/\s+/));
	const emojis = $derived(Array.from(passphrase.replace(/\s/g, '')));
	const locked = $derived(cooldown > 0);

	/**
	 * UTF-8 BYTE length of the typed password — the unit
	 * RAW_PASSPHRASE_MAX_BYTES is expressed in, and therefore the unit both
	 * the counter below and the gate must use.
	 *
	 * Was `passphrase.length` (UTF-16 code units), which is wrong twice
	 * over: it over-counts astral characters (256 emoji reads as 512, so a
	 * valid password was blocked at half the limit while the counter showed
	 * a number the user could not reconcile with what they typed) and
	 * under-counts everything above ASCII (512 CJK characters reads as 512
	 * but is 1536 bytes, so submit was enabled and preparePassphrase then
	 * threw PASSPHRASE_TOO_LONG). Counting bytes makes the number on screen
	 * the number actually enforced.
	 */
	const rawBytes = $derived(rawPassphraseByteLength(passphrase));

	const canSubmit = $derived(
		isRawProfile
			? passphrase.length > 0 &&
					rawBytes <= RAW_PASSPHRASE_MAX_BYTES &&
					!locked &&
					phase !== 'unlocking'
			: mode === 'emoji'
				? emojis.length >= 8 && !locked && phase !== 'unlocking'
				: words.length === 6 && !locked && phase !== 'unlocking'
	);

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


	const progressPct = $derived(
		progress && progress.totalBytes > 0
			? Math.min(100, Math.round((progress.bytesProcessed / progress.totalBytes) * 100))
			: 0
	);

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

	async function unlock() {
		if (!canSubmit) return;
		phase = 'unlocking';
		error = '';
		progress = null;
		// See workspace.svelte.ts's `activeVaultOperations` doc comment — marks
		// this decrypt as active for Modal's `dismissible` guard and the
		// workspace-level beforeunload warning.
		workspace.beginVaultOperation();
		try {
			const result = await importVaultFileToDisk(
				file,
				passphrase,
				isRawProfile ? 'raw' : mode,
				(p) => {
					progress = p;
				}
			);

			// `result.savedName` reflects the file handle's ACTUAL saved name
			// (Tier 1: what the user confirmed in the native save dialog,
			// which they may have edited; Tier 2/3: the exact `<a download>`
			// name) — never just the assumed original metadata filename, so
			// this success message can't lie about what's really on disk.
			savedName = result.savedName || result.metadata.filename || file.name;

			phase = 'success';
			onsaved?.(savedName);
		} catch (e) {
			if (e instanceof VaultCancelledError) {
				phase = 'input';
				return;
			}
			error = e instanceof Error ? e.message : 'Unable to decrypt this file.';
			failedAttempts += 1;
			phase = 'input';
			if (failedAttempts >= 3) startCooldown(5);
		} finally {
			workspace.endVaultOperation();
		}
	}

</script>

<Modal open={true} title="Decrypt large file" {onclose} dismissible={phase !== 'unlocking'}>

	{#if phase === 'success'}
		<div class="flex flex-col items-center justify-center gap-3 py-10 text-center">
			<div class="flex h-12 w-12 items-center justify-center rounded-full bg-green-900/40 text-2xl">
				✓
			</div>
			<p class="text-sm font-medium text-white">Saved <span class="font-mono">{savedName}</span> to disk.</p>
		</div>
	{:else if phase === 'unlocking'}
		<div class="flex flex-col items-center justify-center gap-3 py-10 text-center">
			<div class="h-8 w-8 animate-spin rounded-full border-2 border-slate-700 border-t-blue-500"></div>
			<p class="text-sm text-gray-400">Decrypting and writing to disk…</p>
			{#if progress && progress.totalBytes > 0}
				<div class="w-full max-w-xs">
					<div class="h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
						<div
							class="h-full rounded-full bg-blue-600 transition-all"
							style="width: {progressPct}%"
						></div>
					</div>
					<p class="mt-1 text-xs text-gray-500 tabular-nums">
						{formatBytes(progress.bytesProcessed)} / {formatBytes(progress.totalBytes)}
					</p>
				</div>
			{/if}
		</div>
	{:else}
		<div class="space-y-4">
			<p class="text-sm text-gray-300">
				{#if isRawProfile}
					<span class="font-medium text-gray-100">{file.name}</span> is too large to open in the
					viewer ({formatBytes(file.size)}). Enter the password to decrypt it directly to a
					location on your device.
				{:else}
					<span class="font-medium text-gray-100">{file.name}</span> is too large to open in the
					viewer ({formatBytes(file.size)}). Enter the passphrase to decrypt it directly to a
					location on your device — 6 words or 8 emoji.
				{/if}
			</p>

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
				name="cesvu-vault-passphrase"
				aria-label={isRawProfile ? 'Custom password' : 'Six-word diceware or eight-emoji passphrase'}
				placeholder={isRawProfile
					? 'Enter password'
					: 'rocket garden mirror forest candle window  or  🦏🐙🌵🚀🍄🔥🐝🌙'}
				class="w-full rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 font-mono text-sm text-gray-100 outline-none placeholder:text-gray-600 focus:border-blue-600 focus:ring-1 focus:ring-blue-600 disabled:opacity-50"
				disabled={locked}
			/>

			<p class={['text-xs', isRawProfile && rawBytes > RAW_PASSPHRASE_MAX_BYTES ? 'text-red-300' : 'text-gray-500']}>
				{#if isRawProfile}
					{rawBytes}/{RAW_PASSPHRASE_MAX_BYTES} bytes{rawBytes >
					RAW_PASSPHRASE_MAX_BYTES
						? ' — too long'
						: ''}
				{:else if mode === 'emoji'}
					{emojis.length}/8 emoji
				{:else}
					{words.length}/6 words
				{/if}
			</p>

			<label class="flex items-center gap-2 text-xs text-gray-400 select-none cursor-pointer">
				<input
					type="checkbox"
					bind:checked={showPassphrase}
					class="h-3.5 w-3.5 rounded border-gray-600 bg-slate-800 text-blue-600 focus:ring-blue-500 focus:ring-offset-gray-900"
				/>
				<span>{isRawProfile ? 'Show password' : mode === 'emoji' ? 'Show emoji' : 'Show words'}</span>
			</label>


			{#if !saveFilePickerAvailable()}
				<p class="text-xs text-gray-500">
					This browser will save the decrypted file via a normal download instead of letting
					you pick a folder up front.
				</p>
			{/if}

			{#if error}
				<p class="text-xs text-red-300" role="alert">{error}</p>
			{/if}

			{#if locked}
				<p class="text-xs text-amber-200" aria-live="polite">
					Too many attempts. Try again in {cooldown}s.
				</p>
			{/if}
		</div>
	{/if}

	{#snippet footer()}
		{#if phase === 'input'}
			<div class="flex justify-end gap-2">
				<button
					onclick={onclose}
					class="rounded-lg px-3 py-1.5 text-xs font-medium text-gray-400 transition-colors hover:text-gray-200"
				>
					Cancel
				</button>
				<button
					onclick={unlock}
					disabled={!canSubmit}
					class="rounded-lg bg-blue-700 px-4 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-40"
				>
					{locked ? `Wait ${cooldown}s` : 'Decrypt & Save'}
				</button>
			</div>
		{:else if phase === 'success'}
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
