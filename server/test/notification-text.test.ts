import { describe, expect, test } from "bun:test";
import { duration, questionText, lang, preview, runText, testText } from "../src/notification-text.ts";

describe("preview", () => {
  test("keeps a short answer whole", () => expect(preview("테스트 3개를 추가했습니다.")).toBe("테스트 3개를 추가했습니다."));
  test("drops markdown but keeps the words", () => {
    expect(preview("## 결과\n- **로그인** 버그를 `fix` 했습니다\n- [문서](http://x) 확인")).toBe("결과 - 로그인 버그를 fix 했습니다 - 문서 확인".replace(/ - /g, " "));
  });
  test("a code block is not a summary", () => expect(preview("고쳤습니다.\n```ts\nconst a = 1;\n```\n끝")).toBe("고쳤습니다. 끝"));
  test("cuts a long answer at a word and says so", () => {
    const p = preview("alpha beta gamma delta ".repeat(20), 50);
    expect(p.length).toBeLessThanOrEqual(51); expect(p.endsWith("…")).toBe(true); expect(p).not.toMatch(/\s…$/);
  });
  test("cuts text with no spaces at the limit", () => expect(preview("가".repeat(300), 100)).toBe("가".repeat(100) + "…"));
});

describe("run notification", () => {
  test("finished: title says what and which chat, body previews the answer", () => {
    const t = runText({ title: "로그인 버그", status: "ok", answer: "원인은 토큰 만료였고, 갱신 로직을 고쳤습니다.", durationMs: 5000 }, "ko");
    expect(t.title).toBe("✅ 작업 완료 · 로그인 버그");
    expect(t.body).toBe("원인은 토큰 만료였고, 갱신 로직을 고쳤습니다.");
  });
  test("a long run mentions how long it took", () => {
    expect(runText({ title: "x", status: "ok", answer: "done", durationMs: 134_000 }, "ko").body).toBe("done · 2분 14초 걸림");
    expect(runText({ title: "x", status: "ok", answer: "done", durationMs: 134_000 }, "en").body).toBe("done · took 2m 14s");
  });
  test("failed: the reason is the body", () => {
    const t = runText({ title: "배포", status: "error", error: "401 Unauthorized" }, "en");
    expect(t.title).toBe("⚠️ Failed · 배포"); expect(t.body).toBe("401 Unauthorized");
  });
  test("failed with no reason still says something", () => expect(runText({ title: "x", status: "error" }, "ko").body).toContain("오류"));
  test("finished with no answer text still says something", () => expect(runText({ title: "x", status: "ok" }, "en").body).toBe("The task has finished"));
  test("a chat nobody named is left out of the title", () => {
    expect(runText({ title: "New chat", status: "ok" }, "en").title).toBe("✅ Done");
    expect(runText({ title: "새 대화", status: "ok" }, "ko").title).toBe("✅ 작업 완료");
  });
  test("one language per notification: no Korean words in an English one, no English labels in a Korean one", () => {
    expect(runText({ title: "x", status: "ok", answer: "ok" }, "en").title).not.toMatch(/[가-힣]/);
    expect(runText({ title: "x", status: "ok", answer: "ok" }, "ko").title).not.toMatch(/Done|Failed/);
  });
});

describe("question notification", () => {
  test("names the chat and previews the question", () => {
    const t = questionText({ title: "정리", question: "어느 브랜치에 병합할까요?" }, "ko");
    expect(t.title).toBe("❓ 답변 필요 · 정리"); expect(t.body).toBe("어느 브랜치에 병합할까요?");
  });
  test("an empty question still says what is waiting", () => { expect(questionText({ title: "", question: " " }, "en")).toEqual({ title: "❓ Answer needed", body: "Waiting for your answer" }); });
});

test("language: Korean tags and nothing else", () => {
  expect(lang("ko")).toBe("ko"); expect(lang("ko-KR")).toBe("ko"); expect(lang("en-US")).toBe("en"); expect(lang("ja")).toBe("en"); expect(lang(undefined)).toBe("en");
});
test("duration", () => { expect(duration(9000, "ko")).toBe("9초"); expect(duration(60_000, "en")).toBe("1m"); });
test("test notification speaks the device's language", () => { expect(testText("ko").title).toContain("시험"); expect(testText("en").title).toContain("Test"); });
