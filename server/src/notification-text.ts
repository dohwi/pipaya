/**
 * The wording of the server's own notifications (a run ended, a tool needs approval).
 *
 * It is written here, in the language of the device that receives it, because a push that arrives while the app is
 * closed never passes through the app: whatever the server writes is what the person reads.
 * Layout: the title says WHAT happened and in WHICH chat; the body is a preview of the result, so the notification
 * can be judged without opening the app.
 */
export type Lang = "ko" | "en";

export const lang = (tag: string | undefined | null): Lang => (tag ?? "").toLowerCase().startsWith("ko") ? "ko" : "en";

const WORDS = {
  ko: {
    done: "작업 완료", failed: "작업 실패", approval: "승인 필요",
    noAnswer: "작업이 끝났습니다", noReason: "원인을 알 수 없는 오류로 멈췄습니다",
    wants: (tool: string) => `${tool} 실행 승인을 기다리고 있습니다`,
    took: (s: string) => `${s} 걸림`, test: "시험 알림", testBody: "이 알림이 보이면 알림이 정상입니다",
  },
  en: {
    done: "Done", failed: "Failed", approval: "Approval needed",
    noAnswer: "The task has finished", noReason: "Stopped by an unknown error",
    wants: (tool: string) => `Waiting for your approval to run ${tool}`,
    took: (s: string) => `took ${s}`, test: "Test notification", testBody: "If you can read this, notifications work",
  },
} as const;

/** One line, no markdown, no more than `max` characters, cut at a word edge where there is one. */
export function preview(text: string, max = 110): string {
  const plain = text
    .replace(/```[\s\S]*?```/g, " ")           // code blocks are not a summary
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")  // links and images keep their label
    .replace(/^\s{0,3}(#{1,6}|[-*+]|\d+[.)]|>)\s+/gm, "")
    .replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, "$1")
    .replace(/\s+/g, " ").trim();
  if (plain.length <= max) return plain;
  const cut = plain.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export function duration(ms: number, l: Lang): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return l === "ko" ? `${s}초` : `${s}s`;
  const m = Math.floor(s / 60), r = s % 60;
  return l === "ko" ? `${m}분${r ? ` ${r}초` : ""}` : `${m}m${r ? ` ${r}s` : ""}`;
}

export interface RunFacts { title: string; status: "ok" | "error"; answer?: string; error?: string | null; durationMs?: number }
export interface Text { title: string; body?: string }

/** Titles that were never set show up as the default; say nothing rather than "New chat". */
const isDefaultTitle = (t: string) => !t.trim() || /^(new (chat|session)|새 (대화|채팅|세션)|untitled)$/i.test(t.trim());

const head = (icon: string, label: string, chat: string) => `${icon} ${isDefaultTitle(chat) ? label : `${label} · ${preview(chat, 40)}`}`;

export function runText(f: RunFacts, l: Lang): Text {
  const w = WORDS[l];
  if (f.status === "error") {
    return { title: head("⚠️", w.failed, f.title), body: preview(f.error || w.noReason, 140) };
  }
  const lead = f.answer ? preview(f.answer) : w.noAnswer;
  const took = f.durationMs && f.durationMs >= 20_000 ? ` · ${w.took(duration(f.durationMs, l))}` : "";
  return { title: head("✅", w.done, f.title), body: `${lead}${took}` };
}

export function approvalText(f: { title: string; tool: string; args: unknown }, l: Lang): Text {
  const w = WORDS[l];
  const detail = approvalDetail(f.args);
  return { title: head("🔐", w.approval, f.title), body: detail ? `${w.wants(f.tool)}: ${detail}` : w.wants(f.tool) };
}

/** What the tool is about to touch. Commands and paths only: file contents and other arguments stay out of a notification. */
export function approvalDetail(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;
  const pick = ["command", "cmd", "path", "file", "file_path", "url"].find((k) => typeof a[k] === "string" && (a[k] as string).trim());
  return pick ? preview(String(a[pick]), 80) : "";
}

export const testText = (l: Lang): Text => ({ title: `🔔 ${WORDS[l].test}`, body: WORDS[l].testBody });
