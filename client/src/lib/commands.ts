import { app } from "./store.svelte";
import { extensions } from "./extensions/host.svelte";
import { copyText } from "./clipboard";
import { clip } from "./format";
import type { AssistantItem, Session, UserItem } from "./types";
import { localeTag, msg, t } from "./i18n";

export interface CommandArgument {
	value: string;
	desc: string;
	current?: boolean;
}

export interface SlashCommand {
	name: string;
	/** Argument hint shown in the menu, e.g. "<title>". */
	args?: string;
	desc: string;
	/** Needs an open conversation. */
	needsChat?: boolean;
	/** Finite argument choices, evaluated against the current model/settings. */
	argumentOptions?: () => CommandArgument[];
	argumentEmpty?: string;
	run(arg: string): void | Promise<void>;
}

export const COMMAND_PREFIX = "/";
export const commandText = (cmd: SlashCommand) => `${COMMAND_PREFIX}${cmd.name}`;

/** Only the explicit command prefix is reserved; paths and ordinary messages remain text. */
export const isCommandInput = (text: string) => /^\/[^\s/.]+(?:\s|$)/.test(text.trimStart()) && !isSkillCall(text) && !isTemplateCall(text);
/** `/template:name args` is not a client command either: the server expands the saved prompt. */
export const TEMPLATE_PREFIX = "template:";
export const isTemplateCall = (text: string) => text.trimStart().startsWith(`${COMMAND_PREFIX}${TEMPLATE_PREFIX}`);
/** `/skill:name` is not a client command: the server turns it into a manual skill call. */
export const SKILL_PREFIX = "skill:";
export const isSkillCall = (text: string) => text.trimStart().startsWith(`${COMMAND_PREFIX}${SKILL_PREFIX}`);
export const commandQuery = (text: string): string | null => /^\/([a-z][a-z0-9:-]*|)$/i.exec(text)?.[1] ?? null;

const dirLabel = (cwd: string) => {
	const r = app.relPath(cwd);
	return r === "." ? t("워크스페이스 루트") : r;
};

function when(ts: number): string {
	const d = new Date(ts);
	const today = new Date();
	const same = d.toDateString() === today.toDateString();
	return same
		? d.toLocaleTimeString(localeTag(), { hour: "2-digit", minute: "2-digit" })
		: d.toLocaleDateString(localeTag(), { month: "numeric", day: "numeric" });
}

/** Sessions as palette rows: title + "작업 디렉터리 · 시각". */
function sessionRows(list: Session[], opts: { current?: string; showClosed?: boolean } = {}) {
	return list.map((s) => ({
		id: s.id,
		title: s.title,
		sub: `${dirLabel(s.cwd)} · ${when(s.updatedAt)}`,
		tag: opts.showClosed && s.closed ? t("닫힘") : undefined,
		current: s.id === opts.current,
		dim: s.closed,
	}));
}

export async function resume() {
	const list = await app.listClosed();
	app.palette = {
		title: t("닫은 대화 다시 열기"),
		empty: msg("닫은 대화가 없습니다"),
		items: sessionRows(list),
		onpick: (it) => void app.resume(it.id),
		ondelete: async (it) => {
			const ok = await app.remove(it.id);
			if (ok) {
				app.toast(t("대화를 영구 삭제했습니다"));
				if (app.palette) {
					app.palette = {
						...app.palette,
						items: app.palette.items.filter((x) => x.id !== it.id),
					};
				}
			}
		},
	};
}

