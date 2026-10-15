<script lang="ts">
	import { t } from "../lib/i18n";
	import { slidingIndicator } from "../lib/sliding-indicator";
	import { formatCombo } from "../lib/keys";
	import Icon from "./Icon.svelte";
	import PipayaLogo from "./PipayaLogo.svelte";
	import AgentBadge from "./AgentBadge.svelte";
	import { app } from "../lib/store.svelte";
	import { dragSource, dropTarget } from "../lib/dnd.svelte";
	import { sidebarBlocks } from "../lib/nav";
	import type { Session } from "../lib/types";
	import { ACTIVITY_LABEL, activityOf, summarize, URGENCY } from "../lib/activity";
	const hint = $derived(app.prefs.bindings.toggleSidebar ? ` (${formatCombo(app.prefs.bindings.toggleSidebar)})` : "");

	const counts = $derived(summarize(app, app.sessions));
	/** What a dragged session is over: an agent (pair up with it), a folder (join), or the bare rail (leave its group). */
	let dropOn = $state<string | null>(null);
	const hover = (key: string) => (pt: unknown) => {
		if (pt) dropOn = key;
		else if (dropOn === key) dropOn = null;
	};
	const top = $derived(URGENCY.find((a) => a !== "idle" && counts[a] > 0));

	/** Loose sessions by directory first, then the groups (each one a folder of its own): the same order as the open sidebar. */
	const blocks = $derived.by(() => {
		const { groups, dirs } = sidebarBlocks(app.sessions, app.groups, undefined, undefined, app.currentDirOrder, app.currentGroupOrder);
		return { groups: groups.filter((b) => b.sessions.length), loose: dirs.flatMap((d) => d.sessions) };
	});
</script>

