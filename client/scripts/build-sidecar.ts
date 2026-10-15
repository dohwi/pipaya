// Compiles the server into a single binary and places it where Tauri's `externalBin` expects it:
//   src-tauri/binaries/pipaya-server-<target triple>[.exe]
// The desktop app starts it on 127.0.0.1 so a PC client works without a separate server install.
import { mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const triple = (Bun.env.TAURI_ENV_TARGET_TRIPLE || Bun.env.TARGET_TRIPLE || (() => {
	const out = Bun.spawnSync(["rustc", "-vV"]).stdout.toString();
	return /^host:\s*(\S+)/m.exec(out)?.[1];
})());
if (!triple) throw new Error("cannot determine the target triple (set TARGET_TRIPLE)");

const bunTarget = (): string | undefined => {
	if (triple.includes("windows")) return "bun-windows-x64";
	if (triple.includes("apple")) return triple.startsWith("aarch64") ? "bun-darwin-arm64" : "bun-darwin-x64";
	if (triple.includes("linux")) return triple.startsWith("aarch64") ? "bun-linux-arm64" : "bun-linux-x64";
};

const root = resolve(import.meta.dir, "..");
const server = resolve(root, "..", "server");
const dir = resolve(root, "src-tauri", "binaries");
const out = resolve(dir, `pipaya-server-${triple}${triple.includes("windows") ? ".exe" : ""}`);
mkdirSync(dir, { recursive: true });

if (Bun.env.SKIP_EXISTING_SIDECAR && existsSync(out)) process.exit(0);

const args = ["bun", "build", "--compile", "src/index.ts", "--outfile", out];
const target = bunTarget();
if (target && Bun.env.CROSS_SIDECAR) args.push("--target", target);
const r = Bun.spawnSync(args, { cwd: server, stdout: "inherit", stderr: "inherit" });
if (r.exitCode !== 0) process.exit(r.exitCode ?? 1);
console.log(`sidecar: ${out}`);
