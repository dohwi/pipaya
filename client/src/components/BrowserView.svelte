<script lang="ts">
	import { onMount } from "svelte";
	import { t } from "../lib/i18n";
	import { app } from "../lib/store.svelte";
	import { browserSocketUrl, modifiersOf, type BrowserControl, type BrowserHandoff, type BrowserTabInfo } from "../lib/browser";
	import { isTouch } from "../lib/format";
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
	/** An agent waits for you to finish something in this page */
	let handoff = $state<BrowserHandoff | null>(null);
	/** Hidden field that owns the soft keyboard and the IME on touch screens (a canvas cannot) */
	let typer: HTMLTextAreaElement | undefined = $state();
	const touch = isTouch();
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
				let msg: { type?: string; control?: BrowserControl; by?: string | null; handoff?: BrowserHandoff | null; width?: number; height?: number; missing?: boolean };
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
					handoff = null;
					fitNow();
				} else if (msg.type === "frame" && msg.width && msg.height) {
					pendingSize = { width: msg.width, height: msg.height };
					page = pendingSize;
				} else if (msg.type === "state") {
					control = msg.control ?? "user";
					by = control === "agent" ? (msg.by ?? null) : null;
					handoff = msg.handoff ?? null;
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
		const locked = () => control === "agent" && !handoff;
		/* touch: a tap clicks, a drag scrolls the page like a phone browser does, a long press is a right click */
		let touchStart: { x: number; y: number; t: number; lastY: number; lastX: number; moved: boolean; timer?: ReturnType<typeof setTimeout>; menu: boolean } | null = null;
		const TAP_SLOP = 10;
		const tdown = (e: PointerEvent) => {
			cv.setPointerCapture(e.pointerId);
			const s = { x: e.clientX, y: e.clientY, t: performance.now(), lastY: e.clientY, lastX: e.clientX, moved: false, menu: false } as NonNullable<typeof touchStart>;
			s.timer = setTimeout(() => {
				if (!touchStart || touchStart.moved || locked()) return;
				touchStart.menu = true;
				send?.({ type: "mouse", action: "down", ...at(e), button: "right", clickCount: 1 });
				send?.({ type: "mouse", action: "up", ...at(e), button: "right", clickCount: 1 });
			}, 550);
			touchStart = s;
		};
		const tmove = (e: PointerEvent) => {
			const s = touchStart;
			if (!s) return;
			if (!s.moved && Math.hypot(e.clientX - s.x, e.clientY - s.y) > TAP_SLOP) {
				s.moved = true;
				clearTimeout(s.timer);
			}
			if (!s.moved || locked()) return;
			const r = cv.getBoundingClientRect();
			const scale = page.height / r.height;
			// content follows the finger: dragging up scrolls down
			send?.({ type: "wheel", ...at(e), dx: (s.lastX - e.clientX) * scale, dy: (s.lastY - e.clientY) * scale });
			s.lastX = e.clientX;
			s.lastY = e.clientY;
		};
		const tup = (e: PointerEvent) => {
			const s = touchStart;
			touchStart = null;
			if (!s) return;
			clearTimeout(s.timer);
			if (s.moved || s.menu || locked()) return;
			send?.({ type: "mouse", action: "move", ...at(e) });
			send?.({ type: "mouse", action: "down", ...at(e), button: "left", clickCount: 1 });
			send?.({ type: "mouse", action: "up", ...at(e), button: "left", clickCount: 1 });
			// a tap may land in a text field: bring the keyboard up, the hidden field forwards what is typed
			typer?.focus({ preventScroll: true });
		};
		const down = (e: PointerEvent) => {
			if (e.pointerType === "touch") return tdown(e);
			cv.focus();
			if (locked()) return;
			cv.setPointerCapture(e.pointerId);
			send?.({ type: "mouse", action: "down", ...at(e), button: buttonOf(e.button), clickCount: e.detail || 1 });
		};
		const up = (e: PointerEvent) => {
			if (e.pointerType === "touch") return tup(e);
			if (locked()) return;
			send?.({ type: "mouse", action: "up", ...at(e), button: buttonOf(e.button), clickCount: e.detail || 1 });
		};
		const move = (e: PointerEvent) => {
			if (e.pointerType === "touch") return tmove(e);
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

		/* the hidden field: finished text goes as text, Backspace / Enter / arrows as keys (soft keyboards send those too) */
		const tk = typer;
		const SPECIAL = new Set(["Backspace", "Enter", "Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Delete", "Home", "End", "PageUp", "PageDown"]);
		const tkey = (action: "down" | "up") => (e: KeyboardEvent) => {
			if (e.isComposing || locked()) return;
			if (!SPECIAL.has(e.key) && !(e.ctrlKey || e.metaKey)) return; // plain characters arrive through `input`
			e.preventDefault();
			send?.({ type: "key", action, key: e.key, code: e.code, text: e.key === "Enter" && action === "down" ? "\r" : undefined, modifiers: modifiersOf(e) });
		};
		const tkd = tkey("down");
		const tku = tkey("up");
		const tinput = (e: Event) => {
			const ie = e as InputEvent;
			const field = e.currentTarget as HTMLTextAreaElement;
			// while composing (Korean), wait for the finished syllables; the text is sent once the composition ends
			if (ie.isComposing) return;
			if (field.value && !locked()) send?.({ type: "text", text: field.value });
			field.value = "";
		};
		const tcomp = () => {
			const field = tk;
			if (!field) return;
			if (field.value && !locked()) send?.({ type: "text", text: field.value });
			field.value = "";
		};
		tk?.addEventListener("keydown", tkd);
		tk?.addEventListener("keyup", tku);
		tk?.addEventListener("input", tinput);
		tk?.addEventListener("compositionend", tcomp);

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
			tk?.removeEventListener("keydown", tkd);
			tk?.removeEventListener("keyup", tku);
			tk?.removeEventListener("input", tinput);
			tk?.removeEventListener("compositionend", tcomp);
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
		{#if info.profile !== "default"}<span class="prof mono" title={info.profile === "temp" ? t("기록이 남지 않는 임시 프로필입니다. 마지막 탭을 닫으면 사라집니다") : t("프로필: {name}", { name: info.profile })}>{info.profile}</span>{/if}
		<span class="who" class:agent={control === "agent" && !handoff} class:ask={!!handoff} title={control === "agent" ? t("에이전트가 이 페이지를 조작하는 동안에는 입력이 잠깁니다") : t("직접 조작할 수 있습니다")}>
			{handoff ? t("내 차례") : control === "agent" ? (byTitle ? t("{name} 조작 중", { name: byTitle }) : t("에이전트 조작 중")) : t("직접 조작")}
		</span>
	</form>
	{#if handoff}
		<div class="handoff" role="status">
			<Icon name="alert" />
			<span class="note-text"><b>{(handoff.by && app.session(handoff.by)?.title) || t("에이전트")}</b> — {handoff.note}<span class="sub">{t("이 페이지에서 직접 하고, 끝나면 대화에서 \"완료\"를 누르세요")}</span></span>
		</div>
	{/if}
	<div class="stage" class:agent={control === "agent" && !handoff} class:ask={!!handoff} bind:this={stage}>
		{#if touch}<textarea bind:this={typer} class="typer" aria-hidden="true" tabindex="-1" autocapitalize="off" autocomplete="off" spellcheck="false" rows="1" {@attach (el) => el.setAttribute("autocorrect", "off")}></textarea>{/if}
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
	.prof {
		flex: none;
		padding: 2px 7px;
		border-radius: 999px;
		border: 1px solid var(--border-strong);
		color: var(--text-dim);
		font-size: var(--fs-2xs);
		max-width: 90px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.who.ask {
		background: color-mix(in srgb, var(--warn, #d9822b) 22%, transparent);
		color: var(--warn, #b5651d);
	}
	.handoff {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		padding: 8px 12px;
		border-bottom: 1px solid var(--border);
		background: color-mix(in srgb, var(--warn, #d9822b) 12%, var(--bg));
		font-size: var(--fs-sm);
		line-height: 1.5;
	}
	.handoff :global(svg) {
		flex: none;
		width: 16px;
		height: 16px;
		margin-top: 2px;
		stroke-width: 2;
		color: var(--warn, #b5651d);
	}
	.handoff .sub {
		display: block;
		color: var(--text-faint);
		font-size: var(--fs-xs);
	}
	.stage.ask {
		box-shadow: inset 0 0 0 2px var(--warn, #d9822b);
	}
	/* off-screen but focusable: it only exists to carry the soft keyboard and the IME */
	.typer {
		position: absolute;
		left: 0;
		top: 0;
		width: 1px;
		height: 1px;
		opacity: 0;
		border: 0;
		padding: 0;
		resize: none;
		pointer-events: none;
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
