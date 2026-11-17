<script lang="ts">
	import { sessionTitle } from "../../lib/session-title";
	import { parentLabel, peerLabel } from "../../lib/peers";
	import { extensions } from "../../lib/extensions/host.svelte";
	import { t } from "../../lib/i18n";
	import { schedule, unschedule } from "../../lib/frame";
	import Icon from "../ui/Icon.svelte";
	import SessionStrip from "./SessionStrip.svelte";
	import AgentBadge from "./AgentBadge.svelte";
	import TabControls from "./TabControls.svelte";
	import Pin from "../ui/Pin.svelte";
	import PinMark from "../ui/PinMark.svelte";
	import RowMenu, { type RowMenuItem } from "../ui/RowMenu.svelte";
	import { rowMenuEntries, type RowTarget } from "../../lib/sidebar-model";
	import { InlineRename } from "../../lib/inline-rename.svelte";
	import { registerRenamePlace } from "../../lib/rename-places";
	import { chooseGroup } from "../../lib/group-picker";
	import { activityOf, ACTIVITY_LABEL, URGENCY, type Activity } from "../../lib/activity";
	import { drag, dragSource, dropTarget, type Point } from "../../lib/dnd.svelte";
	import { dragScroll } from "../../lib/drag-scroll";
	import { edgeFade } from "../../lib/edge-fade";
	import { rovingKeys } from "../../lib/roving";
	import { slidingIndicator } from "../../lib/sliding-indicator";
	import { tabPanes, type Tab } from "../../lib/nav";
	import { app } from "../../lib/store.svelte";

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

	const titleOf = (x: Tab) => (x.kind === "group" ? x.group.name : x.kind === "session" ? sessionTitle(x.session.title) : x.terminal.title);
	/** The `@name` other sessions call this conversation by, as the sidebar row and the split tab's title bar show it. */
	/** the parent mark ("made by @parent") on a tab whose session another open session made: who started it, beside it */
	const parentOf = (x: Tab) => (x.kind === "session" ? parentLabel(x.session, (id) => app.session(id)) : undefined);
	const handleOf = (x: Tab) => (x.kind === "session" ? (peerLabel(x.session) ?? extensions.labelOf(x.id)) : undefined);
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
	/** A pinned tab leads the strip, so a lone tab cannot be put across that border (the list would sort it straight back). */
	const acrossPins = (id: string | null, x: string) =>
		!!app.serverId && !!id && ids.includes(id) && app.sidebar.isTabPinned(app.serverId, id) !== app.sidebar.isTabPinned(app.serverId, x);
	const tabTarget = (x: Tab) => ({
		accepts: (id: string) => takes(id) && !acrossPins(id, x.id),
		hover: (pt: Point | null) => {
			if (pt && drag.id === x.id) slot = null;
			else if (pt) {
				const after = sideOf(pt, document.querySelector(`[data-tab="${CSS.escape(x.id)}"]`));
				// right beside the carried tab is where it already is: no gap
				const i = drag.id ? ids.indexOf(drag.id) : -1;
				const j = ids.indexOf(x.id);
				slot = i >= 0 && (after ? j === i - 1 : j === i + 1) ? null : { id: x.id, after };
			} else if (slot?.id === x.id) slot = null;
		},
		drop: (id: string, pt: Point) => {
			slot = null;
			void put(id, x.id, sideOf(pt, document.querySelector(`[data-tab="${CSS.escape(x.id)}"]`)));
		},
	});
	/** A group's box: a pane of that same group let go on it stays where it is; anything else lands before / after the box. */
	const groupTarget = (x: Tab) => {
		const base = tabTarget(x);
		const own = (id: string) => tabPanes(x).includes(id);
		return {
			...base,
			hover: (pt: Point | null) => base.hover(pt && drag.id && own(drag.id) ? null : pt),
			drop: (id: string, pt: Point) => (own(id) ? base.hover(null) : base.drop(id, pt)),
		};
	};
	const stripTarget = {
		// the end of the strip is behind every unpinned tab: a pinned one cannot go there
		accepts: (id: string) => takes(id) && !(!!app.serverId && ids.includes(id) && app.sidebar.isTabPinned(app.serverId, id) && tabs.some((t) => !app.sidebar.isTabPinned(app.serverId!, t.id))),
		hover: (pt: Point | null) => (end = !!pt),
		drop: (id: string) => {
			end = false;
			void put(id, null, true);
		},
	};

	/** A group's tab has no close button: dissolving a group is the sidebar's menu alone. */
	function close(x: Tab) {
		if (x.kind === "group") return;
		if (x.kind === "terminal") void app.closeTerminal(x.id);
		else void app.close(x.id);
	}
	const closeLabel = (x: Tab) => (x.kind === "terminal" ? t("터미널 닫기 (셸 종료)") : t("닫기 (/resume 으로 다시 열기)"));

	let menu: ReturnType<typeof RowMenu> | undefined = $state();
	let menuId = $state<string | null>(null);

	/* ---- context menu (right click / long press): the sidebar row's entries, renaming in place ---- */
	const rename = new InlineRename();
	/** A click on this strip makes F2 rename its tab here rather than in the sidebar (`rename-places`) */
	$effect(() =>
		registerRenamePlace({
			order: 1,
			zone: '[data-part="tabbar"]',
			open: () => {
				const x = tabs.find((x) => x.id === activeTab);
				// a split tab is a box of its sessions here: its own name is renamed on its sidebar row
				return x && x.kind !== "group" ? { id: x.id, title: titleOf(x) } : null;
			},
			start: (id, title) => rename.start(id, title),
		})
	);
	const targetOf = (x: Tab): RowTarget =>
		x.kind === "group" ? { kind: "group", g: { id: x.id, name: x.group.name } } : { kind: x.kind, x: { id: x.id, title: titleOf(x) } };
	const tabItems = (x: Tab): RowMenuItem[] =>
		rowMenuEntries(targetOf(x), {
			renameTab: (id, title) => rename.start(id, title),
			renameGroup: (g) => rename.start(g.id, g.name),
			groupWith: chooseGroup,
			closeSession: (id) => void app.close(id),
			closeTerminal: (id) => void app.closeTerminal(id),
			togglePin: (id) => app.sidebar.toggleTabPinned(app.serverId!, id),
			isPinned: (id) => app.sidebar.isTabPinned(app.serverId!, id),
			schedule: (id) => app.openScheduleFor(id),
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
		void app.activeId;
		const host = strip;
		if (!host) return;
		// Next frame, with the other layout reads: scrolling here forced the style pass of everything the send just changed
		// in the middle of the effect flush. Both reads go first, the writes after (no layout thrash between them).
		schedule(host, () => {
			const on = host.querySelector<HTMLElement>(".tab.on");
			const chip = host.querySelector<HTMLElement>('.gchip[aria-current="true"]');
			return () => {
				on?.scrollIntoView({ inline: "nearest", block: "nearest", behavior: "smooth" });
				chip?.scrollIntoView({ inline: "nearest", block: "nearest", behavior: "smooth" });
			};
		});
		return () => unschedule(host);
	});
	/** The wheel scrolls the strip sideways, as in an editor. */
	function wheel(e: WheelEvent) {
		if (!strip || e.ctrlKey || strip.scrollWidth <= strip.clientWidth || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
		strip.scrollLeft += e.deltaY;
		e.preventDefault();
	}
</script>

{#snippet tabItem(x: Tab, on: boolean, st: ReturnType<typeof stateOf>, first: boolean)}
	{@const pinned = !!app.serverId && app.sidebar.isTabPinned(app.serverId, x.id)}
	{@const who = handleOf(x)}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
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
				title="{who ? `${who.title} · ` : ''}{titleOf(x)}{x.kind === 'session' ? ` · ${ACTIVITY_LABEL[st]}` : ''}"
				use:dragSource={{ id: x.id, disabled: rename.is(x.id), menu: (pt) => tabMenu(pt, x) }}
				use:dropTarget={tabTarget(x)}
				onclick={() => {
					if (rename.is(x.id)) return;
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
				<!-- the hover pill and the hairline before this tab: boxes of their own, since ::before / ::after are the drop line -->
				<span class="fill" aria-hidden="true"></span>{#if !first}<span class="sep" aria-hidden="true"></span>{/if}
				{#if x.kind === "group"}
					<span class="ico gico"><Icon name="columns" />{#if st !== "idle"}<Pin tone={st === "working" ? "info" : st === "asking" ? "warn" : st === "done" ? "ok" : "danger"} pulse={st === "working"} ping={st === "asking"} />{/if}{#if pinned}<PinMark />{/if}</span>
				{:else if x.kind === "terminal"}
					<span class="ico"><Icon name="terminal" />{#if pinned}<PinMark />{/if}</span>
				{:else}
					<span class="ico"><AgentBadge id={x.id} state={st} size={16} />{#if pinned}<PinMark />{/if}</span>
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
					{#if who}<span class="who mono {st}">{who.text}</span>{/if}<span class="t">{titleOf(x)}</span>{#if parentOf(x)}{@const pl = parentOf(x)!}<span class="from mono" title={pl.title}><Icon name="fork" /><span class="fn">{pl.text}</span></span>{/if}
				{/if}
				{#if x.kind === "group"}<span class="n mono">{x.members.length}</span>{/if}
				{#if x.kind !== "group"}<button class="x tap" onpointerdown={(e) => e.stopPropagation()} onclick={(e) => (e.stopPropagation(), close(x))} aria-label={closeLabel(x)} title={closeLabel(x)}><Icon name="x" /></button>{/if}
			</div>
{/snippet}

{#if app.serverId && app.net !== "idle"}
	<div class="bar" data-part="tabbar" class:solo={tabs.length <= 1 && tabs[0]?.kind !== "group"} class:group={app.activeTab?.tab.kind === "group"} use:dropTarget={stripTarget}>
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div class="tabs" role="tablist" aria-label={t("탭")} bind:this={strip} onwheel={wheel} use:rovingKeys={{ item: '[role="tab"]' }} use:dragScroll use:edgeFade use:slidingIndicator={{ selector: ".tab.on, .gbox.on" }}>
			{#each tabs as x, i (x.id)}
				{@const on = x.id === activeTab}
				{@const st = stateOf(x)}
				<!-- a group is a bordered box around its sessions, laid out inline with the other tabs (its name is in the page
				     header's "group › session" and the sidebar) -->
				{#if x.kind === "group"}
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<div
						class="gbox"
						class:on
						class:before={slot?.id === x.id && !slot.after}
						class:after={slot?.id === x.id && slot.after}
						class:carried={drag.id === x.id}
						class:menuopen={menuId === x.id}
						data-tab={x.id}
						title={x.group.name}
						use:dragSource={{ id: x.id, disabled: rename.is(x.id), menu: (pt) => tabMenu(pt, x) }}
						use:dropTarget={groupTarget(x)}
					>
						<SessionStrip tab={x} />
					</div>
				{:else}
					{@render tabItem(x, on, st, i === 0)}
				{/if}
			{/each}
			<div class="tail" class:over={end && !slot}></div>
		</div>
		<!-- "+" and the tab count, pinned to the bar's right end whatever the number of tabs (on a phone the same cluster
		     sits in the header instead, see Header.svelte) -->
		<span class="ctlslot"><TabControls /></span>
	</div>
	<RowMenu bind:this={menu} bind:open={menuId} />
{/if}

<style>
	/* A browser's tab strip (wider than a phone): the bar is a tone off the page (--bg-tabbar), the tab in front is the page's own
	   colour with rounded top corners and runs over the bar's bottom hairline into the conversation below, so the two read as
	   one sheet. The other tabs have no fill, only a hairline between them. Tabs share the width evenly up to 200px each and
	   scroll sideways below 112px. "+" and the tab count are pinned to the bar's right end (TabControls), not after the
	   last tab, so they stay where the hand found them whether one tab is open or twenty. */
	.bar {
		flex: none;
		display: flex;
		align-items: stretch;
		height: 38px;
		padding: 0 11px 0 max(0px, var(--sal)); /* right: the count's 18px square sits 5px inside its 28px button, so its edge lands on the 16px gutter (DESIGN rule 5); left: the strip pads itself (room for the front tab's flare) */
		background: var(--bg-tabbar);
		box-shadow: inset 0 -1px var(--border); /* the hairline under the strip, drawn below the tabs so the front one covers it */
	}
	/* a phone with one tab or none: the strip would be a row of height for nothing ("+" and the count live in the header there) */
	@media (max-width: 600px) {
		.bar.solo {
			display: none;
		}
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
	/* the tabs take every pixel left of the controls; what they do not fill stays empty */
	.tabs {
		position: relative;
		flex: 1 1 auto;
		min-width: 0;
		display: flex;
		align-items: flex-end;
		padding-left: 8px; /* the first tab's left flare draws here; its icon lands on 16, the header title's line */
		overflow-x: auto;
		overscroll-behavior-x: contain;
		scrollbar-width: none;
	}
	.tabs::-webkit-scrollbar {
		display: none;
	}
	/* the controls share the tabs' row: 4px down like the tabs, so the buttons centre on the titles (21px from the top) */
	.ctlslot {
		flex: none;
		display: flex;
		align-items: center;
		padding-top: 4px;
		padding-left: 8px;
	}
	@media (max-width: 600px) {
		.ctlslot {
			display: none;
		}
	}

	/* the front tab's fill is the sliding marker: the page colour, rounded on top, with the two outward curves at its foot */
	.tabs > :global(.slide-ind) {
		background: var(--bg);
		border-radius: var(--radius-sm) var(--radius-sm) 0 0;
	}
	.tabs > :global(.slide-ind)::before,
	.tabs > :global(.slide-ind)::after {
		content: "";
		position: absolute;
		bottom: 0;
		width: 8px;
		height: 8px;
	}
	.tabs > :global(.slide-ind)::before {
		left: -8px;
		background: radial-gradient(circle at 0 0, transparent 8px, var(--bg) 8.5px); /* the flare's curve: --radius-sm, half a pixel of antialiasing */
	}
	.tabs > :global(.slide-ind)::after {
		right: -8px;
		background: radial-gradient(circle at 100% 0, transparent 8px, var(--bg) 8.5px); /* the mirror of ::before */
	}

	.tab {
		position: relative;
		z-index: 1; /* above the sliding fill */
		flex: 0 1 200px;
		display: flex;
		align-items: center;
		gap: 4px;
		height: 34px;
		min-width: 112px;
		max-width: 200px;
		padding: 0 4px 0 8px;
		border-radius: var(--radius-sm) var(--radius-sm) 0 0;
		color: var(--text-dim);
		font-size: var(--fs-sm);
		line-height: 20px; /* whole-pixel title beside the session logo (rule 3) */
		cursor: pointer;
		user-select: none;
		-webkit-user-select: none;
		transition:
			background var(--motion-fast) var(--ease-std),
			color var(--motion-fast) var(--ease-std),
			margin var(--motion-fast) var(--ease-std);
	}
	.tab.on {
		background: var(--bg); /* until the sliding marker is placed */
		color: var(--text);
	}
	.tabs:global([data-indicator-ready]) .tab.on {
		background: transparent;
	}
	/* hover: a soft pill inside the tab, 4px in, like the tab strips of today's browsers */
	.fill {
		position: absolute;
		inset: 4px 4px;
		z-index: -1;
		border-radius: var(--radius-sm);
		background: var(--bg-tabbar-hover);
		opacity: 0;
		pointer-events: none;
		transition: opacity var(--motion-fast) var(--ease-std);
	}
	@media (hover: hover) {
		.tab:not(.on):hover {
			color: var(--text);
		}
		.tab:not(.on):hover .fill {
			opacity: 1;
		}
	}
	.tab.menuopen:not(.on) .fill {
		opacity: 1;
	}
	/* the hairline between two plain tabs, gone beside the front tab, a hovered one and a group's frame */
	.sep {
		position: absolute;
		left: 0;
		top: 8px;
		bottom: 8px;
		width: 1px;
		background: var(--border-strong);
		pointer-events: none;
		transition: opacity var(--motion-fast) var(--ease-std);
	}
	.tab.on .sep,
	.tab.on + .tab .sep,
	:global(.gbox) + .tab .sep,
	.tab.before .sep,
	.tab.after + .tab .sep {
		opacity: 0;
	}
	@media (hover: hover) {
		.tab:hover .sep,
		.tab:hover + .tab .sep {
			opacity: 0;
		}
	}
	.tab.carried {
		opacity: 0.45;
	}

	/* the open group as one unit of its sessions: a tab of the strip whose content is the sessions' chips. Behind it is
	   a frame 4px in (the hover pill's place); in front, the frame gives way to the front tab's sheet. The sessions are what
	   picks the pane while the group is enlarged, so the box keeps its whole width and the bar scrolls past it. */
	.gbox {
		position: relative;
		z-index: 1; /* above the sliding fill, like a tab */
		flex: none;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: 4px;
		height: 34px;
		padding: 0 8px;
		border-radius: 12px; /* the frame drawn 4px in below comes out at --radius-sm */
		outline: 1px solid var(--border-strong);
		outline-offset: -4px;
		transition:
			margin var(--motion-fast) var(--ease-std),
			outline-color var(--motion-fast) var(--ease-std);
	}
	.gbox + .gbox {
		margin-left: 4px;
	}
	.gbox.on {
		outline-color: transparent;
		border-radius: var(--radius-sm) var(--radius-sm) 0 0;
	}
	.gbox:not(.on).menuopen {
		outline-color: var(--text-faint);
	}
	/* a chip under the pointer on the strip's tone (SessionStrip's own hover is the page's --bg-hover) */
	@media (hover: hover) and (min-width: 601px) {
		.gbox:not(.on) :global(.gchip:hover) {
			background: var(--bg-tabbar-hover);
		}
	}
	.gbox.carried {
		opacity: 0.45;
	}

	/* the neighbours step aside: the tab grows a 24px gap on the side where the carried one would land, animated, with
	   the line in the middle of it. The pseudo-element fills the gap and takes the pointer, so the tab under it stays the
	   same one while the gap opens (no flicker). */
	.tab.before,
	.gbox.before {
		margin-left: 24px;
	}
	.tab.after,
	.gbox.after {
		margin-right: 24px;
	}
	.tab.before::before,
	.tab.after::after,
	.gbox.before::before,
	.gbox.after::after {
		content: "";
		position: absolute;
		top: 8px;
		bottom: 4px;
		width: 24px; /* the margin it fills */
		background: linear-gradient(var(--accent), var(--accent)) center / 2px 100% no-repeat;
		z-index: 2;
	}
	.tab.before::before,
	.gbox.before::before {
		left: -24px;
	}
	.tab.after::after,
	.gbox.after::after {
		right: -24px;
	}
	.tail {
		position: relative;
		flex: none;
		width: 8px; /* the last tab's right flare draws here */
		align-self: stretch;
	}
	.tail.over::before {
		content: "";
		position: absolute;
		top: 8px;
		bottom: 4px;
		left: 0;
		width: 2px;
		border-radius: 1px;
		background: var(--accent);
		z-index: 2;
		pointer-events: none;
	}

	/* the `@name` other sessions call this one by, before its title: the same small dim handle the sidebar row and the
	   split tab's title bar carry (11px on a 16px line box, so it centres on the tab like the title does). It takes the
	   same activity colour as the sidebar's handle, so a working conversation reads blue in both places. */
	.who {
		flex: none;
		font-size: var(--fs-2xs);
		font-weight: 600;
		color: var(--text-faint);
		line-height: 16px;
	}
	.who.working {
		color: var(--info);
	}
	.who.asking {
		color: var(--warn);
	}
	.who.done {
		color: var(--ok);
	}
	.who.failed {
		color: var(--danger);
	}
	/* the parent mark (fork icon + "@parent", like "forked from"): who made this conversation, after its title and quieter than its own handle */
	.from {
		flex: none;
		display: flex;
		align-items: center;
		gap: 4px;
		font-size: var(--fs-2xs);
		color: var(--text-faint);
		line-height: 16px; /* whole-pixel line box, centred on the title's like .who */
	}
	.from :global(svg) {
		width: 12px;
		height: 12px;
		stroke-width: 2;
	}
	/* the title takes the tab's spare width, so the close button sits at its right end as in a browser */
	.t {
		flex: 1 1 auto;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.tab.on .t {
		font-weight: 600;
	}
	.rename {
		flex: 1 1 auto;
		width: 0;
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
		position: relative; /* hosts the status dot (Pin) and the pinned mark (PinMark) */
		display: grid;
		flex: none;
	}
	.ico > :global(svg), /* the icon's own glyph only: the pinned mark keeps its own size */
	.x :global(svg) {
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
	@media (hover: hover) {
		.x:hover {
			background: var(--bg-active);
			color: var(--text);
		}
	}

	/* A phone keeps the compact strip it had: rounded chips of their own width on the page colour, the selection a soft fill
	   (the sidebar rows and the drawer look the same way). "+" and the count are in the header there. */
	@media (max-width: 600px) {
		.bar {
			align-items: center;
			padding: 0 8px 0 max(8px, var(--sal));
			background: var(--bg);
		}
		.tabs {
			height: 100%;
			align-items: center;
			gap: 4px;
			padding-left: 0;
		}
		.tabs > :global(.slide-ind) {
			background: var(--bg-active);
			border-radius: var(--radius-sm);
		}
		.tabs > :global(.slide-ind)::before,
		.tabs > :global(.slide-ind)::after {
			display: none;
		}
		.tab {
			flex: none;
			height: 28px;
			min-width: 0;
			max-width: 220px;
			border-radius: var(--radius-sm);
		}
		.tab.on {
			background: var(--bg-active);
		}
		.t {
			flex: 0 1 auto;
		}
		.rename {
			flex: none;
			width: 140px;
		}
		.sep,
		.fill {
			display: none;
		}
		.gbox {
			height: 28px;
			padding: 0 4px;
			border-radius: var(--radius-sm);
			outline: 0;
			border: 1px solid var(--border);
		}
		.gbox.on {
			border-color: var(--text-faint);
			border-radius: var(--radius-sm);
		}
		.gbox + .gbox {
			margin-left: 0;
		}
		.tab.before,
		.gbox.before {
			margin-left: 20px; /* with the strip's 4px gap, the 24px the line's box fills */
		}
		.tab.after,
		.gbox.after {
			margin-right: 20px; /* as above */
		}
		.tab.before::before,
		.tab.after::after,
		.gbox.before::before,
		.gbox.after::after,
		.tail.over::before {
			top: 4px;
			bottom: 4px;
		}
	}
</style>
