import { clip, firstLine } from "./format";

export type ToolIcon = "file" | "pencil" | "folder" | "search" | "terminal" | "bolt" | "chat" | "skill" | "fork" | "brain" | "list";

const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : JSON.stringify(v));

/** What a tool call really is. A `read` of a SKILL.md is a skill being loaded gets its own look. */
export type ToolKind = "read" | "write" | "edit" | "ls" | "grep" | "bash" | "ask_user" | "skill" | "think" | "other";

/** `read` of …/<name>/SKILL.md → the skill's name, else null. */
export function skillOf(name: string, args: Record<string, unknown>): string | null {
	if (name !== "read") return null;
	const parts = str(args.path).split(/[\\/]/).filter(Boolean);
	return parts.at(-1)?.toLowerCase() === "skill.md" ? (parts.at(-2) ?? "skill") : null;
}

export function toolKind(name: string, args: Record<string, unknown> = {}): ToolKind {
	if (skillOf(name, args)) return "skill";
	return name in LOOK ? (name as ToolKind) : "other";
}

/** Icon and badge colour (an oklch hue angle) per kind, so each kind of work is recognisable at a glance. */
const LOOK: Record<ToolKind, { icon: ToolIcon; hue: number }> = {
	read: { icon: "file", hue: 240 },
	ls: { icon: "folder", hue: 215 },
	grep: { icon: "search", hue: 185 },
	write: { icon: "pencil", hue: 150 },
	edit: { icon: "pencil", hue: 60 },
	bash: { icon: "terminal", hue: 25 },
	ask_user: { icon: "chat", hue: 345 },
	skill: { icon: "skill", hue: 90 },
	think: { icon: "brain", hue: 280 },
	other: { icon: "bolt", hue: 265 },
};

export const toolIcon = (name: string, args: Record<string, unknown> = {}): ToolIcon => LOOK[toolKind(name, args)].icon;

/** Inline style that feeds `.tbadge` in app.css. */
export const badgeStyle = (kind: ToolKind): string => `--th:${LOOK[kind].hue}`;

/** Text on the badge: the tool name, except skills, which say what they are. */
export function toolLabel(name: string, args: Record<string, unknown> = {}): string {
	const kind = toolKind(name, args);
	if (kind === "skill") return `skill · ${skillOf(name, args)}`;
	return name;
}

/** One line that says what a tool call is doing. */
export function toolSummary(name: string, args: Record<string, unknown>): string {
	if (toolKind(name, args) === "skill") return "";
	switch (name) {
		case "bash":
			return firstLine(str(args.command));
		case "ask_user":
			return firstLine(str(args.question));
		case "grep":
			return `${str(args.pattern)}${args.path ? `  in ${str(args.path)}` : ""}`;
		case "ls":
			return str(args.path) || ".";
		case "read":
		case "write":
		case "edit":
			return str(args.path);
		default:
			return clip(JSON.stringify(args), 90);
	}
}
