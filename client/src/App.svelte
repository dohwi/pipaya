<script lang="ts">
	import ExtensionMount from "./components/extensions/ExtensionMount.svelte";
	import { onMount, untrack } from "svelte";
	import { backLayer, handleBack } from "./lib/dialog";
	import { fadeIn, fadeOut } from "./lib/motion";
	import Icon from "./components/Icon.svelte";
	import Sidebar from "./components/Sidebar.svelte";
	import Rail from "./components/Rail.svelte";
	import { drag, dropTarget } from "./lib/dnd.svelte";
	import { cancelChord, onShortcut, onShortcutCapture, onShortcutUp, resetKeyboard } from "./lib/actions";
	import Header from "./components/Header.svelte";
	import Pane from "./components/Pane.svelte";
	import GroupView from "./components/GroupView.svelte";
	import SessionStrip from "./components/SessionStrip.svelte";
	import TabBar from "./components/TabBar.svelte";
	import Palette from "./components/Palette.svelte";
	import NoServer from "./components/NoServer.svelte";
	import Toasts from "./components/Toasts.svelte";
	import RowMenu from "./components/RowMenu.svelte";
	import { registerContextMenu } from "./lib/context-menu";
	import Lazy from "./components/Lazy.svelte";
	import UpdateBanner from "./components/UpdateBanner.svelte";
	import DoneNotice from "./components/DoneNotice.svelte";
	import ChordStrip from "./components/ChordStrip.svelte";
	import { updater } from "./lib/updater.svelte";
	import { paneAdapter } from "./lib/extensions/panes";
	import ExtensionPanels from "./components/extensions/ExtensionPanels.svelte";
	import ExtensionDock from "./components/extensions/ExtensionDock.svelte";
	import ExtensionFloating from "./components/extensions/ExtensionFloating.svelte";
	import CloseConfirm from "./components/CloseConfirm.svelte";
	import { guardWindowClose } from "./lib/window-close";
	import { createAttention } from "./lib/attention";
	import { summarize } from "./lib/activity";
	import ExtensionApproval from "./components/extensions/ExtensionApproval.svelte";
	import ExtensionDialog from "./components/extensions/ExtensionDialog.svelte";
	import { app, SIDEBAR_W } from "./lib/store.svelte";
	import { armSound } from "./lib/sound";
	import { extensions } from "./lib/extensions/host.svelte";
	import { COMMANDS, runCommand } from "./lib/commands";
	import { workspaceAdapter } from "./lib/extensions/workspace";
	import { viewport } from "./lib/viewport.svelte";
	import { notifications } from "./lib/notifications";
	import { nativePushAdapter } from "./lib/native-push";
	import { notificationRules } from "./lib/notification-rules";
	import { getLang, t } from "./lib/i18n";
	import { isTauri } from "./lib/tauri";
	import { notificationPlatform } from "./lib/notifications";
	import { listenForPairingLinks } from "./lib/pairing-intake";

	// Load the transcript of every session on screen (all panes of the open group on a wide screen), drop the rest.
	$effect(() => {
		const ids = app.visibleIds;
		untrack(() => { app.syncChats(ids); void notifications.heartbeat(); });
	});
	// Leaving the group the user backed out of (to another tab, or via the sidebar) forgets it, so opening it again shows its sessions.
	$effect(() => {
		if (viewport.backedOut && app.activeGroup?.id !== viewport.backedOut) viewport.backedOut = null;
	});
	const mobile = ["android", "ios"].includes(notificationPlatform());
	const group = $derived(viewport.narrow ? undefined : app.activeGroup);

	// Dialogs and settings panels load on first open, keeping them (and ModelConnections, Extensions, Backup…) out of the start-up chunk.
	const load = {
		settings: () => import("./components/Settings.svelte"),
		skills: () => import("./components/Skills.svelte"),
		commands: () => import("./components/CommandFamilies.svelte"),
		lightbox: () => import("./components/Lightbox.svelte"),
		queue: () => import("./components/QueueModal.svelte"),
		filePreview: () => import("./components/FilePreview.svelte"),
		dirPicker: () => import("./components/DirPicker.svelte"),
		serverForm: () => import("./components/ServerForm.svelte"),
		linkCard: () => import("./components/LinkCard.svelte"),
		sessions: () => import("./components/SessionsDialog.svelte"),
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
	/** The shared context menu of the rail, pane title bars and the phone's pane strip (lib/context-menu). */
	let contextMenu: ReturnType<typeof RowMenu> | undefined = $state();
	$effect(() => {
		registerContextMenu(contextMenu);
		return () => registerContextMenu(undefined);
	});
	// Taskbar / dock: count of sessions waiting for the user (asking, failed, finished unread).
	const setAttention = createAttention();
	$effect(() => {
		const n = summarize(app, app.sessions);
		setAttention(n.asking + n.failed + n.done);
	});

	// Back button / swipe: close the top modal, else the phone drawer, before leaving the app.
	$effect(() => {
		if (!viewport.narrow || !app.sidebar.open) return;
		return backLayer({ onclose: () => (app.sidebar.open = false) });
	});
	onMount(() => {
		if (!mobile) return;
		let off: (() => void) | undefined;
		let gone = false;
		// plugin-process is desktop only; the app module's exit() finishes the Android activity (core:app:allow-exit).
		void import("@tauri-apps/api/app").then(async ({ onBackButtonPress, exit }) => {
			const l = await onBackButtonPress(async () => {
				if (handleBack()) return;
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

	onMount(() => {
		armSound();
		app.init();
		let stopLinks = () => {};
		let gone = false;
		void listenForPairingLinks(link => app.connectByLink(link)).then(stop => { if (gone) stop(); else stopLinks = stop; });
		updater.connection = () => ({ api: app.api, serverId: app.serverId });
		// A few seconds after launch, so the check never competes with connecting to the server.
		const updateTimer = setTimeout(() => updater.autoCheck(), 5000);
		notifications.init(() => app.visibleIds, (sid, api) => { const sv = api ? app.serverIdOfApi(api) : null; if (sv && sv !== app.serverId) app.openIn(sv, { session: sid }); else void app.openAny(sid); }, nativePushAdapter(), () => app.readableId);
		const api = () => { if (!app.api) throw new Error(t("서버에 연결해 주세요")); return app.api; };
		extensions.init({
			prefill: text => { app.prefill = text; },
			notify: text => app.toast(text),
			systemNotifications: {
				send: (owner, spec) => api().sendNotification(owner, spec),
				status: () => notifications.status(),
				register: async (owner, id, rule) => { await notificationRules.register(api(), owner, id, rule); },
				remove: async (owner, id) => { await notificationRules.remove(api(), owner, id); },
				revoke: async owner => { await notificationRules.revoke(api(), owner); },
			},
			context: () => ({ sessionId: app.activeId, model: app.effective.model, provider: app.effective.provider, running: app.runningHere, online: app.net === "online", language: getLang() }),
			session: {
				send: async (text, mode) => { if (!app.activeId) throw new Error(t("열려 있는 대화가 없습니다")); const ok = mode === "steer" ? await app.steer(text) : mode === "follow_up" ? await app.queue(text) : await app.send(text); if (!ok) throw new Error(t("보내지 못했습니다")); },
				abort: async () => { if (app.activeId) await app.abort(); },
			},
			panes: paneAdapter(app),
			workspace: workspaceAdapter(app, { names: () => COMMANDS.map(c => c.name), run: (name, arg) => runCommand(name, arg) }),
			dialog: request => app.askExtension(request),
			dark: () => app.prefs.resolvedDark,
			reservedCommands: () => COMMANDS.map(c => c.name),
			connection: () => app.conn,
			serverId: () => app.serverId,
			listChanged: () => app.listChanged(),
			statesChanged: () => app.statesChanged(),
			configuration: { capture: () => app.captureConfiguration(), apply: document => app.applyConfiguration(document), applyBackground: document => app.applyBackgroundConfiguration(document), backup: () => app.backupConfiguration(), restore: value => app.restoreConfiguration(value), confirm: message => app.confirmExtension(message) },
		});
		return () => { gone = true; stopLinks(); clearTimeout(updateTimer); extensions.stop(); notifications.stop(); };
	});

	// Drag the sidebar edge to resize it (desktop).
	let resizing = $state(false);
	let gripFrom = { x: 0, w: 0 };
	function gripDown(e: PointerEvent) {
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		gripFrom = { x: e.clientX, w: app.sidebar.width };
		resizing = true;
		document.body.style.userSelect = "none";
	}
	function gripMove(e: PointerEvent) {
		if (resizing) app.sidebar.setWidth(gripFrom.w + e.clientX - gripFrom.x, false);
	}
	function gripUp() {
		if (!resizing) return;
		resizing = false;
		document.body.style.userSelect = "";
		app.sidebar.setWidth(app.sidebar.width); // persist once, at the end of the drag
	}
	function gripKey(e: KeyboardEvent) {
		const d = e.key === "ArrowLeft" ? -16 : e.key === "ArrowRight" ? 16 : 0;
		if (!d) return;
		e.preventDefault();
		app.sidebar.setWidth(app.sidebar.width + d * (e.shiftKey ? 4 : 1));
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

	// Swipe sideways anywhere to drag the drawer open / shut: it follows the finger, and settles on release by
	// distance or flick speed (touch only, narrow screens only, never while a dialog is up).
	let sideEl: HTMLElement | undefined = $state();
	let startX = 0;
	let startY = 0;
	let lastX = 0;
	let lastT = 0;
	let vx = 0; // px/ms, smoothed
	let tracking = false;
	let locked = false; // decided: this gesture is a horizontal drag of the drawer
	let swipe: number | null = $state(null); // drawer's visible width in px while dragging
	let drawerW = $state(320);
	// A swipe that starts on these keeps its own meaning (typing, selecting, scrolling sideways, dragging).
	const NO_SWIPE = "input, textarea, select, [contenteditable], [role=separator], [role=slider], [draggable=true], pre, table, .grip";
	const MODAL = 'dialog[open], [role="dialog"], [role="alertdialog"]';
	function scrollsSideways(el: Element | null): boolean {
		for (; el && el !== document.body; el = el.parentElement) {
			if (el.scrollWidth > el.clientWidth + 1 && /(auto|scroll)/.test(getComputedStyle(el).overflowX)) return true;
		}
		return false;
	}
	function touchStart(e: TouchEvent) {
		tracking = locked = false;
		swipe = null;
		if (e.touches.length !== 1 || !viewport.narrow) return; // the drawer only exists on narrow screens
		if (document.querySelector(MODAL)) return;
		const t = e.touches[0]!;
		startX = lastX = t.clientX;
		startY = t.clientY;
		lastT = e.timeStamp;
		vx = 0;
		if (!app.sidebar.open && t.clientX >= 24) {
			const el = e.target instanceof Element ? e.target : null;
			if (el?.closest(NO_SWIPE) || scrollsSideways(el)) return;
			if (getSelection()?.toString()) return; // adjusting a text selection
		}
		drawerW = sideEl?.offsetWidth || 320;
		tracking = true;
	}
	function touchMove(e: TouchEvent) {
		if (!tracking) return;
		if (drag.id || e.touches.length !== 1) return cancelSwipe(); // a session is being carried, not the drawer swiped
		const t = e.touches[0]!;
		const dx = t.clientX - startX;
		const dy = t.clientY - startY;
		if (!locked) {
			if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) return cancelSwipe(); // vertical scroll
			if (Math.abs(dx) < 8 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
			if (app.sidebar.open ? dx > 0 : dx < 0) return cancelSwipe(); // wrong direction for the current state
			locked = true;
		}
		const dt = e.timeStamp - lastT;
		if (dt > 0) vx = 0.6 * vx + 0.4 * ((t.clientX - lastX) / dt);
		lastX = t.clientX;
		lastT = e.timeStamp;
		swipe = Math.max(0, Math.min(drawerW, (app.sidebar.open ? drawerW : 0) + dx));
	}
	function cancelSwipe() {
		tracking = locked = false;
		swipe = null;
	}
	function touchEnd() {
		if (!tracking || !locked || swipe === null) return cancelSwipe();
		const open = swipe / drawerW > 0.35 ? vx > -0.35 : vx > 0.35;
		app.sidebar.open = open;
		cancelSwipe();
	}
</script>

<svelte:head>
	<title>pipaya</title>
</svelte:head>

<svelte:window
	ontouchstart={touchStart}
	ontouchmove={touchMove}
	ontouchend={touchEnd}
	ontouchcancel={cancelSwipe}
	onkeydowncapture={onShortcutCapture}
	onkeydown={onShortcut}
	onkeyup={onShortcutUp}
	onpointerdowncapture={cancelChord}
	onblur={resetKeyboard}
/>

{#snippet launcher()}<ExtensionPanels />{/snippet}

{#if app.servers.length === 0}
	<!-- The desktop app starts its own server, so it never shows a start screen: wait for it. Only a phone (or a build without the bundled server) needs to ask. -->
	{#if app.localChecked || !isTauri() || mobile}
		<div class="extension-launcher fixed">{@render launcher()}</div>
		<NoServer />
	{/if}
{:else}
	<div class="app" data-part="app">
		<div class="side" bind:this={sideEl} class:dragging={swipe !== null} style:translate={swipe !== null ? `${swipe - drawerW}px 0` : undefined} class:open={app.sidebar.open} class:collapsed={app.sidebar.collapsed} class:resizing style:--sidebar-w="{app.sidebar.width}px">
			<div class="full"><Sidebar /></div>
			<div class="rail-slot"><Rail /></div>
			{#if !app.sidebar.collapsed}
				<!-- A window splitter (WAI-ARIA): focusable, with value attributes and arrow-key handling; the rule does not know the role is interactive. -->
				<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
				<div
					class="grip"
					role="separator"
					aria-orientation="vertical"
					aria-label={t("사이드바 너비 조절")}
					aria-valuemin={SIDEBAR_W.min}
					aria-valuemax={SIDEBAR_W.max}
					aria-valuenow={app.sidebar.width}
					tabindex="0"
					title={t("끌어서 너비 조절 · 더블 클릭으로 원래 크기")}
					onpointerdown={gripDown}
					onpointermove={gripMove}
					onpointerup={gripUp}
					onpointercancel={gripUp}
					ondblclick={() => app.sidebar.setWidth(SIDEBAR_W.def)}
					onkeydown={gripKey}
				></div>
			{/if}
		</div>
		<!-- Tapping the scrim closes the drawer; with a keyboard the drawer closes with Esc (the app shortcut layer). -->
		<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
		<div class="scrim" class:show={app.sidebar.open} class:dragging={swipe !== null} class:catch={canCatch} class:over={scrimOver} style:opacity={swipe !== null ? swipe / drawerW : undefined} onclick={() => (app.sidebar.open = false)} use:dropTarget={scrimDrop}>
			{#if canCatch}<span class="catch-hint">{t("지금 보는 대화에 합치기")}</span>{/if}
		</div>

		<main>
			<Header />
			<TabBar />
			{#if viewport.inGroup(app.activeGroup?.id) || (!viewport.narrow && (app.isFull(app.activeGroup?.id) || (app.activeGroup && app.zoomId)))}<SessionStrip />{/if}

			{#if app.net !== "online"}
				<div class="banner" class:bad={app.net === "offline" || app.net === "unauthorized"} in:fadeIn out:fadeOut>
					{#if app.net === "connecting"}
						<span class="spinner"></span> {t("연결하는 중…")}
					{:else if app.net === "unauthorized"}
						<Icon name="key" /> {t("서버가 토큰을 거부했습니다.")}
						<button onclick={() => app.openSettings("servers", app.serverId)}>{t("토큰 수정")}</button>
					{:else}
						<Icon name="wifi-off" /> {t("서버에 다시 연결하는 중…")}
						<button onclick={() => app.sync()}>{t("지금 재시도")}</button>
					{/if}
				</div>
			{/if}

			<div class="stage">
				<!-- One column for everything pinned to the top of the stage: notices first, the extension button below them, so they never overlap -->
				<div class="overlay">
					{#if viewport.narrow || group}<DoneNotice />{/if}
					<div class="extension-launcher">{@render launcher()}</div>
				</div>
				<div class="work">
					<div class="panes">
						{#if group}
							<GroupView {group} />
						{:else}
							<Pane id={app.activeId} />
						{/if}
					</div>
					<ExtensionDock />
				</div>
			</div>
		</main>

	</div>
{/if}

{#if app.settingsOpen}<Lazy load={load.settings} />{/if}
{#if app.sessionsDialog}<Lazy load={load.sessions} serverId={app.sessionsDialog} />{/if}
{#if app.skillsDialog && app.api}
	{#key app.serverId}<Lazy load={load.skills} dialog={app.skillsDialog} api={app.api} onclose={() => (app.skillsDialog = null)} />{/key}
{/if}
{#if app.commandsDialog && app.api}
	{#key app.serverId}<Lazy load={load.commands} dialog={app.commandsDialog} api={app.api} onclose={() => (app.commandsDialog = null)} />{/key}
{/if}
{#if app.servers.length === 0}
	<button class="extension-entry" onclick={() => app.openSettings("extensions")}>{t("설정 · 확장")}</button>
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
<CloseConfirm />

<style>
	.overlay {
		position: absolute;
		z-index: 20;
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
		z-index: 20;
	}
	.extension-entry {
		position: fixed;
		right: 16px;
		bottom: calc(16px + var(--sab));
		padding: 8px 14px;
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
		width: var(--sidebar-w);
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
	/* a connection strip: the same box, tint and hairline as the toast / "done" strips (ToastStrip, DoneNotice) */
	.banner {
		--tone: var(--text-faint);
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 10px;
		min-height: 44px;
		padding: 4px 12px;
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
	.banner button {
		height: var(--control-h-sm);
		padding: 0 12px;
		border-radius: var(--radius-control);
		background: var(--bg);
		border: 1px solid var(--border-strong);
		font-weight: 600;
		font-size: var(--fs-xs);
	}
	.banner .spinner {
		width: 12px;
		height: 12px;
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
		.side.collapsed .grip {
			display: none;
		}
		.grip {
			display: block;
			position: absolute;
			z-index: 20;
			top: 0;
			bottom: 0;
			right: -4px;
			width: 9px;
			cursor: col-resize;
			touch-action: none;
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
		.grip:focus-visible {
			outline: none;
		}
		.full,
		.rail-slot {
			width: 100%;
			height: 100%;
			overflow: hidden;
		}
		.rail-slot {
			display: none;
		}
		/* Folded: not gone, but a slim rail of the active sessions' agents */
		.side.collapsed {
			width: var(--rail-w);
		}
		.side.collapsed .full {
			display: none; /* out of the tab order too */
		}
		.side.collapsed .rail-slot {
			display: block;
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
			z-index: 50;
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
			box-shadow: var(--shadow);
		}
		.scrim {
			display: block;
			position: fixed;
			inset: 0;
			z-index: 49;
			background: var(--scrim);
			opacity: 0;
			pointer-events: none;
			transition: opacity var(--motion-normal) var(--ease-std);
		}
		.side.dragging,
		.scrim.dragging {
			transition: none; /* follow the finger exactly */
		}
		.side.dragging {
			box-shadow: var(--shadow);
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
			padding: 6px 14px;
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