/** Parent/child forks as an indented tree, across active and closed sessions. */
async function tree() {
	const all = await app.listAll();
	const byId = new Map(all.map((s) => [s.id, s]));
	const kids = new Map<string, Session[]>();
	const roots: Session[] = [];
	for (const s of all) {
		if (s.parentId && byId.has(s.parentId)) {
			if (!kids.has(s.parentId)) kids.set(s.parentId, []);
			kids.get(s.parentId)!.push(s);
		} else roots.push(s);
	}
	// Show only the family of the open chat when there is one, otherwise everything grouped by working directory.
	const familyRoot = (() => {
		let cur = app.current;
		while (cur?.parentId && byId.has(cur.parentId)) cur = byId.get(cur.parentId);
		return cur;
	})();
	const out: ReturnType<typeof sessionRows> = [];
	const walk = (s: Session, depth: number) => {
		out.push({ ...sessionRows([s], { current: app.activeId ?? undefined, showClosed: true })[0]!, depth } as never);
		for (const c of (kids.get(s.id) ?? []).sort((a, b) => a.createdAt - b.createdAt)) walk(c, depth + 1);
	};
	for (const r of familyRoot ? [familyRoot] : roots) walk(r, 0);
	app.palette = {
		title: familyRoot ? t("이 대화의 분기 트리") : t("대화 트리 (분기 관계)"),
		empty: msg("대화가 없습니다"),
		items: out as never,
		onpick: (it) => void app.openAny(it.id),
	};
}

/** Fork from a chosen message of the open chat (default: everything so far). */
async function fork(arg: string) {
	const chat = app.chat;
	const s = app.current;
	if (!chat || !s) return void app.toast(t("분기할 대화가 없습니다. 먼저 대화를 시작하세요"), "error", app.activeId);
	type Msg = UserItem | AssistantItem;
	const done = (i: Msg) => i.kind === "user" || i.stopReason === "stop" || i.stopReason === "length";
	// Only finished turns are valid branch points (a cut inside a tool call would leave it without a result).
	const msgs = chat.items.filter((i): i is Msg => (i.kind === "user" || (i.kind === "assistant" && !i.streaming)) && i.seq !== null && done(i));
	if (!msgs.length) return void app.toast(t("아직 분기할 메시지가 없습니다"), "error", s.id);
	if (arg.trim() === "last") {
		const last = [...msgs].reverse().find((i) => i.kind === "assistant");
		return void (last ? app.fork(s.id, last.seq!) : app.fork(s.id));
	}
	const textOf = (i: Msg): string =>
		i.kind === "user" ? i.text : i.blocks.flatMap((b) => (b.type === "text" ? [b.text] : [])).join(" ") || t("(도구 호출)");
	const rows = msgs
		.map((i, n) => ({
			id: String(i.seq),
			title: clip(textOf(i).replace(/\s+/g, " "), 80),
			sub: `${i.kind === "user" ? t("나") : t("에이전트")} · #${n + 1}`,
		}))
		.reverse();
	app.palette = {
		title: t("어느 메시지까지 복사해 분기할까요?"),
		empty: msg("분기할 메시지가 없습니다"),
		items: rows,
		onpick: (it) => void app.fork(s.id, Number(it.id)),
	};
}

function pickList<T extends string>(title: string, items: { id: T; title: string; sub?: string; current?: boolean }[], apply: (id: T) => void) {
	app.palette = { title, empty: msg("선택할 항목이 없습니다"), items, onpick: (it) => apply(it.id as T) };
}

