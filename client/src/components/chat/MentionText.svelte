<script lang="ts">
	import { t } from "../../lib/i18n";
	import { app } from "../../lib/store.svelte";
	import { splitMentions } from "../../lib/composer-text";
	import { groupHandle } from "../../lib/peers";
	import { nameInLang } from "../../lib/member-names";

	/**
	 * Message text with each `@name` of a known session or group drawn as a chip in the composer's mention colour, so a
	 * sent message reads the way it was typed. A session chip opens that session; a group chip is only a label.
	 */
	let { text }: { text: string } = $props();

	// Every way a name may be written (stored Korean and the romanized display form) → the session it names.
	const sessions = $derived.by(() => {
		const map = new Map<string, string>();
		for (const s of app.sessions) {
			if (!s.name) continue;
			map.set(s.name.toLowerCase(), s.id);
			map.set(nameInLang(s.name).toLowerCase(), s.id);
		}
		return map;
	});
	const groups = $derived(app.groups.map((g) => groupHandle(g.name)).filter(Boolean));
	const parts = $derived(splitMentions(text, [...sessions.keys(), ...groups]));
</script>

{#each parts as p, i (i)}{#if p.name && sessions.has(p.name.toLowerCase())}{@const id = sessions.get(p.name.toLowerCase())!}<button type="button" class="mention" title={t("{name} 대화 열기", { name: p.text })} onclick={() => void app.openAny(id)}>{p.text}</button>{:else if p.name}<span class="mention">{p.text}</span>{:else}{p.text}{/if}{/each}

<style>
	/* The composer's @mention mark (app.css --mark-mention), readable on its own: tinted fill and text, no outline. */
	.mention {
		display: inline;
		padding: 0 4px;
		border-radius: var(--radius-xs);
		background: color-mix(in srgb, var(--mark-mention) 18%, transparent);
		color: var(--mark-mention);
		font: inherit;
		font-weight: 600;
		-webkit-box-decoration-break: clone;
		box-decoration-break: clone;
	}
	button.mention {
		cursor: pointer;
	}
	button.mention:hover {
		background: color-mix(in srgb, var(--mark-mention) 30%, transparent);
	}
</style>
