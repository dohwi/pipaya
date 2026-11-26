import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { buildMentionIndex } from "../src/lib/peers";
import { decorateMarkdownTokens, mentionSignature, splitMarkdownTokens } from "../src/lib/markdown-tokens";
import { patchHtml } from "../src/lib/patch-html";

const dom = new Window();
Object.assign(globalThis, { window: dom, document: dom.document });
const { renderMarkdown } = await import("../src/lib/markdown");

const labels = {
	openSession: (name: string) => `Open ${name} chat`,
	openGroup: (name: string) => `Open ${name} group`,
	openSkill: (name: string) => `View skill ${name}`,
	openPrompt: (name: string) => `View prompt ${name}`,
	openFile: (name: string) => `Preview ${name}`,
};

describe("splitMarkdownTokens", () => {
	const names = ["서아", "서아2", "민수", "bob", "front-team"];

	test("matches mentions after opening punctuation, whitespace, or delimiters while keeping surrounding text", () => {
		expect(splitMarkdownTokens("UI 전담 세션(@서아, claude-sonnet-5.5)이 작업 중", { names })).toEqual([
			{ text: "UI 전담 세션(" },
			{ text: "@서아", kind: "mention", name: "서아" },
			{ text: ", claude-sonnet-5.5)이 작업 중" },
		]);
		expect(splitMarkdownTokens('"@서아" [@민수] 「@서아2」 ·@bob', { names })).toEqual([
			{ text: '"' },
			{ text: "@서아", kind: "mention", name: "서아" },
			{ text: '" [' },
			{ text: "@민수", kind: "mention", name: "민수" },
			{ text: "] 「" },
			{ text: "@서아2", kind: "mention", name: "서아2" },
			{ text: "」 ·" },
			{ text: "@bob", kind: "mention", name: "bob" },
		]);
		expect(splitMarkdownTokens("@서아,@민수", { names })).toEqual([
			{ text: "@서아", kind: "mention", name: "서아" },
			{ text: "," },
			{ text: "@민수", kind: "mention", name: "민수" },
		]);
	});

	test("preserves original casing, takes longest name, and respects Korean particles and ASCII word boundaries", () => {
		expect(splitMarkdownTokens("@Bob @bobby @서아랑 @서아2랑", { names })).toEqual([
			{ text: "@Bob", kind: "mention", name: "bob" },
			{ text: " @bobby " },
			{ text: "@서아", kind: "mention", name: "서아" },
			{ text: "랑 " },
			{ text: "@서아2", kind: "mention", name: "서아2" },
			{ text: "랑" },
		]);
	});

	test("rejects email addresses, paths, double-at, and word-attached @", () => {
		for (const s of ["a@서아.com", "foo.bar@bob", "user_1@bob", "a-b@bob", "123@서아", "한글@서아", "@@서아", "https://x.com/@서아", "/@bob"]) {
			expect(splitMarkdownTokens(s, { names }), s).toEqual([{ text: s }]);
		}
	});

	test("matches /skill:name in prose and inside parentheses, adjacent to mentions, rejecting paths and invalid slugs", () => {
		expect(splitMarkdownTokens("요청받을 때만 (/skill:release)와 @서아(/skill:my-skill)를 따릅니다", { names, skills: true })).toEqual([
			{ text: "요청받을 때만 (" },
			{ text: "/skill:release", kind: "skill", name: "release" },
			{ text: ")와 " },
			{ text: "@서아", kind: "mention", name: "서아" },
			{ text: "(" },
			{ text: "/skill:my-skill", kind: "skill", name: "my-skill" },
			{ text: ")를 따릅니다" },
		]);
		expect(splitMarkdownTokens("foo/skill:release /a/skill:release /skill:UPPER /skill:a_b", { names, skills: true })).toEqual([
			{ text: "foo/skill:release /a/skill:release /skill:UPPER /skill:a_b" },
		]);
		expect(splitMarkdownTokens("/skill:release", { names, skills: false })).toEqual([{ text: "/skill:release" }]);
	});

	test("handles empty inputs", () => {
		expect(splitMarkdownTokens("", { names, skills: true })).toEqual([{ text: "" }]);
		expect(splitMarkdownTokens("@서아", { names: [], skills: false })).toEqual([{ text: "@서아" }]);
	});
});

