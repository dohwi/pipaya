<script lang="ts">
	import { collapseIn, collapseOut } from "../../lib/motion";
	import { app } from "../../lib/store.svelte";
	import { tilde } from "../../lib/format";
	import { t } from "../../lib/i18n";
	import { shortName } from "../../lib/sidebar-model";
	import { type RecentTab } from "../../lib/recent-tabs.svelte";
	import { sessionTitle } from "../../lib/session-title";
	import AgentBadge from "../AgentBadge.svelte";
	import Icon from "../Icon.svelte";

	/**
	 * The tabs closed in the last hour, above the servers: one click resumes a conversation and shows it, newest first, at
	 * most three. A shell cannot be opened again (its scrollback and its processes are gone), so only conversations are
	 * listed. The whole section is the user's to switch off (설정 → 일반 → 최근 사용 탭).
	 */
	const rows = $derived(app.prefs.recentTabs ? app.recent.visible.filter((x) => x.kind === "session") : []);
	/** Where it worked, as a folder's label reads it (`work/app`); each server has its own home. */
	const where = (x: RecentTab) => shortName(x.cwd, app.links[x.serverId]?.workspace?.home);
	/** The whole path, for the tooltip. */
	const full = (x: RecentTab) => tilde(x.cwd, app.links[x.serverId]?.workspace?.home);

	/** Open it again on its own server (the store switches, resumes and shows it); it leaves the list. */
	function reopen(x: RecentTab) {
		app.recent.drop(x.id);
		app.reopen(x.serverId, x.id);
	}
</script>

{#if rows.length}
	<section class="recent" data-part="sidebar.recent" in:collapseIn out:collapseOut>
		<div class="recenthead">
			<span class="ricon"><Icon name="clock" /></span>
			<span class="rlabel">{t("최근 사용 탭")}</span>
		</div>
		{#each rows as x (x.id)}
			<button class="item rrow" onclick={() => reopen(x)} title={`${sessionTitle(x.title)}\n${full(x)}`}>
				<span class="lead"><AgentBadge id={x.id} server={x.serverId} size={16} /></span>
				<span class="title">{sessionTitle(x.title)}</span>
				<span class="rwhere mono">{where(x)}</span>
			</button>
		{/each}
	</section>
{/if}

<style>
	/* a band like a server's, so it reads as one more block of the tree (the list's 8px inset, 8px to the first server) */
	.recent {
		display: flex; /* a column, so a row stretches to the card's content line like a tab row does (a button does not stretch on its own) */
		flex-direction: column;
		margin: 0 8px 8px;
		padding: 0 12px 4px 8px; /* the same inner box as a server band: the first column 12 from the card's left, the last 12 from its right */
		background: var(--band);
		border: 1px solid color-mix(in srgb, var(--text) 8%, transparent);
		border-radius: var(--radius);
	}
	/* the head sits on the folder rows' columns: a 14px icon where a folder's icon is, the label where folder names start */
	.recenthead {
		display: flex;
		align-items: center;
		gap: 6px; /* alignment, not spacing: the same column step as `.dirtoggle` */
		height: 32px;
		padding: 0 4px 0 24px; /* the clock sits where a folder's icon does (x 48), so the label starts on the folder names' line (x 61) */
		color: var(--text-faint);
	}
	.ricon {
		display: grid;
		flex: none;
		width: 14px;
		height: 14px;
	}
	.ricon :global(svg) {
		width: 14px;
		height: 14px;
		stroke-width: 1.9;
	}
	.rlabel {
		flex: none;
		font-size: var(--fs-sm);
		font-weight: 600;
		line-height: 20px; /* a whole-pixel line box, centred by the 32px row */
	}
	/* a closed tab: the agent's logo where a tab's icon is (x 68), its title, then where it worked, dim at the end */
	.rrow {
		/* no `width`: as a flex item of the column above it stretches to the card's content line, and `.item`'s own -8px margin runs its highlight past it, exactly like a tab row's */
		gap: 4px;
		min-height: 32px;
		padding-left: 39px; /* the tab icon's column, as `.item.nested .open` */
	}
	.rwhere {
		flex: none;
		max-width: 40%; /* the title keeps the room: the path gives way first */
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: var(--fs-2xs);
		color: var(--text-faint);
	}
</style>
