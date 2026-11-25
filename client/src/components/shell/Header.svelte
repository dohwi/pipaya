<script lang="ts">
	import { sessionTitle } from "../../lib/session-title";
	import { RENAME_KEY } from "../../lib/keys";
	import { t } from "../../lib/i18n";
	import { formatCombo } from "../../lib/keys";
	import { baseName, sizeLabel, splitFilePath } from "../../lib/files";
	import Button from "../ui/Button.svelte";
	import Icon from "../ui/Icon.svelte";
	import IconButton from "../ui/IconButton.svelte";
	import InlineRenameField from "../ui/InlineRenameField.svelte";
	import Segmented from "../ui/Segmented.svelte";
	import FileIcon from "../workspace/FileIcon.svelte";
	import TabControls from "./TabControls.svelte";
	import NavbarItems from "../extensions/NavbarItems.svelte";
	import ExtensionSlot from "../extensions/ExtensionSlot.svelte";
	import ExtensionMount from "../extensions/ExtensionMount.svelte";
	import ExtensionPart from "../extensions/ExtensionPart.svelte";
	import { app } from "../../lib/store.svelte";
	import { formatCompactCount } from "../../lib/workspace-edits";
	import { workspaceViewer } from "../../lib/workspace-viewer.svelte";
	import { panesOf } from "../../lib/layout";
	import { workDir } from "../../lib/nav";
	import { viewport } from "../../lib/viewport.svelte";
	import { InlineRename } from "../../lib/inline-rename.svelte";
	import { registerRenamePlace } from "../../lib/rename-places";
	import { closeContextMenu, openContextMenu } from "../../lib/context-menu";
	import { pressMenu, type Point } from "../../lib/press-menu";
	const hint = $derived(app.prefs.bindings.toggleSidebar ? ` (${formatCombo(app.prefs.bindings.toggleSidebar)})` : "");
	const filesHint = $derived(app.prefs.bindings.toggleFiles ? ` (${formatCombo(app.prefs.bindings.toggleFiles)})` : "");

	const s = $derived(app.current);
	const term = $derived(app.terminal(app.activeId));
	const activeFile = $derived(!app.graphOpen ? workspaceViewer.activeFile : null);
	const fileName = $derived(activeFile ? baseName(activeFile) : "");
	const fileDir = $derived(activeFile ? (splitFilePath(activeFile)?.dir.replace(/\/$/, "") ?? "") : "");
	const fileChange = $derived(activeFile ? workspaceViewer.changeFor(activeFile) : undefined);
	const fileCtrl = $derived(activeFile && workspaceViewer.paneControl?.path === activeFile ? workspaceViewer.paneControl : null);
	const fileSub = $derived.by(() => {
		if (!activeFile) return "";
		const parts: string[] = [];
		if (fileDir) parts.push(fileDir);
		if (fileCtrl?.imgDims) parts.push(`${fileCtrl.imgDims.w}×${fileCtrl.imgDims.h}`);
		if (fileCtrl?.size !== undefined && !fileCtrl.editing) parts.push(sizeLabel(fileCtrl.size));
		return parts.join(" · ");
	});
	/** The open group: the header reads as a path, "group › the session being looked at" (on every screen size). */
	const group = $derived(app.activeGroup);
	/** The session in the group shown alone (a phone, or one pane enlarged), named after the group; none while all panes show. */
	const crumb = $derived(group && (viewport.narrow || app.isFull(group.id) || app.zoomId) ? (term ?? s) : undefined);
	const crumbTitle = $derived(crumb ? ("shell" in crumb ? crumb.title : sessionTitle(crumb.title)) : "");
	/** The title being renamed in place: the group's, the terminal's or the conversation's (double click or right click). */
	const rename = new InlineRename();
	/** What the title is about, for renaming: nothing for a chat that has no session yet. With a "group › session" path the
	 *  session is the current step, so the keyboard and a double click on it rename the session; the group's name renames the group. */
	const sessionTarget = $derived(term ? { id: term.id, name: term.title } : s ? { id: s.id, name: s.title } : null);
	const groupTarget = $derived(group ? { id: group.id, name: group.name } : null);
	const target = $derived(activeFile ? null : group && !crumb ? groupTarget : sessionTarget);
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
		activeFile ? { title: fileName, sub: fileSub }
		: group ? { title: crumb ? `${group.name} › ${crumbTitle}` : group.name, sub: crumb ? workDir(crumb).split(/[\\/]/).slice(-2).join("/") : t("대화 {n}개", { n: panesOf(group.layout).length }) }
		: term ? { title: term.title, sub: `${t("터미널")} · ${term.cwd.split(/[\\/]/).slice(-2).join("/")}` }
		: { title: sessionTitle(s?.title), sub: s ? workDir(s).split(/[\\/]/).slice(-2).join("/") : "" },
	);