describe("decorateMarkdownTokens + patchHtml", () => {
	const index = buildMentionIndex(
		[
			{ id: "s1", name: "서아", closed: false },
			{ id: "s2", name: "민수", closed: false },
			{ id: "s3", name: "닫힘", closed: true },
		],
		[{ id: "g1", name: "front team" }],
	);

	test("turns prose @session, @group and /skill:name into clickable buttons across paragraphs, bold, lists and tables", () => {
		const md = [
			"UI 전담 세션(@서아, `claude-sonnet-5.5`)과 **@front-team** 그룹이 `/skill:ignored` 대신 /skill:orchestrate로 작업합니다.",
			"",
			"- @민수에게 보고 (@닫힘은 닫힘)",
			"",
			"| 담당 | 비고 |",
			"| - | - |",
			"| @서아 | /skill:release |",
		].join("\n");
		const html = renderMarkdown(md, { cache: false });
		const host = dom.document.createElement("div");
		patchHtml(host, {
			html,
			decorate: (frag) => decorateMarkdownTokens(frag, { index, skills: true, labels }),
		});

		const mentions = [...host.querySelectorAll<HTMLButtonElement>("button.wd-mention")];
		expect(mentions.map((b) => [b.textContent, b.dataset.mentionKind, b.dataset.mentionId, b.title])).toEqual([
			["@서아", "session", "s1", "Open @서아 chat"],
			["@front-team", "group", "g1", "Open @front-team group"],
			["@민수", "session", "s2", "Open @민수 chat"],
			["@서아", "session", "s1", "Open @서아 chat"],
		]);

		const skills = [...host.querySelectorAll<HTMLButtonElement>("button.wd-skill")];
		expect(skills.map((b) => [b.textContent, b.dataset.skill, b.title])).toEqual([
			["/skill:orchestrate", "orchestrate", "View skill orchestrate"],
			["/skill:release", "release", "View skill release"],
		]);
		// Inline code `/skill:ignored` stays untouched inside <code>
		expect(host.querySelectorAll("code button")).toHaveLength(0);
	});

	test("converts sole known @session/@group inside inline code, while leaving non-sole/unknown inline code, code blocks, and links untouched", () => {
		const md = [
			"워커(`@서아`, `@FRONT-TEAM`)와 `/skill:release`, `@닫힘`, `@unknown`, `@@서아`, `@서아랑`, `@서아 extra`, `@`.",
			"",
			"```",
			"@서아",
			"// @서아 /skill:release",
			"```",
			"",
			"Link [@서아](https://example.com), [`@서아`](https://example.com) and file [@서아](out/report.md).",
		].join("\n");
		const html = renderMarkdown(md, { cache: false });
		const host = dom.document.createElement("div");
		patchHtml(host, {
			html,
			decorate: (frag) => decorateMarkdownTokens(frag, { index, skills: true, labels }),
		});
		const mentions = [...host.querySelectorAll<HTMLButtonElement>("button.wd-mention")];
		expect(mentions.map((b) => [b.textContent, b.dataset.mentionKind, b.dataset.mentionId, b.title])).toEqual([
			["@서아", "session", "s1", "Open @서아 chat"],
			["@FRONT-TEAM", "group", "g1", "Open @FRONT-TEAM group"],
		]);
		expect(host.querySelectorAll("button.wd-skill")).toHaveLength(0);
		expect(host.querySelectorAll("pre button")).toHaveLength(0);
		expect(
			[...host.querySelectorAll("code")].filter((c) => !c.closest("pre")).map((c) => c.textContent),
		).toEqual(["/skill:release", "@닫힘", "@unknown", "@@서아", "@서아랑", "@서아 extra", "@", "@서아"]);
		expect([...host.querySelectorAll("a[data-ext]")].map((a) => a.textContent)).toEqual(["@서아", "@서아"]);
		expect(host.querySelector("a[data-file]")?.textContent).toBe("@서아");
	});

	test("cannot inject HTML even if a group name contains HTML metacharacters", () => {
		const xssIndex = buildMentionIndex([], [{ id: "gx", name: 'a"onclick="alert(1)' }, { id: "g2", name: "R&D" }]);
		const html = renderMarkdown('Ping @a"onclick="alert(1) and @R&D', { cache: false });
		const host = dom.document.createElement("div");
		patchHtml(host, {
			html,
			decorate: (frag) => decorateMarkdownTokens(frag, { index: xssIndex, skills: false, labels }),
		});
		expect(host.querySelectorAll("script")).toHaveLength(0);
		const btns = [...host.querySelectorAll<HTMLButtonElement>("button.wd-mention")];
		expect(btns).toHaveLength(2);
		expect(btns[0]!.getAttribute("onclick")).toBeNull();
		expect(btns[0]!.dataset.mentionId).toBe("gx");
		expect(btns[1]!.textContent).toBe("@R&D");
		expect(btns[1]!.dataset.mentionId).toBe("g2");
	});

	test("strips spoofed data-mention-*, data-skill, data-prompt, and button data-file attributes from raw markdown HTML", () => {
		const html = renderMarkdown(
			'<button class="wd-mention" data-mention-id="s1" data-mention-kind="session" data-skill="release" data-prompt="daily" data-file="/etc/passwd">spoof</button>',
			{ cache: false },
		);
		const host = dom.document.createElement("div");
		patchHtml(host, {
			html,
			decorate: (frag) => decorateMarkdownTokens(frag, { index, skills: true, prompts: true, files: true, labels }),
		});
		expect(host.querySelectorAll("button[data-mention-id]")).toHaveLength(0);
		expect(host.querySelectorAll("button[data-skill]")).toHaveLength(0);
		expect(host.querySelectorAll("button[data-prompt]")).toHaveLength(0);
		expect(host.querySelectorAll("button[data-file]")).toHaveLength(0);
	});

	test("converts /prompt:name, #path:line, markdown file links with lines, and sole repo-relative file paths in inline code", () => {
		const md = [
			"(/prompt:daily-check)와 #client/src/lib/markdown.ts:42-50 그리고 [markdown.ts](client/src/lib/markdown.ts#L10-L20) 확인.",
			"",
			"수정한 파일은 `client/src/lib/files.ts:15`이며 `claude-sonnet-5.5`, `MessageList`, `console.log`, `feat/scroll`, `/etc/passwd`는 코드로 남습니다.",
			"",
			"```",
			"client/src/lib/files.ts:15",
			"```",
		].join("\n");
		const html = renderMarkdown(md, { cache: false });
		const host = dom.document.createElement("div");
		patchHtml(host, {
			html,
			decorate: (frag) => decorateMarkdownTokens(frag, { index, skills: true, prompts: true, files: true, labels }),
		});

		const prompts = [...host.querySelectorAll<HTMLButtonElement>("button.wd-prompt")];
		expect(prompts.map((b) => [b.textContent, b.dataset.prompt])).toEqual([["/prompt:daily-check", "daily-check"]]);

		const linkFiles = [...host.querySelectorAll<HTMLAnchorElement>("a.wd-file")];
		expect(linkFiles.map((a) => [a.dataset.file, a.dataset.line, a.dataset.endLine])).toEqual([["client/src/lib/markdown.ts", "10", "20"]]);

		const btnFiles = [...host.querySelectorAll<HTMLButtonElement>("button.wd-file")];
		expect(btnFiles.map((b) => [b.dataset.file, b.dataset.line, b.dataset.endLine])).toEqual([
			["client/src/lib/markdown.ts", "42", "50"],
			["client/src/lib/files.ts", "15", undefined],
		]);
		// Non-file inline code & fenced code blocks stay untouched
		const codes = [...host.querySelectorAll("p code")].map((c) => c.textContent);
		expect(codes).toEqual(["claude-sonnet-5.5", "MessageList", "console.log", "feat/scroll", "/etc/passwd"]);
		expect(host.querySelectorAll("pre button")).toHaveLength(0);
	});

	test("does not chip @name immediately following an inline element ending in a word character", () => {
		const html = renderMarkdown("**user**@서아 and **(**@서아**)**", { cache: false });
		const host = dom.document.createElement("div");
		patchHtml(host, {
			html,
			decorate: (frag) => decorateMarkdownTokens(frag, { index, skills: false, labels }),
		});
		const btns = [...host.querySelectorAll<HTMLButtonElement>("button.wd-mention")];
		expect(btns.map((b) => b.textContent)).toEqual(["@서아"]);
	});

	test("patchHtml updates decorated mentions incrementally without recreating unchanged paragraphs", () => {
		const host = dom.document.createElement("div");
		const p1 = renderMarkdown("첫 문단\n\n@서", { cache: false });
		const action = patchHtml(host, {
			html: p1,
			decorate: (frag) => decorateMarkdownTokens(frag, { index, skills: true, labels }),
		});
		const firstPara = host.querySelector("p")!;
		expect(host.querySelectorAll("button.wd-mention")).toHaveLength(0);

		const p2 = renderMarkdown("첫 문단\n\n@서아", { cache: false });
		action.update({
			html: p2,
			decorate: (frag) => decorateMarkdownTokens(frag, { index, skills: true, labels }),
		});
		expect(host.querySelector("p")).toBe(firstPara);
		expect(host.querySelector("button.wd-mention")?.textContent).toBe("@서아");
	});

	test("renders self-session @mentions as non-clickable self chips in both prose and inline code", () => {
		const html = renderMarkdown("현재 세션 @서아 (`@서아`)와 다른 세션 @민수 그리고 @front-team", { cache: false });
		const host = dom.document.createElement("div");
		const labelsWithSelf = { ...labels, selfSession: "현재 대화" };
		const action = patchHtml(host, {
			html,
			decorate: (frag) => decorateMarkdownTokens(frag, { index, selfId: "s1", skills: false, labels: labelsWithSelf }),
		});

		const selfChips = [...host.querySelectorAll<HTMLSpanElement>("span.wd-mention.wd-self")];
		expect(selfChips.map((s) => [s.textContent, s.dataset.mentionSelf, s.title])).toEqual([
			["@서아", "1", "현재 대화"],
			["@서아", "1", "현재 대화"],
		]);
		const clickable = [...host.querySelectorAll<HTMLButtonElement>("button.wd-mention")];
		expect(clickable.map((b) => [b.textContent, b.dataset.mentionKind, b.dataset.mentionId])).toEqual([
			["@민수", "session", "s2"],
			["@front-team", "group", "g1"],
		]);

		// Switching selfId updates the DOM cleanly via patchHtml
		action.update({
			html,
			decorate: (frag) => decorateMarkdownTokens(frag, { index, selfId: "s2", skills: false, labels: labelsWithSelf }),
		});
		expect([...host.querySelectorAll("span.wd-mention.wd-self")].map((s) => s.textContent)).toEqual(["@민수"]);
		expect([...host.querySelectorAll("button.wd-mention")].map((b) => b.textContent)).toEqual(["@서아", "@서아", "@front-team"]);
	});

	test("strips spoofed data-mention-self, closed, server, and activity attributes from raw HTML", () => {
		const html = renderMarkdown('<span data-mention-self="1" data-mention-closed="1" data-mention-server="x" data-activity="working" class="wd-mention wd-self">fake</span>', { cache: false });
		const host = dom.document.createElement("div");
		patchHtml(host, {
			html,
			decorate: (frag) => decorateMarkdownTokens(frag, { index, selfId: "s1", skills: false, labels }),
		});
		expect(host.querySelectorAll("[data-mention-self], [data-mention-closed], [data-mention-server], [data-activity]")).toHaveLength(0);
	});

	test("renders closed session and remote @server/session mentions with proper dataset and classes", () => {
		const extIndex = buildMentionIndex(
			[{ id: "s1", name: "서아", closed: false }],
			[],
			{
				closedSessions: [{ id: "c1", name: "소민", closed: true }],
				remotes: [{ serverId: "srv-desk", handle: "desktop", sessions: [{ id: "r1", name: "민석", closed: false }] }],
			},
		);
		const html = renderMarkdown("닫힌 @소민 과 원격 @desktop/민석 확인", { cache: false });
		const host = dom.document.createElement("div");
		patchHtml(host, {
			html,
			decorate: (frag) =>
				decorateMarkdownTokens(frag, {
					index: extIndex,
					selfId: "s1",
					selfServerId: "srv-main",
					skills: false,
					labels: { ...labels, openClosedSession: (n) => `Closed ${n}` },
				}),
		});
		const btns = [...host.querySelectorAll<HTMLButtonElement>("button.wd-mention")];
		expect(btns.map((b) => [b.textContent, b.className, b.dataset.mentionClosed, b.dataset.mentionServer, b.title])).toEqual([
			["@소민", "wd-mention wd-closed", "1", undefined, "Closed @소민"],
			["@desktop/민석", "wd-mention", undefined, "srv-desk", "Open @desktop/민석 chat"],
		]);
	});
});

