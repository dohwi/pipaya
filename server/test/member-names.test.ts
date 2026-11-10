import { describe, expect, test } from "bun:test";
import { groupHandle, koreanName, nameKey, sameName, MEMBER_NAMES_EN, MEMBER_NAMES_KO, memberAt, mentioned, nameInLang, nextMemberName, romanize } from "../src/member-names.ts";

describe("member names", () => {
	test("romanizes Hangul syllable by syllable and keeps anything else", () => {
		expect(romanize("민수")).toBe("Minsu");
		expect(romanize("abc")).toBe("Abc");
		expect(MEMBER_NAMES_EN).toHaveLength(MEMBER_NAMES_KO.length);
	});

	test("a stored name is always the Korean one, whatever form it was saved in", () => {
		expect(koreanName("민수")).toBe("민수");
		expect(koreanName("Minsu")).toBe("민수"); // saved by an older server that renamed on a language switch
		expect(koreanName("minsu2")).toBe("민수2");
		expect(koreanName("custom")).toBe("custom");
	});

	test("hands out the first free name, then numbers the first one", () => {
		expect(nextMemberName(new Set())).toBe(MEMBER_NAMES_KO[0]!);
		const all = new Set(MEMBER_NAMES_KO.map((n) => n.toLowerCase()));
		expect(nextMemberName(all)).toBe(`${MEMBER_NAMES_KO[0]}2`);
		all.add(`${MEMBER_NAMES_KO[0]}2`.toLowerCase());
		expect(nextMemberName(all)).toBe(`${MEMBER_NAMES_KO[0]}3`);
	});

	test("shows a name in the language asked for, numbered ones included, and leaves strangers alone", () => {
		const ko = MEMBER_NAMES_KO[0]!;
		const en = MEMBER_NAMES_EN[0]!;
		expect(nameInLang(ko, "en")).toBe(en);
		expect(nameInLang(`${ko}2`, "en")).toBe(`${en}2`);
		expect(nameInLang(ko, "ko")).toBe(ko);
		expect(nameInLang(ko, "ko-KR")).toBe(ko);
		expect(nameInLang(ko)).toBe(ko);
		expect(nameInLang("custom", "en")).toBe("custom");
		// a name stored in the old romanized form still shows as the Korean one in Korean
		expect(nameInLang(en, "ko")).toBe(ko);
		expect(nameInLang(`${en.toLowerCase()}3`, "ko")).toBe(`${ko}3`);
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

	test("a name and its romanized twin are one name, whichever language wrote it", () => {
		expect(nameKey("철수")).toBe(nameKey("Cheolsu"));
		expect(nameKey("철수2")).toBe(nameKey("cheolsu2"));
		expect(nameKey("철수")).not.toBe(nameKey("철수2"));
		expect(sameName("Mina", "미나")).toBe(true);
		expect(sameName("미나", "가온")).toBe(false);
		expect(sameName("builder-1", "Builder-1")).toBe(true);
	});

	test("@mentions in either script point at the same stored name", () => {
		expect(memberAt("Mina", ["미나", "가온"])).toBe("미나");
		expect(memberAt("미나랑", ["미나"])).toBe("미나");
		expect(memberAt("mina2", ["미나", "미나2"])).toBe("미나2");
		expect(memberAt("Minah", ["미나"])).toBeNull(); // still not cut out of a longer ASCII word
		expect(mentioned("hi @Cheolsu and @가온, @철수 again", ["철수", "가온"])).toEqual(["철수", "가온"]);
	});
});
