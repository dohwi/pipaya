import { describe, expect, test } from "bun:test";
import type { StoredMessage } from "../src/lib/api";
import { cleanPreviewText, extractPreviewSnippet } from "../src/lib/mention-preview";

const msg = (role: string, content: unknown, seq = 1): StoredMessage =>
	({ seq, role, createdAt: 1000, message: { role, content, timestamp: 1000 } }) as StoredMessage;

describe("mention-preview", () => {
	test("cleanPreviewText strips hints, peer headers, markdown formatting, and truncates long text", () => {
		const raw = "[from @민석, another session on this server; reply with peer]\n### 진행 요약\n`src/a.ts`에서 [링크](https://example.com) 수정 완료<pipaya-hint>hidden</pipaya-hint>";
		expect(cleanPreviewText(raw)).toBe("진행 요약 src/a.ts에서 링크 수정 완료");

		const long = "가".repeat(200);
		const cleaned = cleanPreviewText(long);
		expect(cleaned.length).toBeLessThanOrEqual(160);
		expect(cleaned.endsWith("…")).toBe(true);
	});

	test("extractPreviewSnippet returns the latest non-empty assistant or user text", () => {
		const msgs = [
			msg("user", [{ type: "text", text: "첫 질문" }], 1),
			msg("assistant", [{ type: "text", text: "최종 답변 요약입니다." }], 2),
			msg("toolResult", [{ type: "text", text: "ignore tool output" }], 3),
			msg("assistant", [{ type: "toolCall", id: "1", name: "read", arguments: {} }], 4),
		];
		expect(extractPreviewSnippet(msgs)).toBe("최종 답변 요약입니다.");
		expect(extractPreviewSnippet([])).toBe("");
	});
});
