<script lang="ts">
	import { sessionTitle } from "../lib/session-title";
	import { RENAME_KEY } from "../lib/keys";
	import { t } from "../lib/i18n";
	import { formatCombo } from "../lib/keys";
	import Icon from "./Icon.svelte";
	import NavbarItems from "./extensions/NavbarItems.svelte";
	import ExtensionSlot from "./extensions/ExtensionSlot.svelte";
	import ExtensionMount from "./extensions/ExtensionMount.svelte";
	import ExtensionPart from "./extensions/ExtensionPart.svelte";
	import { app } from "../lib/store.svelte";
	import { panesOf } from "../lib/layout";
	import { viewport } from "../lib/viewport.svelte";
	import { InlineRename } from "../lib/inline-rename.svelte";
	import { registerRenamePlace } from "../lib/rename-places";
	import { closeContextMenu, openContextMenu } from "../lib/context-menu";
	import { pressMenu, type Point } from "../lib/press-menu";
	const hint = $derived(app.prefs.bindings.toggleSidebar ? ` (${formatCombo(app.prefs.bindings.toggleSidebar)})` : "");

	const s = $derived(app.current);
	const term = $derived(app.terminal(app.activeId));
	/** The open group: the header reads as a path, "group › the session being looked at" (on every screen size). */
	const group = $derived(app.activeGroup);
	/** The session in the group shown alone (a phone, or one pane enlarged), named after the group; none while all panes show. */
	const crumb = $derived(group && (viewport.narrow || app.isFull(group.id) || app.zoomId) ? (term ?? s) : undefined);
	const crumbTitle = $derived(crumb ? ("shell" in crumb ? crumb.title : (crumb.title ?? t("대화"))) : "");
	/** The title being renamed in place: the group's, the terminal's or the conversation's (double click or right click). */
	const rename = new InlineRename();
	/** What the title is about, for renaming: nothing for a chat that has no session yet. With a "group › session" path the
	 *  session is the current step, so the keyboard and a double click on it rename the session; the group's name renames the group. */
	const sessionTarget = $derived(term ? { id: term.id, name: term.title } : s ? { id: s.id, name: s.title } : null);
	const groupTarget = $derived(group ? { id: group.id, name: group.name } : null);
	const target = $derived(group && !crumb ? groupTarget : sessionTarget);
	/**
	 * The title is where F2 renames the open thing when the sidebar is folded away (it has no row then); while the sidebar
	 * shows, its row comes first (see `rename-places`).
	 */
	$effect(() =>
		registerRenamePlace({
			order: 2,
			zone: '[data-part="header"]',
			open: () => (target ? { id: target.id, title: target.name } : null),
			start: (id, title) => rename.start(id, title),
		})
	);
	function commitRename() {
		const done = rename.commit();
		if (!done) return;
		if (group?.id === done.id) void app.renameGroup(done.id, done.name);
		else if (app.terminal(done.id)) void app.renameTerminal(done.id, done.name);
		else void app.rename(done.id, done.name);
	}
	function focusSelect(node: HTMLInputElement) {
		node.focus();
		node.select();
	}
	function titleMenu(pt: Point) {
		if (!target) return;
		const { id, name } = target;
		const items = [{ icon: "pencil" as const, label: group && !crumb ? t("그룹 이름 바꾸기") : t("이름 바꾸기"), title: "", run: () => rename.start(id, name) }];
		// on a path both steps can be renamed from here
		if (group && crumb && groupTarget) items.push({ icon: "pencil", label: t("그룹 이름 바꾸기"), title: "", run: () => rename.start(groupTarget.id, groupTarget.name) });
		openContextMenu(pt, `title:${id}`, items);
		return closeContextMenu;
	}
	/** What the title shows, also handed to an extension that replaces it. */
	const heading = $derived(
		group ? { title: crumb ? `${group.name} › ${crumbTitle}` : group.name, sub: crumb ? crumb.cwd.split(/[\\/]/).slice(-2).join("/") : t("대화 {n}개", { n: panesOf(group.layout).length }) }
		: term ? { title: term.title, sub: `${t("터미널")} · ${term.cwd.split(/[\\/]/).slice(-2).join("/")}` }
		: { title: sessionTitle(s?.title), sub: s ? s.cwd.split(/[\\/]/).slice(-2).join("/") : "" },
	);
</script>

