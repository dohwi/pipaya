<script lang="ts">
	import { onMount } from "svelte";
	import { t } from "../lib/i18n";
	import { app } from "../lib/store.svelte";
	import { browserSocketUrl, modifiersOf, type BrowserControl, type BrowserTabInfo } from "../lib/browser";
	import Icon from "./Icon.svelte";

	/**
	 * One browser tab of the server. The page runs in a Chromium on the server; this draws its frames on a canvas and
	 * sends mouse, wheel and key input back. An agent works in the very same page, so while it acts a badge says so.
	 * Reconnects by itself; the server sends the last frame on attach.
	 */
	let { tab, focused }: { tab: BrowserTabInfo; focused: boolean } = $props();

	let canvas: HTMLCanvasElement | undefined = $state();
	let stage: HTMLDivElement | undefined = $state();
	let status = $state<"connecting" | "open" | "offline" | "closed">("connecting");
	let control = $state<BrowserControl>("user");
	/** The session whose agent is acting (its title is shown) */
	let by = $state<string | null>(null);
	const byTitle = $derived((by && app.session(by)?.title) || null);
	let address = $state("");
	let editing = $state(false);
	let hasFrame = $state(false);
	/** Page size in CSS px of the last frame: pointer positions are scaled to it */
	let page = { width: 1280, height: 800 };
	let send: ((msg: unknown) => void) | undefined;

	const info = $derived(app.browser(tab.id) ?? tab);
	$effect(() => {
		if (!editing) address = info.url === "about:blank" ? "" : info.url;
	});

	function go(e: SubmitEvent) {
		e.preventDefault();
		const to = address.trim();
		if (!to) return;
		send?.({ type: "navigate", to });
		editing = false;
		canvas?.focus();
	}

	onMount(() => {
		const conn = app.conn;
		const cv = canvas;
		if (!conn || !cv) return;
		const ctx = cv.getContext("2d");
		let ws: WebSocket | null = null;
		let retry: ReturnType<typeof setTimeout> | undefined;
		let delay = 500;
		let disposed = false;
		let pendingSize: { width: number; height: number } | null = null;
		let drawing = false;
		let latest: Blob | null = null;

		send = (msg) => {
			if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
		};

		// Frames arrive faster than they can be decoded on a slow device: keep only the newest.
		async function draw() {
			if (drawing) return;
			drawing = true;
			try {
				while (latest && !disposed) {
					const blob = latest;
					latest = null;
					const bmp = await createImageBitmap(blob);
					if (cv!.width !== bmp.width || cv!.height !== bmp.height) {
						cv!.width = bmp.width;
						cv!.height = bmp.height;
					}
					ctx?.drawImage(bmp, 0, 0);
					bmp.close();
					hasFrame = true;
				}
			} catch {
				/* a damaged frame: the next one repairs it */
			} finally {
				drawing = false;
			}
		}

		function connect() {
			if (disposed) return;
			status = "connecting";
			const sock = new WebSocket(browserSocketUrl(conn!.baseUrl, conn!.token, tab.id));
			sock.binaryType = "arraybuffer";
			ws = sock;
			sock.onmessage = (m) => {
				if (typeof m.data !== "string") {
					if (pendingSize) page = pendingSize;
					latest = new Blob([m.data as ArrayBuffer], { type: "image/jpeg" });
					void draw();
					return;
				}
				let msg: { type?: string; control?: BrowserControl; by?: string | null; width?: number; height?: number; missing?: boolean };
				try {
					msg = JSON.parse(m.data);
				} catch {
					return;
				}
				if (msg.type === "hello") {
					status = "open";
					delay = 500;
					control = msg.control ?? "user";
					by = null;
					fitNow();
				} else if (msg.type === "frame" && msg.width && msg.height) {
					pendingSize = { width: msg.width, height: msg.height };
					page = pendingSize;
				} else if (msg.type === "state") {
					control = msg.control ?? "user";
					by = control === "agent" ? (msg.by ?? null) : null;
				} else if (msg.type === "closed") {
					status = "closed";
					app.dropBrowser(tab.id);
				}
			};
			sock.onclose = () => {
				if (ws !== sock || disposed) return;
				ws = null;
				if (status === "closed") return;
				status = "offline";
				retry = setTimeout(connect, delay);
				delay = Math.min(delay * 2, 10_000);
			};
		}
		/* ---- size: the page is laid out for this panel, so a small panel or a phone gets a small picture ---- */
		let fitTimer: ReturnType<typeof setTimeout> | undefined;
		function fitNow() {
			const box = stage?.getBoundingClientRect();
			if (!box || box.width < 40 || box.height < 40) return;
			send?.({ type: "fit", width: Math.round(box.width), height: Math.round(box.height) });
		}
		const ro = new ResizeObserver(() => {
			clearTimeout(fitTimer);
			fitTimer = setTimeout(fitNow, 150);
		});
		if (stage) ro.observe(stage);
		connect();

		/* ---- input ---- */
		const at = (e: { clientX: number; clientY: number }) => {
			const r = cv.getBoundingClientRect();
			return { x: ((e.clientX - r.left) / r.width) * page.width, y: ((e.clientY - r.top) / r.height) * page.height };
		};
		const buttonOf = (b: number) => (b === 1 ? "middle" : b === 2 ? "right" : "left");
		let lastMove = 0;
		/** While an agent acts, a stray click would land in the middle of its step: ignore the pointer until it is done. */
		const locked = () => control === "agent";
		const down = (e: PointerEvent) => {
			cv.focus();
			if (locked()) return;
			cv.setPointerCapture(e.pointerId);
			send?.({ type: "mouse", action: "down", ...at(e), button: buttonOf(e.button), clickCount: e.detail || 1 });
		};
		const up = (e: PointerEvent) => {
			if (locked()) return;
			send?.({ type: "mouse", action: "up", ...at(e), button: buttonOf(e.button), clickCount: e.detail || 1 });
		};
		const move = (e: PointerEvent) => {
			const now = performance.now();
			if (locked() || now - lastMove < 30) return;
			lastMove = now;
			send?.({ type: "mouse", action: "move", ...at(e) });
		};
		const wheel = (e: WheelEvent) => {
			e.preventDefault();
			if (locked()) return;
			const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? page.height : 1;
			send?.({ type: "wheel", ...at(e), dx: e.deltaX * scale, dy: e.deltaY * scale });
		};
		const key = (action: "down" | "up") => (e: KeyboardEvent) => {
			// Shortcuts of the app itself (Mod+Shift…, function keys) stay with the app; everything else is the page's.
			if (e.isComposing || locked()) return;
			const mod = e.ctrlKey || e.metaKey;
			if ((mod && (e.shiftKey || e.altKey)) || /^F\d+$/.test(e.key)) return;
			e.preventDefault();
			e.stopPropagation();
			const printable = e.key.length === 1 && !mod;
			send?.({ type: "key", action, key: e.key, code: e.code, text: printable ? e.key : e.key === "Enter" ? "\r" : undefined, modifiers: modifiersOf(e) });
		};
		const kd = key("down");
		const ku = key("up");
		// IME text (Korean) arrives as a finished string
		const comp = (e: CompositionEvent) => {
			if (e.data && !locked()) send?.({ type: "text", text: e.data });
		};
		const paste = (e: ClipboardEvent) => {
			const text = e.clipboardData?.getData("text/plain");
			if (!text || locked()) return;
			e.preventDefault();
			send?.({ type: "text", text });
		};

		cv.addEventListener("pointerdown", down);
		cv.addEventListener("pointerup", up);
		cv.addEventListener("pointermove", move);
		cv.addEventListener("wheel", wheel, { passive: false });
		cv.addEventListener("keydown", kd);
		cv.addEventListener("keyup", ku);
		cv.addEventListener("compositionend", comp);
		cv.addEventListener("paste", paste);
		return () => {
			disposed = true;
			clearTimeout(retry);
			send = undefined;
			cv.removeEventListener("pointerdown", down);
			cv.removeEventListener("pointerup", up);
			cv.removeEventListener("pointermove", move);
			cv.removeEventListener("wheel", wheel);
			cv.removeEventListener("keydown", kd);
			cv.removeEventListener("keyup", ku);
			cv.removeEventListener("compositionend", comp);
			cv.removeEventListener("paste", paste);
			clearTimeout(fitTimer);
			ro.disconnect();
			ws?.close();
			ws = null;
		};
	});
