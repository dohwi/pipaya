<script lang="ts">
	import { onMount, untrack } from "svelte";
	import { glowFade } from "../../lib/motion";
	import { marquee, middle } from "../../lib/fit-text";
	import { app } from "../../lib/store.svelte";
	import { t } from "../../lib/i18n";
	import { hostOf } from "../../lib/format";
	import { sessionTitle } from "../../lib/session-title";
	import { BRAND_LABEL } from "../../lib/brand";
	import { activityOf } from "../../lib/activity";
	import { formatCombo, isMac } from "../../lib/keys";
	import { toolSummary } from "../../lib/tools";
	import { graphRuns } from "../../lib/graph-runs.svelte";
	import { isMouseWheel, edgeLength, edgePath, edgeTip, sparkPlan, fitGraph, fitView, focusCards, growthPlan, leavePlan, related, springStep, type Card, type Edge, type Graph, type GraphServer } from "../../lib/graph";
	import Icon from "../ui/Icon.svelte";
	import ModelLogo from "../models/ModelLogo.svelte";
	import AgentBadge from "../shell/AgentBadge.svelte";
	import GraphQuick from "./GraphQuick.svelte";
	import GraphDetail from "./GraphDetail.svelte";
	import { released } from "../../lib/pointer";
	import { modelDisplayName, modelIcon, providerDisplayName, splitModelRef } from "../../lib/model-name";

	/**
	 * The graph view: every saved server's open chats as columns (server → provider → model → chat → subagent), the lines
	 * between them moving while work flows. Drag the background to pan, a mouse wheel to zoom (a trackpad scrolls with
	 * two fingers and zooms with a pinch), a card to move it. One click on a chat opens it in a large dialog
	 * (read it, its tool calls, write to it) at once; Ctrl/⌘ + click goes to the chat itself. A click on a server,
	 * provider, model or subagent opens its details (`GraphDetail`).
	 */

	// ---- data: what every link keeps live, plus each server's delegate calls ----
	const servers = $derived<GraphServer[]>(
		app.servers.map((s) => {
			const link = app.links[s.id];
			const d = link?.data;
			return {
				id: s.id,
				name: s.name,
				host: hostOf(s.baseUrl),
				online: !!link?.online,
				sessions: d?.sessions ?? [],
				activity: (id: string) => (d ? activityOf(d, id) : "idle"),
				queued: (id: string) => d?.queued[id]?.length ?? 0,
				runs: graphRuns.runs[s.id] ?? null,
				// the names the owner gave models and connections (the ids when none)
				modelName: (provider: string, id: string) => modelDisplayName(link?.models ?? [], provider, id),
				providerName: (id: string) => providerDisplayName(link?.providers ?? [], id),
			};
		}),
	);
	$effect(() => {
		const map = new Map(app.servers.flatMap((s) => {
			const link = app.links[s.id];
			return link ? [[s.id, { api: link.api, data: link.data }] as const] : [];
		}));
		// untracked: follow reads what its own requests write (the runs, the links' running chats), and tracking that restarted
		// it on every answer: a request loop that took the browser's connections and left a chat opened from here on its skeleton
		return untrack(() => graphRuns.follow(map));
	});

	// ---- layout: pins are cards moved by hand, kept on this device until "다시 배치" ----
	const PIN_KEY = "pipaya.graph.pins";
	const readPins = (): Record<string, { x: number; y: number }> => {
		try {
			return JSON.parse(localStorage.getItem(PIN_KEY) ?? "{}") ?? {};
		} catch {
			return {};
		}
	};
	let pins = $state(readPins());
	const savePins = () => {
		try {
			localStorage.setItem(PIN_KEY, JSON.stringify(pins));
		} catch {
			/* private mode: the pins last this visit */
		}
	};

	let measure: HTMLDivElement | undefined = $state();
	/**
	 * A card wider than its kind's width (a long model id, a long host with "연결 안 됨" after it, a long chat title): its
	 * name line and its second line, measured once per text on hidden copies with the real styles. Past `CARD_W_MAX` an id
	 * loses its middle (`use:middle`) and a display name or title its end; hovering the card flows the whole of it by
	 * (`flow` below), and the tooltip holds it too.
	 */
	const widthCache = new Map<string, number>();
	function widthOf(c: Card): number {
		if (!measure) return 0;
		if (c.kind === "session") return chatWidth(c);
		// a model's id is set in mono; a name the owner gave it in the body face, like the card draws it
		const kind = c.kind === "model" && c.name === c.label ? "model-id" : c.kind;
		const facts = metaOf(c);
		const key = `${kind}|${c.name}|${facts.parts.map((x) => `${x.mono ? "m" : ""}${x.text}`).join("\u0000")}|${facts.extra}`;
		const hit = widthCache.get(key);
		if (hit !== undefined) return hit;
		const nm = measure.querySelector<HTMLElement>(`[data-kind="${kind}"]`);
		const meta = measure.querySelector<HTMLElement>(".meta");
		if (!nm || !meta) return 0;
		nm.textContent = c.name;
		meta.replaceChildren(...facts.parts.flatMap((p, i) => {
			const s = document.createElement("span");
			s.textContent = p.text;
			if (p.mono) s.className = "mono";
			if (p.bold) s.style.fontWeight = "600";
			if (!i) return [s];
			const dot = document.createElement("i");
			dot.textContent = "·";
			dot.style.margin = "0 8px"; // `.meta i`: a scoped rule does not reach elements made here
			return [dot, s];
		}));
		// the name sits in the middle column, with the (empty) third column's 12px gap after it; the facts line spans both
		const line = Math.max(nm.getBoundingClientRect().width + 12, meta.getBoundingClientRect().width + facts.extra);
		const w = Math.ceil(line) + 24 + 12 + 32 + 2; // mark + gap + padding + border
		widthCache.set(key, w);
		return w;
	}
	/** A chat: its name with the time beside it, its title below (what it is doing while it works is live text: it never widens a column). */
	function chatWidth(c: Card): number {
		const s = c.session!;
		const name = s.name ? `@${s.name}` : sessionTitle(s.title);
		const title = sessionTitle(s.title);
		const key = `session|${name}|${title}`;
		const hit = widthCache.get(key);
		if (hit !== undefined) return hit;
		const nm = measure!.querySelector<HTMLElement>('[data-kind="session"]');
		const tl = measure!.querySelector<HTMLElement>(".title");
		const when = measure!.querySelector<HTMLElement>(".when");
		if (!nm || !tl || !when) return 0;
		nm.textContent = name;
		tl.textContent = title;
		// room for the longest time it shows before it turns into days ("59분 전", "23시간 전"), so the column does not twitch as it ages
		let wWhen = 0;
		for (const x of [t("{n}분 전", { n: 59 }), t("{n}시간 전", { n: 23 }), t("{n}일 전", { n: 30 })]) {
			when.textContent = x;
			wWhen = Math.max(wWhen, when.getBoundingClientRect().width);
		}
		const line = Math.max(nm.getBoundingClientRect().width + 12 + wWhen, tl.getBoundingClientRect().width);
		const w = Math.ceil(line) + 24 + 12 + 32 + 2; // mark + gap + padding + border
		widthCache.set(key, w);
		return w;
	}
	/**
	 * The facts line of a card as plain text, to measure it: the same parts the card shows, and the px its marks add
	 * (a role's model logo and gap, the sparkle of a model the agent picked).
	 */
	function metaOf(c: Card): { parts: { text: string; mono?: boolean; bold?: boolean }[]; extra: number } {
		const n = (text: string) => ({ text });
		if (c.kind === "server") return { parts: [n(c.host ?? ""), c.online ? n(t("대화 {n}개", { n: c.count })) : { text: t("연결 안 됨"), bold: true }], extra: 0 };
		if (c.kind === "provider") return { parts: [n(t("모델 {n}개", { n: c.children.length })), n(t("대화 {n}개", { n: c.count }))], extra: 0 };
		if (c.kind === "model") return { parts: [n(modelSource(c)), n(t("대화 {n}개", { n: c.count }))], extra: 0 };
		if (c.kind !== "subagent") return { parts: [], extra: 0 };
		const m = c.models?.[0];
		const more = c.models && c.models.length > 1 ? t("외 {n}", { n: c.models.length - 1 }) : "";
		const parts = [
			...(c.running ? [{ text: t("실행 중 {n}", { n: c.running }), bold: true }] : []),
			...(m ? [{ text: m.name, mono: true }] : []), // `.mn` is always set in mono
			...(more ? [n(more)] : []),
			n(t("{n}회", { n: c.count })),
			...(c.free ? [n(t("즉석"))] : []),
		];
		// the model's 14px logo + 4px gap, the 14px sparkle + 4px gap; "외 N" sits 4px after the name, not a dot's 17px
		return { parts, extra: m ? 18 + (c.asked ? 18 : 0) + (more ? 4 - 17 : 0) : 0 };
	}

	/** The view's size: the layout wraps many chats into columns when that shows the graph larger in it. */
	let viewW = $state(0);
	let viewH = $state(0);
	const graph: Graph = $derived(fitGraph(servers, { widths: widthOf, pins }, viewW, viewH));

	/** Reduced motion: no sparks (SMIL, which CSS cannot stop), cards and the view go straight to their place. */
	let motion = $state(typeof matchMedia !== "function" || !matchMedia("(prefers-reduced-motion: reduce)").matches);

	// ---- view: pan and zoom ----
	let viewEl: HTMLDivElement | undefined = $state();
	let view = $state({ k: 1, x: 24, y: 24 });
	/** Until the user pans, zooms or moves a card, the view keeps fitting the graph as it grows (the subagents arrive later). */
	let touched = false;
	/** The frame loop that moves cards, lines and the view (running only while something moves). */
	let raf = 0;
	let last = 0;
	/**
	 * Where the view is gliding to (fit, a zoom step), or null while the hand moves it directly (drag, pinch, a trackpad).
	 * A zoom step keeps the graph point under the pointer still: it springs the scale only and places x, y around it.
	 */
	let goal: { k: number; x: number; y: number; at?: { cx: number; cy: number; px: number; py: number } } | null = null;
	const vel = { k: 0, x: 0, y: 0 };
	/** The hand takes the view: any glide stops where it is. */
	const hold = () => {
		goal = null;
		vel.k = vel.x = vel.y = 0;
	};
	let fitted = false;
	/** F and the button: fit, and keep fitting as the graph grows (as at the start). */
	const refit = () => {
		touched = false;
		fit();
	};
	function fit() {
		if (!viewEl) return;
		// FIT_PAD keeps the floating bar clear; a graph larger than the view opens on the chats at work
		const to = fitView(graph, viewEl.clientWidth, viewEl.clientHeight, undefined, focusCards(graph));
		// the first fit places the view; later ones (the graph grew, F, the button) glide there
		if (!fitted || !motion) view = to;
		else {
			goal = to;
			kick();
		}
		fitted = true;
	}
	$effect(() => {
		void graph;
		void viewW;
		void viewH;
		if (!touched && graph.cards.size && viewEl && measure) untrack(fit);
	});
	// the window or the sidebar changes the view's size: the layout and the fit follow (until the user takes the view)
	$effect(() => {
		if (!viewEl) return;
		const el = viewEl;
		const ro = new ResizeObserver(() => {
			viewW = el.clientWidth;
			viewH = el.clientHeight;
		});
		ro.observe(el);
		return () => ro.disconnect();
	});
	const clampK = (k: number) => Math.min(2, Math.max(0.3, k));
	/** Zoom right now about a point (a pinch: the fingers lead, nothing may lag behind them). */
	const zoomAt = (k: number, cx: number, cy: number) => {
		touched = true;
		hold();
		const nk = clampK(k);
		view = { k: nk, x: cx - ((cx - view.x) / view.k) * nk, y: cy - ((cy - view.y) / view.k) * nk };
	};
	/** One step of the zoom: a wheel notch, the +/- keys and buttons. Steps in a row add up while it glides. */
	const ZOOM_STEP = 1.2;
	function zoomStep(f: number, cx: number, cy: number) {
		touched = true;
		const nk = clampK((goal?.k ?? view.k) * f);
		const px = (cx - view.x) / view.k, py = (cy - view.y) / view.k;
		if (!motion) return void (view = { k: nk, x: cx - px * nk, y: cy - py * nk });
		goal = { k: nk, x: cx - px * nk, y: cy - py * nk, at: { cx, cy, px, py } };
		kick();
	}
	const zoomBy = (f: number) => viewEl && zoomStep(f, viewEl.clientWidth / 2, viewEl.clientHeight / 2);
	function wheel(e: WheelEvent) {
		e.preventDefault();
		const r = viewEl!.getBoundingClientRect();
		// a mouse wheel zooms; so does a pinch on a trackpad (it arrives as ctrl + wheel). Two fingers on a trackpad scroll.
		const [cx, cy] = [e.clientX - r.left, e.clientY - r.top];
		if (e.ctrlKey || e.metaKey) zoomAt(view.k * Math.exp(-e.deltaY / 300), cx, cy);
		// one notch, one step of the +/- buttons; units differ between browsers, the direction does not
		else if (isMouseWheel(e)) zoomStep(ZOOM_STEP ** -Math.sign(e.deltaY), cx, cy);
		else {
			touched = true;
			hold();
			view = { ...view, x: view.x - e.deltaX, y: view.y - e.deltaY };
		}
	}

	// ---- motion: cards and the view ease to where the layout puts them instead of jumping ----
	/**
	 * Where each card is drawn now, and how fast it moves. The layout (`graph`) says where it belongs; a spring carries it
	 * there, so a chat that starts working, a column that re-sorts or a subagent that arrives slides into place.
	 */
	const shown = new Map<string, { x: number; y: number; h: number; vx: number; vy: number; vh: number }>();
	/** Bumped once per animation frame: what reads `at()` redraws. */
	let frame = $state(0);
	/** The animation clock (performance.now), advanced each frame. */
	let clock = $state(typeof performance === "object" ? performance.now() : 0);

	/*
	 * Growth: a branch grows from left to right. A line draws itself out of the card it leaves, and the card at its end
	 * fades in as the line reaches it, column after column (graph.ts `growthPlan`). Leaving is the reverse: the rightmost
	 * fades first and its line pulls back into the card it came from (`leavePlan`); until then the card stays drawn as a
	 * ghost (not clickable). Opening the view shows the whole graph at once: growth is for what changes while it is open.
	 */
	const GROW = { lead: 80, draw: 380, fade: 300 };
	const LEAVE = { fade: 200, retract: 260 };
	/** When each card starts to fade in, and each line to draw (ms, on `clock`). */
	const born = new Map<string, number>();
	const edgeBorn = new Map<string, number>();
	/** The fade-in each card was given and the draw time of each line (opening is quicker). */
	const fadeOf = new Map<string, number>();
	const drawOf = new Map<string, number>();
	let ghostCards = $state<Card[]>([]);
	let ghostEdges = $state<Edge[]>([]);
	const leaveAt = new Map<string, number>();
	const leaveEdgeAt = new Map<string, number>();
	let prev: Graph | null = null;
	// before the DOM updates: a new card must not show for one frame before its plan hides it
	$effect.pre(() => {
		const g = graph;
		untrack(() => {
			const now = performance.now();
			const opening = !prev;
			const timing = GROW;
			// back before it finished leaving: it is simply there again
			if (ghostCards.some((c) => g.cards.has(c.id))) ghostCards = ghostCards.filter((c) => !g.cards.has(c.id));
			if (ghostEdges.some((e) => g.edges.some((x) => x.id === e.id))) ghostEdges = ghostEdges.filter((e) => !g.edges.some((x) => x.id === e.id));
			if (motion && !opening) {
				const plan = growthPlan(g, (id) => born.get(id), (id) => edgeBorn.has(id), now, timing);
				for (const [id, t] of plan.cards) {
					born.set(id, t);
					fadeOf.set(id, timing.fade);
				}
				for (const [id, t] of plan.edges) {
					edgeBorn.set(id, t);
					drawOf.set(id, timing.draw);
				}
			} else {
				for (const id of g.cards.keys()) if (!born.has(id)) born.set(id, -Infinity);
				for (const e of g.edges) if (!edgeBorn.has(e.id)) edgeBorn.set(e.id, -Infinity);
			}
			// what left the layout leaves the screen right to left
			if (prev && motion) {
				const goneCards = [...prev.cards.values()].filter((c) => !g.cards.has(c.id));
				const ids = new Set(g.edges.map((e) => e.id));
				const goneEdges = prev.edges.filter((e) => !ids.has(e.id) && prev!.cards.has(e.from) && prev!.cards.has(e.to));
				if (goneCards.length || goneEdges.length) {
					const plan = leavePlan(new Set(goneCards.map((c) => c.id)), goneEdges, now, LEAVE);
					for (const [id, t] of plan.cards) leaveAt.set(id, t);
					for (const [id, t] of plan.edges) leaveEdgeAt.set(id, t);
					ghostCards = [...ghostCards, ...goneCards];
					// a line keeps its ends drawn: a gone card from this snapshot, a staying one from the layout
					ghostEdges = [...ghostEdges, ...goneEdges];
				}
			}
			for (const id of born.keys()) if (!g.cards.has(id) && !ghostCards.some((c) => c.id === id)) born.delete(id);
			for (const id of edgeBorn.keys()) if (!g.edges.some((e) => e.id === id)) {
				edgeBorn.delete(id);
				drawOf.delete(id);
			}
			for (const c of g.cards.values()) if (!shown.has(c.id)) shown.set(c.id, { x: c.x, y: c.y, h: c.h, vx: 0, vy: 0, vh: 0 });
			for (const id of shown.keys()) if (!g.cards.has(id) && !ghostCards.some((c) => c.id === id)) shown.delete(id);
			prev = g;
			kick();
		});
	});
	const ghostById = $derived(new Map(ghostCards.map((c) => [c.id, c])));
	/** A card where it is drawn this frame (the layout's place once it has settled). */
	function at(c: Card): Card {
		void frame;
		const s = shown.get(c.id);
		return s ? { ...c, x: s.x, y: s.y, h: s.h } : c;
	}
	const clamp01 = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x);
	const inOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
	/** How far a card has come in (0 hidden, 1 there), or how much of it is left while it leaves. */
	function presence(id: string): number {
		const lv = leaveAt.get(id);
		if (lv !== undefined && ghostById.has(id)) return 1 - clamp01((clock - lv) / LEAVE.fade);
		const b = born.get(id);
		return b === undefined ? 1 : clamp01((clock - b) / (fadeOf.get(id) ?? GROW.fade));
	}
	/** How much of a line is drawn: it grows out of its first card, and pulls back into it when it leaves. */
	function reach(e: Edge, ghost: boolean): number {
		if (ghost) {
			const lv = leaveEdgeAt.get(e.id);
			return lv === undefined ? 0 : 1 - clamp01((clock - lv) / LEAVE.retract) ** 2;
		}
		const b = edgeBorn.get(e.id);
		return b === undefined ? 1 : inOut(clamp01((clock - b) / (drawOf.get(e.id) ?? GROW.draw)));
	}
	/** Something still grows or leaves: the frame loop keeps going. */
	function growing(now: number): boolean {
		let busy = false;
		for (const [id, b] of born) if (now < b + (fadeOf.get(id) ?? GROW.fade)) busy = true;
		for (const [id, b] of edgeBorn) if (now < b + (drawOf.get(id) ?? GROW.draw)) busy = true;
		if (ghostCards.length || ghostEdges.length) {
			const cards = ghostCards.filter((c) => now < (leaveAt.get(c.id) ?? 0) + LEAVE.fade);
			const edges = ghostEdges.filter((e) => now < (leaveEdgeAt.get(e.id) ?? 0) + LEAVE.retract);
			if (cards.length !== ghostCards.length) {
				for (const c of ghostCards) if (!cards.includes(c)) {
					leaveAt.delete(c.id);
					born.delete(c.id);
					if (!graph.cards.has(c.id)) shown.delete(c.id);
				}
				ghostCards = cards;
			}
			if (edges.length !== ghostEdges.length) {
				for (const e of ghostEdges) if (!edges.includes(e)) leaveEdgeAt.delete(e.id);
				ghostEdges = edges;
			}
			busy ||= cards.length > 0 || edges.length > 0;
		}
		return busy;
	}
	function kick() {
		if (raf || typeof requestAnimationFrame !== "function") return;
		last = performance.now();
		raf = requestAnimationFrame(tick);
	}
	const near = (a: number, b: number, v: number, eps: number) => Math.abs(a - b) < eps && Math.abs(v) < eps * 10;
	function tick(now: number) {
		// a frame late (a busy tab, the window in the background) moves at most 50ms: no leap across the canvas
		const dt = Math.min(0.05, (now - last) / 1000);
		last = now;
		let moving = false;
		for (const [id, s] of shown) {
			const c = graph.cards.get(id);
			if (!c) continue; // a ghost: it stays where it was while it leaves
			// the card under the hand, or no motion wanted: exactly where it belongs
			if (!motion || dragging === id) {
				Object.assign(s, { x: c.x, y: c.y, h: c.h, vx: 0, vy: 0, vh: 0 });
				continue;
			}
			[s.x, s.vx] = springStep(s.x, s.vx, c.x, dt);
			[s.y, s.vy] = springStep(s.y, s.vy, c.y, dt);
			[s.h, s.vh] = springStep(s.h, s.vh, c.h, dt);
			if (near(s.x, c.x, s.vx, 0.05) && near(s.y, c.y, s.vy, 0.05) && near(s.h, c.h, s.vh, 0.05)) Object.assign(s, { x: c.x, y: c.y, h: c.h, vx: 0, vy: 0, vh: 0 });
			else moving = true;
		}
		if (goal) {
			const g = goal;
			if (g.at) {
				const [k, vk] = springStep(view.k, vel.k, g.k, dt);
				vel.k = vk;
				view = { k, x: g.at.cx - g.at.px * k, y: g.at.cy - g.at.py * k };
				if (near(k, g.k, vk, 0.0005)) view = { k: g.k, x: g.x, y: g.y };
			} else {
				let k, x, y;
				[k, vel.k] = springStep(view.k, vel.k, g.k, dt);
				[x, vel.x] = springStep(view.x, vel.x, g.x, dt);
				[y, vel.y] = springStep(view.y, vel.y, g.y, dt);
				view = near(k, g.k, vel.k, 0.0005) && near(x, g.x, vel.x, 0.1) && near(y, g.y, vel.y, 0.1) ? { k: g.k, x: g.x, y: g.y } : { k, x, y };
			}
			if (view.k === g.k && view.x === g.x && view.y === g.y) hold();
			else moving = true;
		}
		clock = now;
		if (growing(now)) moving = true;
		frame++;
		raf = moving ? requestAnimationFrame(tick) : 0;
	}
	onMount(() => () => cancelAnimationFrame(raf));


	// ---- pointer: pan the background, drag a card, click / double click a chat ----
	let hover = $state<string | null>(null);
	let selected = $state<string | null>(null);
	/** The chat the quick look shows (the store keeps it: it opens that chat on its server under the dialog). */
	const quick = $derived(app.graphPeek);
	const peek = (server: string, session: string) => void app.peekChat(server, session);
	/** The server, provider, model or subagent card whose details are open. */
	let detail = $state<string | null>(null);
	/** A click (or Enter) on a card: a chat opens its quick look, any other card its details. */
	function openCard(c: Card) {
		if (c.kind === "session") peek(c.server, c.session!.id);
		else detail = c.id;
	}
	/** card: the one being moved (mouse or pen only); tapped: the one under the pointer, which a click selects */
	let drag: { x: number; y: number; vx: number; vy: number; card: string | null; tapped: string | null; cx: number; cy: number; moved: boolean } | null = null;
	let dragging = $state<string | null>(null);
	let panning = $state(false);
	/** Ctrl (⌘ on a Mac) held with the click: go to the chat instead of looking at it. */
	const goKey = (e: { ctrlKey: boolean; metaKey: boolean }) => (isMac ? e.metaKey : e.ctrlKey);

	/** Fingers on the canvas: two make a pinch, which zooms about their midpoint and pans with it. */
	const fingers = new Map<number, { x: number; y: number }>();
	let pinch: { d: number; mx: number; my: number } | null = null;
	const pinchOf = () => {
		const [a, b] = [...fingers.values()];
		return { d: Math.hypot(a!.x - b!.x, a!.y - b!.y) || 1, mx: (a!.x + b!.x) / 2, my: (a!.y + b!.y) / 2 };
	};

	const cardAt = (target: EventTarget | null) => (target as HTMLElement | null)?.closest<HTMLElement>("[data-card]")?.dataset.card ?? null;
	function down(e: PointerEvent) {
		if (e.button !== 0 || (e.target as HTMLElement).closest(".bar")) return;
		if (e.pointerType === "touch") {
			fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
			if (fingers.size === 2) {
				// the second finger turns the drag into a pinch; nothing is clicked or moved
				drag = null;
				dragging = null;
				panning = false;
				pinch = pinchOf();
				viewEl!.setPointerCapture(e.pointerId);
				return;
			}
			if (fingers.size > 2) return;
		}
		// a finger on a card pans like one on the background: on a phone the canvas is mostly cards
		const id = e.pointerType === "touch" ? null : cardAt(e.target);
		const tapped = cardAt(e.target);
		const c = id ? graph.cards.get(id) : undefined;
		drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, card: id, tapped, cx: c?.x ?? 0, cy: c?.y ?? 0, moved: false };
		if (!id) hold(); // a press on the background stops a glide where it is
		try {
			viewEl!.setPointerCapture(e.pointerId);
		} catch {
			/* a pointer already gone (a synthetic or cancelled one): no capture needed */
		}
	}
	function move(e: PointerEvent) {
		if (fingers.has(e.pointerId)) fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
		if (pinch && fingers.size === 2) {
			const now = pinchOf();
			const r = viewEl!.getBoundingClientRect();
			view = { ...view, x: view.x + now.mx - pinch.mx, y: view.y + now.my - pinch.my };
			zoomAt((view.k * now.d) / pinch.d, now.mx - r.left, now.my - r.top);
			pinch = now;
			return;
		}
		if (!drag) {
			if (e.pointerType === "mouse") hover = cardAt(e.target);
			return;
		}
		// let go where no pointerup reached us: end a pan or card move, and a press that never moved is not a click
		if (released(e)) {
			if (drag.moved) up(e);
			else drag = null;
			return;
		}
		if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 3) {
			drag.moved = true;
			touched = true;
			if (drag.card) dragging = drag.card;
			else panning = true;
		}
		if (!drag.moved) return;
		if (drag.card) {
			pins = { ...pins, [drag.card]: { x: drag.cx + (e.clientX - drag.x) / view.k, y: drag.cy + (e.clientY - drag.y) / view.k } };
			kick(); // the dragged card follows the hand this frame, the cards it pushes ease along
		}
		else view = { ...view, x: drag.vx + e.clientX - drag.x, y: drag.vy + e.clientY - drag.y };
	}
	function up(e: PointerEvent) {
		fingers.delete(e.pointerId);
		if (pinch) {
			// the pinch ends with its first lifted finger; the other does not start a pan
			if (!fingers.size) pinch = null;
			return;
		}
		const d = drag;
		drag = null;
		panning = false;
		if (dragging) {
			dragging = null;
			savePins();
		}
		if (!d || d.moved) return;
		const c = d.tapped ? graph.cards.get(d.tapped) : undefined;
		selected = c?.id ?? null;
		if (!c) return;
		// a click opens the chat's dialog (or the card's details) at once, no wait for a second click; Ctrl/⌘ + click goes to the chat
		if (c.kind === "session" && goKey(e)) app.openIn(c.server, { session: c.session!.id });
		else openCard(c);
	}
	function arrange() {
		pins = {};
		savePins();
	}
	function key(e: KeyboardEvent) {
		if (e.ctrlKey || e.metaKey || e.altKey || (e.target as HTMLElement).closest("input, textarea, button")) return;
		const c = selected ? graph.cards.get(selected) : undefined;
		if (quick || detail) return; // the dialog has the keys
		if (e.key === "Escape" && selected) {
			e.preventDefault();
			selected = null;
		} else if (e.key === "Enter" && c) {
			e.preventDefault();
			if (c.kind === "session" && e.shiftKey) app.openIn(c.server, { session: c.session!.id });
			else openCard(c);
		} else if (e.key === "f") refit();
		else if (e.key === "+" || e.key === "=") zoomBy(ZOOM_STEP);
		else if (e.key === "-") zoomBy(1 / ZOOM_STEP);
	}

	onMount(() => {
		const q = matchMedia("(prefers-reduced-motion: reduce)");
		const on = () => (motion = !q.matches);
		q.addEventListener("change", on);
		return () => q.removeEventListener("change", on);
	});

	// ---- focus: the cards a pointer is about stand out, the rest steps back ----
	const focus = $derived(hover && !dragging && graph.cards.has(hover) ? related(graph, hover) : null);

	// ---- text ----
	let now = $state(Date.now());
	$effect(() => {
		const id = setInterval(() => (now = Date.now()), 30_000);
		return () => clearInterval(id);
	});
	function ago(at: number): string {
		const sec = Math.max(0, Math.round((now - at) / 1000));
		if (sec < 60) return t("방금");
		const min = Math.floor(sec / 60);
		if (min < 60) return t("{n}분 전", { n: min });
		const hour = Math.floor(min / 60);
		if (hour < 24) return t("{n}시간 전", { n: hour });
		return t("{n}일 전", { n: Math.floor(hour / 24) });
	}
	/** What a model card says it comes from: its maker, else its connection's name. */
	const modelSource = (c: Card) => (c.brand ? BRAND_LABEL[c.brand] : providerDisplayName(app.links[c.server]?.providers ?? [], c.provider)); // not `graph`: widths are measured while it is built
	/** The mark the owner picked for a model on that server, if any. */
	const iconOf = (server: string, provider: string | undefined, id: string) => modelIcon(app.links[server]?.models ?? [], provider, id);
	const toolNow = (c: Card) => app.links[c.server]?.data.tool[c.session!.id];
	const summary = $derived.by(() => {
		const up = servers.filter((v) => v.online).length;
		const chats = servers.reduce((n, v) => n + v.sessions.filter((s) => !s.closed).length, 0);
		const runs = servers.reduce((n, v) => n + (v.runs?.length ?? 0), 0);
		return [
			t("서버 {n}개", { n: up === servers.length ? servers.length : `${up}/${servers.length}` }),
			t("대화 {n}개", { n: chats }),
			t("서브에이전트 위임 {n}회", { n: runs }),
		].join(" · ");
	});
	/** On a chat card: what a click does, and the modifier that goes to the chat instead. */
	const openHint = t("클릭: 빠른 보기 · {key}+클릭: 대화로 이동", { key: isMac ? "⌘" : "Ctrl" });
	const detailHint = t("클릭: 자세히 보기");
	const keyHint = $derived(app.prefs.bindings.openGraph ? ` (${formatCombo(app.prefs.bindings.openGraph)})` : "");
