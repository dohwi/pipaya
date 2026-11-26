<script lang="ts">
	import ExtensionMount from "./components/extensions/ExtensionMount.svelte";
	import { onMount, untrack } from "svelte";
	import { installFocusRescue } from "./lib/focus-rescue";
	import { isTouch } from "./lib/format";
	import { warmMarkdown } from "./lib/markdown";
	import { backLayer, handleBack } from "./lib/dialog";
	import { mouseNavDirection } from "./lib/back-trail";
	import { OVERLAY_SELECTOR } from "./lib/keys";
	import { fadeIn, fadeOut } from "./lib/motion";
	import Icon from "./components/ui/Icon.svelte";
	import Spinner from "./components/ui/Spinner.svelte";
	import Sidebar from "./components/shell/Sidebar.svelte";
	import Rail from "./components/shell/Rail.svelte";
	import { drag, dropTarget } from "./lib/dnd.svelte";
	import { SidebarResizeController } from "./lib/shell/sidebar-resize.svelte";
	import { DrawerSwipeController } from "./lib/shell/drawer-swipe.svelte";
	import { createExtensionHostAdapter } from "./lib/extensions/adapter";
	import {
		cancelChord,
		endExtensionHold,
		notePress,
		onMouseNavAuxClick,
		onMouseNavDown,
		onMouseNavUp,
		onShortcut,
		onShortcutCapture,
		onShortcutUp,
		onShortcutUpCapture,
		recordSessionVisit,
		resetKeyboard,
		stepSessionHistory,
	} from "./lib/actions";
	import Header from "./components/shell/Header.svelte";
	import Pane from "./components/shell/Pane.svelte";
	import GroupView from "./components/shell/GroupView.svelte";
	import TabBar from "./components/shell/TabBar.svelte";
	import Palette from "./components/shell/Palette.svelte";
	import NoServer from "./components/shell/NoServer.svelte";
	import Toasts from "./components/shell/Toasts.svelte";
	import RowMenu from "./components/ui/RowMenu.svelte";
	import { registerContextMenu } from "./lib/context-menu";
	import Lazy, { preload } from "./components/ui/Lazy.svelte";
	import UpdateBanner from "./components/shell/UpdateBanner.svelte";
	import VersionNotice from "./components/shell/VersionNotice.svelte";
	import ChordStrip from "./components/shell/ChordStrip.svelte";
	import { updater } from "./lib/updater.svelte";
	import ExtensionPanels from "./components/extensions/ExtensionPanels.svelte";
	import ExtensionDock from "./components/extensions/ExtensionDock.svelte";
	import WorkspaceFileTree from "./components/workspace/WorkspaceFileTree.svelte";
	import WorkspaceFilePane from "./components/workspace/WorkspaceFilePane.svelte";
	import { workspaceViewer } from "./lib/workspace-viewer.svelte";
	import { workDir } from "./lib/nav";
	import ExtensionFloating from "./components/extensions/ExtensionFloating.svelte";
	import CloseConfirm from "./components/shell/CloseConfirm.svelte";
	import SessionCloseConfirm from "./components/shell/SessionCloseConfirm.svelte";
	import { guardWindowClose } from "./lib/window-close";
	import { createAttention } from "./lib/attention";
	import { summarize } from "./lib/activity";
	import ExtensionApproval from "./components/extensions/ExtensionApproval.svelte";
	import ExtensionDialog from "./components/extensions/ExtensionDialog.svelte";
	import { app, SIDEBAR_W } from "./lib/store.svelte";
	import { armSound } from "./lib/sound";
	import { extensions } from "./lib/extensions/host.svelte";
	import { voice } from "./lib/voice.svelte";
	import { viewport } from "./lib/viewport.svelte";
	import { notifications } from "./lib/notifications";
	import { nativePushAdapter } from "./lib/native-push";
	import { t } from "./lib/i18n";
	import { isTauri } from "./lib/tauri";
	import { notificationPlatform } from "./lib/notifications";
	import { listenForPairingLinks } from "./lib/pairing-intake";

	// Load the transcript of every session on screen (all panes of the open group on a wide screen), drop the rest.
	$effect(() => {
		const ids = app.visibleIds;
		untrack(() => { app.syncChats(ids); });
	});
	// The sidebar's scheduled-task count and clocks: read when the open server connects and again after its task events pause.
	$effect(() => {
		void app.schedulesTick;
		const link = app.link;
		if (!link?.online) return;
		return app.schedules.follow(link.id, link.api);
	});
	$effect(() => {
		void app.goalsTick;
		const link = app.link;
		if (!link?.online) return;
		return app.goals.follow(link.id, link.api);
	});
	const mobile = ["android", "ios"].includes(notificationPlatform());
	const group = $derived(viewport.narrow ? undefined : app.activeGroup);

	// Dialogs and settings panels load on first open, keeping them (and ModelConnections, Extensions, Backup…) out of the start-up chunk.
	const load = {
		settings: () => import("./components/settings/Settings.svelte"),
		skills: () => import("./components/agent/SkillsDialog.svelte"),
		templates: () => import("./components/agent/TemplatesDialog.svelte"),
		commands: () => import("./components/agent/CommandFamiliesDialog.svelte"),
		mcp: () => import("./components/agent/McpDialog.svelte"),
		schedules: () => import("./components/agent/SchedulesDialog.svelte"),
		tabOverview: () => import("./components/shell/TabOverview.svelte"),
		graph: () => import("./components/graph/GraphView.svelte"),
		subagents: () => import("./components/agent/SubagentsDialog.svelte"),
		lightbox: () => import("./components/chat/Lightbox.svelte"),
		queue: () => import("./components/chat/QueueModal.svelte"),
		goal: () => import("./components/agent/GoalDialog.svelte"),
		filePreview: () => import("./components/chat/FilePreview.svelte"),
		dirPicker: () => import("./components/server/DirPicker.svelte"),
		serverForm: () => import("./components/server/ServerForm.svelte"),
		linkCard: () => import("./components/chat/LinkCard.svelte"),
		sessions: () => import("./components/agent/SessionsDialog.svelte"),
	};

	// "작업 완료" on what is on screen is read as soon as the user comes back to the window or clicks on it (blank space included).
	onMount(() => {
		const seen = () => app.markSeen();
		const visible = () => document.visibilityState === "visible" && seen();
		window.addEventListener("pointerdown", seen, true);
		window.addEventListener("focus", seen);
		document.addEventListener("visibilitychange", visible);
		return () => {
			window.removeEventListener("pointerdown", seen, true);
			window.removeEventListener("focus", seen);
			document.removeEventListener("visibilitychange", visible);
		};
	});

	// The server decides "is somebody looking at this session" from the last report, so switching panes/sessions is reported at once
	// instead of at the next 10 s beat (a run finishing in between would otherwise be judged against the old session).
	$effect(() => {
		void app.readableId; void app.visibleIds.join(",");
		untrack(() => { void notifications.heartbeat(); });
	});

	onMount(() => guardWindowClose(() => app.requestClose()));
	// Focus that would fall to <body> when what held it goes away (a menu, a rename field, the folding sidebar) goes back
	// to where it was before, else to the open pane's input (lib/focus-rescue). Not on touch: that would pop the keyboard.
	onMount(() =>
		installFocusRescue(
			document,
			() => {
				const pane = (app.activeId && document.querySelector(`[data-pane="${CSS.escape(app.activeId)}"]`)) || document.querySelector("[data-part=pane]");
				return pane?.querySelector<HTMLElement>("[data-composer], .xterm-helper-textarea") ?? null;
			},
			() => !isTouch(),
		)
	);
	// Cold markdown code is what the first reply stalls on (lib/markdown.ts): warm it once the first paint is done.
	onMount(() => {
		const run = () => {
			warmMarkdown();
			// Settings is the dialog people open most: fetched on the first click, its sheet arrived ~0.6s late on a phone.
			void preload(load.settings).catch(() => {});
		};
		const win = window as {
			requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number;
			cancelIdleCallback?: (id: number) => void;
		};
		if (win.requestIdleCallback) {
			const id = win.requestIdleCallback(run, { timeout: 2000 });
			return () => win.cancelIdleCallback?.(id);
		}
		const id = setTimeout(run, 500);
		return () => clearTimeout(id);
	});
	/** The shared context menu of the rail, pane title bars and the phone's pane strip (lib/context-menu). */
	let contextMenu: ReturnType<typeof RowMenu> | undefined = $state();
	$effect(() => {
		registerContextMenu(contextMenu);
		return () => registerContextMenu(undefined);
	});
	// Taskbar / dock: count of sessions waiting for the user (asking, failed, finished unread).
	const setAttention = createAttention();
	$effect(() => {
		// every connected server, not only the one in view
		let waiting = 0;
		for (const l of Object.values(app.links)) {
			const n = summarize(l.data, l.data.sessions);
			waiting += n.asking + n.failed + n.done;
		}
		setAttention(waiting);
	});

	// Back button / swipe: close the top modal, else the phone drawer (left sessions or right files), before leaving the app.
	$effect(() => {
		if (!viewport.narrow || !app.sidebar.open) return;
		return backLayer({ onclose: () => (app.sidebar.open = false) });
	});
	$effect(() => {
		if (!viewport.narrow || !app.filesOpen) return;
		return backLayer({ onclose: () => (app.filesOpen = false) });
	});
	// Avoid stacking the left sidebar drawer and right file drawer on narrow viewports, regardless of which opened last.
	let prevSidebarOpen = false;
	let prevFilesOpen = false;
	$effect(() => {
		const left = app.sidebar.open;
		const right = app.filesOpen;
		if (viewport.narrow && left && right) {
			if (!prevSidebarOpen) app.filesOpen = false;
			else if (!prevFilesOpen) app.sidebar.open = false;
			else app.filesOpen = false;
		}
		prevSidebarOpen = app.sidebar.open;
		prevFilesOpen = app.filesOpen;
	});
	// Esc closes the open drawer too (the scrim says so), unless something inside used the key first: a search field
	// clearing itself, a rename field cancelling, a menu or dialog closing. Focus goes back to the menu button.
	$effect(() => {
		if (!viewport.narrow || !app.sidebar.open) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape" || e.defaultPrevented || e.isComposing || document.querySelector(OVERLAY_SELECTOR)) return;
			e.preventDefault();
			const inside = sideEl?.contains(document.activeElement);
			app.sidebar.open = false;
			if (inside) document.querySelector<HTMLElement>("[data-part=header] .menu")?.focus({ preventScroll: true });
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	});
	// Back closes the graph view too, landing on the chat it was opened from.
	$effect(() => {
		if (!(mobile || viewport.narrow) || !app.graphOpen) return;
		return backLayer({ onclose: () => app.toggleGraph(false) });
	});
	// Record visited conversations across all platforms (phone back button, mouse Back/Forward buttons, and shortcuts).
	// The graph and its quick look are not pages: what they open while up is not remembered.
	$effect(() => {
		if (!app.serverId || app.graphOpen) return;
		recordSessionVisit(app.serverId, app.activeId);
	});
	onMount(() => {
		if (!mobile) return;
		let off: (() => void) | undefined;
		let gone = false;
		// plugin-process is desktop only; the app module's exit() finishes the Android activity (core:app:allow-exit).
		void import("@tauri-apps/api/app").then(async ({ onBackButtonPress, exit }) => {
			const l = await onBackButtonPress(async () => {
				if (handleBack() || stepSessionHistory("back")) return;
				await exit(0);
			});
			if (gone) void l.unregister();
			else off = () => void l.unregister();
		}).catch(() => {});
		return () => {
			gone = true;
			off?.();
		};
	});

	// Voice input: read this server's settings, and keep them in step when the open server changes, reconnects/upgrades,
	// or another device saves them (the connection test is kept on the server, so a test on the phone shows the microphone here too).
	$effect(() => {
		const api = app.api;
		const serverId = app.serverId;
		const online = app.net === "online";
		void app.serverVersions?.version;
		void app.voiceTick;
		if (serverId && (online || !untrack(() => voice.loaded))) void voice.load(api, serverId);
	});

	// Keep the read-only workspace file viewer bound to the active working directory.
	let lastActivePaneId: string | null = null;
	$effect(() => {
		const id = app.activeId;
		if (lastActivePaneId !== null && id !== lastActivePaneId) {
			workspaceViewer.deactivateFile();
		}
		lastActivePaneId = id;
	});

	$effect(() => {
		const api = app.api;
		const s = app.current;
		const fallbackSession = !s && app.tabDir ? app.sessions.find((x) => workDir(x) === app.tabDir?.path) ?? null : null;
		const boundSession = s ?? fallbackSession;
		const dir = boundSession ? workDir(boundSession) : (app.tabDir?.path ?? "");
		const online = app.net === "online";
		workspaceViewer.bind(api, boundSession?.id ?? null, dir, (id) => app.chatOf(id));
		if (api && online && boundSession) {
			void workspaceViewer.refreshTree({ preserveOpenDirs: true });
		}
	});

	// Keep recent/pending edits in sync whenever the active session's transcript or tool states change.
	$effect(() => {
		const sid = workspaceViewer.sessionId;
		const chat = sid ? app.chatOf(sid) : null;
		if (!chat) return;
		void chat.items;
		void chat.tools;
		const running = chat.running;
		untrack(() => {
			if (running) workspaceViewer.scheduleSyncRecentChanges();
			else workspaceViewer.syncRecentChanges();
		});
	});

	onMount(() => {
		armSound();
		const stopApp = app.init();
		let stopLinks = () => {};
		let gone = false;
		void listenForPairingLinks(link => app.connectByLink(link)).then(stop => { if (gone) stop(); else stopLinks = stop; });
		updater.connection = () => ({ api: app.api, serverId: app.serverId });
		// A few seconds after launch, so the check never competes with connecting to the server.
		const updateTimer = setTimeout(() => updater.autoCheck(), 5000);
		notifications.init(() => app.visibleIds, (sid, api) => { const sv = api ? app.serverIdOfApi(api) : null; if (sv && sv !== app.serverId) app.openIn(sv, { session: sid }); else void app.openAny(sid); }, nativePushAdapter(), () => app.readableId);
		// Voice input: the microphone's own availability (secure context, MediaRecorder) is fixed for this window.
		voice.probe();
		extensions.init(createExtensionHostAdapter());
		return () => { gone = true; stopLinks(); clearTimeout(updateTimer); extensions.stop(); notifications.stop(); stopApp(); };
	});

	// Drag the sidebar edge to resize it (desktop).
	const sidebarResize = new SidebarResizeController(app.sidebar);
	// the reconnect link gives feedback: the net stays "offline" while a retry runs, so without this a tap looks like nothing happened
	let retrying = $state(false);
	async function retryNow() {
		if (retrying) return;
		retrying = true;
		try {
			await Promise.all([app.syncAll(), new Promise((r) => setTimeout(r, 800))]); // hold at least 800ms so a fast failure is still visible
		} finally {
			retrying = false;
		}
	}

	// Phone drawer: a session carried out of it and let go on the dimmed page joins what is being viewed (its group, or a new one).
	let scrimOver = $state(false);
	const catchable = (id: string) => {
		const cur = app.activeId;
		return !!cur && cur !== id && !app.groups.some((g) => g.id === id) && (!app.groupOf(id) || app.groupOf(id)?.id !== app.groupOf(cur)?.id);
	};
	const canCatch = $derived(app.sidebar.open && !!drag.id && catchable(drag.id));
	const scrimDrop = {
		accepts: catchable,
		hover: (pt: unknown) => (scrimOver = !!pt),
		drop: (id: string) => {
			scrimOver = false;
			const cur = app.activeId;
			if (!cur) return;
			app.sidebar.open = false;
			const g = app.groupOf(cur);
			if (g) void app.addToGroup(id, g.id).then(() => app.openSession(id));
			else void app.groupWith(id, cur);
		},
	};

	// Swipe sideways anywhere to drag either drawer open / shut (touch only, narrow screens only).
	// Left -> right opens sessions; right -> left opens workspace files.
	let sideEl: HTMLElement | undefined = $state();
	let filesEl: HTMLElement | undefined = $state();
	/** The sidebar's drawn width: the user's, or the theme's `--sidebar-w` (which can change while the app runs). */
	let sideW = $state(0);
	const drawerSwipe = new DrawerSwipeController({
		isNarrow: () => viewport.narrow,
		isOpen: (side) => (side === "left" ? app.sidebar.open : app.filesOpen),
		setOpen: (side, open) => {
			if (side === "left") {
				app.sidebar.open = open;
				if (open && viewport.narrow) app.filesOpen = false;
			} else {
				app.filesOpen = open;
				if (open && viewport.narrow) app.sidebar.open = false;
			}
		},
		canOpen: (side) => (side === "left" ? true : !app.graphOpen && Boolean(workspaceViewer.sessionId)),
		isBlocked: () => typeof document !== "undefined" && Boolean(document.querySelector('[data-part="dock"].narrow')),
		isDraggingItem: () => !!drag.id,
		getDrawerWidth: (side) => (side === "left" ? sideEl?.offsetWidth : filesEl?.offsetWidth) || 320,
	});
	// Going to the background can swallow touchend/pointercancel: drop a half-done swipe or carried session so the
	// next gesture starts clean (a stale `drag.id` makes every touchMove cancel the swipe).
	function settleOnHide() {
		if (!document.hidden) return;
		endExtensionHold("hidden"); // the keyup of a held extension shortcut will not arrive while the page is hidden
		drawerSwipe.cancel();
		if (drag.id) drag.end(false);
	}
