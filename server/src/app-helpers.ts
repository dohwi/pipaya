import { badRequest } from "./errors.ts";
import { type GroupManager, type GroupRecord, panesOf } from "./groups.ts";
import { THINKING_LEVELS, type SessionRecord, type SessionStore, type ThinkingLevel } from "./store.ts";
import { GROUP_NAME_SYSTEM, groupNameRequest, parseGroupName, type SystemModelSettings } from "./system-model.ts";
import { isTerminalId } from "./terminals.ts";

/**
 * LIFO teardown registry: subsystems register cleanup hooks as they are constructed/started,
 * and `close()` unwinds them in reverse order.
 */
export class TeardownStack {
	private hooks: (() => void | Promise<void>)[] = [];

	onClose(fn: () => void | Promise<void>): void {
		this.hooks.push(fn);
	}

	async close(): Promise<void> {
		const list = this.hooks.splice(0).reverse();
		for (const fn of list) await fn();
	}
}

/** Validates an optional thinking level string from an extension or API call. */
export function parseThinkingLevel(v: string | undefined): ThinkingLevel | undefined {
	if (v !== undefined && !(THINKING_LEVELS as readonly string[]).includes(v)) {
		throw badRequest(`unknown thinking level "${v}"`);
	}
	return v as ThinkingLevel | undefined;
}

/** Extension-facing summary of a session record. */
export function sessionInfo(r: SessionRecord, opts: { running: boolean; busy: boolean }) {
	return {
		id: r.id,
		name: r.name,
		title: r.title,
		purpose: r.purpose,
		cwd: r.cwd,
		provider: r.provider,
		model: r.model,
		thinkingLevel: r.thinkingLevel,
		tools: r.tools,
		closed: r.closed,
		parentId: r.parentId,
		createdAt: r.createdAt,
		updatedAt: r.updatedAt,
		running: opts.running,
		busy: opts.busy,
	};
}

/** Extension-facing summary of a split-window group record. */
export function groupInfo(g: GroupRecord) {
	return {
		id: g.id,
		name: g.name,
		sessionIds: panesOf(g.layout).filter((id) => !isTerminalId(id)),
		terminalIds: panesOf(g.layout).filter(isTerminalId),
		layout: g.layout,
		createdAt: g.createdAt,
		updatedAt: g.updatedAt,
	};
}

/**
 * In the background, asks the system model for a descriptive name for a newly created group,
 * applying it only if nobody renamed the group in the meantime.
 */
export function autoNameGroup(
	rec: GroupRecord,
	deps: { systemModel: SystemModelSettings; store: SessionStore; groups: GroupManager },
): void {
	if (!deps.systemModel.resolveFor("groupName")) return;
	const members = panesOf(rec.layout).flatMap((id) => {
		const r = deps.store.get(id);
		return r ? [{ cwd: r.cwd, title: r.title, purpose: r.purpose }] : [];
	});
	if (!members.length) return;
	void (async () => {
		const name = parseGroupName((await deps.systemModel.complete(GROUP_NAME_SYSTEM, groupNameRequest(members), 60)) ?? "");
		if (!name || name === rec.name || !deps.systemModel.resolveFor("groupName")) return;
		try {
			if (deps.groups.get(rec.id).name === rec.name) deps.groups.update(rec.id, { name });
		} catch {
			/* the group is gone */
		}
	})();
}
