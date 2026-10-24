import { describe, expect, test } from "bun:test";
import { compileComponent, IMPORTABLE } from "../src/lib/extensions/components";
import { COMPONENT_LIMITS, PERMISSIONS, STYLE_PARTS, UI_PARTS, UI_SLOTS, parsePackage } from "../src/lib/extensions/schema";
import { permissionLabels } from "../src/lib/extensions/labels";

const pkg = (over: Record<string, unknown> = {}, permissions: string[] = ["ui-components"]) => ({
	manifest: { id: "skin", name: "Skin", version: "1.0.0", sdkVersion: 1, permissions },
	components: { Badge: "<p>hi</p>" },
	...over,
});
const fails = (input: unknown, text?: string) => {
	try { parsePackage(input); } catch (e) { if (text) expect(String(e)).toContain(text); return; }
	throw new Error("expected parsePackage to throw");
};

describe("compileComponent", () => {
	test("turns imports into lookups and the default export into an assignment", () => {
		const js = compileComponent("skin", "Badge", `<script>
	import { onMount } from "svelte";
	import { Icon, t as tr } from "pipaya";
	import Other from "./Other.svelte";
	let { name = "x" } = $props();
</script>
<Icon name="check" /><Other />{tr(name)}`);
		expect(js).not.toMatch(/^\s*import /m);
		expect(js).not.toMatch(/export default/);
		expect(js).toContain('__import("svelte")["onMount"]');
		expect(js).toContain('Icon = __import("pipaya")["Icon"]');
		expect(js).toContain('tr = __import("pipaya")["t"]');
		expect(js).toContain('Other = __import("./Other.svelte").default');
		expect(js).toContain("__exports.default = Badge");
	});
	test("scopes the CSS per extension and component", () => {
		const a = compileComponent("skin", "A", "<p class='x'>a</p><style>.x{color:red}</style>");
		const b = compileComponent("other", "A", "<p class='x'>a</p><style>.x{color:red}</style>");
		const cls = (js: string) => /x-[a-z0-9]+/.exec(js)![0];
		expect(cls(a)).not.toBe(cls(b));
	});
	test("a syntax error names the problem instead of returning code", () => {
		expect(() => compileComponent("skin", "Bad", "<div>{#if}</div>")).toThrow();
	});
	test("re-exports are refused", () => {
		expect(() => compileComponent("skin", "Bad", `<script module>export * from "x";</script><p/>`)).toThrow();
	});
});

describe("importable modules", () => {
	test("lists the app kit and sibling components, never the runtime internals", () => {
		expect(IMPORTABLE).toContain("pipaya");
		expect(IMPORTABLE).toContain("svelte");
		expect(IMPORTABLE).not.toContain("svelte/internal/client");
	});
});

