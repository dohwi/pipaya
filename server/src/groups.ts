import { groupHandle } from "./member-names.ts";
import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import Type, { type Static } from "typebox";
import { badRequest, notFound } from "./errors.ts";
import type { EventBus } from "./events.ts";

/**
 * A group is a named, split-window arrangement of sessions.
 * The layout is a binary tree: a `pane` shows one session, a `split` divides its area in two.
 * A session lives in at most one group; putting it into another group moves it.
 * A group holds at least two sessions: when one is left alone the group dissolves by itself.
 */
export type Layout =
	| { type: "pane"; sessionId: string }
	| { type: "split"; dir: "row" | "col"; ratio: number; a: Layout; b: Layout };

export const MAX_PANES = 8;
export const MIN_PANES = 2;
const MAX_DEPTH = 8;
const MIN_RATIO = 0.1;
const MAX_RATIO = 0.9;

export interface GroupRecord {
	id: string;
	name: string;
	layout: Layout;
	createdAt: number;
	updatedAt: number;
}

interface GroupRow {
	id: string;
	name: string;
	layout: string;
	created_at: number;
	updated_at: number;
}

const toRecord = (r: GroupRow): GroupRecord => ({
	id: r.id,
	name: r.name,
	layout: JSON.parse(r.layout),
	createdAt: r.created_at,
	updatedAt: r.updated_at,
});

/* ---------- schemas ---------- */

export const LayoutSchema = Type.Unknown({
	description:
		'Binary split tree: { type: "pane", sessionId } | { type: "split", dir: "row"|"col", ratio: 0.1-0.9, a, b }. "row" puts a left of b, "col" puts a above b. Max 8 panes.',
});
export const GroupSchema = Type.Object({
	id: Type.String(),
	name: Type.String(),
	layout: LayoutSchema,
	createdAt: Type.Integer({ description: "Unix ms" }),
	updatedAt: Type.Integer({ description: "Unix ms" }),
});
export const GroupList = Type.Object({ groups: Type.Array(GroupSchema) });
export const CreateGroupBody = Type.Object({
	name: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
	layout: LayoutSchema,
	autoName: Type.Optional(Type.Boolean({ description: "The name is only a placeholder: when a system model is set, the server replaces it with a suggested one" })),
});
export const PatchGroupBody = Type.Object({
	name: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
	layout: Type.Optional(LayoutSchema),
});
export type CreateGroupInput = Static<typeof CreateGroupBody>;
export type PatchGroupInput = Static<typeof PatchGroupBody>;

/* ---------- layout helpers ---------- */

export function panesOf(layout: Layout): string[] {
	return layout.type === "pane" ? [layout.sessionId] : [...panesOf(layout.a), ...panesOf(layout.b)];
}

/** Drop a session's pane; its sibling takes the freed space. null = nothing left. */
export function withoutSession(layout: Layout, sessionId: string): Layout | null {
	if (layout.type === "pane") return layout.sessionId === sessionId ? null : layout;
	const a = withoutSession(layout.a, sessionId);
	const b = withoutSession(layout.b, sessionId);
	if (a && b) return a === layout.a && b === layout.b ? layout : { ...layout, a, b };
	return a ?? b;
}

function needTwo(layout: Layout): Layout {
	if (panesOf(layout).length < MIN_PANES) throw badRequest(`a group needs at least ${MIN_PANES} sessions`);
	return layout;
}

/** Validate untrusted input into a clean layout (unknown keys dropped, ratio clamped). */
export function cleanLayout(input: unknown, sessionExists: (id: string) => boolean): Layout {
	const seen = new Set<string>();
	const walk = (n: unknown, depth: number): Layout => {
		if (depth > MAX_DEPTH) throw badRequest("layout is nested too deeply");
		if (!n || typeof n !== "object") throw badRequest("layout node must be an object");
		const o = n as Record<string, unknown>;
		if (o.type === "pane") {
			if (typeof o.sessionId !== "string" || !o.sessionId) throw badRequest("pane needs a sessionId");
			if (seen.has(o.sessionId)) throw badRequest("a session can only appear once in a group");
			if (!sessionExists(o.sessionId)) throw notFound(`session ${o.sessionId}`);
			seen.add(o.sessionId);
			if (seen.size > MAX_PANES) throw badRequest(`a group holds at most ${MAX_PANES} sessions`);
			return { type: "pane", sessionId: o.sessionId };
		}
		if (o.type === "split") {
			if (o.dir !== "row" && o.dir !== "col") throw badRequest('split dir must be "row" or "col"');
			const ratio = typeof o.ratio === "number" && Number.isFinite(o.ratio) ? o.ratio : 0.5;
			return {
				type: "split",
				dir: o.dir,
				ratio: Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio)),
				a: walk(o.a, depth + 1),
				b: walk(o.b, depth + 1),
			};
		}
		throw badRequest('layout node type must be "pane" or "split"');
	};
	return walk(input, 0);
}

/* ---------- manager ---------- */

