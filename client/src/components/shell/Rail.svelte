<script lang="ts">
	import { tick } from "svelte";
	import { t } from "../../lib/i18n";
	import { liveNext } from "../../lib/minute-clock.svelte";
	import { slidingIndicator } from "../../lib/sliding-indicator";
	import { formatCombo } from "../../lib/keys";
	import IconButton from "../ui/IconButton.svelte";
	import PipayaMark from "../ui/PipayaMark.svelte";
	import Pin from "../ui/Pin.svelte";
	import { updater } from "../../lib/updater.svelte";
	import { serverUpdater } from "../../lib/server-update.svelte";
	import { extensionUpdates } from "../../lib/extension-updates.svelte";
	import { app } from "../../lib/store.svelte";
	import { tilde } from "../../lib/format";
	import { tabPanes, type DirBlock } from "../../lib/nav";
	import type { Server } from "../../lib/store.svelte";
	import { ACTIVITY_LABEL, activityOf, URGENCY, type Activity } from "../../lib/activity";
	import { asWorkdir, connectionState, newMenuEntries, orderServers, shortName, unreachable } from "../../lib/sidebar-model";
	import { platformName } from "../../lib/terminal";
	import { openContextMenu, closeContextMenu } from "../../lib/context-menu";
	import { pressMenu, type Point } from "../../lib/press-menu";
	import Icon from "../ui/Icon.svelte";
	const hint = $derived(app.prefs.bindings.toggleSidebar ? ` (${formatCombo(app.prefs.bindings.toggleSidebar)})` : "");
	/** Desktop expand button: hand keyboard focus to the expanded sidebar's fold button so it doesn't fall to body. */
	function expandSidebar(e: MouseEvent) {
		app.sidebar.toggleCollapsed();
		if (e.detail === 0) void tick().then(() => document.querySelector<HTMLElement>("[data-part=sidebar] .foldbtn")?.focus({ preventScroll: true }));
	}
	// the bottom of the rail: the same places as the sidebar's bottom (graph view, scheduled tasks, settings), as icons
	const graphTip = $derived(app.prefs.bindings.openGraph ? `${t("그래프 뷰")} (${formatCombo(app.prefs.bindings.openGraph)})` : t("그래프 뷰"));
	const scheduled = $derived(app.schedules.all(app.serverId));
	const schedulesShown = $derived(!!app.serverId && app.schedules.supported(app.serverId));
	const schedulesTip = $derived(scheduled.next === null ? t("예약 작업") : `${t("예약 작업")} · ${t("다음 실행: {when}", { when: liveNext(scheduled.next) })}`);
	const problems = $derived(app.problemCount);
	const alertTone = $derived(problems ? "danger" : app.compat === "ok" ? "ok" : "warn");
	const settingsAlert = $derived(problems ? t("설정 문제 {n}", { n: problems }) : app.compat !== "ok" ? t("업데이트 필요") : updater.visible ? t("업데이트 있음") : serverUpdater.available ? t("서버 업데이트 있음") : "");
	const settingsTip = $derived(settingsAlert ? `${t("설정")} · ${settingsAlert}` : extensionUpdates.any ? `${t("설정")} · ${t("업데이트 있음")}` : t("설정"));

	interface Section {
		server: Server;
		current: boolean;
		dirs: DirBlock[];
		/** activity of this server's sessions, by id */
		state: Record<string, Activity>;
	}
	/**
	 * Every server's active sessions, each read live from its own server, in the sidebar's server order. Servers with none
	 * are left out, and so are the unreachable ones: their list is only the copy last seen, and the sidebar folds and locks
	 * them, so the rail does not offer their folders either.
	 */
	const sections = $derived.by<Section[]>(() =>
		orderServers(
			app.servers.map((server) => {
				const link = app.links[server.id];
				return { server, local: server.local, state: link ? connectionState(link.net) : ("checking" as const) };
			}),
		).flatMap(({ server, state: conn }) => {
			if (unreachable(conn)) return [];
			const current = server.id === app.serverId;
			const ov = app.links[server.id]?.data;
			const sessions = ov?.sessions ?? [];
			const terminals = ov?.terminals ?? [];
			if (!sessions.length && !terminals.length) return [];
			const dirs = app.dirsByServer[server.id] ?? [];
			const state: Record<string, Activity> = {};
			if (ov) for (const x of sessions) state[x.id] = activityOf(ov, x.id);
			return [{ server, current, dirs, state }];
		}),
	);
	const multi = $derived(sections.length > 1);
	const home = (sec: Section) => app.links[sec.server.id]?.workspace?.home;
	const dirName = (sec: Section, path: string) => app.sidebar.dirName(sec.server.id, path) ?? shortName(path, home(sec));
	/** The most urgent thing going on in a folder's tabs. */
	function dirState(sec: Section, d: DirBlock): Activity {
		const ids = d.tabs.flatMap((x) => tabPanes(x));
		return URGENCY.find((a) => ids.some((id) => (sec.state[id] ?? "idle") === a)) ?? "idle";
	}
	/** Right click / long press on a folder: start a conversation or a terminal there. */
	function dirMenu(pt: Point, sec: Section, d: DirBlock) {
		const root = app.links[sec.server.id]?.workspace?.root;
		const workdir = asWorkdir(d.path, root);
		const os = app.links[sec.server.id]?.terminalSupport?.platform;
		openContextMenu(pt, `rail:${d.path}`, newMenuEntries(platformName(os), {
			chat: () => app.openIn(sec.server.id, { workdir }),
			terminal: () => app.openIn(sec.server.id, { workdir, terminal: true }),
		}));
		return closeContextMenu;
	}
	/** How many of a folder's sessions have something going on (working, asking, done, failed). Idle ones are not counted, so a quiet folder shows no badge. */
	const dirCount = (sec: Section, d: DirBlock) => d.tabs.reduce((n, x) => n + tabPanes(x).filter((id) => (sec.state[id] ?? "idle") !== "idle").length, 0);
