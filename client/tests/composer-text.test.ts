import { describe, expect, test } from "bun:test";
import { groupHandle, insertToken, memberOf, mentionAt, mirrorHtml, replaceMention } from "../src/lib/composer-text";

describe("mentionAt", () => {
	test("finds the token that ends at the caret", () => {
		expect(mentionAt("file", "look at #src/comp", 17)).toEqual({ query: "src/comp", start: 8 });
		expect(mentionAt("member", "@mi", 3)).toEqual({ query: "mi", start: 0 });
		expect(mentionAt("member", "ask @미나", 7)).toEqual({ query: "미나", start: 4 });
	});
	test("needs a space (or the start) before the sigil, and nothing after it before the caret", () => {
		expect(mentionAt("file", "a#b", 3)).toBeNull();
		expect(mentionAt("file", "#src done", 9)).toBeNull();
		expect(mentionAt("member", "mail@host", 9)).toBeNull();
	});
	test("reads only up to the caret", () => {
		expect(mentionAt("file", "#abc rest", 2)).toEqual({ query: "a", start: 0 });
	});
});

describe("replaceMention", () => {
	test("swaps the token for the pick and folds a following space into it", () => {
		const text = "see #sr more";
		const r = replaceMention(text, 7, { query: "sr", start: 4 }, "#src/a.ts ");
		expect(r).toEqual({ text: "see #src/a.ts more", caret: 14 });
	});
	test("a folder pick keeps the space so the menu stays open on the folder", () => {
		const r = replaceMention("#sr x", 3, { query: "sr", start: 0 }, "#src/", true);
		expect(r).toEqual({ text: "#src/ x", caret: 5 });
	});
});

describe("insertToken", () => {
	test("pads with spaces only where it would touch a word", () => {
		expect(insertToken("ab", 2, "#image1")).toEqual({ text: "ab #image1 ", caret: 11 });
		expect(insertToken("a b", 2, "#image1")).toEqual({ text: "a #image1 b", caret: 10 });
		expect(insertToken("", 0, "#image1")).toEqual({ text: "#image1 ", caret: 8 });
	});
});

describe("memberOf", () => {
	test("takes the longest name and lets a Korean particle follow", () => {
		expect(memberOf("미나랑", ["철수", "미나"])).toBe("미나");
		expect(memberOf("미나2랑", ["미나", "미나2"])).toBe("미나2");
		expect(memberOf("bobby", ["bob"])).toBeNull();
		expect(memberOf("Bob", ["bob"])).toBe("bob");
	});
});

describe("mirrorHtml", () => {
	const known = { templates: [{ name: "fix" }], skills: [{ name: "review" }], agents: [{ name: "explore" }], members: ["미나"], images: 1, paths: ["src/a.ts"] };
	test("marks only tokens that refer to something real", () => {
		const html = mirrorHtml("#src/a.ts #nope /subagent:explore /subagent:ghost $explore #image1 #image2 @미나랑 @철수 /skill:review /prompt:fix", known);
		expect(html).toContain('<mark class="file">#src/a.ts</mark>');
		expect(html).not.toContain('<mark class="file">#nope');
		expect(html).toContain('<mark class="agent">/subagent:explore</mark>');
		expect(html).not.toContain("ghost</mark>");
		expect(html).not.toContain("$explore</mark>");
		expect(html).toContain('<mark class="img">#image1</mark>');
		expect(html).not.toContain("#image2</mark>");
		expect(html).toContain('<mark class="member">@미나</mark>랑');
		expect(html).not.toContain("@철수</mark>");
		expect(html).toContain('<mark class="skill">/skill:review</mark>');
		expect(html).toContain('<mark class="skill">/prompt:fix</mark>');
	});
	test("escapes the text and ends with a newline (keeps the layer as tall as the textarea)", () => {
		expect(mirrorHtml("<b>&", known)).toBe("&lt;b&gt;&amp;\n");
	});
});

describe("mirrorHtml group tags", () => {
	const known = { templates: [], skills: [], agents: [], members: ["미나"], groups: ["결제-개편"], images: 0, paths: [] };
	test("marks a group handle like a session mention, particle left outside", () => {
		expect(mirrorHtml("@결제-개편에 PR 해", known)).toContain('<mark class="member">@결제-개편</mark>에');
		expect(mirrorHtml("@미나 와 @nobody", known)).toContain('<mark class="member">@미나</mark>');
		expect(mirrorHtml("@nobody", known)).not.toContain("<mark");
	});
	test("groupHandle joins words with dashes", () => {
		expect(groupHandle("  결제   개편 ")).toBe("결제-개편");
	});
});
