import { describe, expect, test } from "bun:test";
import { compile } from "svelte/compiler";
import { Glob } from "bun";
import { parseNavbarItem, navbarId, NAVBAR_LIMITS } from "../src/lib/extensions/navbar";
import { HTTP_MAX_BYTES, HttpReader, copyJson, httpOrigin, httpPath } from "../src/lib/extensions/http";
import { SANDBOX_HTML } from "../src/lib/extensions/runtime";
import { parseView, type UINode } from "../src/lib/extensions/ui";

const icon = { viewBox: "0 0 24 24", paths: [{ d: "M0 0L24 0 24 24Z", fill: "#10a37f", fillRule: "evenodd" }] };
const meter = (extra: Record<string, unknown> = {}) => ({ type: "progress", id: "g", label: "Usage", value: 10, ...extra });
const bad = (node: unknown, message?: string) => expect(() => parseView(node)).toThrow(message);

describe("icon node", () => {
	test("accepts a strict vector icon and returns a fresh copy", () => {
		const input = { type: "icon", id: "i", icon, size: "large", label: "Logo" };
		const out = parseView(input) as any;
		expect(out).toEqual(input);
		expect(out.icon).not.toBe(icon);
		expect(parseView({ type: "icon", id: "i", icon: { viewBox: "-5 -5.5 1e2 512", paths: [{ d: "M1,2 h3e-1 z" }] } })).toBeTruthy();
	});
	test("viewBox: four finite numbers, width/height 1..512", () => {
		for (const viewBox of ["0 0 24", "0 0 24 24 1", "0 0 0.5 24", "0 0 513 24", "0 0 24 0", "a b c d", "0 0 NaN 24", "0 0 Infinity 24", "0,0,24,24", " 0 0 24 24", "0 0 -4 24", ""]) {
			bad({ type: "icon", id: "i", icon: { ...icon, viewBox } }, "viewBox");
		}
		parseView({ type: "icon", id: "i", icon: { ...icon, viewBox: "0 0 512 1" } });
	});
	test("path data charset, length and path count limits", () => {
		for (const d of ["M0 0 <script>", "M0 0 url(#x)", "M0 0;", "M0 0 L1 1 z!", "javascript:1", "M0 0 \u00e9", "", "   "]) {
			bad({ type: "icon", id: "i", icon: { ...icon, paths: [{ d }] } });
		}
		parseView({ type: "icon", id: "i", icon: { ...icon, paths: [{ d: "M 0 0\n\tL 1 1\rZ" }] } });
		parseView({ type: "icon", id: "i", icon: { ...icon, paths: [{ d: "M".padEnd(8192, "0") }] } });
		bad({ type: "icon", id: "i", icon: { ...icon, paths: [{ d: "M".padEnd(8193, "0") }] } }, "8192");
		bad({ type: "icon", id: "i", icon: { ...icon, paths: [] } });
		bad({ type: "icon", id: "i", icon: { ...icon, paths: Array(9).fill({ d: "M0 0" }) } });
		parseView({ type: "icon", id: "i", icon: { ...icon, paths: Array(8).fill({ d: "M0 0" }) } });
	});
	test("fill, fillRule and unknown fields are strict", () => {
		for (const fill of ["red", "#fff", "#12345g", "url(#a)", "#1234567", "rgb(0,0,0)", "CurrentColor", 1]) {
			bad({ type: "icon", id: "i", icon: { ...icon, paths: [{ d: "M0 0", fill }] } });
		}
		parseView({ type: "icon", id: "i", icon: { ...icon, paths: [{ d: "M0 0", fill: "currentColor" }] } });
		bad({ type: "icon", id: "i", icon: { ...icon, paths: [{ d: "M0 0", fillRule: "other" }] } });
		bad({ type: "icon", id: "i", icon: { ...icon, paths: [{ d: "M0 0", stroke: "#000000" }] } }, "unknown field");
		bad({ type: "icon", id: "i", icon: { ...icon, href: "http://x" } }, "unknown field");
		bad({ type: "icon", id: "i", icon, onclick: "x" }, "unknown field");
		bad({ type: "icon", id: "i", icon, size: "huge" });
		bad({ type: "icon", id: "i" });
	});
});