<header class:group={!!group} data-part="header">
	<div class="capsule">
		<ExtensionMount slot="header.start" />
		<button class="tool menu" onclick={() => (app.sidebar.open = true)} aria-label={t("사이드바 열기")} title={t("사이드바 열기") + hint}>
			<Icon name="sidebar" />
		</button>

		<ExtensionPart part="header.title" props={{ title: heading.title, subtitle: heading.sub, kind: group ? "group" : term ? "terminal" : "chat" }}>
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div class="title" data-part="header.title" tabindex="-1" onkeydown={(e) => e.key === RENAME_KEY && target && !rename.is(target.id) && (e.preventDefault(), rename.start(target.id, target.name))} use:pressMenu={titleMenu}>
			{#if (target && rename.is(target.id)) || (groupTarget && rename.is(groupTarget.id))}
				{@const renamingGroup = !!groupTarget && rename.is(groupTarget.id)}
				<input
					class="rename"
					value={rename.draft}
					maxlength={renamingGroup ? 100 : undefined}
					aria-label={renamingGroup ? t("그룹 이름 바꾸기") : t("이름 바꾸기")}
					use:focusSelect
					oninput={(e) => (rename.draft = e.currentTarget.value)}
					onblur={commitRename}
					onkeydown={(e) => {
						if (e.key === "Enter") commitRename();
						if (e.key === "Escape") rename.cancel();
					}}
				/>
			{:else if group}
				<span class="t crumbs">
					<span class="gname">{group.name}</span>
					{#if crumb}<span class="sep" aria-hidden="true"><Icon name="chevron-right" /></span><span class="cur">{crumbTitle}</span>{/if}
				</span>
				<span class="sub mono">{crumb ? crumb.cwd.split(/[\\/]/).slice(-2).join("/") : t("대화 {n}개", { n: panesOf(group.layout).length })}</span>
			{:else if term}
				<span class="t">{term.title}</span>
				<span class="sub mono">{t("터미널")} · {term.cwd.split(/[\\/]/).slice(-2).join("/")}</span>
			{:else}
				<span class="t">{sessionTitle(s?.title)}</span>
				{#if s}<span class="sub mono">{s.cwd.split("/").slice(-2).join("/")}</span>{/if}
			{/if}
		</div>

		</ExtensionPart>

		<NavbarItems />
		<!-- The right sidebar's toggle, shown while it is shut. Open, it lives in the panel's own header row (the way the left
		     sidebar's fold button lives in its brand row) at the very same screen position, so it never jumps. -->
		{#if !app.right.open}
			<button class="tool right" onclick={() => app.right.toggle()} aria-label={t("우측 사이드바 열기")} title={t("우측 사이드바 열기")}>
				<Icon name="sidebar-right" />
			</button>
		{/if}
		<ExtensionMount slot="header.end" />

	</div>
</header>
<ExtensionMount slot="header.below" />
<ExtensionSlot slot="header" />


<style>
	header {
		flex: none;
		z-index: 10; /* above the pane's own scroll content (fade, sticky rows); below every popover and dialog */
		padding: var(--sat) var(--sar) 0 var(--sal);
		border-bottom: 1px solid var(--border);
		background: var(--bg);
	}
	.capsule {
		display: flex;
		align-items: center;
		gap: 4px;
		height: 44px;
		/* Every visible edge sits 16px from the window, like the extension button below. The round menu button's circle is
		   only a hover state, so the drawn icon is what counts: the sidebar glyph's strokes start ~2.4px inside its 19px box,
		   so left = 3px + 10.5px around the icon + 2.4px of glyph inset (set below where the menu shows) or 6px + the title's own 10px; right = 13px + the 3px padding of the nav slot. */
		padding: 0 12px 0 4px;
	}
	.title {
		flex: 1 1 0;
		/* The title keeps priority over the extension slot: never squeezed to nothing. */
		min-width: min(96px, 40%);
		display: flex;
		flex-direction: column;
		justify-content: center;
		padding: 0 12px; /* with the 4px capsule padding the title text starts at 16: the tab label's and the conversation column's line */
	}
	/* "group › session": the group's name is the dimmer first step, the session the current one */
	.crumbs {
		display: flex;
		align-items: center;
		gap: 4px;
		min-width: 0;
	}
	.crumbs .gname {
		flex: 0 1 auto;
		min-width: 0;
		max-width: 50%;
		overflow: hidden;
		text-overflow: ellipsis;
		color: var(--text-dim);
	}
	.crumbs .sep {
		flex: none;
		display: grid;
		place-items: center;
		color: var(--text-faint);
	}
	.crumbs .sep :global(svg) {
		width: 14px;
		height: 14px;
		stroke-width: 2;
	}
	.crumbs .cur {
		flex: 0 1 auto;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.t {
		font-weight: 600;
		font-size: var(--fs-md);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		line-height: 1.2;
	}
	.rename {
		width: min(100%, 360px);
		min-width: 0;
		height: 28px;
		padding: 0 8px;
		border: 1px solid var(--accent);
		border-radius: var(--radius-sm);
		background: var(--bg);
		color: var(--text);
		font-size: var(--fs-md);
		outline: 0;
	}
	.sub {
		font-size: var(--fs-2xs);
		color: var(--text-faint);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		line-height: 1.2;
	}
	.tool {
		display: grid;
		place-items: center;
		width: 40px;
		height: 40px;
		border-radius: 50%;
		color: var(--text-dim);
		transition:
			background var(--motion-fast) var(--ease-std),
			color var(--motion-fast) var(--ease-std);
	}
	/* 40px in a 44px bar: an outer ring would run into the window's top edge, so it is drawn inside */
	.tool:focus-visible {
		outline-offset: -2px;
	}
	.tool:hover {
		background: var(--bg-hover);
		color: var(--text);
	}
	.tool :global(svg) {
		width: 19px;
		height: 19px;
		stroke-width: 1.75;
	}
	.menu {
		display: none;
	}
	/* The right sidebar's toggle (only while it is shut). Measured, not guessed: the capsule pads
	   12px on the right, so the 40px button bleeds -8px and its 19px glyph (10.5px in, its ink a further 2.4px) ends
	   16.9px from the window, exactly where the left menu button's ink starts. At 32px the inset is 6.5px, so -4px. */
	.right {
		margin-right: -8px;
	}
	@media (max-width: 640px) {
		/* the nav slot pads 2px here */
		.capsule { padding-right: 12px; }
		.title { padding: 0 4px; }
		.tool { width: 32px; }
	}
	@media (max-width: 860px) {
		.capsule { padding-left: 4px; }
		.menu {
			display: grid;
		}
		/* the drawer's own button is in the sidebar; the right one opens a sheet, so it stays */
		.right {
			width: 32px;
			margin-right: -4px; /* the 32px box holds the glyph 6.5px in: the ink still ends 16.9px from the window */
		}
	}
	@media (max-width: 640px) {
		/* declared after the 860px rule so it wins: the 32px button leaves 6.5px around the icon */
		.capsule { padding-left: 8px; }
	}
</style>
