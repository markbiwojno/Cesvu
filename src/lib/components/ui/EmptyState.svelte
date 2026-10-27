<script lang="ts">
	interface Props {
		icon?: string;
		title: string;
		description?: string;
		actionLabel?: string;
		onAction?: () => void;
		class?: string;
	}
	let {
		icon = '📂',
		title,
		description,
		actionLabel,
		onAction,
		class: className = ''
	}: Props = $props();
</script>

<div class="flex flex-col items-center justify-center py-16 px-6 text-center {className}">
	<div class="text-5xl mb-4 select-none" aria-hidden="true">{icon}</div>
	<h3 class="text-base font-semibold text-gray-700 dark:text-gray-200 mb-2">{title}</h3>
	{#if description}
		<p class="text-sm text-gray-500 max-w-xs mb-6 leading-relaxed">{description}</p>
	{/if}
	{#if actionLabel && onAction}
		<button
			onclick={onAction}
			class="px-4 py-2 rounded-lg bg-blue-700 hover:bg-blue-600 active:bg-blue-800 text-white text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
		>
			{actionLabel}
		</button>
	{/if}
</div>