describe("ui-style and ui-components in a package", () => {
	test("styles need ui-style and cannot escape the stylesheet", () => {
		const base = { manifest: { id: "skin", name: "S", version: "1.0.0", sdkVersion: 1, permissions: ["ui-style"] } };
		expect(parsePackage({ ...base, styles: "[data-part='header']{height:60px}" }).styles).toContain("60px");
		fails({ ...base, manifest: { ...base.manifest, permissions: [] }, styles: "a{}" }, "ui-style");
		fails({ ...base, styles: "a{}</style><script>" }, "</style>");
		fails({ ...base, styles: "@import url(x);" }, "@import");
		fails({ ...base, styles: "x".repeat(COMPONENT_LIMITS.styles + 1) });
	});
	test("components, mounts and replaces need ui-components", () => {
		expect(parsePackage(pkg()).components).toEqual({ Badge: "<p>hi</p>" });
		fails(pkg({}, []), "ui-components");
		fails({ ...pkg(), components: undefined, mounts: [] }, "components");
	});
	test("mounts must name a known slot and component", () => {
		const ok = parsePackage(pkg({ mounts: [{ slot: "header.end", component: "Badge", order: 5 }] }));
		expect(ok.mounts).toEqual([{ slot: "header.end", component: "Badge", order: 5 }]);
		fails(pkg({ mounts: [{ slot: "nowhere", component: "Badge" }] }), "slot");
		fails(pkg({ mounts: [{ slot: "header.end", component: "Missing" }] }), "Missing");
		fails(pkg({ mounts: [{ slot: "header.end", component: "Badge", order: 1.5 }] }), "order");
		fails(pkg({ mounts: [{ slot: "header.end", component: "Badge", extra: 1 }] }), "unknown field");
	});
	test("replaces only the parts the app offers", () => {
		expect(parsePackage(pkg({ replaces: { "composer.send": "Badge" } })).replaces).toEqual({ "composer.send": "Badge" });
		fails(pkg({ replaces: { "composer.box": "Badge" } }), "unknown field");
		fails(pkg({ replaces: { "composer.send": "Missing" } }), "Missing");
	});
	test("component names are PascalCase and the source is bounded", () => {
		fails(pkg({ components: { badge: "<p/>" } }), "PascalCase");
		fails(pkg({ components: { Big: "x".repeat(COMPONENT_LIMITS.source + 1) } }));
		fails(pkg({ components: {} }), "empty");
	});
});

describe("registry consistency", () => {
	test("both new permissions have a consent sentence", () => {
		for (const p of ["ui-style", "ui-components"]) {
			expect(PERMISSIONS).toContain(p as never);
			expect(permissionLabels[p as keyof typeof permissionLabels].length).toBeGreaterThan(20);
		}
	});
	test("no duplicates among slots, parts and style hooks", () => {
		for (const list of [UI_SLOTS, UI_PARTS, STYLE_PARTS]) expect(new Set(list).size).toBe(list.length);
	});
});

describe("loadComponents", () => {
	const { loadComponents } = require("../src/lib/extensions/components") as typeof import("../src/lib/extensions/components");
	const load = (components: Record<string, string>, kit: Record<string, unknown> = {}) =>
		loadComponents(parsePackage(pkg({ components })) as never, kit);

	test("links the kit, svelte and sibling components in any order", () => {
		const out = load({
			Outer: `<script>import Inner from "./Inner.svelte"; import { Icon, ext } from "pipaya"; import { onMount } from "svelte";</script><Inner /><Icon name="x" />{ext.id}`,
			Inner: `<script>import { fade } from "svelte/transition";</script><p transition:fade>hi</p>`,
		}, { Icon: () => {}, ext: { id: "skin" } });
		expect(Object.keys(out).sort()).toEqual(["Inner", "Outer"]);
		expect(typeof out.Outer).toBe("function");
	});
	test("a circular sibling import does not hang", () => {
		const out = load({ A: `<script>import B from "./B.svelte";</script><B />`, B: `<script>import A from "./A.svelte";</script><p>b</p>` });
		expect(typeof out.A).toBe("function");
	});
	test("refuses modules outside the allowed list, naming the component", () => {
		expect(() => load({ Bad: `<script>import fs from "node:fs";</script><p/>` })).toThrow(/Bad\.svelte.*cannot import "node:fs"/);
		expect(() => load({ Bad: `<script>import x from "svelte/internal/client";</script><p/>` })).toThrow(/svelte\/internal/);
		expect(() => load({ Bad: `<script>import X from "./Missing.svelte";</script><p/>` })).toThrow(/Missing/);
	});
	test("a compile error names the component", () => {
		expect(() => load({ Oops: "<div>{#if}</div>" })).toThrow(/^Oops\.svelte/);
	});
	test("the stylesheet is injected by the component and scoped to the extension", () => {
		const js = compileComponent("skin", "S", "<p class='a'>x</p><style>.a{color:red}</style>");
		expect(js).toContain("append_styles");
		expect(js).toMatch(/x-[a-z0-9]+/);
	});
});