describe("navbar item validation", () => {
	const view = { type: "stack", id: "root", direction: "horizontal", children: [meter(), { type: "icon", id: "i", icon }, { type: "text", id: "t", text: "x" }, { type: "badge", id: "b", text: "x" }, { type: "divider", id: "d" }, { type: "progress", id: "p", label: "p", value: 1 }, { type: "stat", id: "s", label: "s", value: "1" }, { type: "grid", id: "gr", children: [] }] };
	test("accepts non-interactive nodes and returns a fresh copy", () => {
		const out = parseNavbarItem({ label: "Usage", view });
		expect(out).toEqual({ label: "Usage", view });
		expect(out.view).not.toBe(view as unknown as UINode);
	});
	test("rejects interactive and unsupported nodes with a clear error", () => {
		for (const node of [
			{ type: "button", id: "b", label: "Go" },
			{ type: "form", id: "f", submitLabel: "x", children: [] },
			{ type: "input", id: "i", label: "x" }, { type: "textarea", id: "i", label: "x" },
			{ type: "select", id: "i", label: "x", options: [{ value: "a", label: "a" }] }, { type: "checkbox", id: "i", label: "x" },
			{ type: "tabs", id: "t", items: [{ id: "a", label: "a", children: [] }] },
			{ type: "card", id: "c", children: [] }, { type: "table", id: "t", columns: [{ id: "a", label: "a" }], rows: [] },
			{ type: "list", id: "l", items: [] }, { type: "code", id: "c", text: "x" }, { type: "alert", id: "a", text: "x" },
		]) {
			expect(() => parseNavbarItem({ label: "x", view: node })).toThrow(/not allowed here/);
			expect(() => parseNavbarItem({ label: "x", view: { type: "stack", id: "s", children: [node] } })).toThrow(/non-interactive/);
		}
	});
	test("label, unknown field, node/depth/byte limits", () => {
		const one = { type: "text", id: "t", text: "x" };
		parseNavbarItem({ label: "x".repeat(40), view: one });
		for (const label of ["", " ", "x".repeat(41)]) expect(() => parseNavbarItem({ label, view: one })).toThrow();
		expect(() => parseNavbarItem({ label: "x", view: one, extra: 1 })).toThrow("unknown field");
		expect(() => parseNavbarItem({ label: "x" })).toThrow("view");
		// Exactly `n` nodes: a root, two groups, and n - 3 texts split between the groups.
		const many = (n: number) => {
			const texts = n - 3, first = Math.ceil(texts / 2);
			const group = (id: string, from: number, count: number) => ({ type: "stack", id, children: Array.from({ length: count }, (_, i) => ({ type: "text", id: `t${from + i}`, text: "x" })) });
			return { type: "stack", id: "root", children: [group("ga", 0, first), group("gb", first, texts - first)] };
		};
		parseNavbarItem({ label: "x", view: many(NAVBAR_LIMITS.nodes) });
		expect(() => parseNavbarItem({ label: "x", view: many(NAVBAR_LIMITS.nodes + 1) })).toThrow("60 nodes");
		const deep = (n: number): any => n === 0 ? { type: "text", id: "leaf", text: "x" } : { type: "stack", id: `s${n}`, children: [deep(n - 1)] };
		parseNavbarItem({ label: "x", view: deep(3) });
		expect(() => parseNavbarItem({ label: "x", view: deep(4) })).toThrow("levels deep");
		const heavy = { type: "stack", id: "root", children: Array.from({ length: 5 }, (_, i) => ({ type: "text", id: `t${i}`, text: "x".repeat(7000) })) };
		expect(() => parseNavbarItem({ label: "x", view: heavy })).toThrow("32768");
		// Normal panels keep their larger limits.
		expect(parseView(deep(6))).toBeTruthy();
	});
	test("navbar IDs follow the local ID rule", () => {
		expect(navbarId("usage-1")).toBe("usage-1");
		for (const id of ["", "Usage", "1a", "a_b", "a".repeat(41), 1, null]) expect(() => navbarId(id)).toThrow();
	});
});

