import { describe, expect, test } from "bun:test";
import {
	CODENAME_LETTERS,
	codenamePrefix,
	codenamePrefixOf,
	groupHandle,
	memberAt,
	mentioned,
	nameKey,
	nextMemberName,
	sameName,
} from "../src/member-names.ts";

describe("member names", () => {
	test("codename alphabet omits confusing I/O and generates Excel-style prefixes", () => {
		expect(CODENAME_LETTERS).toHaveLength(24);
		expect(CODENAME_LETTERS).not.toContain("I");
		expect(CODENAME_LETTERS).not.toContain("O");
		expect(codenamePrefix(0)).toBe("A");
		expect(codenamePrefix(7)).toBe("H");
		expect(codenamePrefix(8)).toBe("J");
		expect(codenamePrefix(13)).toBe("P");
		expect(codenamePrefix(23)).toBe("Z");
		expect(codenamePrefix(24)).toBe("AA");
		expect(codenamePrefix(25)).toBe("AB");
		expect(codenamePrefix(47)).toBe("AZ");
		expect(codenamePrefix(48)).toBe("BA");
		expect(codenamePrefix(-3)).toBe("A");
	});

	test("codenamePrefixOf extracts uppercase prefixes and rejects non-codenames", () => {
		expect(codenamePrefixOf("A1")).toBe("A");
		expect(codenamePrefixOf("a12")).toBe("A");
		expect(codenamePrefixOf("ab3")).toBe("AB");
		expect(codenamePrefixOf("")).toBeNull();
		expect(codenamePrefixOf(null)).toBeNull();
		expect(codenamePrefixOf(undefined)).toBeNull();
		expect(codenamePrefixOf("A0")).toBeNull();
		expect(codenamePrefixOf("I1")).toBeNull();
		expect(codenamePrefixOf("O2")).toBeNull();
		expect(codenamePrefixOf("AI1")).toBeNull();
		expect(codenamePrefixOf("worker")).toBeNull();
		expect(codenamePrefixOf("A1-extra")).toBeNull();
	});

	test("independent sessions take fresh letter prefixes and overflow to AA1, AB1...", () => {
		const taken = new Set<string>();
		const first26: string[] = [];
		for (let i = 0; i < 26; i++) {
			const name = nextMemberName(taken);
			first26.push(name);
			taken.add(name.toLowerCase());
		}
		expect(first26.slice(0, 4)).toEqual(["A1", "B1", "C1", "D1"]);
		expect(first26[7]).toBe("H1");
		expect(first26[8]).toBe("J1");
		expect(first26[23]).toBe("Z1");
		expect(first26[24]).toBe("AA1");
		expect(first26[25]).toBe("AB1");
	});

	test("independent sessions never intrude on a prefix still held by a child, and reclaim fully free prefixes", () => {
		// A1 was deleted while A2 still exists -> new independent session skips A and takes B1
		expect(nextMemberName(new Set(["A2"]))).toBe("B1");
		// Once A is completely gone, a new independent session reclaims A1
		expect(nextMemberName(new Set(["b1", "c1"]))).toBe("A1");
		// Group handle colliding with a codename reserves that prefix too
		expect(nextMemberName(new Set(["a1", "b1"]))).toBe("C1");
	});

	test("derived sessions inherit their parent's prefix, fill gaps, and grow past 9", () => {
		expect(nextMemberName(new Set(["a1"]), "A1")).toBe("A2");
		expect(nextMemberName(new Set(["a1", "a2"]), "a2")).toBe("A3");
		expect(nextMemberName(new Set(["a1", "a3"]), "A1")).toBe("A2");
		const nine = new Set(Array.from({ length: 9 }, (_, i) => `a${i + 1}`));
		expect(nextMemberName(nine, "A1")).toBe("A10");
		// Non-codename or missing parent falls back to a fresh top-level prefix
		expect(nextMemberName(new Set(["a1", "worker"]), "worker")).toBe("B1");
		expect(nextMemberName(new Set(["a1"]), "")).toBe("B1");
		expect(nextMemberName(new Set(["a1"]), null)).toBe("B1");
		expect(nextMemberName(new Set(["a1"]), "I1")).toBe("B1");
	});

	test("a group handle is one token", () => {
		expect(groupHandle("  my  team ")).toBe("my-team");
	});

	test("@mentions pick the longest known name, match case-insensitively, and respect word boundaries", () => {
		expect(memberAt("A1한테", ["A1", "B1"])).toBe("A1"); // Korean particle may follow
		expect(memberAt("a1.", ["A1"])).toBe("A1");
		expect(memberAt("A10", ["A1", "A10"])).toBe("A10");
		expect(memberAt("A10", ["A1"])).toBeNull(); // not cut out of a longer ASCII token
		expect(memberAt("A1x", ["A1"])).toBeNull();
		expect(mentioned("hi @a1 and @B1, @A1 again, @nobody", ["A1", "B1"])).toEqual(["A1", "B1"]);
		expect(mentioned("mail me@A1.com", ["A1"])).toEqual([]); // not at a word start
	});

	test("nameKey and sameName are case-insensitive", () => {
		expect(nameKey("A1")).toBe("a1");
		expect(sameName("A1", "a1")).toBe(true);
		expect(sameName("A1", "A2")).toBe(false);
		expect(sameName("builder-1", "Builder-1")).toBe(true);
	});
});
