<script lang="ts">
	import { t } from "../lib/i18n";
	import ModelField from "./ModelField.svelte";
	import { app } from "../lib/store.svelte";
	import { getPane } from "../lib/pane";
	import type { ThinkingLevel } from "../lib/types";

	/** The composer's model button: the shared ModelField, wired to this chat's model and the open-picker shortcut. */
	let open = $state(false);

	const pane = getPane();
	const eff = $derived(app.effectiveOf(pane.id));

	let lastTick = app.modelPickerTick;
	$effect(() => {
		const tick = app.modelPickerTick;
		if (tick === lastTick) return;
		lastTick = tick;
		if (pane.focused) open = true;
	});

	function pick(c: { provider: string; model: string; thinkingLevel?: ThinkingLevel } | null) {
		if (!c) return;
		// The model and its strength are one choice: send both together so the chat never holds a mismatched pair.
		void app.configure({ provider: c.provider, model: c.model, ...(c.thinkingLevel ? { thinkingLevel: c.thinkingLevel } : {}) }, pane.id);
	}
</script>

<ModelField
	variant="inline"
	bind:open
	models={app.models}
	providers={app.providers}
	value={eff.model ? { provider: eff.provider, model: eff.model } : null}
	level={eff.thinkingLevel}
	favs={app.favModels}
	label={t("모델 설정")}
	onfav={(p, id) => app.toggleFavModel(p, id)}
	onmanage={() => (app.openSettings("agent"))}
	onpick={pick}
/>