describe("http origin and path validation", () => {
	test("origin must be a pure http(s) origin; no default", () => {
		for (const input of [undefined, null, "", "  "]) expect(() => httpOrigin(input)).toThrow("설정에 httpOrigin이 필요합니다");
		for (const input of ["https://u:p@host", "https://@host", "https://host/any", "https://host?", "https://host?a=1", "https://host#", "ftp://host", "file:///tmp", "https://host\\evil", " https://host", "https://host/%2e%2e", "https://host//", "javascript:1", "host:80", 5]) {
			expect(() => httpOrigin(input)).toThrow();
		}
		expect(httpOrigin("http://localhost:8317/")).toBe("http://localhost:8317");
		expect(httpOrigin("https://example.com")).toBe("https://example.com");
	});
	test("paths: single leading slash, no traversal, backslash, control, fragment or scheme", () => {
		for (const path of ["/", "/a/b", "/a?x=1&y=2", "/a/b.json", "/a%20b"]) expect(httpPath(path)).toBe(path);
		for (const path of ["", "a", "//evil.com/x", "///x", "https://evil.com/x", "/a/../b", "/..", "/a/./b", "/a/%2e%2E/b", "/a\\b", "/a#frag", "/a\nb", "/a\u0000b", "/a b", "/\u007f", "/a%2fb", "/a%5Cb", "http:/x", 5, null, undefined, "/" + "a".repeat(2049)]) {
			expect(() => httpPath(path)).toThrow();
		}
	});
});

