import { describe, expect, test } from "bun:test";
import { insertToken, mentionAt, mirrorHtml, replaceMention } from "../src/lib/composer-text";

describe("mentionAt", () => {
	test("finds the token that ends at the caret", () => {
		expect(mentionAt("file", "look at @src/comp", 17)).toEqual({ query: "src/comp", start: 8 });
		expect(mentionAt("agent", "$exp", 4)).toEqual({ query: "exp", start: 0 });
		expect(mentionAt("image", "see #ima", 8)).toEqual({ query: "ima", start: 4 });
	});
	test("needs a space (or the start) before the sigil, and nothing after it before the caret", () => {
		expect(mentionAt("file", "mail@host", 9)).toBeNull();
		expect(mentionAt("file", "@src done", 9)).toBeNull();
		expect(mentionAt("agent", "$Upper", 6)).toBeNull(); // agent names are lower-case
	});
	test("reads only up to the caret", () => {
		expect(mentionAt("file", "@abc rest", 2)).toEqual({ query: "a", start: 0 });
	});
});

describe("replaceMention", () => {
	test("swaps the token for the pick and folds a following space into it", () => {
		const text = "see @sr more";
		const r = replaceMention(text, 7, { query: "sr", start: 4 }, "@src/a.ts ");
		expect(r).toEqual({ text: "see @src/a.ts more", caret: 14 });
	});
	test("a folder pick keeps the space so the menu stays open on the folder", () => {
		const r = replaceMention("@sr x", 3, { query: "sr", start: 0 }, "@src/", true);
		expect(r).toEqual({ text: "@src/ x", caret: 5 });
	});
});

describe("insertToken", () => {
	test("pads with spaces only where it would touch a word", () => {
		expect(insertToken("ab", 2, "#image1")).toEqual({ text: "ab #image1 ", caret: 11 });
		expect(insertToken("a b", 2, "#image1")).toEqual({ text: "a #image1 b", caret: 10 });
		expect(insertToken("", 0, "#image1")).toEqual({ text: "#image1 ", caret: 8 });
	});
});

describe("mirrorHtml", () => {
	const known = { templates: [{ name: "fix" }], skills: [{ name: "review" }], agents: [{ name: "explore" }], images: 1, paths: ["src/a.ts"] };
	test("marks only tokens that refer to something real", () => {
		const html = mirrorHtml("@src/a.ts @nope $explore $ghost #image1 #image2 /skill:review /template:fix", known);
		expect(html).toContain('<mark class="file">@src/a.ts</mark>');
		expect(html).not.toContain('<mark class="file">@nope');
		expect(html).toContain('<mark class="agent">$explore</mark>');
		expect(html).not.toContain("$ghost</mark>");
		expect(html).toContain('<mark class="img">#image1</mark>');
		expect(html).not.toContain("#image2</mark>");
		expect(html).toContain('<mark class="skill">/skill:review</mark>');
		expect(html).toContain('<mark class="skill">/template:fix</mark>');
	});
	test("escapes the text and ends with a newline (keeps the layer as tall as the textarea)", () => {
		expect(mirrorHtml("<b>&", known)).toBe("&lt;b&gt;&amp;\n");
	});
});
