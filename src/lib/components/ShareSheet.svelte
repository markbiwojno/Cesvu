<script module lang="ts">
	/**
	 * ShareSheet.svelte — Web Share API flow for an already-built `.cesvu`
	 * `File` living in memory.
	 *
	 * Wired to ExportModal.svelte's "Share" button (see its `share()`/
	 * `phase === 'sharing'`).
	 *
	 * ── Why the Web Share API, and what it can't do ─────────────────────────
	 * `navigator.share({ files })` hands the file to the OS-native
	 * share sheet. Cesvu has NO control over which destination app the user
	 * picks (Gmail, Apple Mail, WhatsApp, etc.) and no visibility into what
	 * happens after the sheet opens — the destination app owns its own
	 * auth/compose UI from that point on. This component's job ends the
	 * moment `navigator.share()` settles.
	 *
	 * ── Decision tree (mirrors the design doc exactly) ───────────────────────
	 *   size >= 15MB                → onFallback()
	 *   !canShare({files})          → onFallback()
	 *   iOS                         → clipboard + files-only share (WebKit
	 *                                 bug: share() throws if `files` AND
	 *                                 `text` are both present)
	 *   else                        → share({ title, text, files }) directly
	 *   resolved                    → success banner
	 *   AbortError                  → silent reset (onCancel) — no toast,
	 *                                 no error, no fallback: the user simply
	 *                                 chose to cancel
	 *   any other error             → onFallback()
	 *
	 * The pure helpers below (`buildEmailBody`, `exceedsShareSizeLimit`,
	 * `detectIOS`) are exported from this module context so they're
	 * unit-testable with plain vitest — no component mount, no jsdom
	 * Web Share API shims required.
	 */

	/** Hard cutoff above which we never attempt navigator.share() at all —
	 *  matches common email-attachment size ceilings (Gmail caps at 25MB;
	 *  base64 attachment encoding adds ~33% overhead on top of that), so a
	 *  file this large is unlikely to be deliverable as an attachment
	 *  through whatever app the user picks in the share sheet anyway. */
	export const SHARE_SIZE_LIMIT_BYTES = 15 * 1024 * 1024;

	export function exceedsShareSizeLimit(size: number): boolean {
		return size >= SHARE_SIZE_LIMIT_BYTES;
	}

	/**
	 * iPadOS 13+ reports `navigator.platform === 'MacIntel'` (matching
	 * desktop Safari) — `maxTouchPoints > 1` is what actually distinguishes
	 * a touch-capable iPad from a real Mac.
	 */
	export function detectIOS(userAgent: string, platform: string, maxTouchPoints: number): boolean {
		return /iPad|iPhone|iPod/.test(userAgent) || (platform === 'MacIntel' && maxTouchPoints > 1);
	}

	/** Shared by the standard-path share() call and (as a display copy for
	 *  the clipboard) the iOS two-step path. */
	export function buildEmailBody(): string {
		return `I sent you a file — here's how to open it:

1. Visit https://cesvu.com
2. Upload this attachment

Takes 30 seconds. Free, no account needed, your file never
leaves your browser.

Want to send me a file back? → https://cesvu.com`;
	}
</script>

