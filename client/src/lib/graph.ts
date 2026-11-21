/**
 * The graph view's model: every saved server's open chats, as columns of cards joined by lines.
 *
 *   server → provider → model → chat (→ chats it branched or started) → subagent roles it delegated to, one card per
 *   role and model (the same role run on two models is two cards, side by side)
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
	/** What the app calls a model (its display name from the connection settings) and a connection; the id when left out. */
	modelName?: (provider: string, id: string) => string;
	providerName?: (id: string) => string;
}

export type CardKind = "server" | "provider" | "model" | "session" | "subagent";

/** One call of a role still running: who made it (a running subagent card says it on its live line). */
export interface RoleCall {
	sessionId: string;
	/** The caller as the app names it: `@name`, else its title. */
	who: string;
	at: number;
}

/** The model a subagent card runs on: `provider/model` as the calls recorded it, and what the app calls it. */
export interface RoleModel {
	model: string;
	/** Its display name, else the bare id. */
	name: string;
	brand: Brand | null;
}

/** A subagent card's id: one per server, role and model. */
export const roleCardId = (server: string, role: string, model: string) => `r:${server}/${role}@${model}`;

export interface Card {
	id: string;
	kind: CardKind;
	server: string;
	/** What identifies it on its server: the server's name, the provider or model id, the role's name. */
	label: string;
	/** What it reads as: a provider's or model's display name (the label when it has none). */
	name: string;
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
	/** The model a subagent card's calls ran on. */
	model?: RoleModel;
	running?: number;
	/** A role's running calls, the newest first. */
	calls?: RoleCall[];
	/** Calls where the agent named the model itself. */
	asked?: number;
	/** A subagent card's latest call (unix ms): of one role's cards the model used last sits on top. */
	last?: number;
	/** No role file: a name the agent made up (role policy "any"). */
	free?: boolean;
	/** A chat in a wrapped block (many chats under one card): which of its columns, 0 the first. */
	lane?: number;
	/**
	 * How the line reaches a chat in a block's second or later column: along a bus above the block, then down a spine
	 * in the gap left of its column. Offsets from the card's centre, so the route moves with the card.
	 */
	bus?: { dy: number; gx: number; sx: number };
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

/** The rows one server's cards take (with two or more servers a hairline runs in the gap between two of them). */
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

/** Card sizes. Every card is two 20px lines in a 16px frame (72); a working chat or a running role adds its 40px activity line. */
export const CARD_W: Record<CardKind, number> = { server: 208, provider: 184, model: 232, session: 272, subagent: 248 };
export const CARD_H = 72;
/**
 * The widest a column grows for a long name, facts line or chat title: past it an id loses its middle and a name or
 * title its end (the whole of it in the tooltip). Wider would shrink the whole graph to fit the view.
 */
export const CARD_W_MAX = 400;
export const CARD_H_LIVE = 112;
export const COL_GAP = 64;
export const ROW_GAP = 12;
/** Between two servers' cards: 24 above the hairline that splits them, 24 below. */
export const BAND_GAP = 48;
/** A card with this many chats or more may wrap them into columns (at least 3 rows each, up to `lanes`). */
export const WRAP_MIN = 6;
const WRAP_ROWS = 3;
/** Room above a wrapped block for its bus line: the line runs 18px from the cards above and below it. */
const BUS_GAP = 24;

/** The app's urgency order for chats in one column: the ones that want the user first, then by last activity. */
const RANK: Record<Activity, number> = { asking: 0, failed: 1, working: 2, done: 3, idle: 4 };
export const isLive = (a: Activity | undefined) => a === "working" || a === "asking";

/** `provider/model` → model id (what a card shows; the provider is the column to its left). */
export const modelName = (m: string) => (m.includes("/") ? m.slice(m.indexOf("/") + 1) : m);

/**
 * Builds the cards and lays them out in columns. `widths` measures a card that needs more than its kind's width (a long
 * model id); `pins` are cards moved by hand, kept where they were put.
 */
export interface LayoutOpts {
	widths?: (c: Card) => number;
	pins?: Record<string, { x: number; y: number }>;
	/** Up to how many columns many chats under one card may wrap into (1 = never). */
	lanes?: number;
	/** The widest a measured card may make its column (default `CARD_W_MAX`; `fitGraph` lowers it so the graph fits the view). */
	maxW?: number;
}

export function buildGraph(servers: GraphServer[], opts: LayoutOpts = {}): Graph {
	const cards = new Map<string, Card>();
	const add = (c: Omit<Card, "children" | "col" | "x" | "y" | "live" | "name"> & Partial<Card>) => {
		const card: Card = { children: [], col: 0, x: 0, y: 0, live: false, name: c.label, ...c };
		cards.set(card.id, card);
		return card;
	};
	const link = (parent: string, child: string) => cards.get(parent)!.children.push(child);
	const delegateEdges = new Map<string, Edge>();

	for (const v of servers) {
		const vid = `v:${v.id}`;
		const nameOf = (provider: string, id: string) => v.modelName?.(provider, id) || id;
		add({ id: vid, kind: "server", server: v.id, label: v.name, count: 0, parent: null, w: CARD_W.server, h: CARD_H, host: v.host, online: v.online });
		const open = v.sessions.filter((s) => !s.closed);
		const ids = new Set(open.map((s) => s.id));
		const byId = new Map(open.map((s) => [s.id, s]));
		for (const s of open) {
			// provider and model cards are per server: one provider name on two servers is two connections
			const pid = `p:${v.id}/${s.provider}`, mid = `m:${v.id}/${s.provider}/${s.model}`;
			if (!cards.has(pid)) { add({ id: pid, kind: "provider", server: v.id, label: s.provider, name: v.providerName?.(s.provider) || s.provider, count: 0, parent: vid, w: CARD_W.provider, h: CARD_H }); link(vid, pid); }
			if (!cards.has(mid)) { add({ id: mid, kind: "model", server: v.id, label: s.model, name: nameOf(s.provider, s.model), count: 0, parent: pid, w: CARD_W.model, h: CARD_H, provider: s.provider, brand: brandOf(s.provider, s.model) }); link(pid, mid); }
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
			// one card per role and model per server (role files and the delegate policy belong to a server), so the line from
			// a chat says which model its subagent ran on
			const rid = roleCardId(v.id, r.role, r.model);
			const provider = r.model.includes("/") ? r.model.slice(0, r.model.indexOf("/")) : "";
			const model = { model: r.model, name: nameOf(provider, modelName(r.model)), brand: brandOf(provider, modelName(r.model)) };
			const role = cards.get(rid) ?? add({ id: rid, kind: "subagent", server: v.id, label: r.role, count: 0, parent: null, w: CARD_W.subagent, h: CARD_H, model, running: 0, calls: [], asked: 0, free: true, last: 0 });
			role.count++;
			role.last = Math.max(role.last!, r.at);
			if (r.running) {
				role.running!++;
				const s = byId.get(r.sessionId)!;
				role.calls!.push({ sessionId: r.sessionId, who: s.name ? `@${s.name}` : s.title, at: r.at });
			}
			if (r.asked) role.asked!++;
			role.free = role.free! && r.free;
			const k = `${from}|${rid}`;
			const e = delegateEdges.get(k) ?? { id: `d:${k}`, kind: "delegate" as const, from, to: rid, weight: 0, live: false };
			e.weight++;
			if (r.running) e.live = true;
			delegateEdges.set(k, e);
		}
	}
	for (const c of cards.values()) {
		if (c.kind !== "subagent") continue;
		c.calls!.sort((a, b) => b.at - a.at);
		if (c.running) c.h = CARD_H_LIVE;
	}
	return layout(cards, servers, [...delegateEdges.values()], opts);
}

function layout(cards: Map<string, Card>, servers: GraphServer[], delegates: Edge[], opts: LayoutOpts): Graph {
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
		return y.count - x.count || x.name.localeCompare(y.name);
	};
	let cursor = 0, maxCol = 0;
	const maxLanes = Math.max(1, Math.floor(opts.lanes ?? 1));
	const calls = new Set(delegates.map((e) => e.from));
	/** The bus line's height for each wrapped chat, set once the columns have their x. */
	const busY = new Map<string, number>();
	/**
	 * Leaves take the next row; a card with children is centred on them. Many chats under one card (each with nothing
	 * under it) wrap into a block of columns, filled top to bottom so the first column keeps the urgency order; the
	 * chats that call subagents go last, nearest the subagents, so their lines cross no other column.
	 */
	const place = (id: string, col: number) => {
		const c = get(id);
		c.col = col;
		maxCol = Math.max(maxCol, col);
		c.children.sort(order);
		if (!c.children.length) { c.y = cursor + c.h / 2; cursor += c.h + ROW_GAP; return; }
		const top = cursor;
		const leaves = c.children.filter((k) => get(k).kind === "session" && !get(k).children.length);
		const lanes = leaves.length >= WRAP_MIN ? Math.min(maxLanes, Math.ceil(leaves.length / WRAP_ROWS)) : 1;
		if (lanes < 2) for (const k of c.children) place(k, col + 1);
		else {
			const wrap = new Set(leaves);
			for (const k of c.children) if (!wrap.has(k)) place(k, col + 1);
			const grid = [...leaves.filter((k) => !calls.has(k)), ...leaves.filter((k) => calls.has(k))];
			const rows = Math.ceil(grid.length / lanes);
			const bus = cursor + BUS_GAP / 4; // 18 below the cards above (their 12 gap + 6), 18 above the block
			cursor += BUS_GAP;
			const rowH = Array.from({ length: rows }, (_, r) => Math.max(...grid.filter((_, i) => i % rows === r).map((k) => get(k).h)));
			const rowTop: number[] = [];
			for (const h of rowH) { rowTop.push(cursor); cursor += h + ROW_GAP; }
			grid.forEach((k, i) => {
				const kc = get(k), lane = Math.floor(i / rows);
				kc.col = col + 1 + lane;
				kc.lane = lane;
				kc.y = rowTop[i % rows]! + kc.h / 2; // top-aligned rows
				if (lane) busY.set(k, bus);
				maxCol = Math.max(maxCol, kc.col);
			});
		}
		const ys = c.children.map((k) => get(k).y);
		c.y = (Math.min(...ys) + Math.max(...ys)) / 2;
		// a card taller than the rows under it (a working chat over one branch) would reach into the rows above and below:
		// move what is under it down so it is centred on them, and its own rows end below it
		const lift = top + c.h / 2 - c.y;
		if (lift > 0) {
			const down = (id: string) => {
				for (const k of get(id).children) {
					get(k).y += lift;
					const b = busY.get(k);
					if (b !== undefined) busY.set(k, b + lift);
					down(k);
				}
			};
			down(id);
			c.y += lift;
			cursor = Math.max(cursor + lift, top + c.h + ROW_GAP);
		}
	};
	const roles = [...cards.values()].filter((c) => c.kind === "subagent");
	const bands: Band[] = [];
	servers.forEach((v, i) => {
		const root = get(`v:${v.id}`);
		if (i) cursor += BAND_GAP - ROW_GAP;
		const top = cursor;
		count(root.id);
		place(root.id, 0);
		// a server's subagents sit beside the chats that call them, without overlapping: one role's cards (one per model) in
		// one run, the model used last on top, the roles in the order of their callers
		const groups = new Map<string, Card[]>();
		for (const r of roles) if (r.server === v.id) groups.set(r.label, [...(groups.get(r.label) ?? []), r]);
		const runs = [...groups.values()].map((g) => {
			const ys = g.flatMap((r) => delegates.filter((e) => e.to === r.id).map((e) => get(e.from).y));
			return { cards: g.sort((a, b) => b.last! - a.last! || a.id.localeCompare(b.id)), y: ys.reduce((a, b) => a + b, 0) / ys.length };
		});
		runs.sort((a, b) => a.y - b.y || a.cards[0]!.label.localeCompare(b.cards[0]!.label));
		let below = top; // the bottom of the cards placed so far, plus the gap
		for (const g of runs) {
			const tall = g.cards.reduce((n, r) => n + r.h, 0) + ROW_GAP * (g.cards.length - 1);
			let y = Math.max(below, g.y - tall / 2);
			for (const r of g.cards) { r.y = y + r.h / 2; y += r.h + ROW_GAP; }
			below = y;
		}
		if (runs.length) cursor = Math.max(cursor, below);
		bands.push({ server: v.id, y0: top, y1: cursor - ROW_GAP, online: v.online });
	});
	for (const r of roles) r.col = maxCol + 1;

