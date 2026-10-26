// Keeps the Tauri CSP in sync with the extension sandbox's inline bootstrap script.
// The sandbox iframe (srcdoc) inherits the app CSP, and Tauri strips 'unsafe-inline' once it
// injects nonces/hashes, so the sandbox script must be allowed by hash.
//   bun scripts/sync-csp.ts          rewrite src-tauri/tauri.conf.json
//   bun scripts/sync-csp.ts --check  exit 1 when it is stale
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SANDBOX_HTML } from "../src/lib/extensions/runtime.ts";

const IMG = "'self' data: blob: http: https: asset: http://asset.localhost";
// blob: lets the app read back its own object URLs (saving a previewed file, copying an image)
const CONNECT = "'self' blob: ipc: http://ipc.localhost http: https: ws: wss:";

export function sandboxScriptHash(): string {
	const m = /<script>([\s\S]*?)<\/script>/.exec(SANDBOX_HTML);
	if (!m) throw new Error("sandbox bootstrap script not found");
	return `'sha256-${createHash("sha256").update(m[1]!).digest("base64")}'`;
}

export function buildCsp(dev = false): Record<string, string> {
	return {
		"default-src": "'self'",
		"script-src": dev ? "'self' 'unsafe-inline' 'unsafe-eval' blob:" : `'self' 'unsafe-eval' blob: ${sandboxScriptHash()}`,
		"worker-src": "blob:",
		"connect-src": CONNECT,
		"img-src": IMG,
		"font-src": "'self' data:",
		"style-src": "'self' 'unsafe-inline'",
		"style-src-attr": "'unsafe-inline'",
		"object-src": "'none'",
		"base-uri": "'none'",
		"form-action": "'none'",
		"media-src": "'self' blob:",
		"frame-src": "blob: data:",
	};
}

if (import.meta.main) {
	const file = join(import.meta.dir, "..", "src-tauri", "tauri.conf.json");
	const conf = JSON.parse(readFileSync(file, "utf8"));
	const next = { ...conf, app: { ...conf.app, security: { ...conf.app.security, csp: buildCsp(), devCsp: buildCsp(true) } } };
	const text = JSON.stringify(next, null, 2) + "\n";
	if (process.argv.includes("--check")) {
		if (JSON.stringify(conf) !== JSON.stringify(next)) { console.error("tauri.conf.json CSP is stale: run `bun scripts/sync-csp.ts`"); process.exit(1); }
	} else {
		writeFileSync(file, text);
		console.log("updated", file);
	}
}
