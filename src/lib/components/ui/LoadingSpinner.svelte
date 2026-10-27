<script lang="ts">
	interface Props {
		size?: 'sm' | 'md' | 'lg';
		message?: string;
		class?: string;
	}
	let { size = 'md', message, class: className = '' }: Props = $props();

	const ring: Record<string, string> = {
		sm: 'w-4 h-4 border-2',
		md: 'w-7 h-7 border-2',
		lg: 'w-12 h-12 border-[3px]'
	};
	const text: Record<string, string> = {
		sm: 'text-xs',
		md: 'text-sm',
		lg: 'text-base'
	};
</script>

<div class="flex flex-col items-center justify-center gap-3 {className}" role="status" aria-label={message ?? 'Loading'}>
	<div
		class="rounded-full border-gray-300 dark:border-slate-700 border-t-blue-500 dark:border-t-blue-400 animate-spin {ring[size]}"
		aria-hidden="true"
	></div>
	{#if message}
		<p class="text-gray-500 dark:text-gray-400 {text[size]}">{message}</p>
	{/if}
</div>
