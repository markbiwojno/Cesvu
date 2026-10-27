<script lang="ts">
	interface Props {
		size?: 'sm' | 'md' | 'lg';
		label?: string;
	}
	let { size = 'md', label = 'Loading...' }: Props = $props();

	const sizeClasses = {
		sm: 'w-4 h-4 border-2',
		md: 'w-6 h-6 border-2',
		lg: 'w-10 h-10 border-3'
	};
</script>

<div class="flex items-center gap-2" role="status" aria-label={label}>
	<div
		class="rounded-full border-gray-300 dark:border-gray-600 border-t-brand-500 dark:border-t-brand-400 animate-spin {sizeClasses[size]}"
	></div>
	{#if label && size !== 'sm'}
		<span class="text-sm text-gray-500 dark:text-gray-400">{label}</span>
	{/if}
</div>
