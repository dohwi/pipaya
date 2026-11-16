/**
 * The graph view's model: every saved server's open chats, as columns of cards joined by lines.
 *
 *   server → provider → model → chat (→ chats it branched or started) → subagent roles it delegated to
 *
 * Pure (no Svelte, no DOM): `buildGraph` turns what the client already keeps per server (its sessions and activity, the
 * server's `GET /delegates`) into cards with a column and a centre; `GraphView.svelte` only draws and moves them.
 */
import type { Activity } from "./activity";
import { brandOf, type Brand } from "./brand";
import type { Session } from "./types";

/** One `delegate` call, as `GET /delegates` lists it. */
export interface DelegateRun {
	sessionId: string;
	callId: string;
	role: string;
	free: boolean;
	asked: string | null;
	model: string;
	at: number;
	doneAt: number | null;
	running: boolean;
	error: boolean;
	turns: number | null;
	tokens: number | null;
}

/** What the graph reads of one server. `runs` null = the server has no `GET /delegates` (older) or it failed. */
export interface GraphServer {
	id: string;
	name: string;
	host: string;
	online: boolean;
	sessions: Session[];
	activity: (id: string) => Activity;
	queued: (id: string) => number;
	runs: DelegateRun[] | null;
}

export type CardKind = "server" | "provider" | "model" | "session" | "subagent";

/** A role's models, newest first: the model it ran on lately leads, the rest are "외 N". */
export interface RoleModel {
	model: string;
	brand: Brand | null;
	n: number;
	last: number;
}

export interface Card {
	id: string;
	kind: CardKind;
	server: string;
	label: string;
	/** Chats under this card (a server, provider or model), or calls of this role (a subagent). */
	count: number;
	parent: string | null;
	children: string[];
	col: number;
	/** Centre, in graph units (px at 100%). */
	x: number;
	y: number;
	w: number;
	h: number;
	/** Something under it is working, or (a subagent) one of its calls is running. */
	live: boolean;
	// per kind
	host?: string;
	online?: boolean;
	provider?: string;
	brand?: Brand | null;
	session?: Session;
	activity?: Activity;
	queued?: number;
	models?: RoleModel[];
	running?: number;
	/** Calls where the agent named the model itself. */
	asked?: number;
	/** No role file: a name the agent made up (role policy "any"). */
	free?: boolean;
}

export interface Edge {
	id: string;
	kind: "tree" | "spawn" | "delegate";
	from: string;
	to: string;
	/** Calls along a delegate edge. */
	weight: number;
	/** Work flows along it now. */
	live: boolean;
}

/** A frame behind one server's cards (drawn only with two or more servers). */
export interface Band {
	server: string;
	y0: number;
	y1: number;
	online: boolean;
}

export interface Graph {
	cards: Map<string, Card>;
	edges: Edge[];
	bands: Band[];
	/** Left edge and width of each column. */
	cols: { x: number; w: number }[];
	width: number;
	height: number;
}

/** Card sizes. Every card is two 20px lines in a 16px frame (72); a working chat adds its 40px activity line. */
export const CARD_W: Record<CardKind, number> = { server: 208, provider: 184, model: 232, session: 272, subagent: 248 };
export const CARD_H = 72;
export const CARD_H_LIVE = 112;
export const COL_GAP = 64;
export const ROW_GAP = 12;
/** Between two servers' frames: 24 inside each frame + 24 between them. */
export const BAND_GAP = 72;
export const BAND_PAD = 24;

/** The app's urgency order for chats in one column: the ones that want the user first, then by last activity. */
const RANK: Record<Activity, number> = { asking: 0, failed: 1, working: 2, done: 3, idle: 4 };
export const isLive = (a: Activity | undefined) => a === "working" || a === "asking";

/** `provider/model` → model id (what a card shows; the provider is the column to its left). */
export const modelName = (m: string) => (m.includes("/") ? m.slice(m.indexOf("/") + 1) : m);

/**
 * Builds the cards and lays them out in columns. `widths` measures a card that needs more than its kind's width (a long
 * model id); `pins` are cards moved by hand, kept where they were put.
 */
