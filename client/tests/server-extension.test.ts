import { describe, expect, test } from "bun:test";
import { flagVariable, serverFields, serverProvides, srvKey } from "../src/lib/server-extension";

describe("server extension helpers", () => {
	test("the selection key is the name behind a prefix the sidebar tells apart from client ids", () => {
		expect(srvKey("demo-srv/index")).toBe("srv:demo-srv/index");
	});
	test("commands come as /name, then the tools", () => {
		expect(serverProvides({ commands: [{ name: "demo" }, { name: "x" }], tools: ["t1"] })).toEqual(["/demo", "/x", "t1"]);
		expect(serverProvides({ commands: [], tools: [] })).toEqual([]);
	});
	test("a flag becomes an upper-case variable with every other character an underscore", () => {
		expect(flagVariable("fast-mode")).toBe("PIPAYA_FLAG_FAST_MODE");
		expect(flagVariable("a.b c")).toBe("PIPAYA_FLAG_A_B_C");
	});
	test("no declared settings: nothing to show and nothing wrong", () => {
		expect(serverFields({})).toEqual({});
	});
	test("a valid form is parsed into its fields", () => {
		const r = serverFields({ settings: [{ key: "greeting", type: "string", label: "Greeting", default: "hi" }] });
		expect(r.problem).toBeUndefined();
		expect(r.fields).toHaveLength(1);
		expect(r.fields![0]!.key).toBe("greeting");
	});
	test("a broken form is reported as text instead of throwing", () => {
		const r = serverFields({ settings: [{ key: "x", type: "nope", label: "X" }] });
		expect(r.fields).toBeUndefined();
		expect(typeof r.problem).toBe("string");
		expect(r.problem!.length).toBeGreaterThan(0);
	});
});