const DEFINITIONS: SlashCommand[] = [
	{ name: "resume", desc: msg("닫은 대화 다시 열기"), run: () => resume() },
	{ name: "tree", desc: msg("대화 분기 트리"), run: () => tree() },
	{ name: "fork", args: "[last]", desc: msg("대화 분기"), needsChat: true, run: (a) => fork(a) },
	{
		name: "close",
		desc: msg("대화 닫기 · 기록 유지"),
		needsChat: true,
		run: () => void app.closeActive(),
	},
	{
		name: "new",
		desc: msg("새 대화 시작"),
		run: () => app.newChatInPane(),
	},
	{
		name: "cd",
		args: "[path]",
		desc: msg("작업 디렉터리 변경"),
		run: (a) => {
			if (a.trim()) return void app.changeWorkdir(a);
			if (app.workdirInfo) return void (app.dirPicker = true);
			const dirs = app.workspace?.workdirs ?? [];
			const seen = new Set<string>();
			const items = [{ id: ".", title: t("서버 기본 디렉터리"), sub: app.workspace?.root, current: app.workdir === "." }];
			seen.add(".");
			for (const w of dirs) {
				if (seen.has(w.path)) continue;
				seen.add(w.path);
				items.push({ id: w.path, title: w.path, sub: t("활성 {active} · 닫힘 {closed}", { active: w.active, closed: w.closed }), current: w.path === app.workdir });
			}
			pickList(t("작업 디렉터리"), items, (id) => void app.changeWorkdir(id));
		},
	},
	{
		name: "rename",
		args: "<title>",
		desc: msg("대화 이름 바꾸기"),
		needsChat: true,
		run: (a) => {
			if (!a.trim()) return void app.toast(t("새 제목을 입력하세요. 예: /rename 로그인 버그"), "error", app.activeId);
			if (app.activeId) void app.rename(app.activeId, a);
		},
	},
	{
		name: "compact",
		args: "[instructions]",
		desc: msg("컨텍스트 압축 · 요약 호출 비용 발생"),
		needsChat: true,
		run: async (a) => { await app.compact(a); },
	},
	{ name: "retry", desc: msg("응답 재시도"), needsChat: true, run: () => void app.retry() },
	{ name: "stop", desc: msg("진행 중인 작업 중지"), needsChat: true, run: () => void app.abort() },
	{ name: "cancel", desc: msg("대기열 / 끼워 넣기 취소"), needsChat: true, run: () => app.openQueue() },
	{
		name: "copy",
		desc: msg("마지막 답변 복사"),
		needsChat: true,
		run: async () => {
			const last = app.chat?.lastAssistant;
			const text = last?.blocks
				.filter((b): b is { type: "text"; text: string } => b.type === "text")
				.map((b) => b.text)
				.join("\n\n");
			if (!text) return void app.toast(t("복사할 답변이 없습니다"), "error", app.activeId);
			app.toast((await copyText(text)) ? t("마지막 답변을 복사했습니다") : t("복사하지 못했습니다"), "ok", app.activeId);
		},
	},
	{
		name: "delete",
		desc: msg("대화 영구 삭제 · 복구 불가"),
		needsChat: true,
		run: () => {
			const s = app.current;
			if (!s) return;
			pickList(t("정말 삭제할까요? 복구할 수 없습니다"), [{ id: "yes", title: t("삭제: {title}", { title: s.title }), sub: dirLabel(s.cwd) }, { id: "no", title: t("취소") }], (id) => {
				if (id === "yes") void app.remove(s.id).then((ok) => ok && app.toast(t("대화를 삭제했습니다")));
			});
		},
	},
];

// Stable default order: conversations → settings → execution → history → utilities.
const DEFAULT_ORDER = ["new", "resume", "rename", "close", "cd", "compact", "retry", "stop", "cancel", "fork", "tree", "copy", "delete"];
export const COMMANDS: SlashCommand[] = DEFAULT_ORDER.map((name) => DEFINITIONS.find((c) => c.name === name)!);

/** Run a built-in command by name, as a shortcut would: with its "needs an open chat" rule applied. */
export function runCommand(name: string, arg = ""): void | Promise<void> {
	const cmd = COMMANDS.find((c) => c.name === name);
	if (!cmd) return;
	if (cmd.needsChat && !app.activeId) return void app.toast(t("열려 있는 대화가 없습니다"), "error");
	return cmd.run(arg);
}

/**
 * Commands that extensions inside the server handle (`pi.registerCommand`). Picking one sends `/name args` as the
 * message; the server runs it instead of the model. A name the app or a client extension already uses stays theirs.
 */