export function buildGraph(
	servers: GraphServer[],
	opts: { widths?: (c: Card) => number; pins?: Record<string, { x: number; y: number }> } = {},
): Graph {
	const cards = new Map<string, Card>();
	const add = (c: Omit<Card, "children" | "col" | "x" | "y" | "live"> & Partial<Card>) => {
		const card: Card = { children: [], col: 0, x: 0, y: 0, live: false, ...c };
		cards.set(card.id, card);
		return card;
	};
	const link = (parent: string, child: string) => cards.get(parent)!.children.push(child);
	const delegateEdges = new Map<string, Edge>();

	for (const v of servers) {
		const vid = `v:${v.id}`;
		add({ id: vid, kind: "server", server: v.id, label: v.name, count: 0, parent: null, w: CARD_W.server, h: CARD_H, host: v.host, online: v.online });
		const open = v.sessions.filter((s) => !s.closed);
		const ids = new Set(open.map((s) => s.id));
		for (const s of open) {
			// provider and model cards are per server: one provider name on two servers is two connections
			const pid = `p:${v.id}/${s.provider}`, mid = `m:${v.id}/${s.provider}/${s.model}`;
			if (!cards.has(pid)) { add({ id: pid, kind: "provider", server: v.id, label: s.provider, count: 0, parent: vid, w: CARD_W.provider, h: CARD_H }); link(vid, pid); }
			if (!cards.has(mid)) { add({ id: mid, kind: "model", server: v.id, label: s.model, count: 0, parent: pid, w: CARD_W.model, h: CARD_H, provider: s.provider, brand: brandOf(s.provider, s.model) }); link(pid, mid); }
			const activity = v.activity(s.id);
			add({
				id: `s:${v.id}/${s.id}`, kind: "session", server: v.id, label: s.name ? `@${s.name}` : s.title, count: 1, parent: null,
				w: CARD_W.session, h: isLive(activity) ? CARD_H_LIVE : CARD_H, session: s, activity, queued: v.queued(s.id),
			});
		}
		// a chat branched from (or started by) another open chat sits right of it; otherwise under its model
		for (const s of open) {
			const sid = `s:${v.id}/${s.id}`;
			const parent = s.parentId && ids.has(s.parentId) && s.parentId !== s.id ? `s:${v.id}/${s.parentId}` : `m:${v.id}/${s.provider}/${s.model}`;
			cards.get(sid)!.parent = parent;
			link(parent, sid);
		}
		for (const r of v.runs ?? []) {
			const from = `s:${v.id}/${r.sessionId}`;
			if (!cards.has(from)) continue; // a closed chat's calls are not on the map
			// one card per role per server: role files and the delegate policy belong to a server
			const rid = `r:${v.id}/${r.role}`;
			const role = cards.get(rid) ?? add({ id: rid, kind: "subagent", server: v.id, label: r.role, count: 0, parent: null, w: CARD_W.subagent, h: CARD_H, models: [], running: 0, asked: 0, free: true });
			role.count++;
			if (r.running) role.running!++;
			if (r.asked) role.asked!++;
			role.free = role.free! && r.free;
			const m = role.models!.find((x) => x.model === r.model);
			if (m) { m.n++; m.last = Math.max(m.last, r.at); }
			else role.models!.push({ model: r.model, brand: brandOf(r.model.split("/")[0], modelName(r.model)), n: 1, last: r.at });
			const k = `${from}|${rid}`;
			const e = delegateEdges.get(k) ?? { id: `d:${k}`, kind: "delegate" as const, from, to: rid, weight: 0, live: false };
			e.weight++;
			if (r.running) e.live = true;
			delegateEdges.set(k, e);
		}
	}
	for (const c of cards.values()) if (c.kind === "subagent") c.models!.sort((a, b) => b.last - a.last);
	return layout(cards, servers, [...delegateEdges.values()], opts);
}

