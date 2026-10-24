<script lang="ts">
	import { t } from "../lib/i18n";
	import { slidingIndicator } from "../lib/sliding-indicator";
	import { dragScroll } from "../lib/drag-scroll";
	import AgentBadge from "./AgentBadge.svelte";
	import Icon from "./Icon.svelte";
	import { ACTIVITY_LABEL, activityOf } from "../lib/activity";
	import { panesOf } from "../lib/layout";
	import { app } from "../lib/store.svelte";
	import { viewport } from "../lib/viewport.svelte";

	/** Phones: the sessions of the open group as a strip under the header; a tap switches to that session. */
	const group = $derived(app.activeGroup);
	const items = $derived(group ? panesOf(group.layout).map((id) => app.session(id) ?? app.terminal(id)).filter((s) => !!s) : []);

	let strip: HTMLElement | undefined = $state();
	// keep the focused chip in view when it changes (also when switched from elsewhere)
	$effect(() => {
		app.activeId;
		strip?.querySelector<HTMLElement>('[aria-current="true"]')?.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" });
	});
</script>

{#if group && items.length}
	<nav class="strip" bind:this={strip} aria-label={t("{name} 그룹의 대화", { name: group.name })} use:slidingIndicator={{ selector: ".chip.on", radius: "var(--radius-sm)" }} use:dragScroll>
		{#if viewport.narrow}
			<button class="back" onclick={() => (viewport.backedOut = group.id)} aria-label={t("탭 목록으로")} title={t("탭 목록으로")}><Icon name="chevron-left" /></button>
		{/if}
		<span class="name" title={group.name}>{group.name}</span>
		{#each items as x (x.id)}
			{@const st = app.terminal(x.id) ? "idle" : activityOf(app, x.id)}
			<button class="chip" class:on={x.id === app.activeId} aria-current={x.id === app.activeId ? "true" : undefined} onclick={() => app.openSession(x.id)} title="{x.title} · {ACTIVITY_LABEL[st]}">
				{#if app.terminal(x.id)}<span class="tico"><Icon name="terminal" /></span>{:else}<AgentBadge id={x.id} state={st} size={16} />{/if}
				<span class="t">{x.title}</span>
			</button>
		{/each}
	</nav>
{/if}

<style>
	/* same shape as the tab bar above it: rounded rectangles, a soft fill for the selection */
	.strip {
		position: relative;
		flex: none;
		display: flex;
		align-items: center;
		gap: 2px;
		height: 38px;
		padding: 0 6px 0 max(6px, var(--sal));
		padding-right: max(6px, var(--sar));
		overflow-x: auto;
		overscroll-behavior-x: contain;
		scrollbar-width: none;
		border-bottom: 1px solid var(--border);
		background: var(--bg-group);
	}
	/* going into a group: the tab opens up into the group's sessions */
	.strip {
		animation: into-group var(--motion-fast) var(--ease-std);
	}
	@keyframes into-group {
		from {
			opacity: 0;
			transform: translateX(12px);
		}
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
		padding: 0 6px 0 2px;
		font-size: var(--fs-sm);
		font-weight: 700;
		color: var(--text);
	}
	.back {
		flex: none;
		display: grid;
		place-items: center;
		width: 28px;
		height: 28px;
		border-radius: var(--radius-sm);
		color: var(--text-dim);
	}
	.back:hover {
		background: var(--bg-hover);
		color: var(--text);
	}
	.back :global(svg) {
		width: 16px;
		height: 16px;
		stroke-width: 2;
	}
	.tico {
		display: inline-grid;
	}
	.tico :global(svg) {
		width: 14px;
		height: 14px;
		stroke-width: 1.9;
	}
	.chip {
		position: relative;
		z-index: 1;
		flex: none;
		display: inline-flex;
		align-items: center;
		gap: 6px;
		height: 28px;
		max-width: 46vw;
		padding: 0 9px;
		border-radius: var(--radius-sm);
		color: var(--text-dim);
		font-size: var(--fs-sm);
		white-space: nowrap;
		transition: background var(--motion-fast) var(--ease-std);
	}
	.chip:hover {
		background: var(--bg-hover);
		color: var(--text);
	}
	.chip.on {
		background: var(--bg-active);
		color: var(--text);
		font-weight: 600;
	}
	.strip:global([data-indicator-ready]) .chip.on {
		background: transparent;
	}
	.t {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
