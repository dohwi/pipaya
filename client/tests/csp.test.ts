import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildCsp } from "../scripts/sync-csp.ts";

const conf = JSON.parse(readFileSync(join(import.meta.dir, "..", "src-tauri", "tauri.conf.json"), "utf8"));

test("tauri.conf.json CSP is in sync with the extension sandbox script (run `bun scripts/sync-csp.ts`)", () => {
	expect(conf.app.security.csp).toEqual(buildCsp());
	expect(conf.app.security.devCsp).toEqual(buildCsp(true));
});

test("production CSP blocks plugins, base hijacking and inline scripts other than the sandbox hash", () => {
	const csp = conf.app.security.csp as Record<string, string>;
	expect(csp["object-src"]).toBe("'none'");
	expect(csp["base-uri"]).toBe("'none'");
	expect(csp["script-src"]).not.toContain("'unsafe-inline'");
	expect(csp["script-src"]).toMatch(/'sha256-[A-Za-z0-9+/]+=*'/);
});