function layout(cards: Map<string, Card>, servers: GraphServer[], delegates: Edge[], opts: { widths?: (c: Card) => number; pins?: Record<string, { x: number; y: number }> }): Graph {
	const get = (id: string) => cards.get(id)!;
	const count = (id: string): number => {
		const c = get(id);
		if (c.kind === "session") { for (const k of c.children) count(k); return 1 + c.children.reduce((a, k) => a + get(k).count, 0); }
		c.count = c.children.reduce((a, k) => a + count(k), 0);
		return c.count;
	};
	const order = (a: string, b: string) => {
		const x = get(a), y = get(b);
		if (x.kind === "session" && y.kind === "session") return RANK[x.activity!] - RANK[y.activity!] || y.session!.updatedAt - x.session!.updatedAt;
		return y.count - x.count || x.label.localeCompare(y.label);
	};
	let cursor = 0, maxCol = 0;
	/** Leaves take the next row; a card with children is centred on them. */
	const place = (id: string, col: number) => {
		const c = get(id);
		c.col = col;
		maxCol = Math.max(maxCol, col);
		c.children.sort(order);
		if (!c.children.length) { c.y = cursor + c.h / 2; cursor += c.h + ROW_GAP; return; }
		for (const k of c.children) place(k, col + 1);
		c.y = (get(c.children[0]!).y + get(c.children[c.children.length - 1]!).y) / 2;
	};
	const roles = [...cards.values()].filter((c) => c.kind === "subagent");
	const bands: Band[] = [];
	servers.forEach((v, i) => {
		const root = get(`v:${v.id}`);
		if (i) cursor += BAND_GAP - ROW_GAP;
		const top = cursor;
		count(root.id);
		place(root.id, 0);
		// a server's subagents sit beside the chats that call them, in call order, without overlapping
		const mine = roles.filter((r) => r.server === v.id);
		for (const r of mine) {
			const ys = delegates.filter((e) => e.to === r.id).map((e) => get(e.from).y);
			r.y = Math.max(top + r.h / 2, ys.reduce((a, b) => a + b, 0) / ys.length);
		}
		mine.sort((a, b) => a.y - b.y || a.label.localeCompare(b.label));
		for (let k = 1; k < mine.length; k++) mine[k]!.y = Math.max(mine[k]!.y, mine[k - 1]!.y + CARD_H + ROW_GAP);
		if (mine.length) cursor = Math.max(cursor, mine[mine.length - 1]!.y + CARD_H / 2 + ROW_GAP);
		bands.push({ server: v.id, y0: top, y1: cursor - ROW_GAP, online: v.online });
	});
	for (const r of roles) r.col = maxCol + 1;

	// one width per column, the widest card's (a long model id widens its column, up to 320)
	const cols: { x: number; w: number }[] = [];
	for (const c of cards.values()) {
		const w = Math.min(320, Math.max(c.w, opts.widths?.(c) ?? 0));
		cols[c.col] = { x: 0, w: Math.max(cols[c.col]?.w ?? 0, w) };
	}
	let x = 0;
	for (const col of cols) if (col) { col.x = x; x += col.w + COL_GAP; }
	for (const c of cards.values()) {
		c.w = cols[c.col]!.w;
		c.x = cols[c.col]!.x + c.w / 2;
		const pin = opts.pins?.[c.id];
		if (pin) { c.x = pin.x; c.y = pin.y; }
	}

	// live: a working chat, every card above it, and a role with a running call
	const live = (id: string): boolean => {
		const c = get(id);
		let on = c.kind === "session" && isLive(c.activity);
		for (const k of c.children) on = live(k) || on;
		c.live = on;
		return on;
	};
	for (const v of servers) live(`v:${v.id}`);
	for (const r of roles) r.live = r.running! > 0;

	const edges: Edge[] = [];
	for (const c of cards.values())
		for (const k of c.children) edges.push({ id: `t:${k}`, kind: c.kind === "session" ? "spawn" : "tree", from: c.id, to: k, weight: 1, live: get(k).live });
	edges.push(...delegates);
	return { cards, edges, bands, cols, width: Math.max(0, x - COL_GAP), height: Math.max(0, cursor - ROW_GAP) };
}

/** A curve from the right edge of `a` to the left edge of `b` (or back out of the right side when `b` is not to its right). */
export function edgePath(a: Card, b: Card): string {
	const ax = a.x + a.w / 2;
	if (b.x - b.w / 2 > ax + 8) {
		const bx = b.x - b.w / 2 - 2; // the arrow tip sits just off the card's border
		const c = Math.max(32, (bx - ax) / 2);
		return `M${ax} ${a.y}C${ax + c} ${a.y} ${bx - c} ${b.y} ${bx} ${b.y}`;
	}
	if (b.x + b.w / 2 < a.x - a.w / 2 - 8) {
		const x0 = a.x - a.w / 2, bx = b.x + b.w / 2 + 2, c = Math.max(32, (x0 - bx) / 2);
		return `M${x0} ${a.y}C${x0 - c} ${a.y} ${bx + c} ${b.y} ${bx} ${b.y}`;
	}
	const bx = b.x + b.w / 2 + 2, c = 40 + Math.min(120, Math.abs(b.y - a.y) * 0.3);
	return `M${ax} ${a.y}C${ax + c} ${a.y} ${bx + c} ${b.y} ${bx} ${b.y}`;
}

/** The cards a pointer on `id` is about: its line up to the server, everything below it, and both ends of its delegate edges. */
export function related(g: Graph, id: string): Set<string> {
	const out = new Set<string>([id]);
	const parentOf = new Map<string, string>();
	for (const c of g.cards.values()) for (const k of c.children) parentOf.set(k, c.id);
	const up = (x: string) => { for (let p: string | undefined = x; p; p = parentOf.get(p)) out.add(p); };
	const down = (x: string) => { out.add(x); for (const k of g.cards.get(x)?.children ?? []) down(k); };
	up(id);
	down(id);
	for (const e of g.edges) if (e.kind === "delegate") { if (e.from === id) up(e.to); if (e.to === id) up(e.from); }
	return out;
}

/** The zoom and offset that show the whole graph in a `w` × `h` view: every column across, never below 60%. */
export function fitView(g: Graph, w: number, h: number, pad = 24): { k: number; x: number; y: number } {
	if (!g.cards.size) return { k: 1, x: pad, y: pad };
	const multi = g.bands.length > 1 ? BAND_PAD : 0;
	const gw = g.width + multi * 2, gh = g.height + multi * 2;
	const aw = w - pad * 2, ah = h - pad * 2;
	const k = Math.max(0.6, Math.min(1, aw / gw, Math.max(ah / gh, Math.min(0.85, aw / gw))));
	const sw = gw * k, sh = gh * k;
	// too wide even at the floor: start at the left (servers first) and pan for the rest
	return { k, x: pad + (sw < aw ? (aw - sw) / 2 : 0) + multi * k, y: pad + (sh < ah ? (ah - sh) / 2 : 0) + multi * k };
}
