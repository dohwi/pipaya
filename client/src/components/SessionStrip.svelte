<script lang="ts">
	import FilterChip from "./FilterChip.svelte";
	import { t } from "../lib/i18n";
	import { slidingIndicator } from "../lib/sliding-indicator";
	import AgentBadge from "./AgentBadge.svelte";
	import { ACTIVITY_LABEL, activityOf } from "../lib/activity";
	import { panesOf } from "../lib/layout";
	import { app } from "../lib/store.svelte";

	/** Phones: the sessions of the open group as a strip under the header; a tap switches to that session. */
	const group = $derived(app.activeGroup);
	const items = $derived(group ? panesOf(group.layout).map((id) => app.session(id)).filter((s) => !!s) : []);

	let strip: HTMLElement | undefined = $state();
	// keep the focused chip in view when it changes (also when switched from elsewhere)
	$effect(() => {
		app.activeId;
		strip?.querySelector<HTMLElement>('[aria-current="true"]')?.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" });
	});
</script>

{#if group && items.length}
	<nav class="strip" bind:this={strip} aria-label={t("{name} 그룹의 대화", { name: group.name })} use:slidingIndicator={{ selector: ".fchip.on", variant: "accent" }}>
		<span class="name" title={group.name}>{group.name}</span>
		{#each items as x (x.id)}
			{@const st = activityOf(app, x.id)}
			<FilterChip current on={x.id === app.activeId} onclick={() => app.openSession(x.id)} title="{x.title} · {ACTIVITY_LABEL[st]}">
				<AgentBadge id={x.id} state={st} size={16} />
				<span class="t">{x.title}</span>
			</FilterChip>
		{/each}
	</nav>
{/if}

<style>
	.strip {
		position: relative;
		flex: none;
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 6px 10px;
		padding-left: max(10px, var(--sal));
		overflow-x: auto;
		overscroll-behavior-x: contain;
		scrollbar-width: none;
		border-bottom: 1px solid var(--border);
		background: var(--bg-group);
	}
	.strip::-webkit-scrollbar {
		display: none;
	}
	.name {
		flex: none;
		max-width: 28vw;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		padding-right: 4px;
		font-size: var(--fs-2xs);
		font-weight: 700;
		color: var(--text-faint);
	}
	.t {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
