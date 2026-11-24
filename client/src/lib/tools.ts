import { clip, firstLine } from "./format";

export type ToolIcon = "file" | "pencil" | "folder" | "search" | "terminal" | "bolt" | "chat" | "skill" | "fork" | "brain" | "list" | "sparkles";

export const toolArgStr = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : JSON.stringify(v));
const str = toolArgStr;

/** What a tool call really is. A `read` of a SKILL.md is a skill being loaded gets its own look. */
export type ToolKind = "read" | "write" | "edit" | "ls" | "grep" | "glob" | "bash" | "skill" | "think" | "image" | "peer" | "other";

/** `read` of …/<name>/SKILL.md → the skill's name, else null. */
export function skillOf(name: string, args: Record<string, unknown>): string | null {
	if (name !== "read") return null;
	const parts = str(args.path).split(/[\\/]/).filter(Boolean);
	return parts.at(-1)?.toLowerCase() === "skill.md" ? (parts.at(-2) ?? "skill") : null;
}

export function toolKind(name: string, args: Record<string, unknown> = {}): ToolKind {
	if (skillOf(name, args)) return "skill";
	if (isImageTool(name)) return "image";
	return name in LOOK ? (name as ToolKind) : "other";
}

/** Icon per kind, so each kind of work is recognisable at a glance (the colour stays quiet: red is kept for a failure). */
const LOOK: Record<ToolKind, { icon: ToolIcon }> = {
	read: { icon: "file" },
	ls: { icon: "folder" },
	grep: { icon: "search" },
	glob: { icon: "search" },
	write: { icon: "pencil" },
	edit: { icon: "pencil" },
	bash: { icon: "terminal" },
	skill: { icon: "skill" },
	think: { icon: "brain" },
	other: { icon: "bolt" },
	image: { icon: "sparkles" },
	peer: { icon: "chat" },
};

/** The tool that draws pictures (the server's image model setting gives it to agents). */
export const IMAGE_TOOL = "generate_image";
export const isImageTool = (name: string) => name === IMAGE_TOOL;

export const toolIcon = (name: string, args: Record<string, unknown> = {}): ToolIcon => LOOK[toolKind(name, args)].icon;

/** The name a call's line shows: the tool name, except skills, which say what they are. */
export function toolLabel(name: string, args: Record<string, unknown> = {}): string {
	const kind = toolKind(name, args);
	if (kind === "skill") return `skill · ${skillOf(name, args)}`;
	return name;
}

/**
 * A shell command split into the folder it first `cd`s into and the work after it: `cd ../app && git pull` →
 * `{ dir: "../app", rest: "git pull" }`. Agents prefix nearly every command with the same `cd`, which ate the summary's
 * room and cut off the part that tells two calls apart. A command that is only a `cd` keeps it as its work.
 */