describe("HttpReader", () => {
	const ok = (body: unknown = { ok: true }) => new Response(JSON.stringify(body));
	test("request options: GET, credentials omit, redirect error, no-store, no-referrer, Accept json only", async () => {
		const seen: { url: unknown; options: RequestInit }[] = [];
		const reader = new HttpReader((async (url: unknown, options: RequestInit) => { seen.push({ url, options }); return ok(); }) as typeof fetch, () => 0);
		await reader.getJson("ext", "https://example.com/", "/a/b?x=1", () => true);
		expect(seen[0]!.url).toBe("https://example.com/a/b?x=1");
		expect(seen[0]!.options).toMatchObject({ method: "GET", credentials: "omit", redirect: "error", cache: "no-store", referrerPolicy: "no-referrer" });
		expect(seen[0]!.options.headers).toEqual({ Accept: "application/json" });
		expect(JSON.stringify(seen[0]!.options.headers).toLowerCase()).not.toMatch(/authorization|cookie|token/);
		expect(seen[0]!.options.body).toBeUndefined();
	});
	test("path or origin problems throw synchronously before any fetch", () => {
		let calls = 0;
		const reader = new HttpReader((async () => { calls++; return ok(); }) as typeof fetch);
		expect(() => reader.getJson("e", undefined, "/a", () => true)).toThrow("설정에 httpOrigin이 필요합니다");
		expect(() => reader.getJson("e", "https://example.com", "//evil.com", () => true)).toThrow();
		expect(() => reader.getJson("e", "https://example.com", "/../x", () => true)).toThrow();
		expect(calls).toBe(0);
	});
	test("coalesces in-flight same-path calls and rejects repeats within 2s; other paths and owners are independent", async () => {
		let calls = 0, now = 0;
		const reader = new HttpReader((async () => { calls++; return ok({ n: calls }); }) as typeof fetch, () => now);
		const p = reader.getJson("ext", "https://example.com", "/a", () => true);
		expect(reader.getJson("ext", "https://example.com", "/a", () => true)).toBe(p);
		await expect(p).resolves.toEqual({ n: 1 });
		now = 1999;
		expect(() => reader.getJson("ext", "https://example.com", "/a", () => true)).toThrow("너무 자주");
		await reader.getJson("ext", "https://example.com", "/b", () => true);
		await reader.getJson("other", "https://example.com", "/a", () => true);
		expect(calls).toBe(3);
		now = 2000;
		await expect(reader.getJson("ext", "https://example.com", "/a", () => true)).resolves.toEqual({ n: 4 });
		reader.cleanup("ext");
	});
	test("declared and streamed size caps, HTTP errors, invalid JSON, and error messages never leak URLs", async () => {
		const secret = /secret|token|8317|example/i;
		const cases: [Response | (() => Promise<Response>), RegExp][] = [
			[new Response("{}", { headers: { "content-length": String(HTTP_MAX_BYTES + 1) } }), /너무 큽니다/],
			[new Response("x".repeat(HTTP_MAX_BYTES + 1)), /너무 큽니다/],
			[new Response("nope", { status: 500 }), /오류/],
			[new Response("not json"), /JSON/],
			[new Response(new Uint8Array([0xff, 0xfe])), /./],
			[() => Promise.reject(new Error("http://secret.example:8317/?token=1")), /연결/],
		];
		for (const [response, expected] of cases) {
			const reader = new HttpReader((async () => (typeof response === "function" ? response() : response)) as typeof fetch);
			const error = await reader.getJson("ext", "http://secret.example:8317", "/x?token=1", () => true).catch(e => e as Error);
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toMatch(expected);
			expect((error as Error).message).not.toMatch(secret);
		}
		// Exactly the cap is fine.
		const edge = " ".repeat(HTTP_MAX_BYTES - 2) + "{}";
		await expect(new HttpReader((async () => new Response(edge)) as typeof fetch).getJson("e", "http://localhost", "/x", () => true)).resolves.toEqual({});
	});
	test("timeout aborts a stalled fetch inside the SDK five-second deadline", async () => {
		let signal!: AbortSignal;
		const reader = new HttpReader(((_: unknown, options: RequestInit) => { signal = options.signal as AbortSignal; return new Promise<Response>(() => {}); }) as typeof fetch);
		const started = performance.now();
		await expect(reader.getJson("stalled", "http://localhost", "/x", () => true)).rejects.toThrow(/시간이 초과/);
		expect(signal.aborted).toBe(true);
		expect(performance.now() - started).toBeLessThan(4500);
	});
	test("cleanup aborts in-flight work and a late response cannot resolve (generation guard)", async () => {
		const releases: ((r: Response) => void)[] = [];
		const signals: AbortSignal[] = [];
		const reader = new HttpReader(((_: unknown, options: RequestInit) => {
			signals.push(options.signal as AbortSignal);
			return new Promise<Response>(resolve => releases.push(resolve));
		}) as typeof fetch);
		let current = true;
		const old = reader.getJson("ext", "http://localhost", "/x", () => current);
		const rejected = expect(old).rejects.toThrow(/취소/);
		current = false; reader.cleanup("ext");
		expect(signals[0]!.aborted).toBe(true);
		const fresh = reader.getJson("ext", "http://localhost", "/x", () => true);
		releases[0]!(ok({ old: true })); await rejected;
		releases[1]!(ok({ fresh: true }));
		await expect(fresh).resolves.toEqual({ fresh: true });
		const late = reader.getJson("late", "http://localhost", "/x", () => false);
		releases[2]!(ok());
		await expect(late).rejects.toThrow();
	});
	test("result is deep-copied plain JSON; depth over 32 is rejected; __proto__ stays data", () => {
		const nest = (n: number): unknown => (n === 0 ? 1 : [nest(n - 1)]);
		expect(copyJson(nest(31))).toBeTruthy();
		expect(() => copyJson(nest(40))).toThrow("깊습니다");
		const parsed = JSON.parse('{"__proto__":{"polluted":true},"a":[{"b":null}]}');
		const out = copyJson(parsed) as any;
		expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
		expect(({} as any).polluted).toBeUndefined();
		expect(Object.keys(out)).toEqual(["__proto__", "a"]);
		expect(out.a).not.toBe(parsed.a);
	});
});

