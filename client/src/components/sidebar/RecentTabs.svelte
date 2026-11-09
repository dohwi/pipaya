<script lang="ts">
	import { collapseIn, collapseOut } from "../../lib/motion";
	import { app } from "../../lib/store.svelte";
	import { t } from "../../lib/i18n";
	import { recentKey, type RecentTab } from "../../lib/recent-tabs.svelte";
	import { sessionTitle } from "../../lib/session-title";
	import type { SidebarNode } from "../../lib/sidebar-ctx";
	import AgentBadge from "../AgentBadge.svelte";
	import Icon from "../Icon.svelte";

	/**
	 * A folder's recently used tabs: the conversations closed in the last hour, hanging under the folder's tabs the way a
	 * split tab's panes hang under it. Folded by default (the count says how many), one click resumes and shows a
	 * conversation. A shell cannot be opened again (its scrollback and its processes are gone), so only conversations are
	 * listed. The whole thing is the user's to switch off (설정 → 일반 → 최근 사용 탭).
	 */
	let { n, path }: { n: SidebarNode; path: string } = $props();

	const key = $derived(recentKey(n.server.id, path));
	const open = $derived(app.sidebar.recentOpen.includes(key));
	const rows = $derived(app.prefs.recentTabs ? app.recent.forDir(n.server.id, path).filter((x) => x.kind === "session") : []);

	/** Open it again on its own server (the store switches, resumes and shows it); it leaves the list. */
	function reopen(x: RecentTab) {
		app.recent.drop(x.id);
		app.reopen(x.serverId, x.id);
	}
</script>

{#if rows.length}
	<div class="recent grp" data-part="sidebar.recent" data-server={n.server.id}>
		<button class="recenttoggle" class:folded={!open} onclick={() => app.sidebar.toggleRecentOpen(key)} aria-expanded={open} title={open ? t("최근 사용 탭 접기") : t("최근 사용 탭 펼치기")}>
			<span class="chev" class:folded={!open}><Icon name="chevron-down" /></span>
			<span class="ricon"><Icon name="clock" /></span>
			<span class="rname">{t("최근 사용 탭")}</span>
			{#if !open}<span class="cbadge" title={t("{n}개", { n: rows.length })}>{rows.length}</span>{/if}
		</button>
		{#if open}
			<div class="members fold" in:collapseIn out:collapseOut>
				{#each rows as x (x.id)}
					<div class="item nested member recentrow">
						<span class="branch" aria-hidden="true"></span>
						<button class="open wide" onclick={() => reopen(x)} title={t("{title} · 눌러서 다시 열기", { title: sessionTitle(x.title) })}>
							<span class="lead"><AgentBadge id={x.id} server={x.serverId} size={16} /></span>
							<span class="title">{sessionTitle(x.title)}</span>
						</button>
					</div>
				{/each}
			</div>
		{/if}
	</div>
{/if}

<style>
	.recent {
		position: relative;
		margin: 1px 0; /* 1px between rows, like the tab rows */
	}
	/* the same box as a tab row: 4px in on the left, the highlight running 8px past the content on the right, so its chevron
	   centres on the folder icon's column (x 48) and the clock on the tab icon's (x 68) */
	.recenttoggle {
		position: relative;
		display: flex;
		align-items: center;
		gap: 4px; /* the same gap a split tab's header uses between its chevron and its icon */
		width: calc(100% + 4px);
		height: 32px; /* every row is 32px tall */
		margin: 0 -8px 0 4px;
		/* 48 = the 20px count on x 236 plus the 8px gap to it: the name ends where the count starts */
		padding: 0 48px 0 21px; /* as `.gfold`: the 14px chevron centres on x 49, one step in from a folder's */
		border-radius: var(--radius-sm);
		text-align: left;
		font-size: var(--fs-xs);
		color: var(--text-faint);
	}
	.recenttoggle:hover {
		color: var(--text);
		background: var(--bg-hover);
	}
	/* the clock sits in a 16px box like a split tab's book icon (centre x 68), so the name starts where a split tab's does */
	.ricon {
		display: grid;
		place-items: center;
		flex: none;
		width: 16px;
		height: 16px;
	}
	.ricon :global(svg) {
		width: 14px;
		height: 14px;
		stroke-width: 1.9;
	}
	.rname {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		line-height: 20px; /* a whole-pixel line box, centred by the 32px row */
	}
	/* the count takes the column of the button that belongs there: x 236 on touch, x 256 on a mouse (nothing else is there).
	   Positioned out of the flow so the 48px the name reserves does not move it */
	.recenttoggle :global(.cbadge) {
		position: absolute;
		inset-block: 0;
		margin-block: auto; /* 18px badge centred in the 32px row */
		right: 28px; /* the toggle's end is 8px past the row's: 28 + 8 puts the count's centre on x 236 */
	}
	@media (hover: hover) {
		.recenttoggle :global(.cbadge) {
			right: 8px; /* the highlight's extra 8px: the centre stays on x 256 */
		}
	}
	/* a closed tab reads as a pane of a split tab: dimmed, and only the open row lights up */
	.recentrow {
		opacity: 0.75;
	}
	.recentrow:hover,
	.recentrow:has(:focus-visible) {
		opacity: 1;
	}
</style>
