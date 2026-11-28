import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse } from "svelte/compiler";
import type { StoredMessage } from "../src/lib/api";
import { cleanPreviewText, extractPreviewSnippet } from "../src/lib/mention-preview";

const msg = (role: string, content: unknown, seq = 1): StoredMessage =>
	({ seq, role, createdAt: 1000, message: { role, content, timestamp: 1000 } }) as StoredMessage;

function walkSvelte(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...walkSvelte(p));
		else if (entry.name.endsWith(".svelte")) out.push(p);
	}
	return out;
}

type AstNode = { type?: string; name?: string; start?: number; end?: number; attributes?: AstNode[]; [k: string]: unknown };

function walkAst(node: unknown, visit: (n: AstNode) => void) {
	if (!node || typeof node !== "object") return;
	if (Array.isArray(node)) {
		for (const item of node) walkAst(item, visit);
		return;
	}
	const obj = node as AstNode;
	visit(obj);
	for (const val of Object.values(obj)) walkAst(val, visit);
}

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

	test("mention hover triggers omit native title to avoid overlapping MentionHoverCard and keep aria-label", () => {
		const root = resolve(import.meta.dir, "../src/components");
		const hits: { file: string; attrs: string[] }[] = [];
		for (const file of walkSvelte(root)) {
			const src = readFileSync(file, "utf8");
			if (!src.includes("showMentionHover(")) continue;
			const ast = parse(src, { modern: true });
			walkAst(ast.fragment, (node) => {
				if (node.type !== "RegularElement" || !Array.isArray(node.attributes)) return;
				const hasTrigger = node.attributes.some(
					(attr) =>
						typeof attr.start === "number" &&
						typeof attr.end === "number" &&
						src.slice(attr.start, attr.end).includes("showMentionHover("),
				);
				if (!hasTrigger) return;
				const attrs = node.attributes
					.filter((a) => a.type === "Attribute" && typeof a.name === "string")
					.map((a) => a.name as string);
				hits.push({ file, attrs });
			});
		}
		expect(hits).toHaveLength(5);
		for (const hit of hits) {
			expect(hit.attrs, hit.file).not.toContain("title");
			expect(hit.attrs, hit.file).toContain("aria-label");
		}
	});
});
