<script lang="ts">
	import { onMount, untrack } from "svelte";
	import { glowFade } from "../../lib/motion";
	import { middle } from "../../lib/fit-text";
	import { fontSpecOf, measureTextWidth, onFontsLoaded, type FontSpec } from "../../lib/text-measure";
	import { app } from "../../lib/store.svelte";
	import { localeTag, t } from "../../lib/i18n";
	import { hostOf, pastLabel } from "../../lib/format";
	import { livePast } from "../../lib/minute-clock.svelte";
	import { sessionTitle } from "../../lib/session-title";
	import { BRAND_LABEL } from "../../lib/brand";
	import { activityOf } from "../../lib/activity";
	import { formatCombo, isMac } from "../../lib/keys";
	import { toolSummary } from "../../lib/tools";
	import { graphRuns } from "../../lib/graph-runs.svelte";
	import { onGraphPinForgotten, readGraphPins, writeGraphPins } from "../../lib/graph-pins";
	import { isMouseWheel, edgeLength, edgePath, edgeTip, sparkPlan, fitGraph, fitView, focusCards, growthPlan, leavePlan, quietCards, related, springStep, type Card, type Edge, type Graph, type GraphServer } from "../../lib/graph";
	import EmptyState from "../ui/EmptyState.svelte";
	import Icon from "../ui/Icon.svelte";
	import IconButton from "../ui/IconButton.svelte";
	import ModelLogo from "../models/ModelLogo.svelte";
	import AgentBadge from "../shell/AgentBadge.svelte";
	import SessionQuickModal from "../shell/SessionQuickModal.svelte";
	import GraphDetail from "./GraphDetail.svelte";
	import NavbarItems from "../extensions/NavbarItems.svelte";
	import ExtensionMount from "../extensions/ExtensionMount.svelte";
	import { released } from "../../lib/pointer";
	import { splitModelRef } from "../../lib/model-name";

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
				modelName: (provider: string, id: string) => link?.modelByKey.get(`${provider}\u0000${id}`)?.name?.trim() || id,
				providerName: (id: string) => link?.providerById.get(id)?.name?.trim() || id,
				endpoint: (id: string) => {
					const custom = link?.customProviderById.get(id);
					if (custom) return { id: custom.id, name: custom.name, baseUrl: custom.baseUrl, api: custom.api, builtin: false };
					const info = link?.providerById.get(id);
					if (info) return { id: info.id, name: info.name, builtin: info.builtin };
					return undefined;
				},
			};
		}),
	);
	const multiServer = $derived(servers.length > 1);
	const serverNames = $derived(new Map(servers.map((s) => [s.id, s.name])));
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
	let pins = $state(readGraphPins());
	const savePins = () => writeGraphPins(pins);
	$effect(() =>
		onGraphPinForgotten((key) => {
			if (!Object.hasOwn(pins, key)) return;
			const { [key]: _, ...rest } = pins;
			pins = rest;
		}),
	);

	let measure: HTMLDivElement | undefined = $state();
	/**
	 * A card wider than its kind's width (a long model id, a long host with "연결 안 됨" after it, a long chat title): its
	 * name line and its second line, measured via offscreen Canvas 2D using the hidden `.measure` elements' real computed
	 * fonts (zero DOM mutations / forced layouts per card; falls back to DOM `.measure` when Canvas 2D is unavailable).
	 * Past `CARD_W_MAX` an id loses its middle (`use:middle`) and a display name or title its end; hovering the card flows
	 * the whole of it by (`flow` below), and the tooltip holds it too.
	 */
	type FontSet = { nm: FontSpec; nmMono: FontSpec; meta: FontSpec; metaBold: FontSpec; metaMono: FontSpec; title: FontSpec; when: FontSpec; dotW: number };
	let fonts = $state<FontSet | null>(null);
	let fontGen = $state(0);
	const widthCache = new Map<string, number>();
	let whenSamplesKey = "";
	let whenSamplesCache: string[] = [];
	const whenWidthCache = new Map<string, number>();

	function readFonts(root: HTMLDivElement): FontSet | null {
		const nmEl = root.querySelector<HTMLElement>('[data-kind="session"]');
		const nmMonoEl = root.querySelector<HTMLElement>('[data-kind="model-id"]');
		const metaEl = root.querySelector<HTMLElement>(".meta");
		const metaMonoEl = root.querySelector<HTMLElement>("[data-mono-meta]");
		const titleEl = root.querySelector<HTMLElement>(".title");
		const whenEl = root.querySelector<HTMLElement>(".when");
		if (!nmEl || !nmMonoEl || !metaEl || !metaMonoEl || !titleEl || !whenEl) return null;
		const meta = fontSpecOf(metaEl);
		const dot = measureTextWidth("·", meta);
		if (dot === null) return null; // Canvas 2D unavailable (happy-dom / SSR): use DOM fallback
		return {
			nm: fontSpecOf(nmEl),
			nmMono: fontSpecOf(nmMonoEl),
			meta,
			metaBold: fontSpecOf(metaEl, "600"),
			metaMono: fontSpecOf(metaMonoEl),
			title: fontSpecOf(titleEl),
			when: fontSpecOf(whenEl),
			dotW: dot + 16, // `.meta i { margin: 0 8px }`
		};
	}

	/** Every form a card's time can take (pastLabel with `time: false`), at its widest, cached per locale. */
	function whenSamples(): string[] {
		const tag = localeTag();
		if (whenSamplesKey === tag && whenSamplesCache.length) return whenSamplesCache;
		const now = new Date(2026, 11, 31, 23, 59).getTime();
		const ago = (ms: number) => pastLabel(now - ms, now, { time: false });
		whenSamplesKey = tag;
		whenSamplesCache = [ago(59 * 60_000), ago(5 * 3_600_000), ago(11 * 3_600_000 + 59 * 60_000), ago(24 * 3_600_000), ago(3 * 86_400_000), ago(13 * 86_400_000), pastLabel(new Date(2025, 11, 30).getTime(), now, { time: false })];
		return whenSamplesCache;
	}

	function maxWhenWidth(srv: string, f: FontSet | null): number {
		const key = `${localeTag()}|${f?.when.font ?? "dom"}|${srv}`;
		const hit = whenWidthCache.get(key);
		if (hit !== undefined) return hit;
		let wWhen = 0;
		const samples = whenSamples();
		if (f) {
			for (const x of samples) {
				const w = measureTextWidth(srv ? `${srv} · ${x}` : x, f.when) ?? 0;
				if (w > wWhen) wWhen = w;
			}
		} else if (measure) {
			const when = measure.querySelector<HTMLElement>(".when");
			if (when) {
				for (const x of samples) {
					when.textContent = srv ? `${srv} · ${x}` : x;
					const w = when.getBoundingClientRect().width;
					if (w > wWhen) wWhen = w;
				}
			}
		}
		whenWidthCache.set(key, wWhen);
		return wWhen;
	}

	function widthOf(c: Card): number {
		if (!measure) return 0;
		if (c.kind === "session") return chatWidth(c);
		// a model's id is set in mono; a name the owner gave it in the body face, like the card draws it
		const kind = c.kind === "model" && c.name === c.label ? "model-id" : c.kind;
		const facts = metaOf(c);
		const f = fonts;
		if (f) {
			const nmW = measureTextWidth(c.name, kind === "model-id" ? f.nmMono : f.nm) ?? 0;
			let metaW = 0;
			for (let i = 0; i < facts.parts.length; i++) {
				const p = facts.parts[i]!;
				if (i) metaW += f.dotW;
				const spec = p.mono ? f.metaMono : p.bold ? f.metaBold : f.meta;
				metaW += measureTextWidth(p.text, spec) ?? 0;
			}
			const line = Math.max(nmW + 12, metaW + facts.extra);
			return Math.ceil(line) + 24 + 12 + 32 + 2; // mark + gap + padding + border
		}
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
		const srv = multiServer ? (serverNames.get(c.server) ?? c.server) : "";
		const name = s.name ? `@${s.name}` : sessionTitle(s.title);
		const title = sessionTitle(s.title);
		const f = fonts;
		if (f) {
			const nmW = measureTextWidth(name, f.nm) ?? 0;
			const tlW = measureTextWidth(title, f.title) ?? 0;
			const wWhen = maxWhenWidth(srv, f);
			const line = Math.max(nmW + 12 + wWhen, tlW);
			return Math.ceil(line) + 24 + 12 + 32 + 2; // mark + gap + padding + border
		}
		const key = `session|${srv}|${name}|${title}`;
		const hit = widthCache.get(key);
		if (hit !== undefined) return hit;
		const nm = measure!.querySelector<HTMLElement>('[data-kind="session"]');
		const tl = measure!.querySelector<HTMLElement>(".title");
		if (!nm || !tl) return 0;
		nm.textContent = name;
		tl.textContent = title;
		// room for the widest of the forms its time takes as it ages (pastLabel), so the column does not twitch over time
		const wWhen = maxWhenWidth(srv, null);
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
		if (c.kind === "provider") {
			return {
				parts: [
					...(c.servers && c.servers.length > 1 ? [n(t("서버 {n}개", { n: c.servers.length }))] : []),
					n(t("모델 {n}개", { n: c.children.length })),
					n(t("대화 {n}개", { n: c.count })),
				],
				extra: 0,
			};
		}
		if (c.kind === "model") return { parts: [n(modelSource(c)), n(t("대화 {n}개", { n: c.count }))], extra: 0 };
		if (c.kind !== "subagent") return { parts: [], extra: 0 };
		const m = c.model;
		// a running call is told on the live line below (who called it, on what model), so the facts line keeps to the role
		const parts = [
			...(m ? [{ text: m.name, mono: true }] : []), // `.mn` is always set in mono
			n(t("{n}회", { n: c.count })),
			...(c.free ? [n(t("즉석"))] : []),
			...(multiServer ? [n(serverNames.get(c.server) ?? c.server)] : []),
		];
		// the model's 14px logo + 4px gap
		return { parts, extra: m ? 18 : 0 };
	}

	/** The view's size: the layout wraps many chats into columns when that shows the graph larger in it. */
	const EMPTY_GRAPH: Graph = { cards: new Map(), edges: [], bands: [], cols: [], width: 0, height: 0 };
	let viewEl: HTMLDivElement | undefined = $state();
	let viewW = $state(0);
	let viewH = $state(0);
	let ready = $state(false);
	// Wait until `.view` and `.measure` mount so `fitGraph` runs once with real dimensions and fonts (not twice).
	$effect.pre(() => {
		if (!viewEl || !measure) return;
		const el = viewEl;
		const m = measure;
		untrack(() => {
			viewW = el.clientWidth;
			viewH = el.clientHeight;
			fonts = readFonts(m);
			ready = true;
		});
	});
	const graph: Graph = $derived.by(() => {
		void fontGen;
		if (!ready) return EMPTY_GRAPH;
		return fitGraph(servers, { widths: widthOf, pins }, viewW, viewH);
	});

	/** Reduced motion: no sparks (SMIL, which CSS cannot stop), cards and the view go straight to their place. */
	let motion = $state(typeof matchMedia !== "function" || !matchMedia("(prefers-reduced-motion: reduce)").matches);

	// ---- view: pan and zoom ----
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
	$effect.pre(() => {
		void graph;
		void viewW;
		void viewH;
		if (ready && !touched && graph.cards.size && viewEl) untrack(fit);
	});
	// the window or the sidebar changes the view's size: the layout and the fit follow (until the user takes the view)
	$effect(() => {
		if (!viewEl) return;
		const el = viewEl;
		const ro = new ResizeObserver(() => {
			if (el.clientWidth !== viewW) viewW = el.clientWidth;
			if (el.clientHeight !== viewH) viewH = el.clientHeight;
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
	let growUntil = 0;
	// before the DOM updates: a new card must not show for one frame before its plan hides it
	$effect.pre(() => {
		if (!ready) return;
		const g = graph;
		untrack(() => {
			const now = performance.now();
			const opening = !prev;
			const timing = GROW;
			const edgeIds = new Set(g.edges.map((e) => e.id));
			// back before it finished leaving: it is simply there again
			if (ghostCards.some((c) => g.cards.has(c.id))) ghostCards = ghostCards.filter((c) => !g.cards.has(c.id));
			if (ghostEdges.some((e) => edgeIds.has(e.id))) ghostEdges = ghostEdges.filter((e) => !edgeIds.has(e.id));
			let needsTick = !!goal || ghostCards.length > 0 || ghostEdges.length > 0;
			if (motion && !opening) {
				const plan = growthPlan(g, (id) => born.get(id), (id) => edgeBorn.has(id), now, timing);
				for (const [id, t] of plan.cards) {
					born.set(id, t);
					fadeOf.set(id, timing.fade);
					if (t + timing.fade > growUntil) growUntil = t + timing.fade;
					needsTick = true;
				}
				for (const [id, t] of plan.edges) {
					edgeBorn.set(id, t);
					drawOf.set(id, timing.draw);
					if (t + timing.draw > growUntil) growUntil = t + timing.draw;
					needsTick = true;
				}
			} else {
				for (const id of g.cards.keys()) if (!born.has(id)) born.set(id, -Infinity);
				for (const e of g.edges) if (!edgeBorn.has(e.id)) edgeBorn.set(e.id, -Infinity);
			}
			// what left the layout leaves the screen right to left
			if (prev && motion) {
				const goneCards = [...prev.cards.values()].filter((c) => !g.cards.has(c.id));
				const goneEdges = prev.edges.filter((e) => !edgeIds.has(e.id) && prev!.cards.has(e.from) && prev!.cards.has(e.to));
				if (goneCards.length || goneEdges.length) {
					const plan = leavePlan(new Set(goneCards.map((c) => c.id)), goneEdges, now, LEAVE);
					for (const [id, t] of plan.cards) {
						leaveAt.set(id, t);
						if (t + LEAVE.fade > growUntil) growUntil = t + LEAVE.fade;
					}
					for (const [id, t] of plan.edges) {
						leaveEdgeAt.set(id, t);
						if (t + LEAVE.retract > growUntil) growUntil = t + LEAVE.retract;
					}
					ghostCards = [...ghostCards, ...goneCards];
					// a line keeps its ends drawn: a gone card from this snapshot, a staying one from the layout
					ghostEdges = [...ghostEdges, ...goneEdges];
					needsTick = true;
				}
			}
			const ghostCardIds = ghostCards.length ? new Set(ghostCards.map((c) => c.id)) : null;
			for (const id of born.keys()) if (!g.cards.has(id) && !ghostCardIds?.has(id)) born.delete(id);
			for (const id of edgeBorn.keys()) if (!edgeIds.has(id)) {
				edgeBorn.delete(id);
				drawOf.delete(id);
			}
			for (const c of g.cards.values()) {
				const s = shown.get(c.id);
				if (!s) shown.set(c.id, { x: c.x, y: c.y, h: c.h, vx: 0, vy: 0, vh: 0 });
				else if (s.x !== c.x || s.y !== c.y || s.h !== c.h) needsTick = true;
			}
			for (const id of shown.keys()) if (!g.cards.has(id) && !ghostCardIds?.has(id)) shown.delete(id);
			prev = g;
			if (needsTick || now < growUntil) kick();
		});
	});
	const ghostById = $derived(new Map(ghostCards.map((c) => [c.id, c])));
	const ghostEdgeIds = $derived(new Set(ghostEdges.map((e) => e.id)));
	const orderedEdges = $derived.by(() => {
		const idle: Edge[] = [];
		const live: Edge[] = [];
		for (const x of graph.edges) (x.live ? live : idle).push(x);
		return [...idle, ...live, ...ghostEdges];
	});
	const allCards = $derived([...graph.cards.values(), ...ghostCards]);
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
		if (b === undefined || b === -Infinity) return 1;
		return clamp01((clock - b) / (fadeOf.get(id) ?? GROW.fade));
	}
	/** How much of a line is drawn: it grows out of its first card, and pulls back into it when it leaves. */
	function reach(e: Edge, ghost: boolean): number {
		if (ghost) {
			const lv = leaveEdgeAt.get(e.id);
			return lv === undefined ? 0 : 1 - clamp01((clock - lv) / LEAVE.retract) ** 2;
		}
		const b = edgeBorn.get(e.id);
		if (b === undefined || b === -Infinity) return 1;
		return inOut(clamp01((clock - b) / (drawOf.get(e.id) ?? GROW.draw)));
	}
	/** Something still grows or leaves: the frame loop keeps going. */
	function growing(now: number): boolean {
		let busy = false;
		for (const [id, b] of born) if (b > -Infinity && now < b + (fadeOf.get(id) ?? GROW.fade)) busy = true;
		for (const [id, b] of edgeBorn) if (b > -Infinity && now < b + (drawOf.get(id) ?? GROW.draw)) busy = true;
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
		let cardMoved = false;
		for (const [id, s] of shown) {
			const c = graph.cards.get(id);
			if (!c) continue; // a ghost: it stays where it was while it leaves
			if (s.x === c.x && s.y === c.y && s.h === c.h && s.vx === 0 && s.vy === 0 && s.vh === 0) continue;
			cardMoved = true;
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
		if (growUntil > 0 || ghostCards.length || ghostEdges.length) {
			clock = now;
			const still = growing(now);
			if (still) moving = true;
			else growUntil = 0;
		}
		if (cardMoved) frame++;
		raf = moving ? requestAnimationFrame(tick) : 0;
	}
	onMount(() => {
		const stopFonts = onFontsLoaded(() => {
			whenWidthCache.clear();
			widthCache.clear();
			if (measure) fonts = readFonts(measure);
			fontGen++;
		});
		return () => {
			cancelAnimationFrame(raf);
			stopFonts();
		};
	});


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

	/**
	 * Marquee overflow only applies while a card is hovered (`.card:hover .fl[data-over]`), so measure only the hovered
	 * card's `.fl` elements instead of attaching hundreds of ResizeObservers when opening a large graph.
	 */
	$effect(() => {
		const id = hover;
		if (!id || !viewEl) return;
		void graph;
		const el = viewEl;
		const escaped = typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(id) : id.replace(/["\\]/g, "\\$&");
		const cardEl = el.querySelector<HTMLElement>(`[data-card="${escaped}"]`);
		if (!cardEl) return;
		const nodes = cardEl.querySelectorAll<HTMLElement>(".fl");
		const measured: { node: HTMLElement; over: boolean; dur: string }[] = [];
		for (const node of nodes) {
			const mq = node.querySelector<HTMLElement>(".mq");
			if (!mq) continue;
			const over = node.scrollWidth > node.clientWidth + 1 || mq.offsetWidth > node.clientWidth + 1;
			measured.push({ node, over, dur: over ? `${Math.max(6, (mq.offsetWidth + 32) / 40)}s` : "" });
		}
		for (const r of measured) {
			if (r.over) {
				r.node.dataset.over = "";
				r.node.style.setProperty("--mq-d", r.dur);
			} else delete r.node.dataset.over;
		}
	});

	// ---- text ----
	let now = $state(Date.now());
	$effect(() => {
		const id = setInterval(() => (now = Date.now()), 30_000);
		return () => clearInterval(id);
	});
	/** Cards at rest step back with the lines into them (`quietCards`), unless the pointer is on them or what they belong to. */
	const quiet = $derived(quietCards(graph, now));
	const faded = (id: string) => quiet.has(id) && !focus?.has(id) && selected !== id;
	/** What a model card says it comes from: its maker, else its connection's name. */
	const modelSource = (c: Card) => (c.brand ? BRAND_LABEL[c.brand] : (c.provider ? app.links[c.server]?.providerById.get(c.provider)?.name?.trim() || c.provider : "")); // not `graph`: widths are measured while it is built
	const linkOf = (c: Card) => {
		if (app.links[c.server]?.conn) return app.links[c.server];
		const id = c.servers?.find((s) => app.links[s]?.conn);
		return id ? app.links[id] : app.links[c.server];
	};
	/** The mark the owner picked for a model on any server sharing it, if any. */
	const iconOf = (server: string, provider: string | undefined, id: string, serversList?: string[]) => {
		if (!id) return undefined;
		const key = `${provider ?? ""}\u0000${id}`;
		const hit = app.links[server]?.modelByKey.get(key)?.icon;
		if (hit || !serversList) return hit;
		for (const s of serversList) {
			const x = app.links[s]?.modelByKey.get(key)?.icon;
			if (x) return x;
		}
		return undefined;
	};
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
		<!-- the app header's extension parts (Header.svelte drops them while this view covers it), so each mounts once -->
		<ExtensionMount slot="header.start" />
		<div class="ttl">
			<span class="t">{t("그래프 뷰")}</span>
			<span class="sub mono">{summary}</span>
		</div>
		<NavbarItems />
		<ExtensionMount slot="header.end" />
		<IconButton icon="x" label={t("그래프 뷰 닫기")} title={t("그래프 뷰 닫기") + keyHint} class="gclose" onclick={() => app.toggleGraph(false)} />
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
			<svg class="edges" aria-hidden="true">
				<defs>
				</defs>
				{#each orderedEdges as e (e.id)}
					{@const ghost = !graph.cards.has(e.from) || !graph.cards.has(e.to) || ghostEdgeIds.has(e.id)}
					{@const ca = graph.cards.get(e.from) ?? ghostById.get(e.from)}
					{@const cb = graph.cards.get(e.to) ?? ghostById.get(e.to)}
					{@const r = reach(e, ghost)}
					{#if ca && cb && r > 0}
						{@const a = at(ca)}
						{@const b = at(cb)}
						{@const on = !focus || (focus.has(e.from) && focus.has(e.to))}
						{@const call = e.kind === "delegate"}
						{@const edgeStyle = call || (ca.kind === "server" && cb.kind === "provider") ? "curve" : "elbow"}
						{@const d = edgePath(a, b, r, edgeStyle)}
						{@const full = r >= 1 && !ghost}
						<g class="e-{e.kind}" class:live={e.live && !ghost} class:dim={!on} class:hot={!!focus && on} class:quiet={on && (faded(e.from) || faded(e.to))}>
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
								{@const sp = sparkPlan(edgeLength(ca, cb, edgeStyle), call)}
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
			{#each allCards as c (c.id)}
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
					class:quiet={!ghost && faded(c.id)}
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
						<span class="nm fl" title={c.label}>{@render flow(c.label)}</span>
						<span class="meta"><span class="give fl mid" title={c.host}>{@render flow(c.host ?? "", true)}</span><i>·</i>{#if c.online}<span>{t("대화 {n}개", { n: c.count })}</span>{:else}<em class="bad">{t("연결 안 됨")}</em>{/if}</span>
					{:else if c.kind === "provider"}
						<span class="lead"><Icon name="plug" /></span>
						<span class="nm fl" title={c.name !== c.label ? `${c.name} · ${c.label}` : c.name}>{@render flow(c.name)}</span>
						<span class="meta">{#if c.servers && c.servers.length > 1}<span>{t("서버 {n}개", { n: c.servers.length })}</span><i>·</i>{/if}<span>{t("모델 {n}개", { n: c.children.length })}</span><i>·</i><span>{t("대화 {n}개", { n: c.count })}</span></span>
					{:else if c.kind === "model"}
						<span class="lead"><ModelLogo conn={linkOf(c)?.conn} icon={iconOf(c.server, c.provider, c.label, c.servers)} provider={c.provider} model={c.label} size={24} colored /></span>
						{#if c.name === c.label}<span class="nm mono fl mid" title={c.name}>{@render flow(c.name, true)}</span>
						{:else}<span class="nm fl" title={`${c.name} · ${c.provider}/${c.label}`}>{@render flow(c.name)}</span>{/if}
						<span class="meta"><span class="give fl">{@render flow(modelSource(c))}</span><i>·</i><span>{t("대화 {n}개", { n: c.count })}</span></span>
					{:else if c.kind === "subagent"}
						{@const m = c.model}
						{@const ref = m ? splitModelRef(m.model) : null}
						<span class="lead"><Icon name="bot" /></span>
						<span class="nm fl mid" title={c.label}>{@render flow(c.label, true)}</span>
						<span class="meta">
							{#if m}
								<span class="model" title={m.name !== ref?.id ? m.model : undefined}>
									<ModelLogo conn={app.links[c.server]?.conn} icon={iconOf(c.server, ref?.provider, ref?.id ?? "")} provider={ref?.provider} model={ref?.id} size={14} colored />
									<span class="mn fl" class:mono={m.name === ref?.id} class:mid={m.name === ref?.id}>{@render flow(m.name, m.name === ref?.id)}</span>
								</span><i>·</i>
							{/if}
							<span>{t("{n}회", { n: c.count })}</span>
							{#if c.free}<i>·</i><span title={t("역할 파일 없이 에이전트가 이름을 정한 서브에이전트입니다. 읽기 전용 도구만 쓰고 작업 내용이 곧 지침입니다")}>{t("즉석")}</span>{/if}
							{#if multiServer}<i>·</i><span>{serverNames.get(c.server) ?? c.server}</span>{/if}
						</span>
						{#if c.running && c.calls?.length}
							<!-- who runs it now (the card says on what model): the newest caller's handle in the working colour -->
							{@const k = c.calls[0]!}
							<span class="doing" in:glowFade={{ delay: 120 }} title={c.calls.map((x) => x.who).join("\n")}>
								<Icon name="bolt" /><b class="by fl">{@render flow(k.who)}</b>
								<span class="what">{t("실행 중")}</span>
								{#if c.calls.length > 1}<span class="q" title={t("실행 중 {n}", { n: c.calls.length })}>{t("외 {n}", { n: c.calls.length - 1 })}</span>{/if}
							</span>
						{/if}
					{:else}
						{@const s = c.session!}
						{@const tool = toolNow(c)}
						{@const busy = c.activity === "working" || c.activity === "asking"}
						<span class="lead"><AgentBadge id={s.id} server={c.server} state={c.activity} size={24} /></span>
						{@const name = s.name ? `@${s.name}` : sessionTitle(s.title)}
						<span class="nm fl" class:who={!!s.name} title={name}>{@render flow(name)}</span>
						{#if !busy || multiServer}
							<span class="when">
								{#if multiServer}<span class="srv">{serverNames.get(c.server) ?? c.server}</span>{/if}{#if multiServer && !busy}<i>·</i>{/if}{#if !busy}{livePast(s.updatedAt, { time: false })}{/if}
							</span>
						{/if}
						<span class="title fl" title={sessionTitle(s.title)}>{@render flow(sessionTitle(s.title))}</span>
						{#if busy}
							<span class="doing" class:ask={c.activity === "asking"} in:glowFade={{ delay: 120 }}>
								{#if c.activity === "asking"}
									<Icon name="alert" /><span class="what">{t("답을 기다립니다")}</span>
								{:else if tool}
									<Icon name="bolt" /><b>{tool.name}</b><span class="what fl">{@render flow(toolSummary(tool.name, tool.args))}</span>
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

		{#if ready && !graph.cards.size}
			<div class="empty"><EmptyState tone="plain">{t("저장된 서버가 없습니다")}</EmptyState></div>
		{/if}

		<div class="bar">
			<button class="tbtn" onclick={arrange} disabled={!Object.keys(pins).length} title={t("옮긴 카드를 제자리로")}><Icon name="columns" />{t("다시 배치")}</button>
			<span class="sep"></span>
			<button class="tbtn icon tap" onclick={() => zoomBy(1 / ZOOM_STEP)} aria-label={t("축소")} title={t("축소")}>−</button>
			<span class="pct mono">{Math.round(view.k * 100)}%</span>
			<button class="tbtn icon tap" onclick={() => zoomBy(ZOOM_STEP)} aria-label={t("확대")} title={t("확대")}><Icon name="plus" /></button>
			<button class="tbtn icon tap" onclick={refit} aria-label={t("전체 보기")} title={t("전체 보기 (F)")}><Icon name="expand" /></button>
		</div>
	</div>

	</div>

	<!-- hidden copies of the one-line names, to measure a long one -->
	<div class="measure" bind:this={measure} aria-hidden="true">
		{#each ["server", "provider", "model", "model-id", "subagent", "session"] as k (k)}<span class="nm" class:mono={k === "model-id"} data-kind={k}></span>{/each}
		<span class="meta"></span>
		<span class="meta mono" data-mono-meta></span>
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
	<SessionQuickModal server={quick.server} session={quick.session} mode="graph" onclose={() => app.closePeek()} />
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
		gap: 4px; /* the app header's, between extension items and before the close button (the title keeps 12, below) */
		/* the app header's box (44px + 1px hairline), so its line meets the sidebar brand row's */
		box-sizing: content-box;
		height: 44px;
		padding: 0 16px;
		border-bottom: 1px solid var(--border);
	}
	.ttl {
		min-width: 0;
		flex: 1;
		margin-right: 8px;
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
	/* The shared 38px IconButton (19px glyph). It follows the header's 4px gap, also right after the extension items. */
	.head :global(.iconbtn.gclose) {
		flex: none;
		margin-right: -9.5px; /* the 19px glyph's right edge lands on the 16px gutter (DESIGN.md 5) */
	}
	.head :global(.iconbtn.gclose:focus-visible) {
		outline-offset: -2px;
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
	.split {
		position: absolute;
		left: 0;
		height: 1px;
		background: var(--border);
		pointer-events: none;
		transition:
			top var(--motion-slow) var(--ease-std),
			width var(--motion-slow) var(--ease-std);
	}
	.empty {
		position: absolute;
		inset: 0;
		display: grid;
		place-items: center;
		margin: 0;
		pointer-events: none;
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
	/* a line carrying work: a solid coloured stroke, a dash train and sparks running along it (no blurred glow under it) */
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
	.edges g.quiet {
		opacity: 0.4; /* a line with a card at rest on either end steps back with it */
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
		contain: layout style;
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
		cursor: pointer;
		overflow: hidden;
		transition:
			opacity var(--motion-normal) var(--ease-std),
			border-color var(--motion-normal) var(--ease-std);
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
	}
	/*
	 * A card at work: a light runs round its border (a conic gradient behind a transparent border, turning on the
	 * registered --ring-a), in the colour of the line it sits on: green for a chat, blue for a subagent. No glow
	 * around it (a blurred halo read as decoration). A chat waiting for an answer holds a steady amber ring, no running light.
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
		animation: ring-turn 3.2s linear infinite;
	}
	.card.subagent.working {
		--ring: var(--info);
	}
	.card.asking {
		--ring: var(--warn);
		background:
			linear-gradient(var(--bg), var(--bg)) padding-box,
			linear-gradient(color-mix(in srgb, var(--ring) 70%, var(--border-strong)), color-mix(in srgb, var(--ring) 70%, var(--border-strong))) border-box;
		animation: none;
	}
	@keyframes ring-turn {
		to {
			--ring-a: 360deg;
		}
	}
	.card.sel {
		border-color: var(--text);
		outline: 2px solid var(--accent);
		outline-offset: -1px;
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
	/* at rest (an idle chat, a hub with only idle chats, a role's old model, an offline server's cards): quieter than what is at
	   work, still readable, full again while the pointer is on it or what it belongs to */
	.card.quiet:not(.dim) {
		opacity: 0.6;
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

	/* a chat: name and time, its title, and while it works what it is on */
	.when {
		grid-column: 3;
		grid-row: 1;
		font-size: var(--fs-xs);
		line-height: 16px;
		color: var(--text-faint);
		white-space: nowrap;
	}
	.when i {
		margin: 0 4px;
		font-style: normal;
		opacity: 0.6;
	}
	.when .srv {
		color: var(--text-dim);
		font-weight: 500;
	}
	/* a chat's `@name` takes its badge's state colour, as the handle does in the sidebar, the tabs and the strip (Handle) */
	.working .nm.who {
		color: var(--info);
	}
	.asking .nm.who {
		color: var(--warn);
	}
	.done .nm.who {
		color: var(--ok);
	}
	.failed .nm.who {
		color: var(--danger);
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
	/* a running role's caller: a chat at work, so its handle reads in the working colour */
	.doing b.by {
		flex: 0 1 auto;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--info);
	}
	.doing b.by + .what {
		flex: none;
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
		color: var(--disabled-fg);
		cursor: default;
	}
	.pct {
		min-width: 44px;
		text-align: center;
		font-size: var(--fs-2xs);
		line-height: 16px;
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
			-webkit-mask-image: var(--mq-mask);
			mask-image: var(--mq-mask);
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
		.split,
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
		.run .lead,
		.doing > :global(.ic) {
			animation: none;
		}
	}
	/* touch: the 44px hit box fills the 4px gap edge to edge (height stays 44px) without covering a neighbour */
	@media (pointer: coarse) {
		.tbtn.icon.tap::after {
			width: calc(100% + 4px);
		}
	}
</style>
