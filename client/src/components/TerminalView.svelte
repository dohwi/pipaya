<script lang="ts">
	import "@xterm/xterm/css/xterm.css";
	import { Terminal, type ITheme } from "@xterm/xterm";
	import { FitAddon } from "@xterm/addon-fit";
	import { onMount } from "svelte";
	import { t } from "../lib/i18n";
	import { app } from "../lib/store.svelte";
	import { copyText } from "../lib/clipboard";
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

		const onData = xt.onData((data) => {
			if (status !== "open") return;
			if (!terminal.pty) xt.write(localEcho(data));
			send({ type: "input", data });
		});
		const onResize = xt.onResize(() => sendSize());
		const ro = new ResizeObserver(() => refit());
		ro.observe(host);
		refit();
		connect();
		if (focused) xt.focus();

		return () => {
			disposed = true;
			clearTimeout(retry);
			ro.disconnect();
			onData.dispose();
			onResize.dispose();
			ws?.close();
			xt.dispose();
			term = undefined;
			refitNow = undefined;
		};
	});
</script>

<div class="term" data-terminal={terminal.id}>
	<div class="screen" bind:this={host}></div>
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
		background: var(--bg);
		padding: 6px 4px 4px 10px;
	}
	.screen {
		flex: 1;
		min-width: 0;
		min-height: 0;
		overflow: hidden;
	}
	.screen :global(.xterm) {
		height: 100%;
	}
	.screen :global(.xterm-viewport) {
		background: transparent !important;
	}
	.note {
		position: absolute;
		right: 12px;
		bottom: 10px;
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 6px 10px;
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
		padding: 2px 8px;
		border-radius: var(--radius-sm);
		background: var(--bg-hover);
		color: var(--text);
	}
</style>