</script>

<svelte:head>
	<title>pipaya</title>
</svelte:head>

<svelte:document onvisibilitychange={settleOnHide} />

<svelte:window
	ontouchstart={drawerSwipe.start}
	ontouchmove={drawerSwipe.move}
	ontouchend={drawerSwipe.end}
	ontouchcancel={drawerSwipe.cancel}
	onscrollcapture={drawerSwipe.noteScroll}
	onpagehide={() => (endExtensionHold("hidden"), settleOnHide())}
	onkeydowncapture={onShortcutCapture}
	onkeydown={onShortcut}
	onkeyup={onShortcutUp}
	onkeyupcapture={onShortcutUpCapture}
	onmousedowncapture={onMouseNavDown}
	onmouseupcapture={onMouseNavUp}
	onauxclickcapture={onMouseNavAuxClick}
	onpointerdowncapture={(e) => {
		if (mouseNavDirection(e.button)) {
			// Keep mouse Back/Forward buttons from focusing panes or starting drags while still letting mousedown fire.
			cancelChord();
			e.stopPropagation();
			return;
		}
		notePress(e);
		cancelChord();
	}}
	onblur={resetKeyboard}
/>

<!-- The connection strip: in the column above the stage, or (the graph view covers that) first in the stage's overlay under the graph's header -->
{#snippet netBanner()}
	{#if app.net !== "online" && app.net !== "incompatible"}
		<div class="banner" role="status" aria-live="polite" class:bad={app.net === "offline" || app.net === "unauthorized"} in:fadeIn out:fadeOut>
			{#if app.net === "connecting"}
				<Spinner size={12} /> {t("연결하는 중…")}
			{:else if app.net === "unauthorized"}
				<Icon name="key" /> {t("서버가 토큰을 거부했습니다.")}
				<button class="link" onclick={() => app.openSettings("servers", app.serverId)}>{t("토큰 수정")}</button>
			{:else}
				{#if retrying}<Spinner size={12} />{:else}<Icon name="wifi-off" />{/if} {t("서버에 다시 연결하는 중…")}
				{#if !retrying}<button class="link" onclick={retryNow}>{t("다시 연결하기")}</button>{/if}
			{/if}
		</div>
	{/if}
{/snippet}
{#snippet launcher()}<ExtensionPanels />{/snippet}

{#if app.servers.length === 0}
	<!-- The desktop app starts its own server, so it never shows a start screen: wait for it. Only a phone (or a build without the bundled server) needs to ask. -->
	{#if app.localChecked || !isTauri() || mobile}
		<div class="extension-launcher fixed">{@render launcher()}</div>
		<NoServer />
	{/if}
{:else}
	<div class="app" data-part="app">
		<!-- A closed drawer is only slid off screen: `inert` keeps Tab and screen readers out of it too (they walked 14 hidden
		     controls before reaching the page). Not while a swipe is pulling it in, so it answers the moment it shows. -->
		<div class="side" inert={viewport.narrow && !app.sidebar.open && drawerSwipe.leftSwipe === null} bind:this={sideEl} bind:offsetWidth={sideW} class:dragging={drawerSwipe.leftSwipe !== null} style:translate={drawerSwipe.leftSwipe !== null ? `${drawerSwipe.leftSwipe - drawerSwipe.drawerW}px 0` : undefined} class:open={app.sidebar.open} class:collapsed={app.sidebar.collapsed} class:resizing={sidebarResize.resizing} class:folding={sidebarResize.resizing && sidebarResize.foldingPreview} style:--sidebar-w={app.sidebar.width === null ? undefined : `${app.sidebar.width}px`}>
			<div class="full"><Sidebar /></div>
			<div class="rail-slot"><Rail /></div>
			<!-- A window splitter (WAI-ARIA): stays mounted in both open and rail states so dragging or clicking the edge folds and unfolds. -->
			<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
			<div
				class="grip"
				role="separator"
				aria-orientation="vertical"
				aria-label={t("사이드바 너비 조절")}
				aria-valuemin={SIDEBAR_W.min}
				aria-valuemax={SIDEBAR_W.max}
				aria-valuenow={app.sidebar.collapsed ? 0 : (app.sidebar.width ?? (sideW || app.sidebar.shownWidth()))}
				tabindex="0"
				title={app.sidebar.collapsed ? t("끌어서 펼치기 · 클릭으로 펼치기") : t("끌어서 너비 조절 · 밀어넣어 접기 · 클릭으로 접기/펼치기")}
				onpointerdown={sidebarResize.down}
				onpointermove={sidebarResize.move}
				onpointerup={sidebarResize.up}
				onpointercancel={sidebarResize.up}
				onkeydown={sidebarResize.key}
			></div>
		</div>
		<!-- Tapping the scrim closes the drawer; with a keyboard the drawer closes with Esc (the app shortcut layer). -->
		<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
		<div class="scrim" class:show={app.sidebar.open} class:dragging={drawerSwipe.leftSwipe !== null} class:catch={canCatch} class:over={scrimOver} style:opacity={drawerSwipe.leftSwipe !== null ? drawerSwipe.leftSwipe / drawerSwipe.drawerW : undefined} onclick={() => (app.sidebar.open = false)} use:dropTarget={scrimDrop}>
			{#if canCatch}<span class="catch-hint">{t("지금 보는 대화에 합치기")}</span>{/if}
		</div>

		<main>
			{#if app.graphOpen}
				<!-- the graph view covers the conversation area (header and tabs too); the chat behind keeps its state -->
				<div class="graph-slot"><Lazy load={load.graph} /></div>
			{/if}
			<Header />
			<TabBar />

			{#if !app.graphOpen}{@render netBanner()}{/if}

			<!-- under the graph view the stage lets go of its column, so the overlay hangs from main, under the graph's own header -->
			<div class="stage" class:under-graph={app.graphOpen}>
				<!-- One column for everything pinned to the top of the stage: notices first, the extension button below them, so they never overlap -->
				<div class="overlay">
					{#if app.graphOpen}{@render netBanner()}{/if}
					<VersionNotice />
					<div class="extension-launcher">{@render launcher()}</div>
				</div>
				<!-- hidden, not unmounted, under the graph: a narrow screen's dock (--z-dock) would cover the graph; its panel keeps its state -->
				<div class="work" class:hidden={app.graphOpen}>
					<div class="panes">
						<!-- under the graph view nothing is drawn: its quick look holds the one live pane (one input, one set of
						     window listeners); the chat comes back as it was when the graph closes -->
						{#if !app.graphOpen}
							{#if workspaceViewer.activeFile}
								<WorkspaceFilePane />
							{:else if group}
								<GroupView {group} />
							{:else}
								<Pane id={app.activeId} />
							{/if}
						{/if}
					</div>
					<ExtensionDock />
				</div>
			</div>
		</main>

		<!-- Right workspace sidebar: full-height sibling of <main> just like the left sidebar (collapses to a slim rail on desktop, slide-over drawer on mobile) -->
		{#if !app.graphOpen && workspaceViewer.sessionId}
			<WorkspaceFileTree open={app.filesOpen} bind:drawerEl={filesEl} swipe={drawerSwipe.rightSwipe} drawerWidth={drawerSwipe.drawerW} />
		{/if}

	</div>
{/if}

{#if app.settingsOpen}<Lazy load={load.settings} />{/if}
{#if app.sessionsDialog}<Lazy load={load.sessions} serverId={app.sessionsDialog} />{/if}
{#if app.skillsDialog && app.api}
	{#key app.serverId}<Lazy load={load.skills} dialog={app.skillsDialog} api={app.api} onclose={() => (app.skillsDialog = null)} />{/key}
{/if}
{#if app.mcpDialog && app.api}
	{#key app.serverId}<Lazy load={load.mcp} api={app.api} onclose={() => (app.mcpDialog = false)} />{/key}
{/if}
{#if app.tabOverview && app.serverId}
	{#key app.serverId}<Lazy load={load.tabOverview} onclose={() => (app.tabOverview = false)} />{/key}
{/if}
{#if app.schedulesDialog && app.serverId}
	{#key app.serverId}<Lazy load={load.schedules} serverId={app.serverId} onclose={() => (app.schedulesDialog = false)} />{/key}
{/if}
{#if app.subagentsDialog && app.api}
	{#key app.serverId}<Lazy load={load.subagents} dialog={app.subagentsDialog} api={app.api} onclose={() => (app.subagentsDialog = null)} />{/key}
{/if}
{#if app.commandsDialog && app.api}
	{#key app.serverId}<Lazy load={load.commands} dialog={app.commandsDialog} api={app.api} onclose={() => (app.commandsDialog = null)} />{/key}
{/if}
{#if app.templatesDialog && app.api}
	{#key app.serverId}<Lazy load={load.templates} dialog={app.templatesDialog} api={app.api} onclose={() => (app.templatesDialog = null)} />{/key}
{/if}
{#if app.servers.length === 0}
	<button class="extension-entry" onclick={() => app.openSettings("srvext")}>{t("설정 · 확장")}</button>
{/if}

{#if app.viewer}
	<Lazy load={load.lightbox} onclose={() => (app.viewer = null)} />
{/if}

{#if app.filePreview}
	<Lazy load={load.filePreview} />
{/if}

{#if app.queueDialog}
	<Lazy load={load.queue} />
{/if}

{#if app.goalDialog}
	{#key app.goalDialog}<Lazy load={load.goal} />{/key}
{/if}

{#if app.dirPicker}
	<Lazy load={load.dirPicker} onclose={() => (app.dirPicker = false)} />
{/if}

{#if app.serverForm}
	{#key app.serverForm}<Lazy load={load.serverForm} target={app.serverForm} />{/key}
{/if}

{#if app.linking}<Lazy load={load.linkCard} />{/if}
<Palette />
<RowMenu bind:this={contextMenu} />
<Toasts />
<UpdateBanner />
<ChordStrip />
<ExtensionMount slot="app.overlay" />
{#if app.servers.length}<ExtensionFloating />{/if}
<ExtensionApproval />
<ExtensionDialog />
<SessionCloseConfirm />
<CloseConfirm />

<style>
	.overlay {
		position: absolute;
		z-index: var(--z-popover);
		top: 0;
		left: 0;
		right: 0;
		display: flex;
		flex-direction: column;
		/* only the things inside catch taps; the transcript underneath stays scrollable */
		pointer-events: none;
	}
	.extension-launcher {
		align-self: flex-end;
		margin: 16px 16px 0 0;
		pointer-events: auto;
	}
	.extension-launcher:empty {
		display: none;
	}
	/* no server yet: there is no stage, so it floats as before */
	.extension-launcher.fixed {
		position: fixed;
		right: 0;
		top: calc(64px + var(--sat));
		z-index: var(--z-popover);
	}
	.extension-entry {
		position: fixed;
		right: 16px;
		bottom: calc(16px + var(--sab));
		padding: 8px 12px;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--bg-elev);
	}
	.app {
		display: flex;
		height: 100%;
		height: var(--dvh);
		overflow: hidden;
	}
	.side {
		flex: none;
		width: clamp(220px, var(--sidebar-w), 560px); /* SIDEBAR_W: a theme's --sidebar-w (200-480) stays in the range the grip allows */
		height: 100%;
	}
	main {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		height: 100%;
		position: relative;
		padding-right: var(--sar);
	}
	.stage {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
		position: relative;
	}
	.graph-slot {
		position: absolute;
		inset: 0;
		z-index: 11; /* over the header (10) and the panes; under every popover and dialog (they use the --z tokens) */
		padding-top: var(--sat);
		display: flex;
		flex-direction: column;
		background: var(--bg);
	}
	.stage.under-graph {
		position: static;
	}
	.stage.under-graph .overlay {
		top: calc(45px + var(--sat)); /* the graph view's header: 44px + its 1px hairline, under the safe area (GraphView .head) */
	}
	/* the connection strip in the overlay column: it takes taps like the strips below it */
	.overlay .banner {
		pointer-events: auto;
	}
	.work.hidden {
		visibility: hidden;
	}
	/* the conversation area and the extension dock beside it */
	.work {
		flex: 1;
		min-height: 0;
		display: flex;
		position: relative;
	}
	.panes {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		position: relative;
	}
	.scrim {
		display: none;
	}
	/* a connection strip: the same box, tint and hairline as the toast strip (ToastStrip) */
	.banner {
		--tone: var(--text-faint);
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		min-height: 44px;
		padding: 4px 16px; /* the same 16px side padding as every other strip (toasts, notices): a wrapped line keeps its distance from the edge */
		font-size: var(--fs-sm);
		line-height: 1.4;
		background: color-mix(in srgb, var(--tone) 16%, var(--bg-elev));
		border-bottom: 1px solid color-mix(in srgb, var(--tone) 25%, var(--border-strong));
		color: var(--text);
		flex: none;
	}
	.banner.bad {
		--tone: var(--warn);
	}
	.banner :global(svg) {
		color: var(--tone);
	}
	.banner :global(svg) {
		width: 16px;
		height: 16px;
		stroke: currentColor;
		fill: none;
		stroke-width: 1.9;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	/* the reconnect action is an underlined text link in the strip's own colour; tap it to retry right away */
	.banner button.link {
		padding: 0 4px;
		height: auto;
		min-height: var(--control-h-sm);
		background: none;
		border: 0;
		color: var(--tone); /* the same warning tone as the wifi glyph beside it */
		font-size: inherit;
		font-weight: 600;
		text-decoration: underline;
		text-underline-offset: 3px;
		cursor: pointer;
	}
	@media (hover: hover) {
		.banner button.link:hover {
			color: color-mix(in srgb, var(--tone) 75%, var(--text));
		}
	}
	.banner button:not(.link) {
		height: var(--control-h-sm);
		padding: 0 12px;
		border-radius: var(--radius-control);
		background: var(--bg);
		border: 1px solid var(--border-strong);
		font-weight: 600;
		font-size: var(--fs-xs);
	}

	.grip {
		display: none;
	}
	@media (min-width: 861px) {
		.side {
			position: relative;
			transition:
				width var(--motion-normal) var(--ease),
				visibility 0s;
		}
		.side.resizing {
			transition: none; /* follow the pointer exactly */
		}
		.grip {
			display: block;
			position: absolute;
			z-index: var(--z-popover);
			top: 0;
			bottom: 0;
			right: -4px; /* centres the 9px hit strip over the 1px right border */
			width: 9px;
			cursor: col-resize;
			touch-action: none;
		}
		.grip::before {
			content: "";
			position: absolute;
			top: calc(50% - 16px);
			left: 3px; /* centres the 4px grabber on the 2px hairline at left: 4px */
			width: 4px;
			height: 32px;
			border-radius: 2px;
			background: var(--accent);
			opacity: 0;
			transition: opacity var(--motion-fast) var(--ease-std);
		}
		.grip::after {
			content: "";
			position: absolute;
			top: 0;
			bottom: 0;
			left: 4px;
			width: 2px;
			background: var(--accent);
			opacity: 0;
			transition: opacity var(--motion-fast) var(--ease-std);
		}
		.grip:hover::after,
		.grip:focus-visible::after,
		.side.resizing .grip::after {
			opacity: 0.55;
		}
		.grip:hover::before,
		.grip:focus-visible::before,
		.side.resizing .grip::before {
			opacity: 0.9;
		}
		.grip:focus-visible {
			outline: none;
		}
		/* dragged below minWidth toward the fold snap point: subtle fade signals an imminent snap */
		.side.folding .full {
			opacity: 0.65;
		}
		/* Folding and unfolding cross-fade the two layers while the wrapper's width animates. Both are pinned to the left
		   edge at their own width, so neither reflows nor slides: the rail used to fill the wrapper and shrink from 288 to
		   56px, carrying its logo and icons from x 144 to 28 (the "wiggle"), and the full list popped in and out at once.
		   The hidden layer is `visibility: hidden` once its fade ends, which keeps it out of the tab order. */
		.side {
			background: var(--bg-side); /* under the cross-fade, so the page does not show through at half opacity */
		}
		.full,
		.rail-slot {
			position: absolute;
			top: 0;
			left: 0;
			height: 100%;
			overflow: hidden;
			transition:
				opacity var(--motion-normal) var(--ease-std),
				visibility 0s;
		}
		.full {
			width: 100%; /* clips the list, which keeps its own --sidebar-w (Sidebar.svelte) */
		}
		.rail-slot {
			width: var(--rail-w);
		}
		.side:not(.collapsed) .rail-slot,
		.side.collapsed .full {
			opacity: 0;
			visibility: hidden;
			pointer-events: none;
			transition:
				opacity var(--motion-fast) var(--ease-std),
				visibility 0s linear var(--motion-fast);
		}
		/* the edge line of the moving wrapper: the layers' own borders sit at their fixed widths and are clipped mid-way */
		.side::after {
			content: "";
			position: absolute;
			top: 0;
			right: 0;
			bottom: 0;
			width: 1px;
			background: var(--border);
			pointer-events: none;
		}
		/* Folded: not gone, but a slim rail of the active sessions' agents */
		.side.collapsed {
			width: var(--rail-w);
		}
	}

	@media (max-width: 860px) {
		.rail-slot {
			display: none;
		}
		.full {
			height: 100%;
		}
		.side {
			position: fixed;
			z-index: var(--z-drawer);
			left: 0;
			top: 0;
			bottom: 0;
			width: min(max(320px, 80vw), 90vw, 400px); /* four fifths of a phone, never narrower than 320px nor a tablet-wide sheet */
			translate: -102% 0;
			transition: translate var(--motion-normal) var(--ease);
			box-shadow: none;
		}
		.side.open {
			translate: 0 0;
		}
		.scrim {
			display: block;
			position: fixed;
			inset: 0;
			z-index: var(--z-drawer-scrim);
			background: var(--scrim);
			opacity: 0;
			pointer-events: none;
			transition: opacity var(--motion-normal) var(--ease-std);
		}
		.side.dragging,
		.scrim.dragging {
			transition: none; /* follow the finger exactly */
		}
		.scrim.show {
			opacity: 1;
			pointer-events: auto;
		}
		.scrim.catch {
			display: grid;
			place-items: center;
		}
		.catch-hint {
			padding: 4px 12px;
			border-radius: var(--radius-pill);
			background: var(--bg);
			border: 1px solid var(--border-strong);
			font-size: var(--fs-xs);
			font-weight: 600;
			pointer-events: none;
		}
		.scrim.over {
			background: var(--accent-soft);
			outline: 2px solid var(--accent);
			outline-offset: -2px;
		}
	}
</style>