export function splitCd(command: string): { dir: string; rest: string } {
	const line = firstLine(command).trim();
	const lead = /^cd\s+("[^"]*"|'[^']*'|[^\s;&|]+)\s*(?:&&|;)\s*/;
	let rest = line;
	let dir = "";
	for (let m = lead.exec(rest); m; m = lead.exec(rest)) {
		const next = rest.slice(m[0].length);
		if (!next) break;
		dir = m[1]!.replace(/^(["'])(.*)\1$/, "$2");
		rest = next;
	}
	return { dir, rest };
}

const peerHandle = (v: unknown): string => {
	const s = str(v).trim().replace(/^@/, "");
	return s ? `@${s}` : "";
};

/**
 * Ordered `@`-less handle candidates a `peer` call acted on. `rename` returns `[newName, name]` so callers fall back
 * to the old handle if the rename failed or has not completed yet.
 */
export function peerTargetsOf(args: Record<string, unknown>, output = ""): string[] {
	const clean = (v: unknown) => {
		const s = str(v).trim().replace(/^@/, "");
		return s || null;
	};
	const list = (...vals: (string | null)[]) => vals.filter((v, i, a): v is string => !!v && a.indexOf(v) === i);
	switch (str(args.action)) {
		case "send":
			return list(clean(args.to));
		case "rename":
			return list(clean(args.newName), clean(args.name));
		case "create": {
			const m = /^Created @([^\s(,.:;!?]+)/.exec(output.trim());
			return list(m ? m[1]! : null);
		}
		case "group_create": {
			const m = /^Group @([^\s(,.:;!?]+)/.exec(output.trim());
			return list(m ? m[1]! : null, clean(args.groupName));
		}
		case "group_add":
		case "group_remove":
		case "group_dissolve":
			return list(clean(args.group));
		default:
			return list(clean(args.name), clean(args.to));
	}
}

/** Primary `@`-less handle a `peer` call acted on, or null. */
export const peerTargetOf = (args: Record<string, unknown>, output = ""): string | null => peerTargetsOf(args, output)[0] ?? null;

/** Schedule ID a `schedule` call acted on (from tool `details.id` or `args.id`), or null for `list` / `delete`. */
export function scheduleIdOf(args: Record<string, unknown>, details?: Record<string, unknown> | null): string | null {
	const action = str(args.action);
	if (action === "list" || action === "delete") return null;
	const fromDetails = typeof details?.id === "string" ? details.id.trim() : "";
	if (fromDetails) return fromDetails;
	const fromArgs = str(args.id).trim();
	return fromArgs || null;
}

const LEAD_KEYS = ["action", "command", "method"] as const;
const VALUE_KEYS = [
	"scope",
	"query",
	"url",
	"path",
	"file",
	"name",
	"id",
	"title",
	"target",
	"patterns",
	"paths",
	"prompt",
	"message",
	"content",
	"text",
] as const;

function formatArgValue(v: unknown): string {
	if (v == null) return "";
	if (typeof v === "string") return firstLine(v).trim();
	if (typeof v === "number" || typeof v === "boolean") return String(v);
	if (Array.isArray(v)) {
		const items = v.map((item) => (typeof item === "string" ? firstLine(item).trim() : typeof item === "number" || typeof item === "boolean" ? String(item) : "")).filter(Boolean);
		if (!items.length) return v.length ? `${v.length} items` : "";
		return items.length > 2 ? `${items.slice(0, 2).join(", ")} (+${items.length - 2})` : items.join(", ");
	}
	try {
		const raw = JSON.stringify(v);
		return raw === "{}" ? "" : raw;
	} catch {
		return "";
	}
}

/** Human-readable one-line summary for custom / MCP tools instead of raw JSON. */
export function summarizeGenericArgs(args: Record<string, unknown>): string {
	const parts: string[] = [];
	const used = new Set<string>();
	const pushVal = (key: string, labelKey: boolean) => {
		if (parts.length >= 3 || used.has(key) || !(key in args)) return;
		const formatted = formatArgValue(args[key]);
		used.add(key);
		if (!formatted) return;
		parts.push(labelKey ? `${key}=${formatted}` : formatted);
	};
	for (const k of LEAD_KEYS) pushVal(k, false);
	for (const k of VALUE_KEYS) pushVal(k, false);
	for (const k of Object.keys(args)) pushVal(k, true);
	return clip(parts.join(" · "), 90);
}

/** One line that says what a tool call is doing. */
export function toolSummary(name: string, args: Record<string, unknown>): string {
	if (toolKind(name, args) === "skill") return "";
	switch (name) {
		case "bash":
			return splitCd(str(args.command)).rest;
		case IMAGE_TOOL:
			return clip(str(args.prompt), 90);
		case "grep":
		case "glob":
			return `${str(args.pattern)}${args.path ? `  in ${str(args.path)}` : ""}`;
		case "ls":
			return str(args.path) || ".";
		case "read":
		case "write":
			return str(args.path);
		case "edit": {
			const n = Array.isArray(args.edits) ? args.edits.length : 0;
			return n > 1 ? `${str(args.path)} (${n})` : str(args.path);
		}
		case "delegate":
			return clip(`${str(args.role)}: ${firstLine(str(args.task))}`, 90);
		case "peer": {
			const action = str(args.action);
			if (action === "send") return clip([action, peerHandle(args.to), firstLine(str(args.message))].filter(Boolean).join(" · "), 90);
			if (action === "create") return clip([action, firstLine(str(args.title || args.purpose || args.message))].filter(Boolean).join(" · "), 90);
			if (action === "rename") {
				const to = peerHandle(args.newName);
				return clip([action, peerHandle(args.name), to ? `→ ${to}` : ""].filter(Boolean).join(" · "), 90);
			}
			if (action.startsWith("group_")) {
				const members = Array.isArray(args.members) ? args.members.map(peerHandle).filter(Boolean).join(", ") : "";
				return clip([action, peerHandle(args.group || args.groupName), members].filter(Boolean).join(" · "), 90);
			}
			return clip([action, peerHandle(args.name || args.to), firstLine(str(args.purpose || args.model || args.answer || args.text))].filter(Boolean).join(" · "), 90);
		}
		case "schedule":
			return clip([str(args.action), str(args.id), firstLine(str(args.title || args.prompt))].filter(Boolean).join(" · "), 90);
		case "goal":
			return clip([str(args.action), str(args.status), firstLine(str(args.objective))].filter(Boolean).join(" · "), 90);
		case "ask_user": {
			// the question itself, not its JSON; several questions say how many
			const qs = Array.isArray(args.questions) ? args.questions : [];
			const first = qs.length ? str((qs[0] as { question?: unknown }).question) : str(args.question);
			return clip(qs.length > 1 ? `${first} (+${qs.length - 1})` : first, 90);
		}
		case "workdir":
			return clip([str(args.action), str(args.path)].filter(Boolean).join(" · "), 90);
		default:
			return summarizeGenericArgs(args);
	}
}
