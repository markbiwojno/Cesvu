<script lang="ts">
	interface Props {
		message: string;
		retryable?: boolean;
		onRetry?: () => void;
		class?: string;
	}
	let { message, retryable = false, onRetry, class: className = '' }: Props = $props();

	let dismissed = $state(false);
</script>

{#if !dismissed}
	<div
		class="flex items-start gap-3 p-4 rounded-lg bg-red-950/60 border border-red-800/70 text-red-300 {className}"
		role="alert"
		aria-live="assertive"
	>
		<!-- Icon -->
		<span class="text-lg flex-shrink-0 mt-0.5" aria-hidden="true">⚠️</span>

		<!-- Content -->
		<div class="flex-1 min-w-0">
			<p class="text-sm font-medium leading-snug">{message}</p>
			{#if retryable && onRetry}
				<button
					onclick={onRetry}
					class="mt-2 text-xs text-red-400 hover:text-red-200 underline underline-offset-2 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-red-500 rounded"
				>
					Try again
				</button>
			{/if}
		</div>

		<!-- Dismiss -->
		<button
			onclick={() => (dismissed = true)}
			class="flex-shrink-0 text-red-600 hover:text-red-400 transition-colors p-0.5 rounded focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-red-500"
			aria-label="Dismiss error"
		>
			<svg class="w-4 h-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2">
				<path d="M4 4l8 8M12 4l-8 8" stroke-linecap="round"/>
			</svg>
		</button>
	</div>
{/if}
