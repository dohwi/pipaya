<script lang="ts">
	import { t } from "../lib/i18n";
	import Icon from "./Icon.svelte";
	import AgentBadge from "./AgentBadge.svelte";
	import RowMenu, { type RowMenuItem } from "./RowMenu.svelte";
	import { activityOf, ACTIVITY_LABEL, URGENCY, type Activity } from "../lib/activity";
	import { drag, dragSource, dropTarget, type Point } from "../lib/dnd.svelte";
	import { dragScroll } from "../lib/drag-scroll";
	import { slidingIndicator } from "../lib/sliding-indicator";
	import { tabPanes, type Tab } from "../lib/nav";
	import { app } from "../lib/store.svelte";
	import { tilde } from "../lib/format";
	import { platformName } from "../lib/terminal";

	/**
	 * The tabs of the working directory in front of the user, like an editor's: a lone conversation, a lone terminal,
	 * or a group of panes. Click to switch, drag to reorder; drag a tab onto a pane to split it with that pane, or a
	 * pane's title bar onto the strip to take it out of its group as a tab of its own.
	 */
	const dir = $derived(app.activeTab?.dir ?? app.dirs.find((d) => d.path === app.workdirAbs) ?? null);
	const path = $derived(dir?.path ?? app.workdirAbs);
	const tabs = $derived(dir?.tabs ?? []);
	const activeTab = $derived(app.activeTab?.tab.id ?? null);
	const ids = $derived(tabs.map((x) => x.id));

	const titleOf = (x: Tab) => (x.kind === "group" ? x.group.name : x.kind === "session" ? x.session.title : x.terminal.title);
	/** The most pressing state among a tab's conversations. */
	function stateOf(x: Tab): Activity {
		const states = tabPanes(x)
			.filter((id) => !!app.session(id))
			.map((id) => activityOf(app, id));
		return URGENCY.find((a) => states.includes(a)) ?? "idle";
	}

	/* ---- drop: before / after a tab ---- */
	let slot = $state<{ id: string; after: boolean } | null>(null);
	let end = $state(false);
	const sideOf = (pt: Point, el: Element | null) => {
		const r = el?.getBoundingClientRect();
		return !!r && pt.x > r.left + r.width / 2;
	};
	/** A tab of this strip, or a pane of one of its groups (which then steps out into a tab of its own). */
	const takes = (id: string) => ids.includes(id) || tabs.some((x) => x.kind === "group" && tabPanes(x).includes(id));
	async function put(id: string, target: string | null, after: boolean) {
		const serverId = app.serverId;
		if (!serverId || id === target) return;
		if (!ids.includes(id)) await app.leaveGroup(id);
		// as listed now (stepping out of a group may have changed the tabs)
		const now = app.dirs.find((d) => d.path === path)?.tabs.map((x) => x.id) ?? ids;
		const others = now.filter((x) => x !== id);
		const anchor = target && others.includes(target) ? target : others[others.length - 1];
		if (anchor) app.sidebar.moveTab(serverId, now, id, anchor, target ? after : true);
		app.openTab(id);
	}
	const tabTarget = (x: Tab) => ({
		accepts: takes,
		hover: (pt: Point | null) => {
			if (pt && drag.id === x.id) slot = null;
			else if (pt) slot = { id: x.id, after: sideOf(pt, document.querySelector(`[data-tab="${CSS.escape(x.id)}"]`)) };
			else if (slot?.id === x.id) slot = null;
		},
		drop: (id: string, pt: Point) => {
			slot = null;
			void put(id, x.id, sideOf(pt, document.querySelector(`[data-tab="${CSS.escape(x.id)}"]`)));
		},
	});
	const stripTarget = {
		accepts: takes,
		hover: (pt: Point | null) => (end = !!pt),
		drop: (id: string) => {
			end = false;
			void put(id, null, true);
		},
	};

	function close(x: Tab) {
		if (x.kind === "group") void app.deleteGroup(x.id);
		else if (x.kind === "terminal") void app.closeTerminal(x.id);
		else void app.close(x.id);
	}
	const closeLabel = (x: Tab) => (x.kind === "group" ? t("그룹 해제 (대화는 그대로 남습니다)") : x.kind === "terminal" ? t("터미널 닫기 (셸 종료)") : t("닫기 (/resume 으로 다시 열기)"));

	let menu: ReturnType<typeof RowMenu> | undefined = $state();
	let menuId = $state<string | null>(null);
	const workdir = $derived(path === app.workspace?.root ? "." : path);
	function newItems(): RowMenuItem[] {
		const os = platformName(app.terminalSupport?.platform);
		return [
			{ icon: "chat", label: t("새 대화"), title: "", run: () => app.serverId && app.openIn(app.serverId, { workdir }) },
			{ icon: "terminal", label: os ? t("새 터미널 ({os})", { os }) : t("새 터미널"), title: t("서버의 셸을 이 폴더에서 엽니다 (Windows는 PowerShell)"), run: () => app.serverId && app.openIn(app.serverId, { workdir, terminal: true }) },
		];
	}

	let strip: HTMLElement | undefined = $state();
	$effect(() => {
		void activeTab;
		strip?.querySelector<HTMLElement>(".tab.on")?.scrollIntoView({ inline: "nearest", block: "nearest", behavior: "smooth" });
	});
	/** The wheel scrolls the strip sideways, as in an editor. */
	function wheel(e: WheelEvent) {
		if (!strip || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
		strip.scrollLeft += e.deltaY;
		e.preventDefault();
	}
</script>

{#if app.serverId && app.net !== "idle"}
	<div class="bar" class:group={app.activeTab?.tab.kind === "group"}>
		<span class="dir mono" title={path}>{tilde(path, app.workspace?.home).split("/").pop() || "/"}</span>
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div class="tabs" role="tablist" aria-label={t("탭")} bind:this={strip} onwheel={wheel} use:dragScroll use:slidingIndicator={{ selector: ".tab.on", variant: "accent" }} use:dropTarget={stripTarget}>
			{#each tabs as x (x.id)}
				{@const on = x.id === activeTab}
				{@const st = stateOf(x)}
				<!-- svelte-ignore a11y_click_events_have_key_events, a11y_interactive_supports_focus -->
				<div
					class="tab"
					class:on
					class:before={slot?.id === x.id && !slot.after}
					class:after={slot?.id === x.id && slot.after}
					class:carried={drag.id === x.id}
					data-tab={x.id}
					role="tab"
					aria-selected={on}
					title="{titleOf(x)}{x.kind === 'session' ? ` · ${ACTIVITY_LABEL[st]}` : ''}"
					use:dragSource={{ id: x.id }}
					use:dropTarget={tabTarget(x)}
					onclick={() => app.openTab(x.id)}
					onauxclick={(e) => e.button === 1 && close(x)}
				>
					{#if x.kind === "group"}
						<span class="ico"><Icon name="columns" /></span>
						{#if st !== "idle"}<span class="dot {st}"></span>{/if}
					{:else if x.kind === "terminal"}
						<span class="ico"><Icon name="terminal" /></span>
					{:else}
						<AgentBadge id={x.id} state={st} size={16} />
					{/if}
					<span class="t">{titleOf(x)}</span>
					{#if x.kind === "group"}<span class="n mono">{x.members.length}</span>{/if}
					<button class="x" onpointerdown={(e) => e.stopPropagation()} onclick={(e) => (e.stopPropagation(), close(x))} aria-label={closeLabel(x)} title={closeLabel(x)}><Icon name={x.kind === "group" ? "unlink" : "x"} /></button>
				</div>
			{/each}
			<div class="tail" class:over={end && !slot}></div>
		</div>
		<button class="add" class:on={menuId === "new"} onpointerenter={(e) => menu?.hover(e, "new", newItems())} onpointerleave={(e) => menu?.leave(e)} onclick={(e) => menu?.click(e, "new", newItems())} aria-label={t("새 대화 또는 터미널")} aria-haspopup="menu" title={t("이 디렉터리에서 새 대화 또는 터미널")}><Icon name="plus" /></button>
	</div>
	<RowMenu bind:this={menu} bind:open={menuId} />
{/if}

<style>
	.bar {
		flex: none;
		display: flex;
		align-items: stretch;
		height: 34px;
		padding-left: var(--sal);
		padding-right: var(--sar);
		border-bottom: 1px solid var(--border);
		background: var(--bg-side);
	}
	.dir {
		flex: none;
		display: flex;
		align-items: center;
		max-width: 22vw;
		padding: 0 10px 0 14px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: var(--fs-2xs);
		font-weight: 700;
		color: var(--text-faint);
		border-right: 1px solid var(--border);
	}
	.tabs {
		position: relative;
		flex: 1;
		min-width: 0;
		display: flex;
		overflow-x: auto;
		overscroll-behavior-x: contain;
		scrollbar-width: none;
	}
	.tabs::-webkit-scrollbar {
		display: none;
	}
	.tab {
		position: relative;
		flex: none;
		display: flex;
		align-items: center;
		gap: 6px;
		max-width: 220px;
		min-width: 0;
		padding: 0 4px 0 10px;
		border-right: 1px solid var(--border);
		color: var(--text-dim);
		font-size: var(--fs-sm);
		cursor: pointer;
		user-select: none;
		-webkit-user-select: none;
		transition: background var(--motion-fast) var(--ease-std);
	}
	.tab:hover {
		background: var(--bg-hover);
	}
	.tab.on {
		background: var(--bg);
		color: var(--text);
	}
	.bar.group .tab.on {
		background: var(--bg-group);
	}
	.tab.carried {
		opacity: 0.45;
	}
	.tab.before::before,
	.tab.after::after,
	.tail.over::before {
		content: "";
		position: absolute;
		top: 4px;
		bottom: 4px;
		width: 2px;
		border-radius: 1px;
		background: var(--accent);
		z-index: 2;
		pointer-events: none;
	}
	.tab.before::before {
		left: -1px;
	}
	.tab.after::after {
		right: -1px;
	}
	.tail {
		position: relative;
		flex: 1;
		min-width: 24px;
	}
	.tail.over::before {
		left: 0;
	}
	.t {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.tab.on .t {
		font-weight: 600;
	}
	.n {
		flex: none;
		font-size: var(--fs-2xs);
		color: var(--text-faint);
	}
	.ico {
		display: grid;
		flex: none;
	}
	.ico :global(svg),
	.x :global(svg),
	.add :global(svg) {
		width: 14px;
		height: 14px;
		stroke: currentColor;
		fill: none;
		stroke-width: 1.9;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	.dot {
		flex: none;
		width: 6px;
		height: 6px;
		margin-left: -4px;
		border-radius: 50%;
	}
	.dot.working { background: var(--info); }
	.dot.asking { background: var(--warn); }
	.dot.done { background: var(--ok); }
	.dot.failed { background: var(--danger); }
	.x {
		display: grid;
		place-items: center;
		flex: none;
		width: 22px;
		height: 22px;
		border-radius: var(--radius-sm);
		color: var(--text-faint);
		opacity: 0;
	}
	.tab:hover .x,
	.tab.on .x,
	.x:focus-visible {
		opacity: 1;
	}
	@media (pointer: coarse) {
		.x {
			opacity: 1;
		}
	}
	.x:hover {
		background: var(--bg-active);
		color: var(--text);
	}
	.add {
		flex: none;
		display: grid;
		place-items: center;
		width: 34px;
		color: var(--text-faint);
		border-left: 1px solid var(--border);
	}
	.add:hover,
	.add.on {
		background: var(--bg-hover);
		color: var(--text);
	}
</style>
