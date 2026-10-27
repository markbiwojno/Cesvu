<script lang="ts">
	interface Props {
		message: string;
		onretry?: () => void;
		ondismiss?: () => void;
	}
	let { message, onretry, ondismiss }: Props = $props();
</script>

<div
	class="flex items-start gap-3 p-4 rounded-lg bg-red-950/50 border border-red-800 text-red-300"
	role="alert"
>
	<span class="text-lg flex-shrink-0" aria-hidden="true">⚠️</span>
	<div class="flex-1 min-w-0">
		<p class="text-sm font-medium">{message}</p>
		<div class="flex gap-3 mt-2">
			{#if onretry}
				<button
					onclick={onretry}
					class="text-xs text-red-400 hover:text-red-200 underline transition-colors"
				>
					Try again
				</button>
			{/if}
			{#if ondismiss}
				<button
					onclick={ondismiss}
					class="text-xs text-red-500 hover:text-red-300 transition-colors"
				>
					Dismiss
				</button>
			{/if}
		</div>
	</div>
</div>
