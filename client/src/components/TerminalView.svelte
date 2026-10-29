<script lang="ts">
	import "@xterm/xterm/css/xterm.css";
	import { Terminal, type ITheme } from "@xterm/xterm";
	import { FitAddon } from "@xterm/addon-fit";
	import { onDestroy, onMount } from "svelte";
	import Icon from "./Icon.svelte";
	import { t } from "../lib/i18n";
	import { app } from "../lib/store.svelte";
	import { copyText } from "../lib/clipboard";
	import TerminalKeybar from "./TerminalKeybar.svelte";
	import { viewport } from "../lib/viewport.svelte";
	import { isTouch } from "../lib/format";
	import { applyMods, keySequence, touchLines, type Mods } from "../lib/terminal-keys";
	import { appTakesKey, clipboardKey, localEcho, terminalSocketUrl, type TerminalInfo } from "../lib/terminal";

	/**
	 * The screen of one server terminal. Loaded on demand (xterm.js stays out of the start-up chunk). The shell runs on
	 * the server; this only draws its output and sends keys and the size. Reconnects by itself, and the server replays
	 * what was on screen.
	 */
	let { terminal, focused }: { terminal: TerminalInfo; focused: boolean } = $props();

	let host: HTMLDivElement | undefined = $state();
	let status = $state<"connecting" | "open" | "offline" | "exited">("connecting");
	let exitCode = $state<number | null>(null);
	let term: Terminal | undefined;
	let refitNow: (() => void) | undefined;
	/** Helper-key bar above the soft keyboard: on touch screens and phone-width windows */
	const showBar = $derived(isTouch() || viewport.narrow);
	let mods = $state<Mods>({ ctrl: false, alt: false, shift: false });
	let scrolledUp = $state(false);
	/** Floating keyboard toggle: shown while the soft keyboard is up or the screen was just touched, then it fades */
	let kbOpen = $state(false);
	let awake = $state(true);
	let fade: ReturnType<typeof setTimeout> | undefined;
	function wake() {
		awake = true;
		clearTimeout(fade);
		fade = setTimeout(() => (awake = false), 2500);
	}
	onMount(wake);
	onDestroy(() => clearTimeout(fade));
	let sendInput: ((data: string) => void) | undefined;
	let toggleKeyboard: (() => void) | undefined;
	let toBottom: (() => void) | undefined;
	let pasteClip: (() => void) | undefined;
	const appCursor = () => !!term?.modes.applicationCursorKeysMode;

	function css(name: string, fallback: string) {
		return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
	}
	function theme(): ITheme {
		const dark = app.prefs.resolvedDark;
		return {
			background: css("--bg", dark ? "#161616" : "#ffffff"),
			foreground: css("--text", dark ? "#ededed" : "#0a0a0b"),
			cursor: css("--text", dark ? "#ededed" : "#0a0a0b"),
			cursorAccent: css("--bg", dark ? "#161616" : "#ffffff"),
			selectionBackground: dark ? "#ffffff33" : "#00000026",
			...(dark
				? {}
				: {
						// xterm's defaults are made for a dark background; keep light-on-white readable.
						black: "#1f2328", white: "#6e7781", brightWhite: "#8c959f", yellow: "#9a6700", brightYellow: "#7d4e00",
						green: "#116329", brightGreen: "#1a7f37", cyan: "#1b7c83", brightCyan: "#3192aa",
					}),
		};
	}

	$effect(() => {
		void app.prefs.resolvedDark;
		if (term) term.options.theme = theme();
	});
	/** The chosen family first, then the app's mono stack so Korean and missing glyphs still draw. */
	function fontStack() {
		return `${app.prefs.terminal.fontFamily}, ${css("--mono", "ui-monospace, monospace")}`;
	}
	$effect(() => {
		const p = app.prefs.terminal;
		const xt = term;
		if (!xt) return;
		xt.options.fontFamily = fontStack();
		xt.options.fontSize = p.fontSize;
		xt.options.lineHeight = p.lineHeight;
		xt.options.cursorBlink = p.cursorBlink;
		xt.options.scrollback = p.scrollback;
		// Cell size changed: fit again (the resize observer does not fire for this).
		requestAnimationFrame(() => refitNow?.());
	});
	$effect(() => {
		if (focused && term && status !== "exited") term.focus();
	});

	onMount(() => {
		const conn = app.conn;
		if (!host || !conn) return;
		const fit = new FitAddon();
		const xt = new Terminal({
			fontFamily: fontStack(),
			fontSize: app.prefs.terminal.fontSize,
			lineHeight: app.prefs.terminal.lineHeight,
			cursorBlink: app.prefs.terminal.cursorBlink,
			scrollback: app.prefs.terminal.scrollback,
			allowProposedApi: false,
			convertEol: false,
			theme: theme(),
		});
		term = xt;
		xt.loadAddon(fit);
		xt.open(host);
		// xterm cancels every key it handles; the app's own Mod+Shift/Alt shortcuts must pass through untouched.
		xt.attachCustomKeyEventHandler((e) => {
			if (appTakesKey(e, app.prefs.bindings, app.prefs.terminal.appKeysFirst)) return false;
			const action = clipboardKey(e, xt.hasSelection());
			if (!action) return true;
			if (e.type !== "keydown") return false;
			if (action === "copy") {
				// Ctrl+Shift+C would open the browser's inspector: cancel it and copy ourselves.
				e.preventDefault();
				const text = xt.getSelection();
				if (text) {
					void copyText(text);
					xt.clearSelection(); // the next Ctrl+C is an interrupt again
				}
			}
			// Paste: leave the browser's own paste alone; xterm receives it as a paste event (works on plain http too).
			return false;
		});
		let ws: WebSocket | null = null;
		let retry: ReturnType<typeof setTimeout> | undefined;
		let delay = 500;
		let disposed = false;
		let fresh = true;

		const send = (msg: unknown) => {
			if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
		};
		const sendSize = () => send({ type: "resize", cols: xt.cols, rows: xt.rows });
		const refit = () => {
			if (!host || host.clientWidth < 20 || host.clientHeight < 10) return;
			try {
				fit.fit();
			} catch {
				/* not laid out yet */
			}
		};

		refitNow = refit;
		// A web font that arrives after the first measurement leaves wrong cell sizes: measure again once it is in.
		void document.fonts?.load(`${app.prefs.terminal.fontSize}px ${app.prefs.terminal.fontFamily}`).then(() => {
			if (disposed) return;
			xt.options.fontFamily = fontStack();
			refit();
		}, () => {});

		function connect() {
			if (disposed) return;
			status = "connecting";
			const sock = new WebSocket(terminalSocketUrl(conn!.baseUrl, conn!.token, terminal.id));
			sock.binaryType = "arraybuffer";
			ws = sock;
			sock.onmessage = (m) => {
				if (typeof m.data !== "string") {
					xt.write(new Uint8Array(m.data as ArrayBuffer));
					return;
				}
				let msg: { type?: string; code?: number | null; missing?: boolean };
				try {
					msg = JSON.parse(m.data);
				} catch {
					return;
				}
				if (msg.type === "hello") {
					status = "open";
					delay = 500;
					// The server replays the kept output next: start from a clean screen so nothing shows twice.
					if (!fresh) xt.reset();
					fresh = false;
					refit();
					sendSize();
				} else if (msg.type === "exit") {
					status = "exited";
					exitCode = msg.code ?? null;
					if (msg.missing) app.dropTerminal(terminal.id);
				}
			};
			sock.onclose = () => {
				if (ws !== sock || disposed) return;
				ws = null;
				if (status === "exited") return;
				status = "offline";
				retry = setTimeout(connect, delay);
				delay = Math.min(delay * 2, 10_000);
			};
		}

		const input = (data: string) => {
			if (status !== "open") return;
			if (!terminal.pty) xt.write(localEcho(data));
			send({ type: "input", data });
		};
		sendInput = input;
		const onData = xt.onData((raw) => {
			// Sticky Ctrl/Alt of the helper bar apply to the next typed character
			const r = applyMods(raw, mods);
			if (r.used) mods = { ctrl: false, alt: false, shift: false };
			input(r.data);
		});
		const onResize = xt.onResize(() => sendSize());
		const ro = new ResizeObserver(() => refit());
		ro.observe(host);

		// Soft keyboard / rotation: the visual viewport changes without the host always resizing (iOS), so measure again.
		let raf = 0;
		const later = () => {
			cancelAnimationFrame(raf);
			raf = requestAnimationFrame(() => {
				refit();
				if (xt.buffer.active.viewportY >= xt.buffer.active.baseY) xt.scrollToBottom();
			});
		};
		const vv = window.visualViewport;
		vv?.addEventListener("resize", later);
		window.addEventListener("orientationchange", later);

		const syncScrolled = () => (scrolledUp = xt.buffer.active.viewportY < xt.buffer.active.baseY);
		const onScroll = xt.onScroll(syncScrolled);
		const onWrite = xt.onWriteParsed(syncScrolled);
		toBottom = () => xt.scrollToBottom();
		pasteClip = async () => {
			let text = "";
			try {
				text = await navigator.clipboard.readText();
			} catch {
				// Plain http (no clipboard access): ask for the text in the app's own dialog (window.prompt is blocked or ugly in the apps)
				const asked = await app.askExtension({ owner: "", ownerName: "", kind: "input", title: t("붙여넣을 내용"), multiline: true });
				text = typeof asked === "string" ? asked : "";
			}
			if (text) xt.paste(text);
		};
		toggleKeyboard = () => {
			if (xt.textarea && document.activeElement === xt.textarea) xt.textarea.blur();
			else xt.focus();
		};

		// Touch: drag to scroll (with a little momentum), pinch to change the font size, tap to type.
		let sy = 0, carry = 0, vel = 0, lastT = 0, moved = false, glide = 0;
		let pinch0 = 0, pinchSize = 0;
		const cellH = () => (host!.querySelector(".xterm-screen") as HTMLElement | null)?.clientHeight! / xt.rows || 16;
		const dist = (e: TouchEvent) => Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
		const scrollBy = (lines: number) => {
			if (!lines) return;
			if (xt.buffer.active.type === "alternate") {
				// Full-screen apps (vim, less) have no scrollback: the arrow keys scroll them
				const seq = keySequence(lines < 0 ? "up" : "down", {}, appCursor());
				input(seq.repeat(Math.min(Math.abs(lines), 8)));
			} else xt.scrollLines(lines);
		};
		const tStart = (e: TouchEvent) => {
			cancelAnimationFrame(glide);
			if (e.touches.length === 2) {
				pinch0 = dist(e);
				pinchSize = app.prefs.terminal.fontSize;
				moved = true;
				return;
			}
			sy = e.touches[0].clientY;
			carry = vel = 0;
			lastT = e.timeStamp;
			moved = false;
		};
		const tMove = (e: TouchEvent) => {
			if (e.touches.length === 2 && pinch0) {
				e.preventDefault();
				const size = Math.round(pinchSize * (dist(e) / pinch0));
				if (size !== app.prefs.terminal.fontSize) app.prefs.setTerminal({ fontSize: size });
				return;
			}
			if (e.touches.length !== 1) return;
			const y = e.touches[0].clientY;
			const dy = y - sy;
			if (!moved && Math.abs(dy) < 6) return;
			moved = true;
			e.preventDefault();
			const dt = Math.max(1, e.timeStamp - lastT);
			vel = dy / dt;
			lastT = e.timeStamp;
			sy = y;
			const r = touchLines(carry, dy, cellH());
			carry = r.carry;
			scrollBy(r.lines);
		};
		const tEnd = (e: TouchEvent) => {
			if (e.touches.length) return;
			pinch0 = 0;
			if (!moved || Math.abs(vel) < 0.3 || e.timeStamp - lastT > 80) return;
			let v = vel * 16;
			let c = 0;
			const step = () => {
				const r = touchLines(c, v, cellH());
				c = r.carry;
				scrollBy(r.lines);
				v *= 0.94;
				if (Math.abs(v) > 0.8) glide = requestAnimationFrame(step);
			};
			glide = requestAnimationFrame(step);
		};
		// Capture phase + stopPropagation: xterm's own touch handling must not scroll a second time
		const opts = { capture: true, passive: false } as const;
		const stop = (fn: (e: TouchEvent) => void) => (e: TouchEvent) => {
			fn(e);
			e.stopPropagation();
		};
		const ts = stop(tStart), tm = stop(tMove), te = stop(tEnd);
		host.addEventListener("touchstart", ts, opts);
		host.addEventListener("touchmove", tm, opts);
		host.addEventListener("touchend", te, opts);
		host.addEventListener("touchcancel", te, opts);
		refit();
		connect();
		if (focused) xt.focus();

		return () => {
			disposed = true;
			clearTimeout(retry);
			ro.disconnect();
			cancelAnimationFrame(raf);
			cancelAnimationFrame(glide);
			vv?.removeEventListener("resize", later);
			window.removeEventListener("orientationchange", later);
			onScroll.dispose();
			onWrite.dispose();
			host?.removeEventListener("touchstart", ts, opts);
			host?.removeEventListener("touchmove", tm, opts);
			host?.removeEventListener("touchend", te, opts);
			host?.removeEventListener("touchcancel", te, opts);
			sendInput = toggleKeyboard = toBottom = pasteClip = undefined;
			onData.dispose();
			onResize.dispose();
			ws?.close();
			xt.dispose();
			term = undefined;
			refitNow = undefined;
		};
	});
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="term" data-terminal={terminal.id} ontouchstart={wake} onfocusin={() => (kbOpen = true)} onfocusout={() => (kbOpen = false)}>
	<div class="screen" bind:this={host}></div>
	{#if showBar && status !== "exited"}
		<button
			class="kb tap"
			class:idle={!awake}
			aria-label={t("키보드 접기/펴기")}
			title={t("키보드 접기/펴기")}
			onpointerdown={(e) => e.preventDefault()}
			onclick={() => {
				wake();
				toggleKeyboard?.();
			}}
		><Icon name={kbOpen ? "chevron-down" : "keyboard"} /></button>
	{/if}
	{#if showBar && status !== "exited"}
		<TerminalKeybar
			bind:mods
			{appCursor}
			{scrolledUp}
			onsend={(d) => sendInput?.(d)}
			onfit={() => refitNow?.()}
			onbottom={() => toBottom?.()}
			onpaste={() => pasteClip?.()}
		/>
	{/if}
	{#if status === "offline" || status === "connecting"}
		<div class="note" class:quiet={status === "connecting"}>{status === "offline" ? t("터미널에 다시 연결하는 중…") : t("연결하는 중…")}</div>
	{:else if status === "exited"}
		<div class="note done">
			<span>{exitCode === null ? t("셸이 종료되었습니다") : t("셸이 종료되었습니다 (코드 {code})", { code: exitCode })}</span>
			<button onclick={() => app.dropTerminal(terminal.id)}>{t("닫기")}</button>
		</div>
	{/if}
</div>

<style>
	.term {
		flex: 1;
		min-height: 0;
		position: relative;
		display: flex;
		flex-direction: column;
		background: var(--bg);
	}
	.screen {
		flex: 1;
		min-width: 0;
		min-height: 0;
		overflow: hidden;
		margin: 4px 4px 4px 16px; /* text starts on the same 16px line as the tabs above and the conversation column */
		touch-action: none;
		overscroll-behavior: contain;
	}
	.screen :global(.xterm) {
		height: 100%;
	}
	.screen :global(.xterm-viewport) {
		background: transparent !important;
	}
	/* Floating keyboard toggle, top centre over the output; backdrop blur keeps the text behind it quiet */
	.kb {
		position: absolute;
		top: 8px;
		left: 50%;
		translate: -50% 0;
		z-index: 2;
		display: grid;
		place-items: center;
		width: 44px;
		height: 36px;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-control);
		background: color-mix(in srgb, var(--bg-elev) 70%, transparent);
		backdrop-filter: blur(8px);
		-webkit-backdrop-filter: blur(8px);
		color: var(--text);
		box-shadow: var(--shadow-soft);
		opacity: 0.85;
		transition: opacity var(--motion-fast) var(--ease-std);
	}
	.kb.idle {
		opacity: 0.35;
	}
	.kb:active {
		opacity: 1;
	}
	.note {
		position: absolute;
		right: 12px;
		bottom: 10px;
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 4px 8px;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-sm);
		background: var(--bg-elev);
		color: var(--text-dim);
		font-size: var(--fs-xs);
		box-shadow: var(--shadow);
	}
	.note.quiet {
		opacity: 0.7;
	}
	.note button {
		padding: 4px 8px;
		border-radius: var(--radius-sm);
		background: var(--bg-hover);
		color: var(--text);
	}
</style>
