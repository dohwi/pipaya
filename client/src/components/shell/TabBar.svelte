<script lang="ts">
	import { sessionTitle } from "../../lib/session-title";
	import { parentLabel, peerLabel } from "../../lib/peers";
	import { extensions } from "../../lib/extensions/host.svelte";
	import { t } from "../../lib/i18n";
	import { schedule, unschedule } from "../../lib/frame";
	import Handle from "../ui/Handle.svelte";
	import Icon from "../ui/Icon.svelte";
	import FileIcon from "../workspace/FileIcon.svelte";
	import InlineRenameField from "../ui/InlineRenameField.svelte";
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
	import { chooseGroupLayout } from "../../lib/layout-picker";
	import { activityOf, ACTIVITY_LABEL, ACTIVITY_TONE, URGENCY, type Activity } from "../../lib/activity";
	import { drag, dragSource, dropTarget, type Point } from "../../lib/dnd.svelte";
	import { dragScroll } from "../../lib/drag-scroll";
	import { edgeFade } from "../../lib/edge-fade";
	import { rovingKeys } from "../../lib/roving";
	import { formatCombo } from "../../lib/keys";
	import { slidingIndicator } from "../../lib/sliding-indicator";
	import { tabPanes, type Tab } from "../../lib/nav";
	import { isManualRoot, tabLead, tabLeads } from "../../lib/projects";
	import { app } from "../../lib/store.svelte";
	import { WORKSPACE_FILE_MIME } from "../../lib/workspace-edits";
	import { workspaceViewer } from "../../lib/workspace-viewer.svelte";

	/**
	 * The tabs of the working directory in front of the user, like an editor's: a lone conversation, a lone terminal,
	 * or a group of panes. Click to switch, drag to reorder; drag a tab onto a pane to split it with that pane, or a
	 * pane's title bar onto the strip to take it out of its group as a tab of its own.
	 */
	/** The open folder's tabs, or every folder's of the project picked in the sidebar (each folder's run after an icon marker) */
	const dirs = $derived(app.stripDirs);
	const multi = $derived(dirs.length > 1);
	const tabs = $derived(dirs.flatMap((d) => d.tabs));
	const fileTabs = $derived(workspaceViewer.openFiles);
	const activeFile = $derived(workspaceViewer.activeFile);
	const activeTab = $derived(activeFile ? null : (app.activeTab?.tab.id ?? null));
	const ids = $derived(tabs.map((x) => x.id));
	/** The folder a tab (or a pane of one of its groups) is listed in */
	const dirOf = (id: string) => dirs.find((d) => d.tabs.some((x) => x.id === id || tabPanes(x).includes(id)))?.path ?? null;
	const manualProject = $derived(!!app.tabProject && app.tabProject.serverId === app.serverId && isManualRoot(app.tabProject.root));
	/** Where a folder's run starts in a multi-folder project: an icon-only marker (tooltip names the folder), a hairline between runs */
	const leads = $derived.by(() => {
		const sid = app.serverId;
		if (!multi || !sid) return {};
		const repos = app.links[sid]?.repos ?? {};
		return tabLeads(dirs, (d) =>
			tabLead(d.path, {
				manual: manualProject,
				customName: app.sidebar.dirName(sid, d.path),
				repo: repos[d.path],
				home: app.workspace?.home,
			}),
		);
	});

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
	/** Tabs stay in their own folder: across a project's folders only the end of the strip takes one (the end of its folder's run) */
	const sameDir = (id: string, target: string) => dirOf(id) === dirOf(target);
	async function put(id: string, target: string | null, after: boolean) {
		const serverId = app.serverId;
		const path = dirOf(id);
		if (!serverId || id === target || !path) return;
		if (!ids.includes(id)) await app.leaveGroup(id);
		// as listed now (stepping out of a group may have changed the tabs)
		const now = app.dirs.find((d) => d.path === path)?.tabs.map((x) => x.id) ?? [];
		const others = now.filter((x) => x !== id);
		const anchor = target && others.includes(target) ? target : others[others.length - 1];
		if (anchor) app.sidebar.moveTab(serverId, now, id, anchor, target ? after : true);
		app.openTab(id);
	}
	/** A pinned tab leads the strip, so a lone tab cannot be put across that border (the list would sort it straight back). */
	const acrossPins = (id: string | null, x: string) =>
		!!app.serverId && !!id && ids.includes(id) && app.sidebar.isTabPinned(app.serverId, id) !== app.sidebar.isTabPinned(app.serverId, x);
	const tabTarget = (x: Tab) => ({
		accepts: (id: string) => takes(id) && sameDir(id, x.id) && !acrossPins(id, x.id),
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
		accepts: (id: string) => {
			const own = dirs.find((d) => d.path === dirOf(id))?.tabs ?? [];
			return takes(id) && !(!!app.serverId && ids.includes(id) && app.sidebar.isTabPinned(app.serverId, id) && own.some((t) => !app.sidebar.isTabPinned(app.serverId!, t.id)));
		},
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
	/** The front tab's × also names the key that closes it (the key closes the focused pane, so only there) */
	const closeTip = (x: Tab) => closeLabel(x) + (x.id === activeTab && app.prefs.bindings.closeSession ? ` · ${formatCombo(app.prefs.bindings.closeSession)}` : "");

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
			arrangeGroup: (id) => chooseGroupLayout(id),
			arrangeShortcut: app.prefs.bindings.arrangePanes ? formatCombo(app.prefs.bindings.arrangePanes) : undefined,
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

	let strip: HTMLElement | undefined = $state();
	$effect(() => {
		void activeTab;
		void activeFile;
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
	/**
	 * Keyboard focus on something the strip has scrolled out of view (a split tab's chip, a close button) brings it in.
	 * The browser does not: a chip sits in the group's own scroll box, which has nothing to scroll, and the strip around it
	 * stayed put, so the ring was drawn off screen (scripts/ui-focus.py).
	 */
	function reveal(e: FocusEvent) {
		if (!strip || !(e.target instanceof HTMLElement) || !e.target.matches(":focus-visible")) return;
		const r = e.target.getBoundingClientRect();
		const box = strip.getBoundingClientRect();
		if (r.left < box.left) strip.scrollLeft -= box.left - r.left + 8;
		else if (r.right > box.right) strip.scrollLeft += r.right - box.right + 8;
	}
	/** A double click on the strip's empty part (not a tab, chip, label or button): a new chat where "+" would start one */
	function blankDouble(e: MouseEvent) {
		const el = e.target as HTMLElement;
		if (!app.serverId || el.closest(".tab, .gbox, .lead, button, input")) return;
		const p = app.tabDir?.path ?? app.workdirAbs;
		void app.openIn(app.serverId, { workdir: p === app.workspace?.root ? "." : p });
	}
	/** The wheel scrolls the strip sideways, as in an editor. */
	function wheel(e: WheelEvent) {
		if (!strip || e.ctrlKey || strip.scrollWidth <= strip.clientWidth || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
		strip.scrollLeft += e.deltaY;
		e.preventDefault();
	}
</script>

{#snippet tabItem(x: Tab, on: boolean, st: ReturnType<typeof stateOf>)}
	{@const pinned = !!app.serverId && app.sidebar.isTabPinned(app.serverId, x.id)}
	{@const who = handleOf(x)}
	{@const parent = parentOf(x)}
	{@const sched = x.kind === "session" && app.serverId ? app.schedules.of(app.serverId, x.id) : { count: 0, next: null }}
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
				title="{who ? `${who.title} · ` : ''}{titleOf(x)}{parent ? ` · ${parent.title}` : ''}{sched.count ? ` · ${t('예약 {n}개', { n: sched.count })}` : ''}{x.kind === 'session' ? ` · ${ACTIVITY_LABEL[st]}` : ''}"
				use:dragSource={{ id: x.id, disabled: rename.is(x.id), menu: (pt) => tabMenu(pt, x) }}
				use:dropTarget={tabTarget(x)}
				onclick={() => {
					if (rename.is(x.id)) return;
					workspaceViewer.deactivateFile();
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
				<!-- the hover pill: a box of its own, since ::before / ::after are the drop line -->
				<span class="fill" aria-hidden="true"></span>
				{#if x.kind === "group"}
					<span class="ico gico"><Icon name="columns" />{#if st !== "idle"}<Pin tone={st === "working" ? "info" : st === "asking" ? "warn" : st === "done" ? "ok" : "danger"} pulse={st === "working"} ping={st === "asking"} />{/if}{#if pinned}<PinMark />{/if}</span>
				{:else if x.kind === "terminal"}
					<span class="ico"><Icon name="terminal" />{#if pinned}<PinMark />{/if}</span>
				{:else}
					<span class="ico"><AgentBadge id={x.id} state={st} size={16} />{#if pinned && !app.goals.of(app.serverId, x.id)}<PinMark tone={ACTIVITY_TONE[st]} />{/if}</span>
				{/if}
				{#if rename.is(x.id)}
					<InlineRenameField
						variant="tab"
						value={rename.draft}
						maxlength={x.kind === "group" ? 100 : undefined}
						ariaLabel={t("이름 바꾸기")}
						oninput={(v) => (rename.draft = v)}
						oncommit={commitRename}
						oncancel={() => rename.cancel()}
						stopClick
					/>
				{:else}
					{#if who}<Handle text={who.text} state={st} />{/if}<span class="t">{titleOf(x)}</span>{#if on && parent}<span class="from mono" title={parent.title}><Icon name="fork" /><span class="fn">{parent.text}</span></span>{/if}{#if sched.count}<span class="tclock" aria-hidden="true"><Icon name="clock" /></span>{/if}
				{/if}
				{#if x.kind === "group"}<span class="n mono">{x.members.length}</span>{/if}
				{#if x.kind !== "group"}<button class="x tap" onpointerdown={(e) => e.stopPropagation()} onclick={(e) => (e.stopPropagation(), close(x))} aria-label={closeLabel(x)} title={closeTip(x)}><Icon name="x" /></button>{/if}
			</div>
{/snippet}

{#if app.serverId && app.net !== "idle"}
	<!-- a double click on the bar's empty part starts a new chat in this folder, as in a browser's tab strip -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="bar" data-part="tabbar" class:solo={tabs.length <= 1 && tabs[0]?.kind !== "group" && fileTabs.length === 0} class:group={!activeFile && app.activeTab?.tab.kind === "group"} use:dropTarget={stripTarget} ondblclick={blankDouble}>
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div class="tabs" role="tablist" aria-label={t("탭")} bind:this={strip} onwheel={wheel} onfocusin={reveal} use:rovingKeys={{ item: '[role="tab"], .gchip' }} use:dragScroll use:edgeFade use:slidingIndicator={{ selector: ".tab.on, .gchip.on" }}>
			{#each tabs as x (x.id)}
				{@const on = x.id === activeTab}
				{@const st = stateOf(x)}
				{@const lead = leads[x.id]}
				{#if lead}<span class="lead" class:sep={lead.sep} title={lead.title}><Icon name={lead.icon} /></span>{/if}
				<!-- a group is a tray of its sessions' chips, laid out inline with the other tabs (its name is in the page
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
					{@render tabItem(x, on, st)}
				{/if}
			{/each}
			{#if tabs.length > 0 && fileTabs.length > 0}
				<span class="fdiv" aria-hidden="true"></span>
			{/if}
			{#each fileTabs as fp (fp)}
				{@const on = fp === activeFile}
				{@const ch = workspaceViewer.changeFor(fp)}
				{@const base = fp.split("/").pop() ?? fp}
				{@const fCloseTip = t("닫기") + (on && app.prefs.bindings.closeSession ? ` · ${formatCombo(app.prefs.bindings.closeSession)}` : "")}
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div
					class="tab filetab"
					class:on
					data-file-tab={fp}
					draggable="true"
					ondragstart={(e) => {
						if (!e.dataTransfer) return;
						e.dataTransfer.setData(WORKSPACE_FILE_MIME, JSON.stringify({ path: fp, dir: false }));
						e.dataTransfer.setData("text/plain", fp);
						e.dataTransfer.effectAllowed = "copy";
					}}
					role="tab"
					tabindex={on ? 0 : -1}
					aria-selected={on}
					title={fp}
					onclick={() => void workspaceViewer.activateFile(fp)}
					onauxclick={(e) => e.button === 1 && workspaceViewer.closeFile(fp)}
					onkeydown={(e) => {
						if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) {
							e.preventDefault();
							void workspaceViewer.activateFile(fp);
						}
					}}
				>
					<span class="fill" aria-hidden="true"></span>
					<span class="ico"><FileIcon name={base} /></span>
					<span class="t mono">{base}</span>
					{#if ch}<span class="fdot" class:add={ch.status === "A" || ch.status === "?"} class:del={ch.status === "D"} aria-hidden="true"></span>{/if}
					<button
						class="x tap"
						onpointerdown={(e) => e.stopPropagation()}
						onclick={(e) => {
							e.stopPropagation();
							workspaceViewer.closeFile(fp);
						}}
						aria-label={t("닫기")}
						title={fCloseTip}
					>
						<Icon name="x" />
					</button>
				</div>
			{/each}
			<div class="tail" class:over={end && !slot}></div>
		</div>
		<!-- "+" right after the last tab (a browser's new-tab button; it stays at the strip's edge once the tabs overflow), the
		     tab count pinned to the bar's right end (on a phone both sit in the header instead, see Header.svelte) -->
		<span class="ctlslot add"><TabControls part="add" /></span>
		<span class="ctlslot count"><TabControls part="count" /></span>
	</div>
	<RowMenu bind:this={menu} bind:open={menuId} />
{/if}

<style>
	/* A browser's tab strip (wider than a phone): the bar is a tone off the page (--bg-tabbar), the tab in front is a 28px grey pill
	   (--bg-tabbar-on, 8px corners all round, no ring or shadow) set into the middle of the bar, clear of its bottom hairline:
	   a step past a group's faint tray, so it reads as the one in front. The other tabs have no fill and no hairline: each is as wide as its content (up to 200px, the title
	   ellipsised past that), so they sit edge to edge, and the strip scrolls sideways when they do not fit. "+" follows the last tab
	   like a browser's new-tab button (at the strip's edge once the tabs overflow); the tab count is pinned to the bar's right end. */
	.bar {
		flex: none;
		display: flex;
		align-items: stretch;
		height: 38px;
		padding: 0 11px 0 max(0px, var(--sal)); /* right: the count's 18px square sits 5px inside its 28px button, so its edge lands on the 16px gutter (DESIGN rule 5); left: the strip pads itself */
		background: var(--bg-tabbar);
		box-shadow: inset 0 -1px var(--tabbar-line); /* the hairline under the strip, drawn below the tabs so the front one covers it */
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
	/* the tabs are as wide as they need, up to every pixel left of the controls, so "+" right after them follows the last tab */
	.tabs {
		position: relative;
		flex: 0 1 auto;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: 4px;
		padding-left: 8px; /* with the tab's own 8px, the first icon lands on 16, the header title's line */
		overflow-x: auto;
		overflow-y: hidden;
		overscroll-behavior-x: contain;
		scrollbar-width: none;
	}
	.tabs::-webkit-scrollbar {
		display: none;
	}
	/* the controls share the tabs' row and centre on it like the tabs. "+" comes after the strip's 4px tail (with the 4px gap, the last tab's
	   pill and the button's box stand 8px apart); the count takes the rest of the bar's width and sits at its right end. */
	.ctlslot {
		flex: none;
		display: flex;
		align-items: center;
	}
	.ctlslot.count {
		flex: 1 0 auto;
		justify-content: flex-end;
		padding-left: 8px;
	}
	@media (max-width: 600px) {
		.ctlslot {
			display: none;
		}
	}

	/* the front tab's fill is the sliding marker: a grey pill sunk into the bar, a step past hover. It is one marker for the
	   tabs and the group chips alike, so going from a tab into a group (or back) slides like going from tab to tab instead of
	   one pill vanishing and another appearing. It sits over a group's tray (which is why .gbox makes no stacking context)
	   and under the tabs' and chips' content, which come after it at the same z-index. */
	.tabs > :global(.slide-ind) {
		z-index: 1;
		background: var(--bg-tabbar-on);
		border-radius: var(--radius-sm);
	}

	/* a project's strip: each folder's run of tabs starts with an icon-only marker (fork: git folder, folder: hand-made), the name in its tooltip */
	.lead {
		position: relative;
		flex: none;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		height: 28px;
		padding: 0 4px 0 8px; /* the first marker's icon lands on 16 with the strip's 8px */
		color: var(--text-faint);
		user-select: none;
		-webkit-user-select: none;
	}
	/* a hairline between two folders' runs, never before the first (the sliding indicator is the strip's :first-child) */
	.lead.sep {
		margin-left: 4px; /* with the 4px gap, the hairline stands 8px after the previous pill */
	}
	.lead.sep::before {
		content: "";
		position: absolute;
		left: 0;
		top: calc(50% - 8px);
		width: 1px;
		height: 16px;
		background: var(--tabbar-line);
	}
	.lead > :global(svg) {
		flex: none;
		width: 14px;
		height: 14px;
		stroke-width: 1.9;
	}

	.tab {
		position: relative;
		z-index: 1; /* above the sliding fill */
		flex: none; /* as wide as its icon and title, up to 200px: a short title makes a short tab, and the strip scrolls when they do not fit */
		display: flex;
		align-items: center;
		gap: 4px;
		height: 28px;
		max-width: 200px;
		padding: 0 8px; /* the icon and the close glyph both clear the pill's edges by 8px */
		border-radius: var(--radius-sm);
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
		background: var(--bg-tabbar-on); /* until the sliding marker is placed */
		color: var(--text);
	}
	.tabs:global([data-indicator-ready]) .tab.on,
	.tabs:global([data-indicator-ready]) :global(.gchip.on) {
		background: transparent;
	}
	/* hover: the same pill as the front tab, filled a step darker than the bar */
	.fill {
		position: absolute;
		inset: 0;
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
	.tab.carried {
		opacity: 0.45;
	}
	/* the tab fills the strip to its bottom edge and the strip scrolls (clips): an outer ring lost its bottom and, on the
	   first tab of a phone, its left side, so the ring is drawn inside (scripts/ui-focus.py) */
	.tab:focus-visible {
		outline-offset: -2px;
	}

	/* a group is a tray of its sessions' chips, the same 28px row and 8px corners as a tab: a faint fill (the strip 5%
	   toward --text, under hover's 8%) with no ring, the chips edge to edge inside it at a tab's own height and padding. So
	   the open chip is the front tab's grey pill exactly, and the group's first and last icons stand where a tab's would.
	   The chips are what pick the pane while the group is enlarged, so the tray keeps its whole width and the bar scrolls. */
	.gbox {
		position: relative; /* no z-index: its tray paints under the strip's marker, its chips over it */
		flex: none;
		min-width: 0;
		display: flex;
		align-items: center;
		height: 28px;
		border-radius: var(--radius-sm);
		transition:
			margin var(--motion-fast) var(--ease-std),
			background var(--motion-fast) var(--ease-std);
	}
	.gbox + .gbox {
		margin-left: 4px;
	}
	@media (min-width: 601px) {
		.gbox {
			background: var(--bg-tabbar-group);
		}
		.gbox:not(.on).menuopen {
			background: var(--bg-tabbar-hover);
		}
		.gbox :global(.strip) {
			gap: 0;
		}
		.gbox :global(.gchip) {
			height: 28px;
			border-radius: var(--radius-sm);
		}
		.gbox :global(.gchip.on) {
			background: var(--bg-tabbar-on);
		}
		/* the backing of a chip's "leave" button: the colour under it (the tray, the hover pill or the front chip's) */
		.gbox :global(.gitem) {
			--xbg: var(--bg-tabbar-group);
		}
		.gbox :global(.gitem:has(.gchip.on)) {
			--xbg: var(--bg-tabbar-on);
		}
	}
	/* a chip under the pointer on the strip's tone (SessionStrip's own hover is the page's --bg-hover) */
	@media (hover: hover) and (min-width: 601px) {
		.gbox :global(.gitem:hover > .gchip:not(.on)) {
			background: var(--bg-tabbar-hover);
		}
		.gbox :global(.gitem:hover:not(:has(.gchip.on))) {
			--xbg: var(--bg-tabbar-hover);
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
		top: 0;
		bottom: 0; /* the tab's own 28px */
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
		width: 4px; /* air after the last tab, where a drop at the end shows its line: with the strip's 4px gap, "+" stands 8px after the last pill */
		align-self: stretch;
	}
	.tail.over::before {
		content: "";
		position: absolute;
		top: 5px;
		bottom: 5px; /* 28px, centred in the 38px strip like the tabs */
		left: 0;
		width: 2px;
		border-radius: 1px;
		background: var(--accent);
		z-index: 2;
		pointer-events: none;
	}

	/* the parent mark (fork icon + "@parent", like "forked from"): who made this conversation, after its title and quieter than its own handle */
	.from {
		flex: none;
		display: flex;
		align-items: center;
		gap: 4px;
		font-size: var(--fs-2xs);
		color: var(--text-faint);
		line-height: 16px; /* whole-pixel line box, centred on the title's like the handle (ui/Handle) */
	}
	.from :global(svg) {
		width: 12px;
		height: 12px;
		stroke-width: 2;
	}
	/* subtle clock icon for sessions with active scheduled tasks (matches sidebar SessionRow) */
	.tclock {
		flex: none;
		display: inline-flex;
		align-items: center;
		color: var(--text-faint);
	}
	.tclock :global(svg) {
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
	/* the close button sits at the tab's right end, where a browser's is, but only while the pointer is on the tab, and over
	   the end of the title rather than in a slot of its own: a tab is only as wide as its icon and title, never grows on
	   hover, and leaves no blank where a hidden × would wait (that blank set "+" after the last tab apart like a tab without
	   a title). Its box is the pill's own colour (--xbg) with a 24px fade on its left, so the title runs out under it instead
	   of being cut. The glyph's right edge is 8px in from the pill's, as the icon's left edge is on the other side. */
	.tab {
		--xbg: var(--bg-tabbar);
	}
	.tab.menuopen {
		--xbg: var(--bg-tabbar-hover);
	}
	@media (hover: hover) {
		.tab:hover {
			--xbg: var(--bg-tabbar-hover);
		}
	}
	.tab.on.tab {
		--xbg: var(--bg-tabbar-on); /* .tab.on.tab: outranks the hover rule above, the front pill keeps its own colour */
	}
	.x {
		position: absolute;
		right: 5px;
		top: 4px;
		display: grid;
		place-items: center;
		width: 20px;
		height: 20px;
		border-radius: var(--radius-pill); /* a round close target, as in Chrome */
		background-color: var(--xbg);
		color: var(--text-dim);
		opacity: 0;
		transition:
			opacity var(--motion-fast) var(--ease-std),
			color var(--motion-fast) var(--ease-std);
	}
	.x::before {
		content: "";
		position: absolute;
		top: 0;
		bottom: 0;
		right: 100%;
		width: 24px;
		background: linear-gradient(to right, color-mix(in srgb, var(--xbg) 0%, transparent), color-mix(in srgb, var(--xbg) 60%, transparent) 50%, var(--xbg));
		pointer-events: none;
	}
	.tab:hover .x,
	.tab.menuopen .x,
	.x:focus-visible {
		opacity: 1;
	}
	.x:focus-visible {
		outline-offset: -2px; /* inside the 20px target so the outer ring is never clipped by the scrolling .tabs strip */
	}
	/* no hover on a touch screen: the × is always there, after the title as before */
	@media (pointer: coarse) {
		.x {
			position: static;
			flex: none;
			opacity: 1;
			color: var(--text-faint);
		}
		.tab.on .x {
			color: var(--text-dim);
		}
	}
	/* where the × sits after the title (touch, the phone strip) it has room of its own: no backing, no fade */
	@media (pointer: coarse), (max-width: 600px) {
		.x {
			background-color: transparent;
		}
		.x::before {
			display: none;
		}
	}
	@media (hover: hover) {
		.x:hover {
			background-image: linear-gradient(color-mix(in srgb, var(--text) 10%, transparent), color-mix(in srgb, var(--text) 10%, transparent)); /* a step darker than the pill it sits on */
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
			box-shadow: inset 0 -1px var(--border); /* the header's hairline above: the strip's darker --tabbar-line is for the grey bar only */
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
		.tab {
			flex: none;
			height: 28px;
			padding: 0 4px 0 8px;
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
		.tab :global(.inline-rename) {
			flex: none;
			width: 140px;
		}
		.tail {
			width: 8px; /* no "+" after the tabs here: the strip's own air at its end */
		}
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
		.gbox + .gbox,
		.gbox:first-child {
			margin-left: 0;
		}
		/* the phone strip keeps its × after the title (shown on the front tab, under a mouse, always on touch) */
		.x {
			position: static;
			flex: none;
			color: var(--text-faint);
			width: 22px;
			height: 22px;
		}
		.tab.on .x {
			opacity: 1;
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

	.fdiv {
		flex: none;
		width: 1px;
		height: 16px;
		margin: 0 4px;
		background: var(--tabbar-line);
		align-self: center;
	}
	.fdot {
		flex: none;
		width: 6px; /* optical 6px indicator matching sidebar status dots */
		height: 6px; /* optical 6px indicator matching sidebar status dots */
		border-radius: var(--radius-pill);
		background: var(--warn);
	}
	.fdot.add {
		background: var(--ok);
	}
	.fdot.del {
		background: var(--danger);
	}
</style>
