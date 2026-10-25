import { describe, expect, test } from "bun:test";
import { ASSET_LIMITS, STYLE_PARTS, parsePackage } from "../src/lib/extensions/schema";
import { inlineAssets } from "../src/lib/extensions/style";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// A design pack: a theme, a stylesheet and the files it needs, carried by one package.
const PNG = "data:image/png;base64,iVBORw0KGgo=";
const WOFF2 = "data:font/woff2;base64,d09GMgABAAA=";
const manifest = (permissions: string[]) => ({ id: "example.skin", name: "Skin", version: "1.0.0", sdkVersion: 1, permissions });
const fails = (input: unknown, message: string) => expect(() => parsePackage(input)).toThrow(message);

describe("theme tokens beyond colors", () => {
	test("rgb()/rgba() with plain numbers is a color", () => {
		for (const value of ["rgb(0,0,0)", "rgba(255, 255, 255, 0.1)", "rgba(1,2,3,1)", "rgba(1,2,3,.5)"]) {
			expect(parsePackage({ manifest: manifest([]), theme: { dark: { "--accent-soft": value } } }).theme!.dark!["--accent-soft"]).toBe(value);
		}
	});
	test("fonts are a family list, never a function or a URL", () => {
		expect(parsePackage({ manifest: manifest([]), theme: { light: { "--font": `"Brand Sans", Inter, sans-serif` } } }).theme!.light!["--font"]).toBe(`"Brand Sans", Inter, sans-serif`);
		for (const value of ["url(x)", "a;b", "var(--x)", "a{}", "a\nb", "a/b"]) fails({ manifest: manifest([]), theme: { light: { "--font": value } } }, "theme.light.--font");
	});
	test("type scale and control heights are bounded px", () => {
		expect(parsePackage({ manifest: manifest([]), theme: { dark: { "--fs-base": "16px", "--control-h": "44px", "--sidebar-w": "320px" } } }).theme!.dark!["--fs-base"]).toBe("16px");
		fails({ manifest: manifest([]), theme: { dark: { "--fs-base": "7px" } } }, "integer px");
		fails({ manifest: manifest([]), theme: { dark: { "--control-h": "100px" } } }, "integer px");
	});
});

describe("assets", () => {
	test("images and fonts travel with a ui-style or ui-components package", () => {
		const out = parsePackage({ manifest: manifest(["ui-style"]), assets: { "logo.png": PNG, "brand.woff2": WOFF2 }, styles: `@font-face{font-family:B;src:asset("brand.woff2")} [data-part="sidebar.brand"]{background:asset('logo.png')}` });
		expect(out.assets).toEqual({ "logo.png": PNG, "brand.woff2": WOFF2 });
		expect(parsePackage({ manifest: manifest(["ui-components"]), assets: { "a.png": PNG }, components: { A: "<p/>" } }).assets).toEqual({ "a.png": PNG });
	});
	test("needs a trusted UI permission, a known type and base64", () => {
		fails({ manifest: manifest([]), assets: { "a.png": PNG }, code: "1" }, "assets require");
		fails({ manifest: manifest(["ui-style"]), assets: { "a.png": "data:text/html;base64,PGI+" }, styles: "a{}" }, "assets.a.png");
		fails({ manifest: manifest(["ui-style"]), assets: { "a.png": "data:image/png,<svg>" }, styles: "a{}" }, "assets.a.png");
		fails({ manifest: manifest(["ui-style"]), assets: { "a.png": "https://x.test/a.png" }, styles: "a{}" }, "assets.a.png");
		fails({ manifest: manifest(["ui-style"]), assets: { "../a.png": PNG }, styles: "a{}" }, "lowercase file name");
		fails({ manifest: manifest(["ui-style"]), assets: {}, styles: "a{}" }, "must not be empty");
	});
	test("count and total size are capped", () => {
		const many = Object.fromEntries(Array.from({ length: ASSET_LIMITS.count + 1 }, (_, i) => [`a${i}.png`, PNG]));
		fails({ manifest: manifest(["ui-style"]), assets: many, styles: "a{}" }, `at most ${ASSET_LIMITS.count}`);
		const big = "data:image/png;base64," + "A".repeat(400 * 1024);
		fails({ manifest: manifest(["ui-style"]), assets: { "a.png": big, "b.png": big }, styles: "a{}" }, "in total");
	});
	test("a stylesheet may only name files the package carries", () => {
		fails({ manifest: manifest(["ui-style"]), assets: { "a.png": PNG }, styles: `a{background:asset("b.png")}` }, `asset("b.png") is not in assets`);
		fails({ manifest: manifest(["ui-style"]), styles: `a{background:asset(a.png)}` }, "is not in assets");
	});
	test("inlineAssets turns asset() into a data URL and anything unknown into none", () => {
		const css = `a{background:asset("logo.png")} b{src:asset( 'f.woff2' )} c{x:asset(nope)}`;
		expect(inlineAssets(css, { "logo.png": PNG, "f.woff2": WOFF2 })).toBe(`a{background:url("${PNG}")} b{src:url("${WOFF2}")} c{x:none}`);
		expect(inlineAssets("a{}", undefined)).toBe("a{}");
	});
});

describe("style hooks", () => {
	test("every data-part name is on an element of the app, and every data-part the app sets is listed", () => {
		const files: string[] = [];
		const walk = (dir: string) => { for (const f of readdirSync(dir)) { const p = join(dir, f); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith(".svelte")) files.push(p); } };
		walk("src");
		const used = new Set<string>();
		for (const f of files) for (const m of readFileSync(f, "utf8").matchAll(/data-part="([a-z.]+)"/g)) used.add(m[1]!);
		expect([...used].sort()).toEqual([...STYLE_PARTS].sort());
	});
});

test("the design-pack example installs", () => {
	const pkg = parsePackage(JSON.parse(readFileSync("examples/extensions/design-pack.json", "utf8")));
	expect(Object.keys(pkg.assets ?? {})).toEqual(["logo.svg"]);
	expect(inlineAssets(pkg.styles!, pkg.assets)).toContain('url("data:image/svg+xml;base64,');
});
