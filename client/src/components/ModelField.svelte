<script lang="ts">
	import { t } from "../lib/i18n";
	import Icon from "./Icon.svelte";
	import ModelPickerModal from "./ModelPickerModal.svelte";
	import type { ModelInfo, ProviderInfo, ThinkingLevel } from "../lib/types";

	/**
	 * "Which model, at which reasoning strength": the button that shows the current pair and opens the shared
	 * ModelPickerModal. Every place that picks a model uses it, so they all look and behave the same.
	 *  - `variant="field"`: a form field (settings: default model, compaction, sub-agent);
	 *  - `variant="inline"`: the composer's quiet toolbar button (ModelPicker wires it to the chat).
	 * The caller passes the models in, so it works for any server, not only the open one.
	 * `open` is bindable so a shortcut can open the dialog from outside.
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
		variant = "field",
		open = $bindable(false),
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
		/** the dialog's title, and the button's accessible name in a form */
		label: string;
		variant?: "field" | "inline";
		open?: boolean;
		onpick: (choice: { provider: string; model: string; thinkingLevel?: ThinkingLevel } | null) => void;
		onfav?: (provider: string, id: string) => void;
		onmanage?: () => void;
	} = $props();

	const current = $derived(value ? models.find((m) => m.provider === value.provider && m.id === value.model) : undefined);
	const shown = $derived(current?.name ?? (value ? value.model : (placeholder ?? t("모델 없음"))));
</script>

<button
	type="button"
	class="trigger {variant}"
	onclick={() => (open = true)}
	{disabled}
	aria-haspopup="dialog"
	aria-expanded={open}
	aria-label={variant === "field" ? label : undefined}
	title={variant === "inline" ? label : undefined}
>
	<span class="mname">{shown}</span>
	{#if current?.reasoning && level}<span class="chip think" data-level={level}>{level}</span>{/if}
	<span class="chev" class:up={open}><Icon name="chevron-down" /></span>
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
		min-width: 0;
		max-width: 100%;
		font: inherit;
		text-align: left;
	}
	.trigger.field {
		gap: 8px;
		width: 100%;
		height: 42px;
		padding: 0 12px;
		background: var(--bg);
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-sm);
		color: var(--text);
		font-size: var(--fs-md);
		transition: border-color var(--motion-fast) var(--ease-std);
	}
	.trigger.field:hover:not(:disabled) {
		border-color: var(--accent);
	}
	.trigger.inline {
		gap: 6px;
		height: 36px;
		padding: 0 10px;
		border-radius: var(--radius);
		color: var(--text-dim);
		font-size: var(--fs-sm);
		transition:
			background var(--motion-fast) var(--ease-std),
			color var(--motion-fast) var(--ease-std);
	}
	.trigger.inline:hover {
		background: var(--bg-hover);
		color: var(--text);
	}
	.trigger:disabled {
		opacity: 0.5;
	}
	.mname {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.field .mname {
		flex: 1;
	}
	.inline .mname {
		max-width: 38vw;
	}
	.chev {
		display: grid;
		flex: none;
		transition: rotate var(--motion-normal) var(--ease);
	}
	.chev.up {
		rotate: 180deg;
	}
	.chev :global(svg) {
		width: 15px;
		height: 15px;
		stroke: currentColor;
		fill: none;
		stroke-width: 2;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	.field .chev {
		color: var(--text-dim);
	}
</style>