</script>

<div class="web" data-browser={tab.id}>
	<form class="bar" onsubmit={go}>
		<button type="button" class="nav" onclick={() => send?.({ type: "navigate", to: "back" })} aria-label={t("뒤로")} title={t("뒤로")}><Icon name="arrow-left" /></button>
		<button type="button" class="nav" onclick={() => send?.({ type: "navigate", to: "forward" })} aria-label={t("앞으로")} title={t("앞으로")}><Icon name="arrow-right" /></button>
		<button type="button" class="nav" onclick={() => send?.({ type: "navigate", to: "reload" })} aria-label={t("새로고침")} title={t("새로고침")}><Icon name="retry" /></button>
		<input
			class="addr mono"
			bind:value={address}
			onfocus={(e) => { editing = true; e.currentTarget.select(); }}
			onblur={() => (editing = false)}
			placeholder={t("주소를 입력하세요")}
			aria-label={t("주소")}
			spellcheck="false"
			autocapitalize="off"
			autocomplete="off"
		/>
		<span class="who" class:agent={control === "agent"} title={control === "agent" ? t("에이전트가 이 페이지를 조작하는 동안에는 입력이 잠깁니다") : t("직접 조작할 수 있습니다")}>
			{control === "agent" ? (byTitle ? t("{name} 조작 중", { name: byTitle }) : t("에이전트 조작 중")) : t("직접 조작")}
		</span>
	</form>
	<div class="stage" class:agent={control === "agent"} bind:this={stage}>
		<canvas bind:this={canvas} tabindex="0" class:blank={!hasFrame} aria-label={info.title || t("브라우저")} data-focused={focused ? "" : undefined}></canvas>
		{#if !hasFrame && status !== "offline"}
			<div class="hint">{info.url === "about:blank" ? t("주소를 입력해 페이지를 여세요") : t("불러오는 중…")}</div>
		{/if}
		{#if status === "offline" || status === "connecting"}
			<div class="note" class:quiet={status === "connecting"}>{status === "offline" ? t("브라우저에 다시 연결하는 중…") : t("연결하는 중…")}</div>
		{/if}
	</div>
</div>

<style>
	.web {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
		background: var(--bg);
	}
	.bar {
		display: flex;
		align-items: center;
		gap: 4px;
		padding: 6px 8px;
		border-bottom: 1px solid var(--border);
	}
	.nav {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		border-radius: var(--radius-sm);
		color: var(--text-dim);
		flex: none;
	}
	.nav:hover {
		background: var(--bg-hover);
		color: var(--text);
	}
	.nav :global(svg) {
		width: 15px;
		height: 15px;
		stroke-width: 1.9;
	}
	.addr {
		flex: 1;
		min-width: 0;
		height: 28px;
		padding: 0 10px;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: var(--bg-elev);
		color: var(--text);
		font-size: var(--fs-sm);
	}
	.addr:focus {
		outline: none;
		border-color: var(--accent);
	}
	.who {
		flex: none;
		max-width: 40%;
		overflow: hidden;
		text-overflow: ellipsis;
		padding: 2px 8px;
		border-radius: 999px;
		background: var(--bg-hover);
		color: var(--text-dim);
		font-size: var(--fs-xs);
		white-space: nowrap;
	}
	.who.agent {
		background: color-mix(in srgb, var(--accent) 18%, transparent);
		color: var(--accent);
	}
	@container (max-width: 420px) {
		.who {
			display: none;
		}
	}
	.stage {
		flex: 1;
		min-height: 0;
		position: relative;
		display: flex;
		align-items: stretch;
		justify-content: center;
		background: var(--bg-elev);
		overflow: hidden;
	}
	.stage.agent {
		box-shadow: inset 0 0 0 2px var(--accent);
	}
	canvas {
		display: block;
		max-width: 100%;
		max-height: 100%;
		width: 100%;
		height: 100%;
		object-fit: contain;
		outline: none;
		touch-action: none;
		background: #fff;
	}
	canvas.blank {
		visibility: hidden;
	}
	.hint {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		color: var(--text-faint);
		font-size: var(--fs-sm);
		pointer-events: none;
	}
	.note {
		position: absolute;
		right: 12px;
		bottom: 10px;
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
</style>