describe("mentionSignature", () => {
	test("stays identical when unrelated sessions change, and changes when a mentioned session changes", () => {
		const idx1 = buildMentionIndex([{ id: "s1", name: "서아", closed: false }], []);
		const idx2 = buildMentionIndex(
			[
				{ id: "s1", name: "서아", closed: false },
				{ id: "s2", name: "민수", closed: false },
			],
			[],
		);
		const idx3 = buildMentionIndex([{ id: "s2", name: "민수", closed: false }], []);

		const html = "<p>UI 전담 세션(@서아)이 작업 중</p>";
		expect(mentionSignature("<p>plain text</p>", idx1)).toBe("");
		expect(mentionSignature(html, idx1)).toBe("서아:session:s1;");
		expect(mentionSignature(html, idx2)).toBe("서아:session:s1;");
		expect(mentionSignature(html, idx3)).toBe("");
	});

	test("handles HTML entities around and inside group names and inline code mentions", () => {
		const idx = buildMentionIndex([{ id: "s1", name: "서아", closed: false }], [{ id: "g1", name: "R&D" }]);
		expect(mentionSignature("<p>&lt;@서아&gt; and @R&amp;D</p>", idx)).toBe("서아:session:s1;r&d:group:g1;");
		expect(mentionSignature("<p>워커(<code>@서아</code>)</p>", idx)).toBe("서아:session:s1;");
	});

	test("distinguishes selfId in mentionSignature for sessions but not groups", () => {
		const idx = buildMentionIndex(
			[
				{ id: "s1", name: "서아", closed: false },
				{ id: "s2", name: "민수", closed: false },
			],
			[{ id: "s1", name: "팀" }],
		);
		const html = "<p>@서아 @민수 @팀</p>";
		expect(mentionSignature(html, idx, "s1")).toBe("서아:session:s1:self;민수:session:s2;팀:group:s1;");
		expect(mentionSignature(html, idx, "s2")).toBe("서아:session:s1;민수:session:s2:self;팀:group:s1;");
		expect(mentionSignature(html, idx, null)).toBe("서아:session:s1;민수:session:s2;팀:group:s1;");
	});
});
