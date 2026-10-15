<script lang="ts">
	import { t } from "../lib/i18n";
	import Icon from "./Icon.svelte";
	import ModelPickerModal from "./ModelPickerModal.svelte";
	import type { ModelInfo, ProviderInfo, ThinkingLevel } from "../lib/types";

	/**
	 * A form field for "which model, at which reasoning strength": shows the current pair and opens the shared
	 * ModelPickerModal. Used wherever a setting picks a model, so they all look and behave the same.
	 * The caller passes the models in, so it works for any server, not only the open one.
	 */
	let {
		models,
		providers = [],
		value,
		level = null,
		favs = [],
		allowUnset = false,
		unsetLabel,
		disabled = false,
		placeholder,
		label,
		onpick,
		onfav,
		onmanage,
	}: {
		models: ModelInfo[];
		providers?: ProviderInfo[];
		value: { provider: string; model: string } | null;
		level?: ThinkingLevel | null;
		favs?: string[];
		allowUnset?: boolean;
		unsetLabel?: string;
		disabled?: boolean;
		placeholder?: string;
		label: string;
		onpick: (choice: { provider: string; model: string; thinkingLevel?: ThinkingLevel } | null) => void;
		onfav?: (provider: string, id: string) => void;
		onmanage?: () => void;
	} = $props();

	let open = $state(false);
	const current = $derived(value ? models.find((m) => m.provider === value.provider && m.id === value.model) : undefined);
</script>

<button type="button" class="trigger" onclick={() => (open = true)} {disabled} aria-haspopup="dialog" aria-expanded={open} aria-label={label}>
	<span class="mname">{current?.name ?? (value ? value.model : (placeholder ?? t("모델 없음")))}</span>
	{#if current?.reasoning && level}<span class="chip think" data-level={level}>{level}</span>{/if}
	<Icon name="chevron-down" />
</button>

{#if open}
	<ModelPickerModal
		{models}
		{providers}
		{value}
		{level}
		{favs}
		{allowUnset}
		{unsetLabel}
		title={label}
		{onpick}
		{onfav}
		{onmanage}
		onclose={() => (open = false)}
	/>
{/if}

<style>
	.trigger {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		min-width: 0;
		height: 42px;
		padding: 0 12px;
		background: var(--bg);
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-sm);
		color: var(--text);
		font: inherit;
		font-size: var(--fs-md);
		text-align: left;
		transition: border-color var(--motion-fast) var(--ease-std);
	}
	.trigger:hover:not(:disabled) {
		border-color: var(--accent);
	}
	.trigger:disabled {
		opacity: 0.5;
	}
	.mname {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.trigger :global(svg:not(.model)) {
		width: 15px;
		height: 15px;
		flex: none;
		stroke: currentColor;
		fill: none;
		stroke-width: 2;
		stroke-linecap: round;
		stroke-linejoin: round;
		color: var(--text-dim);
	}
</style>
