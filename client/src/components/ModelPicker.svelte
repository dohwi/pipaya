<script lang="ts">
	import { t } from "../lib/i18n";
	import Icon from "./Icon.svelte";
	import ModelPickerModal from "./ModelPickerModal.svelte";
	import { app } from "../lib/store.svelte";
	import { getPane } from "../lib/pane";

	/** The composer's model button: shows this chat's model and strength, and opens the shared picker dialog. */
	let open = $state(false);

	const pane = getPane();
	const eff = $derived(app.effectiveOf(pane.id));
	const model = $derived(app.effectiveModelOf(pane.id));

	let lastTick = app.modelPickerTick;
	$effect(() => {
		const tick = app.modelPickerTick;
		if (tick === lastTick) return;
		lastTick = tick;
		if (pane.focused) open = true;
	});

	function pick(c: { provider: string; model: string; thinkingLevel?: import("../lib/types").ThinkingLevel } | null) {
		if (!c) return;
		// The model and its strength are one choice: send both together so the chat never holds a mismatched pair.
		void app.configure({ provider: c.provider, model: c.model, ...(c.thinkingLevel ? { thinkingLevel: c.thinkingLevel } : {}) }, pane.id);
	}
</script>

<button type="button" class="trigger" onclick={() => (open = true)} aria-expanded={open} aria-haspopup="dialog">
	<span class="mname">{model?.name ?? (eff.model || t("모델 없음"))}</span>
	{#if model?.reasoning}<span class="chip think" data-level={eff.thinkingLevel}>{eff.thinkingLevel}</span>{/if}
	<Icon name="chevron-down" />
</button>

{#if open}
	<ModelPickerModal
		models={app.models}
		providers={app.providers}
		value={{ provider: eff.provider, model: eff.model }}
		level={eff.thinkingLevel}
		favs={app.favModels}
		onfav={(p, id) => app.toggleFavModel(p, id)}
		onmanage={() => (app.connectionsOpen = true)}
		onpick={pick}
		onclose={() => (open = false)}
	/>
{/if}

<style>
	.trigger {
		display: flex;
		align-items: center;
		gap: 6px;
		height: 36px;
		padding: 0 10px;
		border-radius: var(--radius);
		color: var(--text-dim);
		font-size: var(--fs-sm);
		max-width: 100%;
		min-width: 0;
		transition: background var(--motion-fast) var(--ease-std);
	}
	.trigger:hover {
		background: var(--bg-hover);
		color: var(--text);
	}
	.mname {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		max-width: 38vw;
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
	}
</style>