</script>

<!-- One line of a card that may not fit: idle it ends in "…" (an id: loses its middle, `.cut`); while the card is hovered,
     one that does not fit flows by and loops back to its start (`marquee` measures it, CSS moves it). -->
{#snippet flow(text: string, mid = false)}
	{#if mid}<span class="cut" use:middle={text}></span>{/if}<span class="track" aria-hidden={mid ? "true" : undefined}><span class="mq">{text}</span><span class="dup" aria-hidden="true">{text}</span></span>
{/snippet}

<!-- A region the keyboard can reach: F fits, +/- zoom, Enter opens the selected card (a chat's quick look, Shift+Enter
     the chat itself; any other card its details). A click on a chat opens its dialog; Ctrl/⌘ + click goes to the chat. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<section class="graph" aria-label={t("그래프 뷰")} tabindex="0" onkeydown={key}>
	<header class="head">
		<div class="ttl">
			<span class="t">{t("그래프 뷰")}</span>
			<span class="sub mono">{summary}</span>
		</div>
		<button class="close" onclick={() => app.toggleGraph(false)} aria-label={t("그래프 뷰 닫기")} title={t("그래프 뷰 닫기") + keyHint}><Icon name="x" /></button>
	</header>

	<div class="body">
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="view"
		data-own-swipe
		class:panning
		bind:this={viewEl}
		onpointerdown={down}
		onpointermove={move}
		onpointerup={up}
		onpointercancel={up}
		onpointerleave={() => (hover = null)}
		onwheel={wheel}
		style:background-size="{32 * view.k}px {32 * view.k}px"
		style:background-position="{view.x}px {view.y}px"
	>
		<div class="world" style:transform="translate({Math.round(view.x)}px, {Math.round(view.y)}px) scale({view.k})">
			{#if graph.bands.length > 1}
				{#each graph.bands as b (b.server)}
					<div class="band" class:down={!b.online} style:top="{b.y0 - 24}px" style:height="{b.y1 - b.y0 + 48}px" style:width="{graph.width + 48}px"></div>
				{/each}
			{/if}
			<svg class="edges" aria-hidden="true">
				<defs>
					<filter id="gv-glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="3" /></filter>
				</defs>
				{#each [...graph.edges.filter((x) => !x.live), ...graph.edges.filter((x) => x.live), ...ghostEdges] as e (e.id)}
					{@const ghost = !graph.cards.has(e.from) || !graph.cards.has(e.to) || ghostEdges.includes(e)}
					{@const ca = graph.cards.get(e.from) ?? ghostById.get(e.from)}
					{@const cb = graph.cards.get(e.to) ?? ghostById.get(e.to)}
					{@const r = reach(e, ghost)}
					{#if ca && cb && r > 0}
						{@const a = at(ca)}
						{@const b = at(cb)}
						{@const on = !focus || (focus.has(e.from) && focus.has(e.to))}
						{@const call = e.kind === "delegate"}
						{@const d = edgePath(a, b, r, call ? "curve" : "elbow")}
						{@const full = r >= 1 && !ghost}
						<g class="e-{e.kind}" class:live={e.live && !ghost} class:dim={!on} class:hot={!!focus && on}>
							{#if e.live && full}<path class="halo" {d} filter="url(#gv-glow)" transition:glowFade />{/if}
							<path class="base" {d} style:stroke-width={call && !e.live ? 1.25 + Math.min(2, Math.log2(e.weight) * 0.5) : undefined} />
							{#if call && full}
								<!-- a call points at the subagent: a small level chevron on the card's edge (the line arrives level) -->
								{@const tip = edgeTip(a, b)}
								<path class="tip" d="M{tip.x - 6 * tip.dir} {tip.y - 4.5}L{tip.x} {tip.y}L{tip.x - 6 * tip.dir} {tip.y + 4.5}" />
							{/if}
							{#if e.live && motion && full}
								<!-- work travelling: sparks glide down the line at an even speed (sparkPlan: a long line gets more of them, not
								     faster ones), each fading in as it leaves the card and out as it arrives, a soft two-step tail behind it.
								     Timed on the layout's line, not the easing one, so a card settling does not restart them. -->
								{@const sp = sparkPlan(edgeLength(ca, cb, call ? "curve" : "elbow"), call)}
								<g class="moving" transition:glowFade>
								{#each { length: sp.n } as _, i (i)}
									{@const t0 = (-sp.dur * i) / sp.n}
									<g class="spark">
										{#each [[0.16, call ? 3.6 : 3.2, "tail2"], [0.07, call ? 4.6 : 4, "tail"], [0, call ? 2.4 : 2.1, "dot"]] as [lag, rad, part] (part)}
											<circle class={part as string} r={rad as number}>
												<animateMotion dur="{sp.dur}s" begin="{t0 - (lag as number)}s" repeatCount="indefinite" path={d} />
												<animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.14;0.86;1" dur="{sp.dur}s" begin="{t0 - (lag as number)}s" repeatCount="indefinite" />
											</circle>
										{/each}
									</g>
								{/each}
								</g>
							{/if}
						</g>
					{/if}
				{/each}
			</svg>
			{#each [...graph.cards.values(), ...ghostCards] as c (c.id)}
				{@const p = at(c)}
				{@const ghost = !graph.cards.has(c.id)}
				{@const u = presence(c.id)}
				<div
					class="card {c.kind} {c.kind === 'session' ? c.activity : ''}"
					class:down={c.kind === "server" && !c.online}
					class:run={c.kind === "subagent" && !!c.running}
					class:working={!ghost && ((c.kind === "session" && c.activity === "working") || (c.kind === "subagent" && !!c.running))}
					class:asking={!ghost && c.kind === "session" && c.activity === "asking"}
					class:dim={!!focus && !focus.has(c.id)}
					class:sel={selected === c.id}
					class:dragging={dragging === c.id}
					class:ghost
					class:arriving={u < 1}
					data-card={ghost ? undefined : c.id}
					title={ghost ? undefined : c.kind === "session" ? openHint : detailHint}
					style:--in={u}
					style:width="{c.w}px"
					style:height="{p.h}px"
					style:transform="translate({p.x - c.w / 2}px, {p.y - p.h / 2}px)"
				>
					{#if c.kind === "server"}
						<span class="lead"><Icon name="server" /></span>
						<span class="nm fl" title={c.label} use:marquee={c.label}>{@render flow(c.label)}</span>
						<span class="meta"><span class="give fl mid" title={c.host} use:marquee={c.host ?? ""}>{@render flow(c.host ?? "", true)}</span><i>·</i>{#if c.online}<span>{t("대화 {n}개", { n: c.count })}</span>{:else}<em class="bad">{t("연결 안 됨")}</em>{/if}</span>
					{:else if c.kind === "provider"}
						<span class="lead"><Icon name="plug" /></span>
						<span class="nm fl" title={c.name !== c.label ? `${c.name} · ${c.label}` : c.name} use:marquee={c.name}>{@render flow(c.name)}</span>
						<span class="meta"><span>{t("모델 {n}개", { n: c.children.length })}</span><i>·</i><span>{t("대화 {n}개", { n: c.count })}</span></span>
					{:else if c.kind === "model"}
						<span class="lead"><ModelLogo conn={app.links[c.server]?.conn} icon={iconOf(c.server, c.provider, c.label)} provider={c.provider} model={c.label} size={24} colored /></span>
						{#if c.name === c.label}<span class="nm mono fl mid" title={c.name} use:marquee={c.name}>{@render flow(c.name, true)}</span>
						{:else}<span class="nm fl" title={`${c.name} · ${c.provider}/${c.label}`} use:marquee={c.name}>{@render flow(c.name)}</span>{/if}
						<span class="meta"><span class="give fl" use:marquee={modelSource(c)}>{@render flow(modelSource(c))}</span><i>·</i><span>{t("대화 {n}개", { n: c.count })}</span></span>
					{:else if c.kind === "subagent"}
						{@const m = c.models?.[0]}
						{@const ref = m ? splitModelRef(m.model) : null}
						<span class="lead"><Icon name="bot" /></span>
						<span class="nm fl mid" title={c.label} use:marquee={c.label}>{@render flow(c.label, true)}</span>
						<span class="meta">
							{#if c.running}<em class="run">{t("실행 중 {n}", { n: c.running })}</em><i>·</i>{/if}
							{#if m}
								<span class="model" title={c.models!.map((x) => `${x.name} ${t("{n}회", { n: x.n })}`).join(" · ")}>
									<ModelLogo conn={app.links[c.server]?.conn} icon={iconOf(c.server, ref?.provider, ref?.id ?? "")} provider={ref?.provider} model={ref?.id} size={14} colored />
									<span class="mn fl" class:mono={m.name === ref?.id} class:mid={m.name === ref?.id} use:marquee={m.name}>{@render flow(m.name, m.name === ref?.id)}</span>
									{#if c.asked}<span class="pick" title={t("에이전트가 모델을 직접 골랐습니다 ({n}회)", { n: c.asked })}><Icon name="sparkles" /></span>{/if}
									{#if c.models!.length > 1}<span class="more">{t("외 {n}", { n: c.models!.length - 1 })}</span>{/if}
								</span><i>·</i>
							{/if}
							<span>{t("{n}회", { n: c.count })}</span>
							{#if c.free}<i>·</i><span title={t("역할 파일 없이 에이전트가 이름을 정한 서브에이전트입니다. 읽기 전용 도구만 쓰고 작업 내용이 곧 지침입니다")}>{t("즉석")}</span>{/if}
						</span>
					{:else}
						{@const s = c.session!}
						{@const tool = toolNow(c)}
						{@const busy = c.activity === "working" || c.activity === "asking"}
						<span class="lead"><AgentBadge id={s.id} server={c.server} state={c.activity} size={24} /></span>
						{@const name = s.name ? `@${s.name}` : sessionTitle(s.title)}
						<span class="nm fl" title={name} use:marquee={name}>{@render flow(name)}</span>
						{#if !busy}<span class="when">{ago(s.updatedAt)}</span>{/if}
						<span class="title fl" title={sessionTitle(s.title)} use:marquee={sessionTitle(s.title)}>{@render flow(sessionTitle(s.title))}</span>
						{#if busy}
							<span class="doing" class:ask={c.activity === "asking"} in:glowFade={{ delay: 120 }}>
								{#if c.activity === "asking"}
									<Icon name="alert" /><span class="what">{t("답을 기다립니다")}</span>
								{:else if tool}
									<Icon name="bolt" /><b>{tool.name}</b><span class="what fl" use:marquee={toolSummary(tool.name, tool.args)}>{@render flow(toolSummary(tool.name, tool.args))}</span>
								{:else}
									<Icon name="brain" /><span class="what">{t("생각 중")}</span>
								{/if}
								{#if c.queued}<span class="q" title={t("전달 대기 중인 메시지")}><Icon name="list" />{c.queued}</span>{/if}
							</span>
						{/if}
					{/if}
				</div>
			{/each}
		</div>

		{#if !graph.cards.size}
			<p class="empty">{t("저장된 서버가 없습니다")}</p>
		{/if}

		<div class="bar">
			<button class="tbtn" onclick={arrange} disabled={!Object.keys(pins).length} title={t("옮긴 카드를 제자리로")}><Icon name="columns" />{t("다시 배치")}</button>
			<span class="sep"></span>
			<button class="tbtn icon" onclick={() => zoomBy(1 / ZOOM_STEP)} aria-label={t("축소")} title={t("축소")}>−</button>
			<span class="pct mono">{Math.round(view.k * 100)}%</span>
			<button class="tbtn icon" onclick={() => zoomBy(ZOOM_STEP)} aria-label={t("확대")} title={t("확대")}><Icon name="plus" /></button>
			<button class="tbtn icon" onclick={refit} aria-label={t("전체 보기")} title={t("전체 보기 (F)")}><Icon name="expand" /></button>
		</div>
	</div>

	</div>

	<!-- hidden copies of the one-line names, to measure a long one -->
	<div class="measure" bind:this={measure} aria-hidden="true">
		{#each ["server", "provider", "model", "model-id", "subagent", "session"] as k (k)}<span class="nm" class:mono={k === "model-id"} data-kind={k}></span>{/each}
		<span class="meta"></span>
		<span class="title"></span>
		<span class="when"></span>
	</div>
</section>

{#if detail && !quick}
	<GraphDetail
		{graph}
		id={detail}
		onpick={(id) => { detail = id; selected = id; }}
		onpeek={(server, session) => { detail = null; peek(server, session); }}
		onclose={() => (detail = null)}
	/>
{/if}
{#if quick}
	{#key `${quick.server}/${quick.session}`}<GraphQuick server={quick.server} session={quick.session} onclose={() => app.closePeek()} />{/key}
{/if}


<style>
	.graph {
		position: relative;
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
		outline: none;
	}
	.head {
		flex: none;
		display: flex;
		align-items: center;
		gap: 12px;
		/* the app header's box (44px + 1px hairline), so its line meets the sidebar brand row's */
		box-sizing: content-box;
		height: 44px;
		padding: 0 16px;
		border-bottom: 1px solid var(--border);
	}
	.ttl {
		min-width: 0;
		flex: 1;
		display: flex;
		flex-direction: column;
	}
	.ttl .t {
		font-size: var(--fs-md);
		font-weight: 600;
		line-height: 20px;
	}
	.ttl .sub {
		font-size: var(--fs-2xs);
		line-height: 16px;
		color: var(--text-faint);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.close {
		flex: none;
		display: inline-grid;
		place-items: center;
		width: 32px;
		height: 32px;
		margin-right: -8px; /* the 16px glyph sits on the 16px gutter (DESIGN rule 5) */
		border-radius: var(--radius-sm);
		color: var(--text-dim);
		font-size: 16px;
	}
	@media (hover: hover) {
		.close:hover {
			background: var(--bg-hover);
			color: var(--text);
		}
	}

	/* ---- the canvas, and the chat panel beside it ---- */
	.body {
		position: relative;
		flex: 1;
		min-height: 0;
		display: flex;
	}
	.view {
		position: relative;
		flex: 1;
		min-width: 0;
		min-height: 0;
		overflow: hidden;
		cursor: grab;
		touch-action: none;
		user-select: none;
		background-image: linear-gradient(to right, var(--grid-line) 1px, transparent 1px), linear-gradient(to bottom, var(--grid-line) 1px, transparent 1px);
	}
	.view.panning {
		cursor: grabbing;
	}
	.world {
		position: absolute;
		left: 0;
		top: 0;
		transform-origin: 0 0;
	}
	.band {
		position: absolute;
		left: -24px;
		border: 1px solid var(--border);
		border-radius: var(--radius-panel);
		background: color-mix(in srgb, var(--text) 2%, transparent);
		pointer-events: none;
	}
	.band {
		transition:
			top var(--motion-slow) var(--ease-std),
			height var(--motion-slow) var(--ease-std),
			width var(--motion-slow) var(--ease-std);
	}
	.band.down {
		border-style: dashed;
	}
	.empty {
		position: absolute;
		inset: 0;
		display: grid;
		place-items: center;
		margin: 0;
		color: var(--text-faint);
		font-size: var(--fs-sm);
	}

	/* ---- lines ---- */
	.edges {
		position: absolute;
		left: 0;
		top: 0;
		width: 1px;
		height: 1px;
		overflow: visible;
		pointer-events: none;
	}
	/* a line that starts or stops carrying work changes colour and weight over a moment, not in one frame */
	.edges path {
		fill: none;
		transition:
			stroke var(--motion-slow) var(--ease-std),
			stroke-width var(--motion-slow) var(--ease-std),
			opacity var(--motion-slow) var(--ease-std);
	}
	.edges g {
		transition: opacity var(--motion-normal) var(--ease-std);
	}
	.edges .base {
		stroke-width: 1.25;
		opacity: 0.5;
		stroke-linejoin: round;
	}
	.edges .tip {
		stroke-width: 1.5;
		stroke-linecap: round;
		stroke-linejoin: round;
		opacity: 0.7;
	}
	.edges g.live .tip {
		stroke-width: 2;
		opacity: 1;
	}
	/* structure (server → provider → model → chat): quiet grey; once a chat under it works, the whole line up lights */
	.e-tree path {
		stroke: var(--tree-line);
	}
	.e-spawn path {
		stroke: var(--text-faint);
	}
	.e-spawn .base {
		stroke-width: 1.5;
		stroke-dasharray: 4 4; /* a branch: drawn dashed, so it reads apart from the structure */
	}
	.e-delegate path {
		stroke: var(--info);
	}
	.e-delegate .base {
		opacity: 0.4;
	}
	/* a line carrying work: a solid coloured stroke, a soft glow under it, a dash train and sparks running along it */
	.edges g.live .base {
		stroke-width: 2;
		opacity: 0.9;
		stroke-dasharray: none;
	}
	.e-tree.live path,
	.e-spawn.live path {
		stroke: var(--ok);
	}
	.e-delegate.live .base {
		stroke-width: 2.5;
	}
	/* the glow under a live line breathes slowly, in step with the working cards (same beat as the card ring's glow) */
	.edges .halo {
		stroke-width: 6;
		opacity: 0.3;
		animation: halo 3.2s ease-in-out infinite;
	}
	.e-delegate .halo {
		stroke-width: 7;
	}
	@keyframes halo {
		50% {
			opacity: 0.1;
		}
	}
	/* a spark: a bright head and a tail that thins out behind it (fill-opacity: the opacity itself fades it at the ends) */
	.spark .dot {
		fill: #fff;
	}
	.e-tree .spark circle:not(.dot),
	.e-spawn .spark circle:not(.dot) {
		fill: var(--ok);
	}
	.e-delegate .spark circle:not(.dot) {
		fill: var(--info);
	}
	.spark .tail {
		fill-opacity: 0.4;
	}
	.spark .tail2 {
		fill-opacity: 0.16;
	}
	:global(:root[data-theme="light"]) .spark .dot {
		fill: var(--bg);
		stroke-width: 1.5;
	}
	:global(:root[data-theme="light"]) .e-tree .spark .dot,
	:global(:root[data-theme="light"]) .e-spawn .spark .dot {
		stroke: var(--ok);
	}
	:global(:root[data-theme="light"]) .e-delegate .spark .dot {
		stroke: var(--info);
	}
	.edges g.dim {
		opacity: 0.12;
	}
	.edges g.dim .halo {
		animation-play-state: paused;
	}
	.edges g.dim .spark {
		display: none;
	}
	.edges g.hot .base {
		opacity: 1;
	}

	/* ---- cards: a 24px mark spanning two 20px lines, 12px gap, 16px inside the border (like a list card) ---- */
	.card {
		position: absolute;
		left: 0;
		top: 0;
		display: grid;
		grid-template-columns: 24px minmax(0, 1fr) auto;
		grid-template-rows: 20px 20px;
		grid-auto-rows: 40px;
		gap: 0 12px;
		align-content: start;
		align-items: center;
		padding: 15px 16px; /* 15 + the 1px border = 16 */
		border: 1px solid var(--border-strong);
		border-radius: var(--radius);
		background: var(--bg);
		box-shadow: var(--shadow-soft);
		cursor: pointer;
		overflow: hidden;
		transition:
			opacity var(--motion-normal) var(--ease-std),
			border-color var(--motion-normal) var(--ease-std),
			box-shadow var(--motion-normal) var(--ease-std);
	}
	@media (hover: hover) {
		.card:hover {
			border-color: var(--text-faint);
		}
	}
	.card.dragging {
		z-index: 1;
		cursor: grabbing;
		border-color: var(--text-faint);
		box-shadow: var(--shadow);
	}
	/*
	 * A card at work: a light runs round its border (a conic gradient behind a transparent border, turning on the
	 * registered --ring-a), in the colour of the line it sits on: green for a chat, blue for a subagent. A soft glow
	 * breathes around it. A chat waiting for an answer holds a steady amber ring that breathes, no running light.
	 */
	.card.working,
	.card.asking {
		--ring: var(--ok);
		border-color: transparent;
		background:
			linear-gradient(var(--bg), var(--bg)) padding-box,
			conic-gradient(
					from var(--ring-a),
					color-mix(in srgb, var(--ring) 35%, var(--border-strong)) 0 52%,
					var(--ring) 76%,
					color-mix(in srgb, var(--ring) 35%, var(--border-strong)) 100%
				)
				border-box;
		animation:
			ring-turn 3.2s linear infinite,
			ring-glow 3.2s ease-in-out infinite;
	}
	.card.subagent.working {
		--ring: var(--info);
	}
	.card.asking {
		--ring: var(--warn);
		background:
			linear-gradient(var(--bg), var(--bg)) padding-box,
			linear-gradient(color-mix(in srgb, var(--ring) 70%, var(--border-strong)), color-mix(in srgb, var(--ring) 70%, var(--border-strong))) border-box;
		animation: ring-glow 3.2s ease-in-out infinite;
	}
	@keyframes ring-turn {
		to {
			--ring-a: 360deg;
		}
	}
	@keyframes ring-glow {
		0%,
		100% {
			box-shadow:
				0 0 0 0 color-mix(in srgb, var(--ring) 0%, transparent),
				var(--shadow-soft);
		}
		50% {
			box-shadow:
				0 0 16px 0 color-mix(in srgb, var(--ring) 24%, transparent),
				var(--shadow-soft);
		}
	}
	.card.sel {
		border-color: var(--text);
		box-shadow:
			0 0 0 3px var(--accent-soft),
			var(--shadow-soft);
	}
	.card.dim {
		opacity: 0.45; /* still readable: the related cards stand out, the rest stays legible */
	}
	/* coming in (or going): --in runs 0 → 1 per frame as its line reaches it; it fades up, from a touch smaller and from the
	   left where the line comes from. `scale` and `translate` leave the transform that places the card alone. */
	.card.arriving {
		opacity: var(--in);
		scale: calc(0.96 + 0.04 * var(--in));
		translate: calc((1 - var(--in)) * -12px) 0;
		transition: none;
	}
	.card.dim.arriving {
		opacity: calc(0.45 * var(--in));
	}
	.card.ghost {
		pointer-events: none;
	}
	.lead {
		grid-row: 1 / 3;
		display: grid;
		place-items: center;
		width: 24px;
		height: 24px;
		font-size: 24px;
		color: var(--text-dim);
	}
	.server .lead {
		color: var(--ok);
	}
	.server.down .lead {
		color: var(--danger);
	}
	.run .lead {
		color: var(--info);
		animation: pulse var(--anim-working-duration) var(--anim-working-ease) infinite;
	}
	.nm {
		grid-column: 2;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: var(--fs-md);
		font-weight: 600;
		line-height: 20px;
	}
	.nm.mono {
		font-family: var(--mono);
		font-size: var(--fs-sm);
		font-weight: 500;
	}
	.meta {
		grid-column: 2 / 4;
		grid-row: 2;
		display: flex;
		align-items: center;
		min-width: 0;
		overflow: hidden;
		white-space: nowrap;
		font-size: var(--fs-xs);
		line-height: 20px;
		color: var(--text-faint);
	}
	.meta > * {
		flex: none;
	}
	/* the long part of a facts line (a host, a maker or connection name) gives way to the state and the counts after it */
	.meta > .give {
		flex: 0 1 auto;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.meta i {
		margin: 0 8px;
		font-style: normal;
		opacity: 0.6; /* a quiet dot between facts */
	}
	.meta em {
		font-style: normal;
		font-weight: 600;
	}
	.meta .bad {
		color: var(--danger);
	}
	.meta .run {
		color: var(--info);
	}
	.meta .model {
		flex: 0 1 auto; /* the model name gives way first */
		display: inline-flex;
		align-items: center;
		gap: 4px;
		min-width: 0;
	}
	.meta .model .mn {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		font-family: var(--mono);
		color: var(--text-dim);
	}
	.meta .pick {
		flex: none;
		display: inline-grid;
		place-items: center;
		width: 14px;
		height: 14px;
		font-size: 12px;
		color: var(--warn);
	}
	.meta .more {
		flex: none;
	}

	/* a chat: name and time, its title, and while it works what it is on */
	.when {
		grid-column: 3;
		grid-row: 1;
		font-size: var(--fs-xs);
		line-height: 16px;
		color: var(--text-faint);
		white-space: nowrap;
	}
	.done .when {
		color: var(--ok); /* the time takes the logo's colour: no badge */
	}
	.failed .when {
		color: var(--danger);
	}
	.title {
		grid-column: 2 / 4;
		grid-row: 2;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: var(--fs-sm);
		line-height: 20px;
		color: var(--text-dim);
	}
	.doing {
		grid-column: 1 / 4;
		grid-row: 3;
		align-self: end;
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
		height: 28px;
		padding: 0 8px;
		border-radius: var(--radius-sm);
		background: var(--bg-set);
		font-family: var(--mono);
		font-size: var(--fs-2xs);
		line-height: 16px;
		color: var(--text-faint);
	}
	.doing > :global(.ic) {
		flex: none;
		font-size: 14px;
		color: var(--info);
		animation: pulse var(--anim-working-duration) var(--anim-working-ease) infinite;
	}
	.doing.ask > :global(.ic) {
		color: var(--warn);
	}
	.doing b {
		flex: none;
		font-weight: 600;
		color: var(--text-dim);
	}
	.doing .what {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.doing .q {
		margin-left: auto;
		flex: none;
		display: inline-flex;
		align-items: center;
		gap: 4px;
		font-weight: 600;
		color: var(--text-dim);
	}
	.doing .q :global(.ic) {
		font-size: 12px;
		color: var(--text-faint);
	}
	@keyframes pulse {
		50% {
			opacity: var(--anim-working-dim);
		}
	}

	/* ---- the floating bar ---- */
	.bar {
		position: absolute;
		right: 16px;
		bottom: 16px;
		z-index: 2;
		display: flex;
		align-items: center;
		gap: 4px;
		padding: 4px;
		border: 1px solid var(--border);
		border-radius: var(--radius-control);
		background: var(--bg-elev);
		box-shadow: var(--shadow-soft);
		cursor: default;
	}
	.bar .sep {
		width: 1px;
		height: 20px;
		margin: 0 4px;
		background: var(--border);
	}
	.tbtn {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		height: 32px;
		padding: 0 12px 0 8px;
		border-radius: var(--radius-sm);
		color: var(--text-dim);
		font-size: var(--fs-xs);
		font-weight: 600;
		line-height: 16px;
	}
	.tbtn.icon {
		width: 32px;
		padding: 0;
		justify-content: center;
		font-size: 16px;
	}
	.tbtn :global(.ic) {
		font-size: 16px;
	}
	@media (hover: hover) {
		.tbtn:hover:not(:disabled) {
			background: var(--bg-hover);
			color: var(--text);
		}
	}
	.tbtn:disabled {
		opacity: 0.45;
		cursor: default;
	}
	.pct {
		min-width: 44px;
		text-align: center;
		font-size: var(--fs-2xs);
		color: var(--text-dim);
	}

	/* ---- a line that does not fit: "…" idle, flowing by while its card is hovered ---- */
	.fl .track {
		display: inline;
	}
	.fl .dup {
		display: none;
	}
	/* an id: idle it shows the middle cut; the whole text waits beside it (unseen, still measured) */
	.fl.mid {
		position: relative;
	}
	.fl.mid .cut {
		display: block;
		overflow: hidden;
		white-space: nowrap;
	}
	.fl.mid .track {
		position: absolute;
		left: 0;
		top: 0;
		visibility: hidden;
	}
	@media (hover: hover) and (prefers-reduced-motion: no-preference) {
		.card:hover .fl:global([data-over]) {
			text-overflow: clip;
			-webkit-mask-image: linear-gradient(90deg, #000 calc(100% - 14px), transparent);
			mask-image: linear-gradient(90deg, #000 calc(100% - 14px), transparent);
		}
		.card:hover .fl:global([data-over]) .cut {
			display: none;
		}
		.card:hover .fl:global([data-over]) .track {
			position: static;
			display: flex;
			width: max-content;
			visibility: visible;
			/* a beat on the start first, so a pointer passing over does not set every line moving */
			animation: graph-mq var(--mq-d, 8s) linear 400ms infinite;
		}
		.card:hover .fl:global([data-over]) .mq,
		.card:hover .fl:global([data-over]) .dup {
			display: block;
			flex: none;
			padding-right: 32px;
		}
	}
	@keyframes graph-mq {
		from {
			translate: 0;
		}
		to {
			translate: -50%;
		}
	}
	.measure {
		position: absolute;
		left: -9999px;
		top: 0;
		visibility: hidden;
		pointer-events: none;
	}
	.measure .nm,
	.measure .meta,
	.measure .title,
	.measure .when {
		display: block;
		width: max-content;
		overflow: visible;
	}
	@media (prefers-reduced-motion: reduce) {
		.edges path,
		.edges g,
		.band,
		.card {
			transition: none;
		}
		/* still: the ring stays where it is, a steady colour all round */
		.card.working {
			animation: none;
			background:
				linear-gradient(var(--bg), var(--bg)) padding-box,
				linear-gradient(color-mix(in srgb, var(--ring) 70%, var(--border-strong)), color-mix(in srgb, var(--ring) 70%, var(--border-strong))) border-box;
		}
		.card.asking,
		.edges .halo,
		.run .lead,
		.doing > :global(.ic) {
			animation: none;
		}
	}
</style>
