// Runs before `tauri dev/build`. Mobile targets have no local server, so only desktop builds the sidecar.
const target = Bun.env.TAURI_ENV_PLATFORM ?? "";
if (target === "android" || target === "ios") process.exit(0);
const r = Bun.spawnSync(["bun", "scripts/build-sidecar.ts"], { stdout: "inherit", stderr: "inherit", env: Bun.env as Record<string, string> });
process.exit(r.exitCode ?? 1);