{#snippet agent(x: Session)}
	{@const st = activityOf(app, x.id)}
	<button
		class="agent"
		class:active={x.id === app.activeId}
		class:over={dropOn === x.id}
		use:dragSource={{ id: x.id }}
		use:dropTarget={{ accepts: (id) => id !== x.id && app.groupOf(id)?.id !== app.groupOf(x.id)?.id, hover: hover(x.id), drop: (id) => void app.groupWith(id, x.id) }}
		onclick={() => app.openSession(x.id)}
		title="{x.title} · {ACTIVITY_LABEL[st]}"
		aria-label="{x.title}, {ACTIVITY_LABEL[st]}"
		aria-current={x.id === app.activeId ? "true" : undefined}
	>
		<AgentBadge id={x.id} state={st} size={22} />
	</button>
{/snippet}

<!-- The folded sidebar: a narrow rail that keeps every active session's agent in view. -->
<aside class="rail" aria-label={t("활성 대화")}>
	<div class="top"><PipayaLogo size={20} /></div>
	<div class="tools">
		<button class="btn-ico" onclick={() => app.sidebar.toggleCollapsed()} aria-label={t("사이드바 펼치기")} title={t("사이드바 펼치기") + hint}><Icon name="sidebar" /></button>
		<button class="btn-ico" onclick={() => app.newChat()} aria-label={t("새 대화")} title={t("새 대화")}><Icon name="plus" /></button>
	</div>

	<ul
	class="agents"
	class:over={dropOn === "rail"}
	use:dropTarget={{ accepts: (id) => !!app.groupOf(id), hover: hover("rail"), drop: (id) => void app.leaveGroup(id) }}
	use:slidingIndicator={{ selector: ".agent.active", radius: "var(--radius-sm)", variant: "ring" }}
>
		{#each blocks.loose as x (x.id)}<li>{@render agent(x)}</li>{/each}
		{#if blocks.groups.length && blocks.loose.length}<li class="sep" role="separator"></li>{/if}
		{#each blocks.groups as b, i (b.group.id)}
			{#if i > 0}<li class="sep" role="separator"></li>{/if}
			<li
				class="folder"
				class:cur={b.group.id === app.activeGroup?.id}
				class:over={dropOn === b.group.id}
				title={b.group.name}
				use:dropTarget={{ hover: hover(b.group.id), drop: (id) => void app.addToGroup(id, b.group.id) }}
			>
				<ul class="members" aria-label={t("그룹 {name}", { name: b.group.name })}>
					{#each b.sessions as x (x.id)}<li>{@render agent(x)}</li>{/each}
				</ul>
			</li>
		{/each}
	</ul>

	<div class="bottom">
		{#if top}
			<span class="sum {top}" title={t("{label} {n}개", { label: ACTIVITY_LABEL[top], n: counts[top] })}>{counts[top]}</span>
		{/if}
		<button class="btn-ico" onclick={() => app.openSettings()} aria-label={t("설정")} title={t("설정")}><Icon name="settings" /></button>
	</div>
</aside>

<style>
	.rail {
		display: flex;
		flex-direction: column;
		align-items: center;
		width: 100%;
		height: 100%;
		background: var(--bg-side);
		border-right: 1px solid var(--border);
		padding-top: var(--sat);
		padding-left: var(--sal);
	}
	.top {
		display: grid;
		place-items: center;
		width: 100%;
		/* same box as the header (44px + hairline) so the two lines meet */
		box-sizing: content-box;
		height: 44px;
		border-bottom: 1px solid var(--border);
		color: var(--text);
	}
	.tools {
		display: flex;
		flex-direction: column;
		gap: 4px;
		width: 100%;
		align-items: center;
		padding: 10px 0;
		border-bottom: 1px solid var(--border);
	}
	.btn-ico {
		display: grid;
		place-items: center;
		width: 36px;
		height: 36px;
		border-radius: var(--radius-sm);
		color: var(--text-dim);
	}
	.btn-ico:hover {
		background: var(--bg-hover);
		color: var(--text);
	}
	.btn-ico :global(svg) {
		width: 19px;
		height: 19px;
		stroke: currentColor;
		fill: none;
		stroke-width: 1.75;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	.agents {
		position: relative;
		margin: 0;
		list-style: none;
		flex: 1;
		min-height: 0;
		width: 100%;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 4px;
		padding: 10px 0;
		overflow-y: auto;
		scrollbar-width: none;
	}
	.agents::-webkit-scrollbar {
		display: none;
	}
	/* a group is a folder: its sessions sit together in one outlined box, set apart from the rest by a divider */
	.folder {
		width: 46px;
		flex: none;
		padding: 3px;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--bg-hover);
	}
	.folder.cur {
		border-color: var(--text-faint);
	}
	.members {
		margin: 0;
		padding: 0;
		list-style: none;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 2px;
	}
	.sep {
		flex: none;
		width: 24px;
		height: 1px;
		margin: 4px 0;
		background: var(--border);
	}
	.agent {
		position: relative;
		display: grid;
		place-items: center;
		flex: none;
		width: 40px;
		height: 40px;
		border-radius: var(--radius-sm);
	}
	.agent,
	.folder {
		-webkit-tap-highlight-color: transparent;
		cursor: grab;
	}
	.agent.over,
	.folder.over {
		background: var(--accent-soft);
		box-shadow: inset 0 0 0 2px var(--accent);
	}
	.agents.over {
		box-shadow: inset 0 0 0 2px var(--accent);
	}
	.agent:hover {
		background: var(--bg-hover);
	}
	.agent.active {
		background: var(--bg-active);
		box-shadow: inset 0 0 0 1px var(--text-faint);
	}
	.agents:global([data-indicator-ready]) .agent.active {
		background: transparent;
		box-shadow: none;
	}
	.bottom {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 6px;
		width: 100%;
		padding: 8px 0 calc(10px + var(--sab));
		border-top: 1px solid var(--border);
	}
	.sum {
		min-width: 22px;
		padding: 1px 6px;
		border-radius: var(--radius-pill);
		font-family: var(--mono);
		font-size: var(--fs-2xs);
		font-weight: 600;
		text-align: center;
		background: var(--accent-soft);
		color: var(--text);
	}
	.sum.working {
		background: var(--info-soft);
		color: var(--info);
	}
	.sum.asking {
		background: var(--warn-soft);
		color: var(--warn);
	}
	.sum.done {
		background: var(--ok-soft);
		color: var(--ok);
	}
	.sum.failed {
		background: var(--danger-soft);
		color: var(--danger);
	}
</style>
