import { msg, t } from "./i18n";

/** The settings window's sections. `server: true` ones belong to the chosen server and sit between the app-wide ones. */
export const SETTINGS_TABS = [
	{ id: "general", label: msg("일반"), icon: "settings", sub: msg("언어 · 테마 · 알림 · 터미널"), server: false },
	{ id: "keys", label: msg("단축키"), icon: "keyboard", sub: msg("키 지정과 초기화"), server: false },
	{ id: "info", label: msg("정보"), icon: "server", sub: "", server: true },
	{ id: "agent", label: msg("에이전트"), icon: "key", sub: msg("모델 연결 · 에이전트 도구"), server: true },
	{ id: "sessions", label: msg("대화"), icon: "chat", sub: msg("기본 폴더 · 자동 삭제"), server: true },
	{ id: "srvext", label: msg("서버 확장"), icon: "bolt", sub: "", server: true },
	{ id: "devices", label: msg("기기"), icon: "phone", sub: "", server: true },
	{ id: "extensions", label: msg("클라이언트 확장"), icon: "bolt", sub: "", server: false },
	{ id: "backup", label: msg("백업"), icon: "download", sub: msg("설정 내보내기 · 가져오기"), server: false },
] as const;
export type SettingsTabId = (typeof SETTINGS_TABS)[number]["id"];

/** A server's own sections need the server to answer; only "정보" (address, token) stays open while it is offline. */
export const needsOnlineServer = (id: string) => SETTINGS_TABS.some((x) => x.id === id && x.server) && id !== "info";

/** Settings that are not a tab of their own; `words` are what a person may type to find them (any language). */
export const SETTINGS_ITEMS: { tab: SettingsTabId; label: string; words: string }[] = [
	{ tab: "general", label: msg("언어"), words: "language 한국어 english" },
	{ tab: "general", label: msg("테마"), words: "theme dark light 다크 라이트 어둡게 밝게" },
	{ tab: "agent", label: msg("모델 연결"), words: "model provider key api 모델 연결 키 프로바이더" },
	{ tab: "agent", label: msg("이미지 모델"), words: "image model picture draw generate 이미지 모델 그림 생성" },
	{ tab: "agent", label: msg("에이전트 도구"), words: "tools agent permission 도구 에이전트" },
	{ tab: "sessions", label: msg("기본 폴더"), words: "folder workdir directory cwd default 기본 폴더 작업 디렉터리" },
	{ tab: "sessions", label: msg("자동 삭제"), words: "retention delete cleanup old auto 보관 자동 삭제 정리 오래된" },
	{ tab: "general", label: msg("화면 배율"), words: "zoom scale size 배율 확대 축소 크기" },
	{ tab: "general", label: msg("알림음"), words: "sound volume notification 소리 볼륨 크기 알림" },
	{ tab: "general", label: msg("터미널"), words: "terminal font size 글꼴 폰트 글자 크기 maple mono" },
	{ tab: "general", label: msg("앱 단축키 우선"), words: "terminal shortcut priority keybinding 터미널 단축키 우선 먹히지" },
	{ tab: "general", label: msg("업데이트"), words: "update version 버전" },
];

const norm = (s: string) => s.toLowerCase();
/** The words of a query: split on whitespace, case-insensitive. Empty = no search. */
export const queryWords = (query: string) => norm(query).split(/\s+/).filter(Boolean);
/** Every word of the query appears somewhere in `text`. */
export const matches = (words: readonly string[], text: string) => words.every((w) => norm(text).includes(w));

export interface Hit {
	key: string;
	title: string;
	where: string;
	combo?: string;
	target: { tab: SettingsTabId; keyFilter?: string };
}

export interface ShortcutEntry {
	id: string;
	label: string;
	hint?: string;
	combo: string;
	/** The combo as the person reads it ("Ctrl+B") */
	shown: string;
}

/** One list for the search box: sections, loose settings and shortcuts that match. */
export function searchSettings(words: readonly string[], opts: { hasServer: boolean; serverOnline?: boolean; shortcuts: readonly ShortcutEntry[] }): Hit[] {
	if (!words.length) return [];
	const out: Hit[] = [];
	const tabName = (id: SettingsTabId) => t(SETTINGS_TABS.find((x) => x.id === id)!.label);
	for (const x of SETTINGS_TABS) {
		if (x.server && !opts.hasServer) continue;
		if (opts.serverOnline === false && needsOnlineServer(x.id)) continue;
		if (matches(words, `${t(x.label)} ${x.label} ${x.sub ? t(x.sub) : ""}`)) out.push({ key: `tab:${x.id}`, title: t(x.label), where: x.sub ? t(x.sub) : t("설정"), target: { tab: x.id } });
	}
	for (const x of SETTINGS_ITEMS) {
		if (opts.serverOnline === false && needsOnlineServer(x.tab)) continue;
		if (matches(words, `${t(x.label)} ${x.label} ${x.words}`)) out.push({ key: `item:${x.label}`, title: t(x.label), where: tabName(x.tab), target: { tab: x.tab } });
	}
	for (const a of opts.shortcuts) {
		if (matches(words, `${t(a.label)} ${a.label} ${a.hint ? t(a.hint) : ""} ${a.combo} ${a.shown}`))
			out.push({ key: `key:${a.id}`, title: t(a.label), where: tabName("keys"), combo: a.shown, target: { tab: "keys", keyFilter: t(a.label) } });
	}
	return out;
}

/** What each agent tool lets the agent do. A name without an entry (a tool added by an extension) shows as it is. */
export function toolLabel(name: string): string {
	switch (name) {
		case "read": return t("파일 읽기 (read)");
		case "write": return t("파일 만들기 · 덮어쓰기 (write)");
		case "edit": return t("파일 일부 수정 (edit)");
		case "ls": return t("폴더 목록 (ls)");
		case "grep": return t("내용 검색 (grep)");
		case "bash": return t("셸 명령 실행 (bash)");
		case "ask_user": return t("사용자에게 질문하고 답을 기다림 (ask_user)");
		case "peer_send": return t("다른 대화에 메시지 보내기 (peer_send)");
		case "peer_read": return t("다른 대화의 최근 내용 읽기 (peer_read)");
		case "generate_image": return t("이미지 생성 (generate_image)");
		default: return name;
	}
}