export class GroupManager {
	constructor(
		private db: Database,
		private bus: EventBus,
		private sessionExists: (id: string) => boolean,
		/** Lower-cased @names of the active sessions: a group may not take one, or the tag would be ambiguous. */
		private sessionNames: () => ReadonlySet<string> = () => new Set(),
	) {
		// A deleted, closed or archived session leaves its group, so groups never point at sessions that are gone.
		// Deferred a tick so the session event reaches every subscriber (and gets its cursor) before the group event it causes.
		const later = (sessionId: string) =>
			queueMicrotask(() => {
				try {
					this.evict(sessionId);
				} catch {
					/* the database is closing */
				}
			});
		bus.subscribe((e) => {
			if (e.type === "session_deleted" || e.type === "terminal_closed") later((e.data as { id: string }).id);
			else if (e.type === "session_updated" && ((e.data as { closed?: boolean }).closed || (e.data as { archived?: boolean }).archived) && e.sessionId) later(e.sessionId);
		});
	}

	list(): GroupRecord[] {
		return (this.db.query("SELECT * FROM groups ORDER BY created_at, id").all() as GroupRow[]).map(toRecord);
	}

	get(id: string): GroupRecord {
		const row = this.db.query("SELECT * FROM groups WHERE id = $id").get({ id }) as GroupRow | null;
		if (!row) throw notFound("group");
		return toRecord(row);
	}

	create(input: CreateGroupInput): GroupRecord {
		const layout = needTwo(cleanLayout(input.layout, this.sessionExists));
		const now = Date.now();
		const id = randomUUID();
		const name = this.uniqueName(input.name?.trim() || this.nextName());
		this.db.transaction(() => {
			this.claim(layout, id);
			this.db
				.query("INSERT INTO groups (id, name, layout, created_at, updated_at) VALUES ($id, $name, $layout, $now, $now)")
				.run({ id, name, layout: JSON.stringify(layout), now });
		})();
		const rec = this.get(id);
		this.bus.publish(null, "group_created", rec);
		return rec;
	}

	update(id: string, patch: PatchGroupInput): GroupRecord {
		const cur = this.get(id);
		const wanted = patch.name?.trim();
		const name = wanted && wanted !== cur.name ? this.uniqueName(wanted, id) : cur.name;
		const layout = patch.layout === undefined ? cur.layout : needTwo(cleanLayout(patch.layout, this.sessionExists));
		this.db.transaction(() => {
			this.claim(layout, id);
			this.db
				.query("UPDATE groups SET name = $name, layout = $layout, updated_at = $now WHERE id = $id")
				.run({ id, name, layout: JSON.stringify(layout), now: Date.now() });
		})();
		const rec = this.get(id);
		this.bus.publish(null, "group_updated", rec);
		return rec;
	}

	delete(id: string): void {
		this.get(id);
		this.db.query("DELETE FROM groups WHERE id = $id").run({ id });
		this.bus.publish(null, "group_deleted", { id });
	}

	/** `name`, or `name 2`, `name 3`, ... when its tag (the name with dashes, any case) is already a group's or a session's @name. */
	private uniqueName(name: string, exceptId?: string): string {
		const taken = new Set(this.sessionNames());
		for (const g of this.list()) if (g.id !== exceptId) taken.add(groupHandle(g.name).toLowerCase());
		for (let n = 1; ; n++) {
			const cand = n === 1 ? name : `${name} ${n}`;
			if (!taken.has(groupHandle(cand).toLowerCase())) return cand;
		}
	}

	private nextName(): string {
		const taken = new Set(this.list().map((g) => g.name));
		// Stored text is language-neutral; the client passes a localized name when it creates a group.
		for (let n = 1; ; n++) if (!taken.has(`Group ${n}`)) return `Group ${n}`;
	}

	/** Pull the layout's sessions out of every other group (a session belongs to one group). */
	private claim(layout: Layout, owner: string): void {
		const mine = new Set(panesOf(layout));
		for (const g of this.list()) {
			if (g.id === owner) continue;
			let next: Layout | null = g.layout;
			for (const sid of panesOf(g.layout)) if (mine.has(sid)) next = next && withoutSession(next, sid);
			if (next === g.layout) continue;
			this.save(g, next);
		}
	}

	/** Drop every pane whose id matches (terminals do not outlive a server restart). Groups left too small dissolve. */
	evictWhere(match: (id: string) => boolean): void {
		for (const g of this.list()) {
			let next: Layout | null = g.layout;
			for (const id of panesOf(g.layout)) if (match(id)) next = next && withoutSession(next, id);
			if (next !== g.layout) this.save(g, next);
		}
	}

	private evict(sessionId: string): void {
		for (const g of this.list()) {
			if (!panesOf(g.layout).includes(sessionId)) continue;
			this.save(g, withoutSession(g.layout, sessionId));
		}
	}

	/** Persist a group's shrunken layout; a group left with fewer than two sessions is removed. */
	private save(g: GroupRecord, layout: Layout | null): void {
		if (!layout || panesOf(layout).length < MIN_PANES) {
			this.db.query("DELETE FROM groups WHERE id = $id").run({ id: g.id });
			this.bus.publish(null, "group_deleted", { id: g.id });
			return;
		}
		this.db
			.query("UPDATE groups SET layout = $layout, updated_at = $now WHERE id = $id")
			.run({ id: g.id, layout: JSON.stringify(layout), now: Date.now() });
		this.bus.publish(null, "group_updated", this.get(g.id));
	}
}
