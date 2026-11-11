import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { buildApp } from "./app.ts";
import { isLoopback } from "./auth-throttle.ts";
import { loadConfig } from "./config.ts";
import { installCrashGuard } from "./crash-guard.ts";

// pi-ai loads its OAuth flows with a dynamic import, which a compiled single binary (the desktop sidecar) cannot resolve.
// Registering them statically embeds the flows; it is harmless when running from source.
registerBunOAuthFlows();

const cfg = loadConfig();
const app = await buildApp(cfg);
installCrashGuard(app.server.log);

let stopping = false;
const stop = async (signal: string) => {
	if (stopping) return;
	stopping = true;
	app.server.log.info(`${signal} received, shutting down`);
	const force = setTimeout(() => process.exit(1), 10_000);
	force.unref();
	await app.close();
	process.exit(0);
};
process.on("SIGINT", () => void stop("SIGINT"));
process.on("SIGTERM", () => void stop("SIGTERM"));

await app.server.listen({ host: cfg.host, port: cfg.port });
if (isLoopback(cfg.host) || cfg.host === "localhost") {
	app.server.log.info(`listening on ${cfg.host} only: other devices cannot connect. Set PIPAYA_HOST to this machine's private address (a Tailscale IP) or 0.0.0.0 to accept them`);
}
app.sessions.describeAll(); // sessions from before a system model was set get their title and role in the background
app.server.log.info(`workspace: ${cfg.workspaceRoot}`);
app.server.log.info(`db: ${cfg.dbPath}`);
if (!process.env.PIPAYA_TOKEN) app.server.log.info(`auth token: ${cfg.dataDir}/token`);
