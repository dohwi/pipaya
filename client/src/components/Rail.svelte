<script lang="ts">
	import { t } from "../lib/i18n";
	import { slidingIndicator } from "../lib/sliding-indicator";
	import { formatCombo } from "../lib/keys";
	import Icon from "./Icon.svelte";
	import PipayaMark from "./PipayaMark.svelte";
	import { app } from "../lib/store.svelte";
		import { tilde } from "../lib/format";
	import { sidebarDirs, tabPanes, type DirBlock } from "../lib/nav";
	import type { Server } from "../lib/store.svelte";
	import { ACTIVITY_LABEL, activityOf, URGENCY, type Activity } from "../lib/activity";
	const hint = $derived(app.prefs.bindings.toggleSidebar ? ` (${formatCombo(app.prefs.bindings.toggleSidebar)})` : "");

	interface Section {
		server: Server;
		current: boolean;
		dirs: DirBlock[];
		/** activity of this server's sessions, by id */
		state: Record<string, Activity>;
	}
	/** Every server's active sessions, the open one first-hand and the others as the servers report them. Servers with none are left out. */
	const sections = $derived.by<Section[]>(() =>
		app.servers.flatMap((server) => {
			const current = server.id === app.serverId;
			const ov = app.overview[server.id];
			const sessions = current ? app.sessions : (ov?.sessions ?? []);
			const terminals = current ? app.terminals : (ov?.terminals ?? []);
			if (!sessions.length && !terminals.length) return [];
			const dirs = sidebarDirs(sessions, current ? app.groups : (ov?.groups ?? []), terminals, { dirOrder: app.sidebar.dirOrder[server.id], tabOrder: app.sidebar.tabOrder[server.id] });
			const view = current ? app : { running: ov?.running ?? {}, awaiting: ov?.awaiting ?? {}, unread: {}, failed: {} };
			const state: Record<string, Activity> = {};
			for (const x of sessions) state[x.id] = activityOf(view, x.id);
			return [{ server, current, dirs, state }];
		}),
	);
	const multi = $derived(sections.length > 1);
	const home = (sec: Section) => (sec.current ? app.workspace?.home : app.overview[sec.server.id]?.workspace?.home);
	const segs = (sec: Section, path: string) => tilde(path, home(sec)).split("/").filter(Boolean);
	/** A folder's name: its own, with as many parents as it takes to tell it from the other folders. */
	function dirName(sec: Section, path: string): string {
		const mine = segs(sec, path);
		const others = sec.dirs.filter((d) => d.path !== path).map((d) => segs(sec, d.path));
		for (let k = 1; k < mine.length; k++) {
			const tail = mine.slice(-k).join("/");
			if (!others.some((o) => o.slice(-k).join("/") === tail)) return tail;
		}
		return mine.join("/") || path;
	}
	/** The most urgent thing going on in a folder's tabs. */
	function dirState(sec: Section, d: DirBlock): Activity {
		const ids = d.tabs.flatMap((x) => tabPanes(x));
		return URGENCY.find((a) => ids.some((id) => (sec.state[id] ?? "idle") === a)) ?? "idle";
	}
	/** How many sessions and terminals a folder holds (a group counts its members). */
	const dirCount = (d: DirBlock) => d.tabs.reduce((n, x) => n + tabPanes(x).length, 0);
</script>