	// one width per column, the widest card's (a long model id widens its column, up to `maxW`; never below its kind's width)
	const cols: { x: number; w: number }[] = [];
	for (const c of cards.values()) {
		const w = Math.max(c.w, Math.min(opts.maxW ?? CARD_W_MAX, opts.widths?.(c) ?? 0));
		cols[c.col] = { x: 0, w: Math.max(cols[c.col]?.w ?? 0, w) };
	}
	let x = 0;
	for (const col of cols) if (col) { col.x = x; x += col.w + COL_GAP; }
	for (const c of cards.values()) {
		c.w = cols[c.col]!.w;
		c.x = cols[c.col]!.x + c.w / 2;
		const by = busY.get(c.id);
		// the bus enters over the block's first column; the spine runs down the middle of the gap left of this column
		if (by !== undefined && c.lane) c.bus = { dy: by - c.y, gx: cols[c.col - c.lane]!.x - c.x, sx: cols[c.col]!.x - COL_GAP / 2 - c.x };
		const pin = opts.pins?.[c.id];
		if (pin) { c.x = pin.x; c.y = pin.y; c.bus = undefined; } // moved by hand: a plain line to wherever it is
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

/** A drawn line: cubic curves and straight runs, each from where the last one ended. */
type Seg = { c: true; p: number[] } | { c: false; p: number[] };
const KAPPA = 0.5523; // a quarter circle as a cubic
/** Corner radius where a routed line turns (bus → spine → card). */
const TURN = 12;

/**
 * A line from the right edge of `a` to the left edge of `b` (or back out of the right side when `b` is not to its right).
 * `elbow` (the structure: server → … → chat) runs square through the middle of the gap with round corners, so the lines
 * out of one card share one spine instead of fanning out; a chat in a wrapped block's later column is reached along its
 * bus above the block and a spine left of its column (see `Card.bus`). `curve` (a delegate call, across columns) is one
 * S-curve. `p` < 1 draws only the first part (a line growing from `a` toward `b`).
 */
export function edgePath(a: Card, b: Card, p = 1, style: "curve" | "elbow" = "curve"): string {
	let segs = edgeSegs(a, b, style);
	if (p < 1) segs = cut(segs, Math.max(0, p));
	const r = (n: number) => Math.round(n * 100) / 100;
	let d = `M${r(segs[0]!.p[0]!)} ${r(segs[0]!.p[1]!)}`;
	for (const s of segs) d += s.c ? `C${r(s.p[2]!)} ${r(s.p[3]!)} ${r(s.p[4]!)} ${r(s.p[5]!)} ${r(s.p[6]!)} ${r(s.p[7]!)}` : `L${r(s.p[2]!)} ${r(s.p[3]!)}`;
	return d;
}

/** How long a line is, in graph px: what the work running along it takes to cross it. */
export function edgeLength(a: Card, b: Card, style: "curve" | "elbow" = "curve"): number {
	return edgeSegs(a, b, style).reduce((n, s) => n + segLen(s), 0);
}

function edgeSegs(a: Card, b: Card, style: "curve" | "elbow"): Seg[] {
	const ax = a.x + a.w / 2;
	let segs: Seg[];
	if (b.x - b.w / 2 > ax + 8) {
		const bx = b.x - b.w / 2 - (style === "elbow" ? 0 : 2); // a structure line meets the border; a call's tip sits just off it
		if (style === "elbow") {
			const first = b.bus ? b.x + b.bus.gx : bx; // the block's first column: the spine sits in the gap before it
			const mx = (ax + first) / 2;
			const pts = b.bus
				? [[ax, a.y], [mx, a.y], [mx, b.y + b.bus.dy], [b.x + b.bus.sx, b.y + b.bus.dy], [b.x + b.bus.sx, b.y], [bx, b.y]]
				: [[ax, a.y], [mx, a.y], [mx, b.y], [bx, b.y]];
			segs = squared(pts as [number, number][]);
		} else {
			const c = Math.max(32, (bx - ax) / 2);
			segs = [{ c: true, p: [ax, a.y, ax + c, a.y, bx - c, b.y, bx, b.y] }];
		}
	} else if (b.x + b.w / 2 < a.x - a.w / 2 - 8) {
		const x0 = a.x - a.w / 2, bx = b.x + b.w / 2 + 2, c = Math.max(32, (x0 - bx) / 2);
		segs = [{ c: true, p: [x0, a.y, x0 - c, a.y, bx + c, b.y, bx, b.y] }];
	} else {
		const bx = b.x + b.w / 2 + 2, c = 40 + Math.min(120, Math.abs(b.y - a.y) * 0.3);
		segs = [{ c: true, p: [ax, a.y, ax + c, a.y, bx + c, b.y, bx, b.y] }];
	}
	return segs;
}

/** Where a line ends and which way it points there (1 right, -1 left): for the chevron on a delegate call. */
export function edgeTip(a: Card, b: Card): { x: number; y: number; dir: 1 | -1 } {
	if (b.x - b.w / 2 > a.x + a.w / 2 + 8) return { x: b.x - b.w / 2 - 2, y: b.y, dir: 1 };
	return { x: b.x + b.w / 2 + 2, y: b.y, dir: -1 };
}

/**
 * Straight runs through `pts` (each one level or upright), the corners rounded: a quarter circle of `TURN`, smaller where
 * a run is too short for it (two cards almost level get a soft step, not a hook).
 */
function squared(input: [number, number][]): Seg[] {
	// drop repeated points and the middle of three in a line: no zero-length runs, no corner that does not turn
	const pts: [number, number][] = [];
	for (const q of input) {
		const l = pts[pts.length - 1];
		if (l && Math.abs(l[0] - q[0]) < 0.01 && Math.abs(l[1] - q[1]) < 0.01) continue;
		const m = pts[pts.length - 2];
		if (m && l && ((Math.abs(m[0] - l[0]) < 0.01 && Math.abs(l[0] - q[0]) < 0.01) || (Math.abs(m[1] - l[1]) < 0.01 && Math.abs(l[1] - q[1]) < 0.01))) pts.pop();
		pts.push(q);
	}
	if (pts.length < 2) return [{ c: false, p: [...input[0]!, ...input[input.length - 1]!] }];
	const segs: Seg[] = [];
	let [cx, cy] = pts[0]!;
	for (let i = 1; i < pts.length - 1; i++) {
		const [px, py] = pts[i - 1]!, [x, y] = pts[i]!, [nx, ny] = pts[i + 1]!;
		const lin = Math.hypot(x - px, y - py), lout = Math.hypot(nx - x, ny - y);
		const r = Math.min(TURN, lin / 2, lout / 2);
		const [ix, iy] = [(x - px) / lin, (y - py) / lin], [ox, oy] = [(nx - x) / lout, (ny - y) / lout];
		const [sx, sy] = [x - ix * r, y - iy * r], [ex, ey] = [x + ox * r, y + oy * r];
		segs.push({ c: false, p: [cx, cy, sx, sy] });
		const k = r * (1 - KAPPA);
		segs.push({ c: true, p: [sx, sy, x - ix * k, y - iy * k, x + ox * k, y + oy * k, ex, ey] });
		[cx, cy] = [ex, ey];
	}
	const [lx, ly] = pts[pts.length - 1]!;
	segs.push({ c: false, p: [cx, cy, lx, ly] });
	return segs.filter((s) => s.c || Math.hypot(s.p[2]! - s.p[0]!, s.p[3]! - s.p[1]!) > 0.01);
}

/** The first `p` of a line, by length: whole segments, then the one it stops in, cut short. */
function segLen(s: Seg): number {
	if (!s.c) return Math.hypot(s.p[2]! - s.p[0]!, s.p[3]! - s.p[1]!);
	let l = 0, [px, py] = [s.p[0]!, s.p[1]!];
	for (let i = 1; i <= 8; i++) {
		const [x, y] = splitCubic(s.p, i / 8).slice(6);
		l += Math.hypot(x! - px, y! - py);
		[px, py] = [x!, y!];
	}
	return l;
}
function cut(segs: Seg[], p: number): Seg[] {
	const lens = segs.map(segLen);
	let left = p * lens.reduce((a, b) => a + b, 0);
	const out: Seg[] = [];
	for (const [i, s] of segs.entries()) {
		const l = lens[i]!;
		if (left >= l && i < segs.length - 1) { out.push(s); left -= l; continue; }
		const t = l ? Math.min(1, left / l) : 0;
		out.push(s.c ? { c: true, p: splitCubic(s.p, t) } : { c: false, p: [s.p[0]!, s.p[1]!, s.p[0]! + (s.p[2]! - s.p[0]!) * t, s.p[1]! + (s.p[3]! - s.p[1]!) * t] });
		break;
	}
	return out;
}

/** The first part of a cubic Bézier, up to `t` (de Casteljau): the same curve, cut short. */
export function splitCubic([x0, y0, x1, y1, x2, y2, x3, y3]: number[], t: number): number[] {
	const l = (a: number, b: number) => a + (b - a) * t;
	const [ax, ay, bx, by, cx, cy] = [l(x0!, x1!), l(y0!, y1!), l(x1!, x2!), l(y1!, y2!), l(x2!, x3!), l(y2!, y3!)];
	const [dx, dy, ex, ey] = [l(ax, bx), l(ay, by), l(bx, cx), l(by, cy)];
	const r = (n: number) => Math.round(n * 100) / 100;
	return [x0!, y0!, r(ax), r(ay), r(dx), r(dy), r(l(dx, ex)), r(l(dy, ey))];
}

/**
 * When each new card and line shows, so a branch grows from left to right: a line starts drawing once the card it leaves
 * has appeared, and the card at its end appears when the line reaches it. `known` holds the cards already on screen (and
 * when they appear, which may still be ahead); a card with no line into it (a new server) appears at `now`.
 * Returns when each fresh card appears and each fresh line starts, in ms on the same clock as `now`.
 */
export function growthPlan(
	g: Pick<Graph, "cards" | "edges">,
	known: (id: string) => number | undefined,
	knownEdge: (id: string) => boolean,
	now: number,
	{ lead, draw }: { lead: number; draw: number },
): { cards: Map<string, number>; edges: Map<string, number> } {
	const cards = new Map<string, number>();
	const edges = new Map<string, number>();
	const into = new Map<string, Edge[]>();
	for (const e of g.edges) if (g.cards.has(e.from) && e.from !== e.to) into.set(e.to, [...(into.get(e.to) ?? []), e]);
	const visiting = new Set<string>();
	/** A line leaves its card a moment after the card starts to show (at once from a card already there). */
	const start = (from: string) => Math.max(now, appear(from) + lead);
	const appear = (id: string): number => {
		const k = known(id);
		if (k !== undefined) return k;
		const hit = cards.get(id);
		if (hit !== undefined) return hit;
		if (visiting.has(id)) return now; // never a loop in this graph; if one came, it stops here
		visiting.add(id);
		// the structural line (its column's parent) leads; a subagent has only delegate lines: the earliest caller's
		const ins = into.get(id) ?? [];
		const first = ins.find((e) => e.kind !== "delegate") ?? ins[0];
		const at = first ? start(first.from) + draw : now;
		visiting.delete(id);
		cards.set(id, at);
		return at;
	};
	for (const id of g.cards.keys()) appear(id);
	for (const e of g.edges) if (!knownEdge(e.id) && g.cards.has(e.from)) edges.set(e.id, start(e.from));
	return { cards, edges };
}

/**
 * The way out, growth in reverse: the rightmost goes first. A line pulls back into the card it leaves, and a card fades
 * once every line out of it has pulled back; the line into it follows. `gone` are the cards that left the layout,
 * `edges` the lines that did (their ends may stay). Returns when each card starts to fade and each line to pull back.
 */
export function leavePlan(
	gone: ReadonlySet<string>,
	edges: Edge[],
	now: number,
	{ fade, retract }: { fade: number; retract: number },
): { cards: Map<string, number>; edges: Map<string, number> } {
	const cards = new Map<string, number>();
	const lines = new Map<string, number>();
	const out = new Map<string, Edge[]>();
	for (const e of edges) out.set(e.from, [...(out.get(e.from) ?? []), e]);
	const visiting = new Set<string>();
	const leave = (id: string): number => {
		const hit = cards.get(id);
		if (hit !== undefined) return hit;
		if (visiting.has(id)) return now;
		visiting.add(id);
		const at = Math.max(now, ...(out.get(id) ?? []).map((e) => line(e) + retract));
		visiting.delete(id);
		cards.set(id, at);
		return at;
	};
	const line = (e: Edge): number => {
		const hit = lines.get(e.id);
		if (hit !== undefined) return hit;
		const at = gone.has(e.to) ? leave(e.to) + fade : now;
		lines.set(e.id, at);
		return at;
	};
	for (const id of gone) leave(id);
	for (const e of edges) line(e);
	return { cards, edges: lines };
}

/** How long a role's card on a model it no longer uses stays at full strength after its last call. */
export const ROLE_STALE_MS = 60 * 60_000;

/**
 * The subagent cards that step back: a role's card on a model it has moved off. Not running, last called over
 * `ROLE_STALE_MS` ago, and the same role has a card used more recently. A role's newest card never fades, so a role
 * that is simply idle keeps its card as it is.
 */
export function staleRoles(g: Graph, now: number): Set<string> {
	const newest = new Map<string, number>();
	const key = (c: Card) => `${c.server}\u0000${c.label}`;
	for (const c of g.cards.values()) if (c.kind === "subagent") newest.set(key(c), Math.max(newest.get(key(c)) ?? 0, c.last ?? 0));
	const out = new Set<string>();
	for (const c of g.cards.values()) {
		if (c.kind !== "subagent" || c.running) continue;
		const last = c.last ?? 0;
		if (last < newest.get(key(c))! && now - last > ROLE_STALE_MS) out.add(c.id);
	}
	return out;
}

/**
 * The cards that step back, so what is at work (or wants the user) reads first. One rule for every kind:
 *  - a chat at rest (idle: not working, not asking, nothing new to look at)
 *  - a provider or model whose chats are all at rest
 *  - a role's card with no call running and only resting chats calling it, or on a model it moved off (`staleRoles`)
 *  - everything of a server that is offline, the server card too
 * A server that is online stays (it is the root its lines hang from).
 */
export function quietCards(g: Graph, now: number): Set<string> {
	const out = staleRoles(g, now);
	const down = new Set([...g.cards.values()].filter((c) => c.kind === "server" && !c.online).map((c) => c.server));
	const resting = (c: Card): boolean => {
		if (c.kind === "session") return c.activity === "idle" && c.children.every((k) => resting(g.cards.get(k)!));
		return c.children.length > 0 && c.children.every((k) => resting(g.cards.get(k)!));
	};
	for (const c of g.cards.values()) {
		if (down.has(c.server)) out.add(c.id);
		else if (c.kind === "session" ? c.activity === "idle" : (c.kind === "provider" || c.kind === "model") && resting(c)) out.add(c.id);
	}
	for (const c of g.cards.values()) {
		if (c.kind !== "subagent" || c.running) continue;
		const callers = g.edges.filter((e) => e.kind === "delegate" && e.to === c.id).map((e) => e.from);
		if (callers.every((id) => out.has(id))) out.add(c.id);
	}
	return out;
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

/** Room kept around the graph when it is fitted: the sides, and top and bottom (the floating bar sits in the bottom one). */
export const FIT_PAD = { x: 32, y: 56 };
/** The fitted zoom: never above 100%, never below 50% (names stay legible; zoom in for the rest). */
export const FIT_MIN = 0.5;

/** What the cards take up (the hairlines between servers lie inside it). */
function bounds(g: Graph) {
	let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
	for (const c of g.cards.values()) {
		x0 = Math.min(x0, c.x - c.w / 2); x1 = Math.max(x1, c.x + c.w / 2);
		y0 = Math.min(y0, c.y - c.h / 2); y1 = Math.max(y1, c.y + c.h / 2);
	}
	return { x0, y0, w: x1 - x0, h: y1 - y0 };
}
/** How much of 100% the whole graph fits a `w` × `h` view at, across and down (above 1: room to spare). */
function fitScales(g: Graph, w: number, h: number, pad = FIT_PAD) {
	const b = bounds(g);
	return { across: (w - pad.x * 2) / b.w, down: (h - pad.y * 2) / b.h };
}
function fitScale(g: Graph, w: number, h: number, pad = FIT_PAD) {
	const s = fitScales(g, w, h, pad);
	return Math.min(s.across, s.down);
}

/** The box around some of the cards, or null when none of them is on the graph. */
function boxOf(g: Graph, ids: Iterable<string>) {
	let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
	for (const id of ids) {
		const c = g.cards.get(id);
		if (!c) continue;
		x0 = Math.min(x0, c.x - c.w / 2); x1 = Math.max(x1, c.x + c.w / 2);
		y0 = Math.min(y0, c.y - c.h / 2); y1 = Math.max(y1, c.y + c.h / 2);
	}
	return x0 === Infinity ? null : { x0, y0, w: x1 - x0, h: y1 - y0 };
}

/** The cards the view is fitted around when the whole graph does not fit: the chats at work or waiting for an answer. */
export const focusCards = (g: Graph): string[] => [...g.cards.values()].filter((c) => c.kind === "session" && isLive(c.activity)).map((c) => c.id);

/**
 * The zoom and offset that show the whole graph in a `w` × `h` view, centred. A way it does not fit even at the floor
 * pans: there the `focus` cards (the chats at work) come into view, centred (their start first when they do not fit
 * either), without pulling an end of the graph past its pad. With nothing to focus, too wide starts at the left (the
 * servers) and too tall stays centred on the middle.
 */
export function fitView(g: Graph, w: number, h: number, pad = FIT_PAD, focus: Iterable<string> = []): { k: number; x: number; y: number } {
	if (!g.cards.size) return { k: 1, x: pad.x, y: pad.y };
	const b = bounds(g);
	const k = Math.max(FIT_MIN, Math.min(1, fitScale(g, w, h, pad)));
	const f = boxOf(g, focus);
	/** One axis: the view's size, the graph's start and length, the focus box's (if any), the pad. */
	const axis = (size: number, b0: number, bl: number, f0: number | undefined, fl: number | undefined, p: number, plain: number) => {
		if (bl * k <= size - p * 2) return size / 2 - (b0 + bl / 2) * k; // the whole graph fits this way: centred
		if (f0 === undefined || fl === undefined) return plain;
		const want = fl * k <= size - p * 2 ? size / 2 - (f0 + fl / 2) * k : p - f0 * k;
		// the graph's far end stays at the pad or past it, its near end too
		return Math.min(p - b0 * k, Math.max(size - p - (b0 + bl) * k, want));
	};
	return {
		k,
		x: axis(w, b.x0, b.w, f?.x0, f?.w, pad.x, pad.x - b.x0 * k),
		y: axis(h, b.y0, b.h, f?.y0, f?.h, pad.y, h / 2 - (b.y0 + b.h / 2) * k),
	};
}

/**
 * The layout that fits the view best: many chats under one card wrap into 1 to 4 columns, as many as make the whole
 * graph show largest. Wrapping never makes it wider than the view at the smallest fitted zoom (the subagents on the
 * right must not fall off), and a graph that fits anyway keeps one column (fewer columns win a tie).
 */
export function fitGraph(servers: GraphServer[], opts: Omit<LayoutOpts, "lanes" | "maxW">, w: number, h: number): Graph {
	let best = buildGraph(servers, { ...opts, lanes: 1 });
	if (w <= 0 || h <= 0) return best;
	// Long names widen their columns, but not past the view: the whole graph still fits at the smallest fitted zoom (the
	// subagents on the right stay in sight). The widest columns give way first; a name that no longer fits ends in "…".
	// A view too narrow for even the plain widths (a phone) pans anyway: there the names keep their full room.
	let maxW = CARD_W_MAX;
	const floor = Math.max(...Object.values(CARD_W));
	if (fitScales(best, w, h).across < FIT_MIN && fitScales(buildGraph(servers, { ...opts, lanes: 1, maxW: floor }), w, h).across >= FIT_MIN) {
		let lo = floor, hi = CARD_W_MAX;
		while (hi - lo > 4) {
			const mid = Math.round((lo + hi) / 2);
			if (fitScales(buildGraph(servers, { ...opts, lanes: 1, maxW: mid }), w, h).across >= FIT_MIN) lo = mid;
			else hi = mid;
		}
		maxW = lo;
		best = buildGraph(servers, { ...opts, lanes: 1, maxW });
	}
	let score = Math.min(1, fitScale(best, w, h));
	for (let lanes = 2; lanes <= 4 && score < 1; lanes++) {
		const g = buildGraph(servers, { ...opts, lanes, maxW });
		const f = fitScales(g, w, h);
		if (f.across < FIT_MIN) break; // wider still would only be worse
		const s = Math.min(1, f.across, f.down);
		if (s > score * 1.03) [best, score] = [g, s]; // a real gain, not a wash
	}
	return best;
}

/**
 * Whether a wheel event came from a mouse wheel (zoom) rather than two fingers on a trackpad (scroll). Browsers do not
 * say, so this reads the signs a wheel leaves: Firefox counts it in lines, Chrome and Safari report the old
 * `wheelDeltaY` in steps of 120 that is not -3× the pixel delta (a trackpad's always is), and a trackpad scrolls
 * sideways too. With no legacy delta, a whole step of 50 px or more is taken to be a wheel.
 */
export function isMouseWheel(e: Pick<WheelEvent, "deltaMode" | "deltaX" | "deltaY"> & { wheelDeltaY?: number }): boolean {
	if (e.deltaMode !== 0) return true;
	if (e.deltaX !== 0 || e.deltaY === 0) return false;
	const legacy = e.wheelDeltaY;
	if (typeof legacy === "number" && legacy !== 0) return legacy % 120 === 0 && legacy !== -3 * e.deltaY;
	return Number.isInteger(e.deltaY) && Math.abs(e.deltaY) >= 50;
}

/**
 * How briskly a card or the view settles on a new place: a critically damped spring (it never overshoots), about half a
 * second to come to rest. A spring rather than a timed curve so a target that moves again mid-way (a second chat starts,
 * the column re-sorts) bends the path instead of restarting it.
 */
export const SPRING_OMEGA = 12;

/** One exact step of that spring: from `x` moving at `v`, `dt` seconds toward `to`. Returns the new place and speed. */
export function springStep(x: number, v: number, to: number, dt: number, omega = SPRING_OMEGA): [number, number] {
	const d = x - to;
	const c = v + omega * d;
	const e = Math.exp(-omega * dt);
	return [to + (d + c * dt) * e, (c - omega * (d + c * dt)) * e];
}

/**
 * The work running along a live line: how many sparks and how long each takes to cross. A constant speed rather than a
 * constant time, so a long line does not rush and a short one does not crawl; sparks spaced evenly, more on a longer line.
 * Durations are rounded so a card easing into place does not restart them every frame.
 */
export function sparkPlan(length: number, call: boolean): { n: number; dur: number } {
	const speed = call ? 220 : 130; // px per second: a call is quick, work on the structure flows calmly
	const dur = Math.round(Math.min(call ? 2.6 : 4.2, Math.max(call ? 0.9 : 1.6, length / speed)) * 10) / 10;
	const n = Math.max(call ? 2 : 1, Math.min(4, Math.round(length / (call ? 110 : 170))));
	return { n, dur };
}