<script lang="ts">
	import { onMount } from 'svelte';
	import { copyTextToClipboard } from '$lib/utils/clipboard.js';

	interface Props {
		/** The already-built `.cesvu` file, held only in memory. */
		file: File;
		/**
		 * Run the app's existing default behavior (today: download the file
		 * and show the "done" screen) — invoked whenever sharing isn't
		 * possible or fails for a reason other than the user cancelling.
		 */
		onFallback: () => void;
		/**
		 * The user cancelled the OS share sheet (or the browser reports
		 * AbortError for an equivalent reason). Must be a silent, side-effect-
		 * free reset — no toast, no error, no fallback.
		 */
		onCancel: () => void;
		/** The user is done looking at the success banner. */
		onDone: () => void;
	}
	let { file, onFallback, onCancel, onDone }: Props = $props();

	type State = 'starting' | 'status-standard' | 'ios-instructions' | 'status-ios' | 'success';
	let state = $state<State>('starting');

	function isAbortError(err: unknown): boolean {
		return err instanceof Error && err.name === 'AbortError';
	}

	async function shareEncryptedFile(): Promise<void> {
		if (exceedsShareSizeLimit(file.size)) {
			onFallback();
			return;
		}

		const canShare = navigator.canShare?.({ files: [file] }) ?? false;
		if (!canShare) {
			onFallback();
			return;
		}

		const isIOS = detectIOS(navigator.userAgent, navigator.platform, navigator.maxTouchPoints);

		if (isIOS) {
			// iOS Safari (and every other iOS browser, all WebKit-backed)
			// throws when `files` and `text` are passed to share() together.
			// Two-step workaround: copy the email body to the clipboard first,
			// then share the file alone.
			await copyTextToClipboard(buildEmailBody());
			state = 'ios-instructions';
			return;
		}

		state = 'status-standard';
		try {
			await navigator.share({ title: 'Cesvu file', text: buildEmailBody(), files: [file] });
			state = 'success';
		} catch (err) {
			if (isAbortError(err)) {
				onCancel();
				return;
			}
			onFallback();
		}
	}

	/** iOS path, step 2 — fired by the "Open share sheet →" button tap. */
	async function openIOSShareSheet(): Promise<void> {
		state = 'status-ios';
		try {
			// files ONLY — no text/title (see the WebKit bug note above).
			await navigator.share({ files: [file] });
			state = 'success';
		} catch (err) {
			if (isAbortError(err)) {
				onCancel();
				return;
			}
			onFallback();
		}
	}

	onMount(() => {
		void shareEncryptedFile();
	});
</script>

{#if state === 'starting' || state === 'status-standard'}
	<div class="flex flex-col items-center justify-center gap-3 py-10 text-center">
		<div class="h-8 w-8 animate-spin rounded-full border-2 border-gray-200 dark:border-slate-700 border-t-blue-500"></div>
		<p class="text-sm text-gray-500 dark:text-gray-400">Opening share sheet…</p>
	</div>
{:else if state === 'ios-instructions'}
	<div class="space-y-4">
		<div class="space-y-1.5 rounded-lg border border-blue-200 bg-blue-50 dark:border-slate-700 dark:bg-slate-800/40 px-3 py-2.5">
			<p class="text-sm font-medium text-gray-900 dark:text-gray-100">📋 Instructions copied to clipboard</p>
			<p class="text-xs text-gray-600 dark:text-gray-300">
				Tap "Open share sheet", pick your email app, then long-press in the email body and tap Paste.
			</p>
		</div>
		<div class="flex justify-end">
			<button
				onclick={openIOSShareSheet}
				class="rounded-lg bg-blue-700 px-4 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-blue-600"
			>
				Open share sheet →
			</button>
		</div>
	</div>
{:else if state === 'status-ios'}
	<div class="flex flex-col items-center justify-center gap-3 py-10 text-center">
		<div class="h-8 w-8 animate-spin rounded-full border-2 border-gray-200 dark:border-slate-700 border-t-blue-500"></div>
		<p class="text-sm text-gray-500 dark:text-gray-400">Opening share sheet…</p>
	</div>
{:else if state === 'success'}
	<div class="space-y-3">
		<div class="space-y-1.5 rounded-lg border border-green-300 bg-green-50 dark:border-green-900/50 dark:bg-green-950/30 px-3 py-2.5">
			<p class="text-sm font-medium text-gray-900 dark:text-gray-100">✅ File shared!</p>
			<p class="text-xs text-gray-700 dark:text-gray-300">
				This file is not encrypted — anyone with it can open it.
			</p>
		</div>
		<div class="flex justify-end">
			<button
				onclick={onDone}
				class="text-xs font-medium text-blue-700 transition-colors hover:text-blue-600 dark:text-blue-400 dark:hover:text-blue-300"
			>
				Share another file →
			</button>
		</div>
	</div>
{/if}