{#snippet dirBtn(sec: Section, d: DirBlock)}
	{@const st = dirState(sec, d)}
	{@const name = dirName(sec, d.path)}
	{@const n = dirCount(d)}
	{@const cur = sec.current && app.activeTab?.dir.path === d.path}
	<button
		class="agent dir"
		class:active={cur}
		onclick={() => app.openDir(sec.server.id, d.path)}
		title="{name} · {tilde(d.path, home(sec))}{multi ? ` · ${app.serverLabel(sec.server)}` : ''}{st !== 'idle' ? ` · ${ACTIVITY_LABEL[st]}` : ''}"
		aria-label="{name}{st !== 'idle' ? `, ${ACTIVITY_LABEL[st]}` : ''}"
		aria-current={cur ? "true" : undefined}
	>
		<span class="ini">{[...name][0]?.toUpperCase() ?? "?"}</span>
		{#if n > 0}<span class="cnt {st}">{n > 99 ? "99+" : n}</span>{/if}
	</button>
{/snippet}

<!-- The folded sidebar: a narrow rail with one button per working folder; its tabs are in the tab bar. -->
<aside class="rail" aria-label={t("작업 폴더")}>
	<div class="top"><PipayaMark color size={26} /></div>
	<div class="tools">
		<button class="btn-ico" onclick={() => app.sidebar.toggleCollapsed()} aria-label={t("사이드바 펼치기")} title={t("사이드바 펼치기") + hint}><Icon name="sidebar" /></button>
		<button class="btn-ico" onclick={() => void app.startChat()} aria-label={t("새 대화")} title={t("새 대화")}><Icon name="plus" /></button>
	</div>

	<ul
	class="agents"
	use:slidingIndicator={{ selector: ".agent.active", radius: "var(--radius-sm)", variant: "ring" }}
>
		{#each sections as sec, si (sec.server.id)}
			{#if si > 0}<li class="sep srv" role="separator" title={app.serverLabel(sec.server)}></li>{/if}
			{#each sec.dirs as d (d.path)}
				<li>{@render dirBtn(sec, d)}</li>
			{/each}
		{/each}
	</ul>

	<div class="bottom">
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
	.sep {
		flex: none;
		width: 28px;
		height: 2px;
		margin: 6px 0;
		border-radius: 1px;
		background: color-mix(in srgb, var(--text-faint) 55%, transparent);
	}
	/* between two servers: a longer, stronger line than the one between workdirs */
	.sep.srv {
		width: 36px;
		margin: 10px 0;
		background: var(--text-faint);
	}
	.agent {
		position: relative;
		display: grid;
		place-items: center;
		flex: none;
		width: 44px;
		height: 44px;
		border-radius: var(--radius-sm);
	}
	/* a folder: just its first letter; the button's own shape (hover, selected ring) is the only box */
	.agent.dir {
		color: var(--text-faint);
	}
	.ini {
		font-size: var(--fs-xl);
		font-weight: 700;
		line-height: 1;
	}
	.agent.dir:hover,
	.agent.dir.active {
		color: var(--text);
	}
	/* the open folder: a filled tile and an edge bar, so it reads as selected at a glance */
	.agent.dir.active {
		background: var(--accent-soft);
	}
	.agent.dir.active::before {
		content: "";
		position: absolute;
		left: -6px;
		top: 9px;
		bottom: 9px;
		width: 3px;
		border-radius: 0 2px 2px 0;
		background: var(--text);
	}
	.agents:global([data-indicator-ready]) .agent.dir.active {
		background: var(--accent-soft);
	}
	/* one badge: the session count, tinted by the folder's most urgent state */
	.cnt {
		position: absolute;
		top: 0;
		right: 0;
		min-width: 12px;
		height: 14px;
		padding: 0 3px;
		box-sizing: content-box;
		border: 2px solid var(--bg-side);
		border-radius: var(--radius-pill);
		background: var(--bg-active);
		color: var(--text-dim);
		font-family: var(--mono);
		font-size: 9px;
		font-weight: 600;
		line-height: 14px;
		text-align: center;
		font-variant-numeric: tabular-nums;
	}
	.agent.dir.active .cnt.idle {
		background: var(--text);
		color: var(--bg-side);
	}
	.cnt.working { background: var(--info); color: var(--bg-side); animation: cnt-pulse 1.8s ease-in-out infinite; }
	.cnt.asking { background: var(--warn); color: var(--bg-side); }
	.cnt.done { background: var(--ok); color: var(--bg-side); }
	.cnt.failed { background: var(--danger); color: var(--bg-side); }
	@keyframes cnt-pulse {
		50% { opacity: 0.55; }
	}
	@media (prefers-reduced-motion: reduce) {
		.cnt.working { animation: none; }
	}
	.agent {
		-webkit-tap-highlight-color: transparent;
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
</style>
