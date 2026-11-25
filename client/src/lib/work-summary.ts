import { t } from "./i18n";
import type { IconName } from "./icons";
import { toolKind } from "./tools";
import type { Step } from "./types";

/** What a tool call counts as in the one-line summary of a work box ("명령 3개 실행 및 파일 2개 읽음"). */
export type WorkKind = "bash" | "read" | "edit" | "search" | "web" | "delegate" | "skill" | "image" | "other";

export function workKind(name: string, args: Record<string, unknown> = {}): WorkKind {
	switch (toolKind(name, args)) {
		case "bash":
			return "bash";
		case "read":
			return "read";
		case "write":
		case "edit":
			return "edit";
		case "grep":
		case "glob":
		case "ls":
			return "search";
		case "skill":
			return "skill";
		case "image":
			return "image";
	}
	if (name === "delegate") return "delegate";
	// web tools come from MCP servers and extensions under many names (web_search, mcp_search_web_fetch, browse …)
	if (/search|fetch|web|browse/i.test(name)) return "web";
	return "other";
}

const ICON: Record<WorkKind, IconName> = {
	bash: "terminal",
	read: "file",
	edit: "pencil",
	search: "search",
	web: "globe",
	delegate: "bot",
	skill: "skill",
	image: "sparkles",
	other: "bolt",
};

/** The icon in front of a work box's summary: the kind it names first (see `workSummary`), or a brain for thoughts only. */
export function workIcon(steps: readonly Step[]): IconName {
	let other = false;
	for (const s of steps) {
		if (s.kind !== "tool") continue;
		const k = workKind(s.name, s.args);
		if (k !== "other") return ICON[k];
		other = true;
	}
	return other ? ICON.other : "brain";
}

const phrase = (kind: Exclude<WorkKind, "other">, n: number): string => {
	switch (kind) {
		case "bash":
			return t("명령 {n}개 실행", { n });
		case "read":
			return t("파일 {n}개 읽음", { n });
		case "edit":
			return t("파일 {n}개 수정", { n });
		case "search":
			return t("검색 {n}회", { n });
		case "web":
			return t("웹 {n}회 검색", { n });
		case "delegate":
			return t("위임 {n}회", { n });
		case "skill":
			return t("스킬 {n}개 불러옴", { n });
		case "image":
			return t("이미지 {n}개 생성", { n });
	}
};

/** At most this many phrases; past it the later kinds are counted together as "other tools". */
export const MAX_PARTS = 3;

/** "A", "A 및 B", "A, B 및 C" (English: "A and B", "A, B and C"). */
export function joinAnd(words: readonly string[]): string {
	if (words.length < 2) return words[0] ?? "";
	return t("{a} 및 {b}", { a: words.slice(0, -1).join(", "), b: words.at(-1)! });
}

/**
 * The quiet line a work box shows: what its tool calls did, kind by kind, in the order each kind first appeared
 * ("명령 4개 실행 및 웹 1회 검색"). Tools of no known kind come last. A box with thoughts only is "생각 과정".
 */
export function workSummary(steps: readonly Step[]): string {
	const counts = new Map<WorkKind, number>();
	for (const s of steps) {
		if (s.kind !== "tool") continue;
		const k = workKind(s.name, s.args);
		counts.set(k, (counts.get(k) ?? 0) + 1);
	}
	if (!counts.size) return t("생각 과정");
	let rest = counts.get("other") ?? 0;
	counts.delete("other");
	let known = [...counts] as [Exclude<WorkKind, "other">, number][];
	const lumped = known.length + (rest ? 1 : 0) > MAX_PARTS;
	if (lumped) {
		const keep = known.slice(0, MAX_PARTS - 1);
		const dropped = known.slice(MAX_PARTS - 1);
		const skillIdx = dropped.findIndex(([k]) => k === "skill");
		if (skillIdx >= 0 && keep.length) {
			const [displaced] = keep.splice(keep.length - 1, 1, dropped[skillIdx]!);
			dropped.splice(skillIdx, 1, displaced!);
		}
		for (const [, n] of dropped) rest += n;
		known = keep;
	}
	const words = known.map(([k, n]) => phrase(k, n));
	if (rest) words.push(lumped ? t("그 밖의 도구 {n}개 사용", { n: rest }) : t("도구 {n}개 사용", { n: rest }));
	const line = joinAnd(words);
	return line.charAt(0).toUpperCase() + line.slice(1); // English phrases start lower-case so they can be joined
}