describe("renderers, SDK surface and brand neutrality", () => {
	test("trusted components compile and never inject HTML, images, URLs or gradients", async () => {
		for (const name of ["ExtensionIcon", "NavbarUsage", "ExtensionView"]) {
			const source = await Bun.file(`src/components/extensions/${name}.svelte`).text();
			expect(() => compile(source, { filename: `${name}.svelte`, generate: "client" })).not.toThrow();
			expect(source).not.toMatch(/@html|<img|<image|<use|linearGradient|https?:\/\//);
		}
		const navbar = await Bun.file("src/components/extensions/NavbarUsage.svelte").text();
		expect(navbar).toContain("min-width: 0");
		expect(navbar).toContain("overflow-x: auto");
	});
	test("sandbox SDK exposes frozen navbar and http only, with exactly one getJson argument", () => {
		expect(SANDBOX_HTML).toContain("navbar: Object.freeze({ set:");
		expect(SANDBOX_HTML).toContain("http: Object.freeze({ getJson:");
		expect(SANDBOX_HTML).toContain("http.getJson takes exactly one argument");
		expect(SANDBOX_HTML).not.toMatch(/quota/i);
	});
	test("no AI brand or product name appears anywhere under src/", async () => {
		const pattern = /claude|gemini|antigravity|quota-monitor|quota/i;
		// The model logo shown next to an agent has to recognise model families by name; only these files may.
		const LOGO_FILES = new Set(["lib/brand.ts", "lib/brand-marks.ts", "components/ModelLogo.svelte"]);
		const hits: string[] = [];
		for await (const file of new Glob("**/*").scan({ cwd: "src", onlyFiles: true })) {
			if (/\.(png|jpe?g|gif|webp|ico|icns|woff2?)$/i.test(file) || LOGO_FILES.has(file)) continue;
			if (pattern.test(await Bun.file(`src/${file}`).text())) hits.push(file);
		}
		expect(hits).toEqual([]);
	});
	test("no UI node or component exists for the look of one particular extension", async () => {
		// A look this specific (rings, popovers of usage rows, ...) belongs in the extension that wants it, drawn with
		// `ui-components` (docs/trusted-ui.md). The core only offers generic nodes: adding a node per extension is what this stops.
		const { parseView } = await import("../src/lib/extensions/ui");
		expect(() => parseView({ type: "gauge", id: "g", label: "x", rings: [{ value: 1 }] })).toThrow();
		const files: string[] = [];
		for await (const file of new Glob("**/*").scan({ cwd: "src", onlyFiles: true })) files.push(file);
		expect(files.filter((f) => /gauge|quota|usage/i.test(f.split("/").pop()!) && !/^components\/(?:Pin|Sidebar)/.test(f))).toEqual(["components/extensions/NavbarUsage.svelte"]);
		expect(await Bun.file("src/lib/extensions/ui.ts").text()).not.toMatch(/gauge|\brings?\b/i);
	});
	test("no leftover previous-brand names in src/ or tests/", async () => {
		const REPO_SLUG = ["doh" + "wi", "pipaya"].join("/");
		const pattern = new RegExp(["doo" + "hi", "doh" + "wi", "har" + "ness", "\uB3C4\uD718"].join("|"), "i");
		const hits: string[] = [];
		for (const dir of ["src", "tests"]) {
			for await (const file of new Glob("**/*").scan({ cwd: dir, onlyFiles: true })) {
				if (/\.(png|jpe?g|gif|webp|ico|icns|woff2?)$/i.test(file)) continue;
				// the repository address (owner/name) is allowed; everything else must be free of the old names
				if (pattern.test((await Bun.file(`${dir}/${file}`).text()).replaceAll(REPO_SLUG, ""))) hits.push(`${dir}/${file}`);
			}
		}
		expect(hits).toEqual([]);
	});
});