</script>

{#snippet dirBtn(sec: Section, d: DirBlock)}
	{@const st = dirState(sec, d)}
	{@const name = dirName(sec, d.path)}
	{@const n = dirCount(sec, d)}
	{@const cur = !app.graphOpen && sec.current && app.activeTab?.dir.path === d.path}
	<button
		class="agent dir"
		class:active={cur}
		onclick={() => app.openDir(sec.server.id, d.path)}
		use:pressMenu={(pt) => dirMenu(pt, sec, d)}
		title="{name} · {tilde(d.path, home(sec))}{multi ? ` · ${app.serverLabel(sec.server)}` : ''}{st !== 'idle' ? ` · ${ACTIVITY_LABEL[st]}` : ''}"
		aria-label="{name}{st !== 'idle' ? `, ${ACTIVITY_LABEL[st]}` : ''}"
		aria-current={cur ? "true" : undefined}
	>
		<span class="ini">{[...name][0]?.toUpperCase() ?? "?"}</span>
		{#if n > 0}<Pin count={n} tone={st === "working" ? "info" : st === "asking" ? "warn" : st === "done" ? "ok" : "danger"} pulse={st === "working"} />{/if}
	</button>
{/snippet}

<!-- The folded sidebar: a narrow rail with one button per working folder; its tabs are in the tab bar. -->
<aside class="rail" data-part="rail" aria-label={t("작업 폴더")}>
	<div class="top" data-logo-frame><PipayaMark tone="color" size={26} /></div>
	<div class="tools">
		<IconButton icon="sidebar" size="sm" label={t("사이드바 펼치기")} title={t("사이드바 펼치기") + hint} onclick={expandSidebar} />
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
		<!-- the graph view is a place of its own: while it is open, its button is the selected one (no folder is) -->
		<button class="nav tap" class:on={app.graphOpen} onclick={() => app.toggleGraph()} aria-label={t("그래프 뷰")} aria-pressed={app.graphOpen} aria-current={app.graphOpen ? "page" : undefined} title={graphTip}><Icon name="fork" /></button>
		{#if schedulesShown}
			<button class="nav tap" onclick={() => (app.schedulesDialog = true)} aria-label={t("예약 작업")} title={schedulesTip}>
				<Icon name="clock" />
				{#if scheduled.count}<span class="cnt"><span class="cbadge">{scheduled.count}</span></span>{/if}
			</button>
		{/if}
		<button class="nav tap" onclick={() => app.openSettings()} aria-label={t("설정")} title={settingsTip}>
			<Icon name="settings" />
			{#if settingsAlert || extensionUpdates.any}<Pin tone={alertTone} label={settingsAlert || t("업데이트 있음")} />{/if}
		</button>
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
		flex: none;
		width: 100%;
		/* same box as the header (44px + hairline) so the two lines meet */
		box-sizing: content-box;
		height: 44px;
		border-bottom: 1px solid var(--border);
		color: var(--text);
	}
	/* the same band as the tab strip beside it (38px with its hairline), so the two lines meet; a 32px button fits it */
	.tools {
		display: grid;
		place-items: center;
		flex: none;
		width: 100%;
		box-sizing: content-box;
		height: 37px; /* + the 1px hairline = the strip's 38px */
		border-bottom: 1px solid var(--border);
	}
	.tools :global(.iconbtn:focus-visible) {
		outline-offset: -2px;
	}
	@media (min-width: 601px) {
		:global(:root:has(main > [data-part="tabbar"])) .top,
		:global(:root:has(main > [data-part="tabbar"])) .tools {
			border-bottom-color: var(--tabbar-line); /* the strip's own hairline colour, so the line runs on unbroken */
		}
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
		padding: 8px 0;
		overflow-y: auto;
		overflow-x: hidden;
		scrollbar-width: none;
	}
	.agents::-webkit-scrollbar {
		display: none;
	}
	.sep {
		flex: none;
		width: 28px;
		height: 2px;
		margin: 4px 0;
		border-radius: 1px;
		background: color-mix(in srgb, var(--text-faint) 55%, transparent);
	}
	/* between two servers: a longer, stronger line than the one between workdirs */
	.sep.srv {
		width: 36px;
		margin: 8px 0;
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
		/* the list scrolls and clips, but the rail leaves 6px beside a tile, enough for the pin (default -3px + 2px ring) to overhang the corner */
	}
	/* a folder: its first letter on a faint tile, so the count pinned to the corner sits on something; hover and selected are stronger */
	.agent.dir {
		color: var(--text-faint);
		background: color-mix(in srgb, var(--bg-hover) 55%, transparent);
	}
	.ini {
		font-size: var(--fs-xl);
		font-weight: 700;
		line-height: 1;
	}
	.agent.dir.active {
		color: var(--text);
	}
	@media (hover: hover) {
		.agent.dir:hover {
			color: var(--text);
		}
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
	.agent {
		-webkit-tap-highlight-color: transparent;
	}
	@media (hover: hover) {
		.agent:hover {
			background: var(--bg-hover);
		}
	}
	.agent.active {
		background: var(--bg-active);
		box-shadow: inset 0 0 0 1px var(--text-faint);
	}
	.agents:global([data-indicator-ready]) .agent.active {
		background: transparent;
		box-shadow: none;
	}
	/* the bottom's own buttons: the settings IconButton's small 32px circle and 16px glyph (like the fold button on top), so the three line up; the graph
	   view's, while it is the place shown, takes the selected folder tile's fill and edge bar */
	.nav {
		position: relative;
		display: inline-grid;
		place-items: center;
		flex: none;
		width: 32px;
		height: 32px;
		border-radius: 50%;
		color: var(--text-dim);
		transition:
			background var(--motion-fast) var(--ease-std),
			color var(--motion-fast) var(--ease-std);
		-webkit-tap-highlight-color: transparent;
	}
	.nav :global(.ic) {
		width: 16px;
		height: 16px;
	}
	@media (hover: hover) {
		.nav:hover {
			background: var(--bg-hover);
			color: var(--text);
		}
	}
	.nav.on {
		border-radius: var(--radius-sm);
		background: var(--accent-soft);
		color: var(--text);
	}
	.nav.on::before {
		content: "";
		position: absolute;
		left: -11.5px; /* on the rail's edge, where a folder tile's bar is: the 32px button sits (55 - 32) / 2 in from it */
		top: 6px; /* a 20px bar on the 32px button */
		bottom: 6px;
		width: 3px;
		border-radius: 0 2px 2px 0;
		background: var(--text);
	}
	.cnt {
		display: inline-flex;
		position: absolute;
		top: -4px;
		right: -6px;
		pointer-events: none;
	}
	.bottom {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 4px;
		width: 100%;
		padding: 8px 0 calc(8px + var(--sab));
		border-top: 1px solid var(--border);
	}
	/* touch: the 44px hit box fills the 4px gap edge to edge (width stays 44px) without covering a neighbour */
	@media (pointer: coarse) {
		.nav.tap::after {
			height: calc(100% + 4px);
		}
	}
</style>
