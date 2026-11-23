import { describe, expect, test } from "bun:test";
import { dropImageToken, insertToken, knownMention, mentionAt, mirrorHtml, replaceMention, slashAt, splitTokens } from "../src/lib/composer-text";

describe("mentionAt", () => {
	test("finds the token that ends at the caret", () => {
		expect(mentionAt("file", "look at #src/comp", 17)).toEqual({ query: "src/comp", start: 8 });
		expect(mentionAt("at", "@mi", 3)).toEqual({ query: "mi", start: 0 });
		expect(mentionAt("at", "ask @미나", 7)).toEqual({ query: "미나", start: 4 });
	});
	test("needs a space (or the start) before the sigil, and nothing after it before the caret", () => {
		expect(mentionAt("file", "a#b", 3)).toBeNull();
		expect(mentionAt("file", "#src done", 9)).toBeNull();
		expect(mentionAt("at", "mail@host", 9)).toBeNull();
	});
	test("reads only up to the caret", () => {
		expect(mentionAt("file", "#abc rest", 2)).toEqual({ query: "a", start: 0 });
	});
});

describe("slashAt", () => {
	test("finds a slash token at the start, with or without trailing draft text", () => {
		expect(slashAt("/", 1)).toEqual({ query: "", start: 0, atStart: true, hasTrailing: false });
		expect(slashAt("/comp", 5)).toEqual({ query: "comp", start: 0, atStart: true, hasTrailing: false });
		expect(slashAt("  /skill:rel", 12)).toEqual({ query: "skill:rel", start: 2, atStart: true, hasTrailing: false });
		expect(slashAt("/추가적으로 고쳐줘", 1)).toEqual({ query: "", start: 0, atStart: true, hasTrailing: true });
		expect(slashAt("/fix this bug", 1)).toEqual({ query: "", start: 0, atStart: true, hasTrailing: true });
		expect(slashAt("/orch추가적으로", 5)).toEqual({ query: "orch", start: 0, atStart: true, hasTrailing: true });
		expect(slashAt("/orch 추가적으로", 5)).toEqual({ query: "orch", start: 0, atStart: true, hasTrailing: true });
		expect(slashAt("/comp   ", 5)).toEqual({ query: "comp", start: 0, atStart: true, hasTrailing: false });
	});
	test("does not split an existing ASCII slash token when clicking in the middle of it", () => {
		expect(slashAt("/model gpt", 3)).toBeNull();
		expect(slashAt("/skill:orchestrate", 9)).toBeNull();
		expect(slashAt("fix /skill:orchestrate now", 13)).toBeNull();
	});
	test("finds an inline slash token after whitespace or a newline", () => {
		expect(slashAt("fix this /", 10)).toEqual({ query: "", start: 9, atStart: false, hasTrailing: false });
		expect(slashAt("fix this /orch", 14)).toEqual({ query: "orch", start: 9, atStart: false, hasTrailing: false });
		expect(slashAt("line1\n/skill:a", 14)).toEqual({ query: "skill:a", start: 6, atStart: false, hasTrailing: false });
		expect(slashAt("before /orch after", 12)).toEqual({ query: "orch", start: 7, atStart: false, hasTrailing: true });
		expect(slashAt("/skill:a /b", 11)).toEqual({ query: "b", start: 9, atStart: false, hasTrailing: false });
	});
	test("ignores paths, URLs, numbers, completed arguments, and mid-word slashes", () => {
		for (const [text, caret] of [
			["", 0],
			["/comp", 0],
			["a/b", 3],
			["http://example.com", 7],
			["/src/file.ts", 12],
			["/README.md", 10],
			["/123", 4],
			["/compact instructions", 21],
			["fix /src/a.ts", 13],
			["#src/", 5],
		] as const) {
			expect(slashAt(text, caret)).toBeNull();
		}
	});
	test("clamps out-of-range carets safely", () => {
		expect(slashAt("/orch", 99)).toEqual({ query: "orch", start: 0, atStart: true, hasTrailing: false });
		expect(slashAt("/orch", -5)).toBeNull();
	});
	test("splices cleanly with replaceMention while preserving surrounding text", () => {
		const lead = slashAt("/orch추가적으로", 5)!;
		expect(replaceMention("/orch추가적으로", 5, lead, "/skill:orchestrate ")).toEqual({
			text: "/skill:orchestrate 추가적으로",
			caret: 19,
		});
		const leadSpaced = slashAt("/orch 추가적으로", 5)!;
		expect(replaceMention("/orch 추가적으로", 5, leadSpaced, "/skill:orchestrate ")).toEqual({
			text: "/skill:orchestrate 추가적으로",
			caret: 19,
		});
		const mid = slashAt("앞 /orch 뒤", 7)!;
		expect(replaceMention("앞 /orch 뒤", 7, mid, "/skill:orchestrate ")).toEqual({
			text: "앞 /skill:orchestrate 뒤",
			caret: 21,
		});
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

describe("knownMention", () => {
	test("takes the longest name and lets a Korean particle follow", () => {
		expect(knownMention("미나랑", ["철수", "미나"])).toBe("미나");
		expect(knownMention("미나2랑", ["미나", "미나2"])).toBe("미나2");
		expect(knownMention("bobby", ["bob"])).toBeNull();
		expect(knownMention("Bob", ["bob"])).toBe("bob");
	});
});

describe("splitTokens", () => {
	const known = { names: ["미나", "철수", "mina"], images: 2 };
	test("cuts known @names out of the text, with a particle left as text", () => {
		expect(splitTokens("@미나랑 @철수 봐 줘", known)).toEqual([{ text: "@미나", kind: "mention", name: "미나" }, { text: "랑 " }, { text: "@철수", kind: "mention", name: "철수" }, { text: " 봐 줘" }]);
		expect(splitTokens("줄\n@Mina", known)).toEqual([{ text: "줄\n" }, { text: "@Mina", kind: "mention", name: "mina" }]);
	});
	test("marks attached images and path-like # tokens, trailing punctuation stays text", () => {
		expect(splitTokens("#image2 랑 #src/a.ts, 비교", known)).toEqual([{ text: "#image2", kind: "image", name: "2" }, { text: " 랑 " }, { text: "#src/a.ts", kind: "file", name: "src/a.ts" }, { text: ", 비교" }]);
		expect(splitTokens("#README.md 봐", known)[0]).toEqual({ text: "#README.md", kind: "file", name: "README.md" });
	});
	test("leaves unknown names, e-mail addresses, missing images, issue numbers and words alone", () => {
		for (const t of ["@누구 a@미나.com", "#image3", "PR #96 병합", "#main 브랜치", "hello"]) expect(splitTokens(t, known)).toEqual([{ text: t }]);
		expect(splitTokens("@미나", { names: [] })).toEqual([{ text: "@미나" }]);
	});
	test("marks confirmed /skill:name tokens and keeps Korean particles or punctuation outside", () => {
		const withSkills = { ...known, skills: ["review", "my-skill"] };
		expect(splitTokens("/skill:review로 @미나랑 /skill:my-skill.", withSkills)).toEqual([
			{ text: "/skill:review", kind: "skill", name: "review" },
			{ text: "로 " },
			{ text: "@미나", kind: "mention", name: "미나" },
			{ text: "랑 " },
			{ text: "/skill:my-skill", kind: "skill", name: "my-skill" },
			{ text: "." },
		]);
		expect(splitTokens("/skill:review-extra /skill:unknown /skill:review_x foo/skill:review", withSkills)).toEqual([
			{ text: "/skill:review-extra /skill:unknown /skill:review_x foo/skill:review" },
		]);
		expect(splitTokens("/skill:review", known)).toEqual([{ text: "/skill:review" }]);
	});
});

describe("mirrorHtml", () => {
	const known = { commands: ["snip:fix"], skills: [{ name: "review" }], mentions: ["미나"], images: 1, paths: ["src/a.ts"] };
	test("marks only tokens that refer to something real", () => {
		const html = mirrorHtml("#src/a.ts #nope $explore #image1 #image2 @미나랑 @철수 /skill:review /skill:review로 /skill:review-2 /skill:review_x /snip:fix", known);
		expect(html).toContain('<mark class="file">#src/a.ts</mark>');
		expect(html).not.toContain('<mark class="file">#nope');
		expect(html).not.toContain("ghost</mark>");
		expect(html).not.toContain("$explore</mark>");
		expect(html).toContain('<mark class="img">#image1</mark>');
		expect(html).not.toContain("#image2</mark>");
		expect(html).toContain('<mark class="mention">@미나</mark>랑');
		expect(html).not.toContain("@철수</mark>");
		expect(html).toContain('<mark class="skill">/skill:review</mark>');
		expect(html).toContain('<mark class="skill">/skill:review</mark>로');
		expect(html).not.toContain("/skill:review-2</mark>");
		expect(html).not.toContain("/skill:review_x</mark>");
		expect(html).toContain('<mark class="skill">/snip:fix</mark>');
	});
	test("escapes the text and ends with a newline (keeps the layer as tall as the textarea)", () => {
		expect(mirrorHtml("<b>&", known)).toBe("&lt;b&gt;&amp;\n");
	});
});

describe("mirrorHtml mentions", () => {
	const known = { commands: [], skills: [], mentions: ["미나", "결제-개편"], images: 0, paths: [] };
	test("marks an extension mention, particle left outside", () => {
		expect(mirrorHtml("@결제-개편에 PR 해", known)).toContain('<mark class="mention">@결제-개편</mark>에');
		expect(mirrorHtml("@미나 와 @nobody", known)).toContain('<mark class="mention">@미나</mark>');
		expect(mirrorHtml("@nobody", known)).not.toContain("<mark");
	});

});

describe("dropImageToken", () => {
	test("removes the token with the space before it and renumbers the later ones", () => {
		expect(dropImageToken("compare #image1 #image2 #image3", 2)).toBe("compare #image1 #image2");
		expect(dropImageToken("see #image1", 1)).toBe("see");
	});
	test("leaves earlier tokens and unrelated text alone", () => {
		expect(dropImageToken("#image1 and #image2", 2)).toBe("#image1 and");
		expect(dropImageToken("no tokens, #image10x", 1)).toBe("no tokens, #image10x");
	});
	test("a token with a longer number is not mistaken for the removed one", () => {
		expect(dropImageToken("a #image1 #image10", 1)).toBe("a #image9");
	});
});