export function serverCommands(taken: Set<string>): SlashCommand[] {
	return (app.serverCommands ?? [])
		.filter((c) => /^[a-z][a-z0-9-]*$/.test(c.name) && !taken.has(c.name))
		.map((c) => ({
			name: c.name,
			args: "[args]",
			desc: c.description || c.extension,
			run: async (arg: string) => { await app.send(`${COMMAND_PREFIX}${c.name}${arg.trim() ? ` ${arg.trim()}` : ""}`); },
		}));
}

export function allCommands(): SlashCommand[] {
	const own = [...COMMANDS, ...extensions.commands];
	return [...own, ...serverCommands(new Set(own.map((c) => c.name)))];
}

/** Match canonical English names only: exact, prefix, then substring. */
export function matchCommands(query: string): SlashCommand[] {
	const q = query.trim().toLowerCase();
	const hasChat = !!app.activeId;
	const score = (c: SlashCommand): number => {
		if (!q) return 3;
		if (c.name === q) return 0;
		if (c.name.startsWith(q)) return 1;
		if (c.name.includes(q)) return 2;
		return 9;
	};
	return allCommands().filter((c) => score(c) < 9 && (!c.needsChat || hasChat))
		.map((c, i) => ({ c, i, s: score(c) }))
		.sort((a, b) => a.s - b.s || a.i - b.i)
		.map((x) => x.c);
}

/** Argument recommendations appear only after a known finite-choice command and a space. */
export function argumentSuggestions(text: string): { cmd: SlashCommand; options: CommandArgument[]; empty: string } | null {
	if (!/^\/[a-z][a-z0-9-]*[ \t]+[^\r\n]*$/i.test(text)) return null;
	const parsed = parseSlash(text);
	if (!parsed?.cmd.argumentOptions) return null;
	const all = parsed.cmd.argumentOptions();
	const query = parsed.arg.trim().toLowerCase();
	return {
		cmd: parsed.cmd,
		options: all.filter((option) => option.value.toLowerCase().startsWith(query)),
		empty: all.length ? msg("일치하는 값이 없습니다") : (parsed.cmd.argumentEmpty ?? msg("선택할 값이 없습니다")),
	};
}

/** Skills as menu rows for a query like "ski", "skill:" or "skill:rel"; they come after the commands and never run on pick. */
export function matchSkills<T extends { name: string }>(skills: T[], query: string): T[] {
	const q = query.trim().toLowerCase();
	const full = (k: T) => `${SKILL_PREFIX}${k.name}`;
	const score = (k: T): number => (!q ? 3 : full(k).startsWith(q) ? 1 : k.name.includes(q.replace(/^skill:?/, "")) || full(k).includes(q) ? 2 : 9);
	return skills.map((k, i) => ({ k, i, s: score(k) })).filter((x) => x.s < 9).sort((a, b) => a.s - b.s || a.i - b.i).map((x) => x.k);
}

/** Templates as menu rows for a query like "tem", "template:" or "template:rev". */
export function matchTemplates<T extends { name: string }>(templates: T[], query: string): T[] {
	const q = query.trim().toLowerCase();
	const full = (k: T) => `${TEMPLATE_PREFIX}${k.name}`;
	const score = (k: T): number => (!q ? 3 : full(k).startsWith(q) ? 1 : k.name.includes(q.replace(/^template:?/, "")) || full(k).includes(q) ? 2 : 9);
	return templates.map((k, i) => ({ k, i, s: score(k) })).filter((x) => x.s < 9).sort((a, b) => a.s - b.s || a.i - b.i).map((x) => x.k);
}

/** Parse "/name rest" -> command + argument. No translated or alternate command names. */
export function parseSlash(text: string): { cmd: SlashCommand; arg: string } | null {
	const m = /^\/([a-z][a-z0-9-]*)(?:\s+([\s\S]*))?$/i.exec(text.trim());
	if (!m) return null;
	const name = m[1]!.toLowerCase();
	const cmd = allCommands().find((c) => c.name === name);
	return cmd ? { cmd, arg: m[2] ?? "" } : null;
}
