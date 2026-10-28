<script lang="ts">
	import { t } from "../lib/i18n";
	import Icon from "./Icon.svelte";
	import AgentBadge from "./AgentBadge.svelte";
	import Pin from "./Pin.svelte";
	import RowMenu, { type RowMenuItem } from "./RowMenu.svelte";
	import { newMenuEntries, rowMenuEntries, type RowTarget } from "../lib/sidebar-model";
	import { InlineRename } from "../lib/inline-rename.svelte";
	import { chooseGroup } from "../lib/group-picker";
	import { activityOf, ACTIVITY_LABEL, URGENCY, type Activity } from "../lib/activity";
	import { drag, dragSource, dropTarget, type Point } from "../lib/dnd.svelte";
	import { dragScroll } from "../lib/drag-scroll";
	import { rovingKeys } from "../lib/roving";
	import { slidingIndicator } from "../lib/sliding-indicator";
	import { tabPanes, type Tab } from "../lib/nav";
	import { app } from "../lib/store.svelte";
	import { platformName } from "../lib/terminal";
	import { viewport } from "../lib/viewport.svelte";

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
	const newItems = (): RowMenuItem[] =>
		newMenuEntries(platformName(app.terminalSupport?.platform), {
			chat: () => void (app.serverId && app.openIn(app.serverId, { workdir })),
			terminal: () => void (app.serverId && app.openIn(app.serverId, { workdir, terminal: true })),
		});

	/* ---- context menu (right click / long press): the sidebar row's entries, renaming in place ---- */
	const rename = new InlineRename();
	const targetOf = (x: Tab): RowTarget =>
		x.kind === "group" ? { kind: "group", g: { id: x.id, name: x.group.name } } : { kind: x.kind, x: { id: x.id, title: titleOf(x) } };
	const tabItems = (x: Tab): RowMenuItem[] =>
		rowMenuEntries(targetOf(x), {
			renameTab: (id, title) => rename.start(id, title),
			renameGroup: (g) => rename.start(g.id, g.name),
			groupWith: chooseGroup,
			closeSession: (id) => void app.close(id),
			archiveSession: (id) => void app.archive(id),
			closeTerminal: (id) => void app.closeTerminal(id),
			dissolveGroup: (id) => void app.deleteGroup(id),
		});
	function tabMenu(pt: Point, x: Tab) {
		menu?.openAt(pt, x.id, tabItems(x));
		return () => menuId === x.id && menu?.close();
	}
	function commitRename() {
		const done = rename.commit();
		if (!done) return;
		const x = tabs.find((y) => y.id === done.id);
		if (x?.kind === "group") void app.renameGroup(done.id, done.name);
		else if (x?.kind === "terminal") void app.renameTerminal(done.id, done.name);
		else void app.rename(done.id, done.name);
	}
	function focusSelect(node: HTMLInputElement) {
		node.focus();
		node.select();
	}

	let strip: HTMLElement | undefined = $state();
	$effect(() => {
		void activeTab;
		strip?.querySelector<HTMLElement>(".tab.on")?.scrollIntoView({ inline: "nearest", block: "nearest", behavior: "smooth" });
	});
	/** The wheel scrolls the strip sideways, as in an editor. */
	function wheel(e: WheelEvent) {
		if (!strip || e.ctrlKey || strip.scrollWidth <= strip.clientWidth || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
		strip.scrollLeft += e.deltaY;
		e.preventDefault();
	}
</script>

{#if app.serverId && app.net !== "idle" && !viewport.inGroup(app.activeGroup?.id)}
	<div class="bar" data-part="tabbar" class:group={app.activeTab?.tab.kind === "group"} use:dropTarget={stripTarget}>
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div class="tabs" role="tablist" aria-label={t("탭")} bind:this={strip} onwheel={wheel} use:rovingKeys={{ item: '[role="tab"]' }} use:dragScroll use:slidingIndicator={{ selector: ".tab.on", radius: "var(--radius-sm)" }}>
			{#each tabs as x (x.id)}
				{@const on = x.id === activeTab}
				{@const st = stateOf(x)}
				<div
					class="tab"
					class:on
					class:before={slot?.id === x.id && !slot.after}
					class:after={slot?.id === x.id && slot.after}
					class:carried={drag.id === x.id}
					class:menuopen={menuId === x.id}
					data-tab={x.id}
					role="tab"
					tabindex={on ? 0 : -1}
					aria-selected={on}
					title="{titleOf(x)}{x.kind === 'session' ? ` · ${ACTIVITY_LABEL[st]}` : ''}"
					use:dragSource={{ id: x.id, disabled: rename.is(x.id), menu: (pt) => tabMenu(pt, x) }}
					use:dropTarget={tabTarget(x)}
					onclick={() => {
						if (rename.is(x.id)) return;
						if (x.kind === "group") viewport.backedOut = null;
						app.openTab(x.id);
					}}
					onauxclick={(e) => e.button === 1 && close(x)}
					onkeydown={(e) => {
						// Enter / Space open the tab (arrows are handled by rovingKeys); a rename field or the close button keep their own keys.
						if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) {
							e.preventDefault();
							e.currentTarget.click();
						}
					}}
				>
					{#if x.kind === "group"}
						<span class="ico gico"><Icon name="columns" />{#if st !== "idle"}<Pin tone={st === "working" ? "info" : st === "asking" ? "warn" : st === "done" ? "ok" : "danger"} pulse={st === "working"} ping={st === "asking"} />{/if}</span>
					{:else if x.kind === "terminal"}
						<span class="ico"><Icon name="terminal" /></span>
					{:else}
						<AgentBadge id={x.id} state={st} size={16} />
					{/if}
					{#if rename.is(x.id)}
						<input
							class="rename"
							value={rename.draft}
							maxlength={x.kind === "group" ? 100 : undefined}
							aria-label={t("이름 바꾸기")}
							use:focusSelect
							oninput={(e) => (rename.draft = e.currentTarget.value)}
							onblur={commitRename}
							onclick={(e) => e.stopPropagation()}
							onkeydown={(e) => {
								if (e.key === "Enter") commitRename();
								if (e.key === "Escape") rename.cancel();
							}}
						/>
					{:else}
						<span class="t" ondblclick={() => rename.start(x.id, titleOf(x))}>{titleOf(x)}</span>
					{/if}
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
	/* Navigation rows share one shape: rounded rectangles of --radius-sm, a soft fill for hover and the selection
	   (the sidebar rows, the pane frames and the phone strip look the same way). */
	.bar {
		flex: none;
		display: flex;
		align-items: center;
		gap: 4px;
		height: 38px;
		padding: 0 8px 0 max(8px, var(--sal));
		padding-right: max(8px, var(--sar));
		border-bottom: 1px solid var(--border);
		background: var(--bg);
	}
	/* coming back out of a group: the group's strip folds into the tabs */
	.bar {
		animation: from-group var(--motion-fast) var(--ease-std);
	}
	@keyframes from-group {
		from {
			opacity: 0;
			transform: translateX(-12px);
		}
	}
	.bar.group {
		background: var(--bg-group);
	}
	/* the strip is only as wide as its tabs, so the + follows the last one; once they overflow it stops at the bar's right end */
	.tabs {
		position: relative;
		flex: 0 1 auto;
		min-width: 0;
		height: 100%;
		display: flex;
		align-items: center;
		gap: 4px;
		overflow-x: auto;
		overscroll-behavior-x: contain;
		scrollbar-width: none;
	}
	.tabs::-webkit-scrollbar {
		display: none;
	}
	.tab {
		position: relative;
		z-index: 1; /* above the sliding fill */
		flex: none;
		display: flex;
		align-items: center;
		gap: 4px;
		height: 28px;
		max-width: 220px;
		min-width: 0;
		padding: 0 4px 0 8px;
		border-radius: var(--radius-sm);
		color: var(--text-dim);
		font-size: var(--fs-sm);
		cursor: pointer;
		user-select: none;
		-webkit-user-select: none;
		transition:
			background var(--motion-fast) var(--ease-std),
			color var(--motion-fast) var(--ease-std);
	}
	.tab:hover {
		background: var(--bg-hover);
		color: var(--text);
	}
	.tab.on {
		background: var(--bg-active);
		color: var(--text);
	}
	/* the sliding marker draws the selection */
	.tabs:global([data-indicator-ready]) .tab.on {
		background: transparent;
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
		left: -2px;
	}
	.tab.after::after {
		right: -2px;
	}
	.tail {
		position: relative;
		flex: none;
		width: 8px;
		align-self: stretch;
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
	.tab.menuopen {
		background: var(--bg-hover);
	}
	.rename {
		width: 140px;
		min-width: 0;
		height: 22px;
		padding: 0 4px;
		border: 1px solid var(--accent);
		border-radius: var(--radius-xs);
		background: var(--bg);
		color: var(--text);
		font-size: var(--fs-sm);
		outline: 0;
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
	.gico {
		position: relative;
	}
	.ico :global(svg),
	.x :global(svg),
	.add :global(svg) {
		width: 14px;
		height: 14px;
		stroke-width: 1.9;
	}
	.x {
		display: grid;
		place-items: center;
		flex: none;
		width: 22px;
		height: 22px;
		border-radius: var(--radius-xs);
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
		width: 28px;
		height: 28px;
		border-radius: var(--radius-sm);
		color: var(--text-faint);
		transition: background var(--motion-fast) var(--ease-std);
	}
	.add:hover,
	.add.on {
		background: var(--bg-hover);
		color: var(--text);
	}
</style>
