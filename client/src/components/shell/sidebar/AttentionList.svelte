<script lang="ts">
	import { sessionTitle } from "../../../lib/session-title";
	import { t } from "../../../lib/i18n";
	import { ACTIVITY_LABEL } from "../../../lib/activity";
	import { needsLook } from "../../../lib/projects";
	import { app } from "../../../lib/store.svelte";
	import { getSidebarCtx, type SidebarNode } from "../../../lib/sidebar-ctx";
	import Icon from "../../ui/Icon.svelte";
	import AgentBadge from "../AgentBadge.svelte";

	/**
	 * "확인 필요": the conversations of this server waiting on the user (a question, a failure, a finished run not looked at),
	 * at the top of its card. Folders start folded, so without this a waiting conversation would only tint a count. A copy:
	 * each one stays in its folder too, and leaves this list once it was looked at (or answered).
	 */
	let { n }: { n: SidebarNode } = $props();

	const sb = getSidebarCtx();
	const rows = $derived(needsLook(n.dirs, (id) => sb.stateOfId(n, id), (id) => app.links[n.server.id]?.sessionById.get(id)));
</script>

{#if rows.length}
	<section class="attn" aria-label={t("확인 필요")}>
		<div class="ahead"><span class="aicon"><Icon name="alert" /></span>{t("확인 필요")}<span class="acount">{rows.length}</span></div>
		{#each rows as r (r.session.id)}
			<button
				class="arow"
				class:active={n.current && r.session.id === app.activeId}
				onclick={() => app.openIn(n.server.id, { session: r.session.id })}
				onpointerdown={() => app.prefetchChat(n.server.id, r.session.id)}
				title={`${sessionTitle(r.session.title)} · ${ACTIVITY_LABEL[r.state]}`}
			>
				<span class="lead"><AgentBadge id={r.session.id} server={n.server.id} state={r.state} size={16} /></span>
				<span class="atitle">{sessionTitle(r.session.title)}</span>
				<span class="astate {r.state}">{ACTIVITY_LABEL[r.state]}</span>
			</button>
		{/each}
	</section>
{/if}

<style>
	.attn {
		margin: 4px 0 0;
		padding-bottom: 4px;
		border-bottom: 1px solid color-mix(in srgb, var(--text) 8%, transparent); /* the band's own hairline tone */
	}
	/* the heading sits on the folder rows' columns: the icon on x 48, the text where a folder's name starts */
	.ahead {
		display: flex;
		align-items: center;
		gap: 6px; /* alignment, not spacing: the 14px icon + 6 puts the label where a folder name starts, as in .dirtoggle */
		height: 24px;
		padding-left: 24px; /* alignment: the icon centres on x 48 (.dirtoggle's 4 + the chevron's 14 + 6) */
		font-size: var(--fs-2xs);
		font-weight: 600;
		line-height: 16px; /* whole-pixel line box */
		color: var(--warn);
	}
	.aicon {
		display: grid;
		flex: none;
		width: 14px;
	}
	.aicon > :global(svg) {
		width: 14px;
		height: 14px;
		stroke-width: 2;
	}
	.acount {
		margin-left: auto;
		min-width: 20px; /* the count column of a folded row (x 256) */
		text-align: center;
		font-variant-numeric: tabular-nums;
		color: var(--text-faint);
	}
	.arow {
		position: relative;
		z-index: 2; /* above the sliding selection wash, like the tab rows' text */
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		height: 32px; /* every row is 32px tall */
		padding: 0 0 0 23px; /* alignment: the 16px logo centres on x 48, the folder icon's column */
		border-radius: var(--radius-control);
		text-align: left;
		color: var(--text-dim);
		transition: background var(--motion-fast) var(--ease-std);
	}
	@media (hover: hover) {
		.arow:hover {
			background: var(--bg-hover);
			color: var(--text);
		}
	}
	.arow.active {
		color: var(--text);
	}
	.lead {
		display: grid;
		place-items: center;
		flex: none;
		width: 16px;
		height: 16px;
	}
	.atitle {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: var(--fs-sm);
		line-height: 20px; /* whole-pixel line box */
	}
	.astate {
		flex: none;
		padding-right: 4px; /* the text ends 8px inside the "+" column's right edge, like a count */
		font-size: var(--fs-2xs);
		line-height: 16px; /* whole-pixel line box */
	}
	.astate.asking { color: var(--warn); }
	.astate.failed { color: var(--danger); }
	.astate.done { color: var(--ok); }
	@media (pointer: coarse) {
		.arow {
			height: 40px; /* touch rows are 40px, like .dirtoggle and .item */
		}
	}
</style>