</script>

<header class:group={!!group && !activeFile} data-part="header">
	<div class="capsule">
		<!-- the extension parts of the bar move to the graph view's header while it covers this one (GraphView .head) -->
		{#if !app.graphOpen}<ExtensionMount slot="header.start" />{/if}
		<button class="tool menu tap" onclick={() => (app.sidebar.open = true)} aria-label={t("사이드바 열기")} aria-expanded={app.sidebar.open} aria-controls="app-sidebar" title={t("사이드바 열기") + hint}>
			<Icon name="sidebar" />
		</button>

		<ExtensionPart part="header.title" props={{ title: heading.title, subtitle: heading.sub, kind: activeFile ? "file" : group ? "group" : term ? "terminal" : "chat" }}>
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div class="title" data-part="header.title" tabindex="-1" onkeydown={(e) => e.key === RENAME_KEY && target && !rename.is(target.id) && (e.preventDefault(), rename.start(target.id, target.name))} use:pressMenu={titleMenu}>
			{#if activeFile}
				<span class="t fhead" title={activeFile}>
					<FileIcon name={fileName} />
					<span class="fname mono">{fileName}</span>
					{#if fileCtrl?.editDirty}
						<span class="edirty">{t("수정됨")}</span>
					{/if}
					{#if !fileCtrl?.editing && fileChange && (fileChange.additions > 0 || fileChange.deletions > 0)}
						<span class="fstat mono" title="+{fileChange.additions.toLocaleString()} / -{fileChange.deletions.toLocaleString()}">
							{#if fileChange.additions > 0}<span class="fadd">+{formatCompactCount(fileChange.additions)}</span>{/if}
							{#if fileChange.deletions > 0}<span class="fdel">-{formatCompactCount(fileChange.deletions)}</span>{/if}
						</span>
					{/if}
				</span>
				{#if fileSub}<span class="sub mono" title={activeFile}>{fileSub}</span>{/if}
			{:else if (target && rename.is(target.id)) || (groupTarget && rename.is(groupTarget.id))}
				{@const renamingGroup = !!groupTarget && rename.is(groupTarget.id)}
				<InlineRenameField
					variant="bar"
					class="header-rename"
					value={rename.draft}
					maxlength={renamingGroup ? 100 : undefined}
					ariaLabel={renamingGroup ? t("그룹 이름 바꾸기") : t("이름 바꾸기")}
					oninput={(v) => (rename.draft = v)}
					oncommit={commitRename}
					oncancel={() => rename.cancel()}
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
				{#if s}<span class="sub mono">{workDir(s).split("/").slice(-2).join("/")}</span>{/if}
			{/if}
		</div>

		</ExtensionPart>

		{#if !app.graphOpen}
			{#if activeFile && fileCtrl}
				<div class="ftools" data-part="header.file-tools">
					{#if fileCtrl.editing}
						<Button size="sm" variant="primary" disabled={fileCtrl.editSaving} onclick={fileCtrl.onCommitEdit}>
							{t("저장")}
						</Button>
						<Button size="sm" variant="default" disabled={fileCtrl.editSaving} onclick={fileCtrl.onCancelEdit}>
							{t("취소")}
						</Button>
					{:else}
						{#if fileCtrl.showChangeNav}
							<div class="fcnav">
								<IconButton icon="arrow-up" size="sm" label={t("이전 변경")} onclick={() => fileCtrl.onJumpChange(fileCtrl.activeChangeIdx - 1)} />
								<span class="fcidx mono">{fileCtrl.activeChangeIdx + 1}/{fileCtrl.changeCount}</span>
								<IconButton icon="arrow-down" size="sm" label={t("다음 변경")} onclick={() => fileCtrl.onJumpChange(fileCtrl.activeChangeIdx + 1)} />
							</div>
						{/if}
						{#if fileCtrl.modeOptions.length > 0}
							<Segmented
								label={t("보기 모드")}
								options={fileCtrl.modeOptions}
								value={fileCtrl.activeModeId}
								size="sm"
								full={false}
								onchange={fileCtrl.onModeChange}
							/>
							<span class="fsep" aria-hidden="true"></span>
						{/if}
						<div class="fact">
							{#if fileCtrl.canEdit}
								<IconButton
									icon="pencil"
									size="sm"
									label={t("직접 수정 (더블클릭)")}
									tip
									onclick={fileCtrl.onStartEdit}
								/>
							{/if}
							<span data-file-comment-btn="true">
								<IconButton
									icon="chat"
									size="sm"
									label={t("이 파일에 코멘트")}
									tip
									class={{ on: fileCtrl.fileCommentOpen }}
									onclick={fileCtrl.onToggleFileComment}
								/>
							</span>
							{#if fileCtrl.canCopy}
								<IconButton icon={fileCtrl.copied ? "check" : "copy"} size="sm" label={t("복사")} tip onclick={fileCtrl.onCopy} />
							{/if}
							<IconButton icon="download" size="sm" label={t("저장")} tip disabled={fileCtrl.saving} onclick={fileCtrl.onDownload} />
						</div>
					{/if}
				</div>
			{/if}
			<NavbarItems />
			<ExtensionMount slot="header.end" />
		{/if}
		<!-- a phone only: "+" and the tab count, the cluster the tab strip carries at its right end on wider screens -->
		{#if app.serverId && app.net !== "idle"}<span class="tabs"><TabControls place="header" /></span>{/if}
		<!-- Narrow viewports only (<= 860px): right workspace drawer toggle mirroring `.menu` on the left. On desktop, the right sidebar stays docked as a collapsible rail. -->
		{#if !app.graphOpen && workspaceViewer.sessionId}
			<button
				class="tool files-toggle tap"
				onclick={() => app.toggleFiles()}
				aria-label={t("파일 뷰어")}
				aria-expanded={app.filesOpen}
				title={t("파일 뷰어") + filesHint}
			>
				<Icon name="folder" />
				{#if workspaceViewer.changes.length > 0}<span class="fdot" aria-hidden="true"></span>{/if}
			</button>
		{/if}

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
	/* Above a browser-style tab strip (wider than a phone) the header is the strip's own tone, one chrome band like a browser's
	   title bar over its tabs (a white header over a grey strip stacked three tones). The hairline stays, in the strip's
	   --tabbar-line (--border is lost on light's strip), so the title row and the tabs read as two rows; it meets the sidebar
	   brand row's line at the same height. */
	@media (min-width: 601px) {
		:global(main:has(> [data-part="tabbar"])) > header {
			border-bottom-color: var(--tabbar-line);
			background: var(--bg-tabbar);
		}
		@media (hover: hover) {
			:global(main:has(> [data-part="tabbar"])) > header .tool:hover {
				background: var(--bg-tabbar-hover); /* --bg-hover is lighter than the strip's tone on light */
			}
		}
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
		line-height: 17px;
	}
	.fhead {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
		line-height: 20px;
	}
	.fname {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: var(--fs-sm);
		line-height: 20px;
	}
	.edirty {
		font-size: var(--fs-2xs);
		font-weight: 500;
		color: var(--warn);
		flex: none;
		line-height: 16px;
	}
	.fstat {
		display: inline-flex;
		gap: 4px;
		font-size: var(--fs-2xs);
		font-weight: 500;
		flex: none;
		line-height: 16px;
	}
	.fadd {
		color: var(--ok);
	}
	.fdel {
		color: var(--danger);
	}
	.ftools {
		flex: none;
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.fcnav {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		flex: none;
	}
	.fcidx {
		font-size: var(--fs-2xs);
		color: var(--text-faint);
		line-height: 16px;
	}
	.fsep {
		width: 1px;
		height: 16px;
		background: var(--border-strong);
		flex: none;
	}
	.fact {
		display: inline-flex;
		align-items: center;
		gap: 0; /* 32px sm buttons already carry 8px inner padding each (16px ink-to-ink), keeping icon spacing tight and uniform */
		flex: none;
	}
	/* 32px sm buttons inside the 44px Header bar: keep focus ring inside to prevent clipping */
	.ftools :global(.iconbtn:focus-visible) {
		outline-offset: -2px;
	}
	@media (max-width: 640px) {
		.ftools {
			display: none;
		}
	}
	.title :global(.header-rename) {
		flex: none;
		width: min(100%, 360px);
		font-size: var(--fs-md);
	}
	.sub {
		font-size: var(--fs-2xs);
		color: var(--text-faint);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		line-height: 13px;
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
	@media (hover: hover) {
		.tool:hover {
			background: var(--bg-hover);
			color: var(--text);
		}
	}
	.tool :global(svg) {
		width: 19px;
		height: 19px;
		stroke-width: 1.75;
	}
	/* Shown only below the desktop sidebar breakpoint (<= 860px), mirroring `.menu` on the left */
	.tool.files-toggle {
		display: none;
		position: relative;
		flex: none;
	}
	.fdot {
		position: absolute;
		top: 9px;
		right: 9px;
		width: 6px; /* optical 6px indicator matching tab/tree change dots */
		height: 6px; /* optical 6px indicator matching tab/tree change dots */
		border-radius: var(--radius-pill);
		background: var(--warn);
		pointer-events: none;
	}
	.menu {
		display: none;
	}
	/* a phone only: the tab strip folds away there for a lone tab, so "+" and the count live where the thumb always finds
	   them, like a mobile browser's buttons beside its address bar */
	.tabs {
		display: none;
	}
	@media (max-width: 860px) {
		.capsule { padding-left: 4px; }
		.menu {
			display: grid;
		}
		.tool.files-toggle {
			display: grid;
			/* 12px capsule padding - 7px + 20px (half of 40px button) = 25px from right edge, matching TabBar TabCountButton center (11 + 14 = 25px) */
			margin-right: -7px;
		}
	}
	@media (max-width: 640px) {
		/* declared after the 860px rule so it wins: the 32px button leaves 6.5px around the icon */
		.capsule { padding-left: 8px; padding-right: 12px; }
		.title { padding: 0 4px; }
		.tool {
			width: 32px;
			border-radius: min(var(--radius-pill), 16px); /* 32 x 40: a rounded slot, not a 50% oval */
		}
		.tool.files-toggle {
			/* 12px capsule padding - 3px + 16px (half of 32px button) = 25px from right edge, matching TabCountButton center */
			margin-right: -3px;
		}
		.fdot {
			top: 9px;
			right: 5px;
		}
	}
	@media (max-width: 600px) {
		.tabs {
			display: contents;
		}
		.tabs :global(.ctl) {
			margin-right: -4px; /* cancel the capsule's 4px flex gap so "+", count, and the right folder toggle read as one even 28px-wide cluster */
		}
		.tool.files-toggle {
			width: 28px; /* overrides the 640px .tool 32px rule (via specificity) to match TabControls' 28px buttons */
			margin-right: -4px; /* pull the 28px button's 4.5px right glyph inset into the 12px phone capsule gutter */
			border-radius: min(var(--radius-pill), 14px);
		}
		.fdot {
			top: 10px;
			right: 4px;
		}
	}
</style>
