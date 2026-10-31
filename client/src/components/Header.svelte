<script lang="ts">
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
	import { closeContextMenu, openContextMenu } from "../lib/context-menu";
	import { pressMenu, type Point } from "../lib/press-menu";
	const hint = $derived(app.prefs.bindings.toggleSidebar ? ` (${formatCombo(app.prefs.bindings.toggleSidebar)})` : "");

	const s = $derived(app.current);
	const term = $derived(app.terminal(app.activeId));
	// Wide screens show the whole group at once, so the header names the group rather than one session.
	const group = $derived(viewport.narrow ? undefined : app.activeGroup);
	/** The title being renamed in place: the group's, the terminal's or the conversation's (double click or right click). */
	const rename = new InlineRename();
	/** What the title is about, for renaming: nothing for a chat that has no session yet. */
	const target = $derived(group ? { id: group.id, name: group.name } : term ? { id: term.id, name: term.title } : s ? { id: s.id, name: s.title } : null);
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
		openContextMenu(pt, `title:${id}`, [{ icon: "pencil", label: group ? t("그룹 이름 바꾸기") : t("이름 바꾸기"), title: "", run: () => rename.start(id, name) }]);
		return closeContextMenu;
	}
	/** What the title shows, also handed to an extension that replaces it. */
	const heading = $derived(
		group ? { title: group.name, sub: t("대화 {n}개", { n: panesOf(group.layout).length }) }
		: term ? { title: term.title, sub: `${t("터미널")} · ${term.cwd.split(/[\\/]/).slice(-2).join("/")}` }
		: { title: s?.title ?? t("새 대화"), sub: s ? s.cwd.split(/[\\/]/).slice(-2).join("/") : "" },
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
		<div class="title" data-part="header.title" tabindex="-1" onkeydown={(e) => e.key === RENAME_KEY && target && !rename.is(target.id) && (e.preventDefault(), rename.start(target.id, target.name))} ondblclick={() => target && rename.start(target.id, target.name)} use:pressMenu={titleMenu}>
			{#if target && rename.is(target.id)}
				<input
					class="rename"
					value={rename.draft}
					maxlength={group ? 100 : undefined}
					aria-label={group ? t("그룹 이름 바꾸기") : t("이름 바꾸기")}
					use:focusSelect
					oninput={(e) => (rename.draft = e.currentTarget.value)}
					onblur={commitRename}
					onkeydown={(e) => {
						if (e.key === "Enter") commitRename();
						if (e.key === "Escape") rename.cancel();
					}}
				/>
			{:else if group}
				<span class="t">{group.name}</span>
				<span class="sub mono">{t("대화 {n}개", { n: panesOf(group.layout).length })}</span>
			{:else if term}
				<span class="t">{term.title}</span>
				<span class="sub mono">{t("터미널")} · {term.cwd.split(/[\\/]/).slice(-2).join("/")}</span>
			{:else}
				<span class="t">{s?.title ?? t("새 대화")}</span>
				{#if s}<span class="sub mono">{s.cwd.split("/").slice(-2).join("/")}</span>{/if}
			{/if}
		</div>

		</ExtensionPart>

		<NavbarItems />
		<ExtensionMount slot="header.end" />

	</div>
</header>
<ExtensionMount slot="header.below" />
<ExtensionSlot slot="header" />


<style>
	header {
		flex: none;
		z-index: 10;
		padding: var(--sat) var(--sar) 0 var(--sal);
		border-bottom: 1px solid var(--border);
		background: var(--bg);
	}
	header.group {
		background: var(--bg-group);
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
	}
	@media (max-width: 640px) {
		/* declared after the 860px rule so it wins: the 32px button leaves 6.5px around the icon */
		.capsule { padding-left: 8px; }
	}
</style>
