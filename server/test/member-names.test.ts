import { describe, expect, test } from "bun:test";
import { groupHandle, MEMBER_NAMES_EN, MEMBER_NAMES_KO, memberAt, mentioned, nameInLang, nextMemberName, poolForLang, poolOfName, romanize } from "../src/member-names.ts";

describe("member names", () => {
	test("romanizes Hangul syllable by syllable and keeps anything else", () => {
		expect(romanize("민수")).toBe("Minsu");
		expect(romanize("abc")).toBe("Abc");
		expect(MEMBER_NAMES_EN).toHaveLength(MEMBER_NAMES_KO.length);
	});

	test("the pool follows the UI language: Korean for ko*, English otherwise, Korean without a tag", () => {
		expect(poolForLang()).toBe(MEMBER_NAMES_KO);
		expect(poolForLang("ko-KR")).toBe(MEMBER_NAMES_KO);
		expect(poolForLang("en")).toBe(MEMBER_NAMES_EN);
		expect(poolForLang("kok")).toBe(MEMBER_NAMES_EN); // not Korean: only `ko` and `ko-…`
		expect(poolOfName("Minsu")).toBe(MEMBER_NAMES_EN);
		expect(poolOfName("민수")).toBe(MEMBER_NAMES_KO);
	});

	test("hands out the first free name, then numbers the first one", () => {
		expect(nextMemberName(new Set())).toBe(MEMBER_NAMES_KO[0]!);
		const all = new Set(MEMBER_NAMES_KO.map((n) => n.toLowerCase()));
		expect(nextMemberName(all)).toBe(`${MEMBER_NAMES_KO[0]}2`);
		all.add(`${MEMBER_NAMES_KO[0]}2`.toLowerCase());
		expect(nextMemberName(all)).toBe(`${MEMBER_NAMES_KO[0]}3`);
	});

	test("translates a name between languages, numbered ones included, and leaves strangers alone", () => {
		const ko = MEMBER_NAMES_KO[0]!;
		const en = MEMBER_NAMES_EN[0]!;
		expect(nameInLang(ko, "en")).toBe(en);
		expect(nameInLang(`${ko}2`, "en")).toBe(`${en}2`);
		expect(nameInLang(en, "ko")).toBe(ko);
		expect(nameInLang(`${en.toLowerCase()}3`, "ko")).toBe(`${ko}3`);
		expect(nameInLang("custom", "en")).toBe("custom");
		expect(nameInLang(ko, "ko")).toBe(ko);
	});

	test("a group handle is one token", () => {
		expect(groupHandle("  my  team ")).toBe("my-team");
	});

	test("@mentions pick the longest known name and respect word boundaries", () => {
		expect(memberAt("미나랑", ["미나", "미"])).toBe("미나"); // a Korean particle may follow
		expect(memberAt("minah", ["mina", "min"])).toBeNull(); // not cut out of a longer ASCII word
		expect(memberAt("mina.", ["mina"])).toBe("mina");
		expect(memberAt("MINA", ["mina"])).toBe("mina");
		expect(mentioned("hi @mina and @bo, @mina again, @nobody", ["mina", "bo"])).toEqual(["mina", "bo"]);
		expect(mentioned("mail me@mina.com", ["mina"])).toEqual([]); // not at a word start
	});
});
