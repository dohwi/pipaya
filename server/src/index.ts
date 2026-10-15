import { buildApp } from "./app.ts";
import { loadConfig } from "./config.ts";

const cfg = loadConfig();
const app = await buildApp(cfg);

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
app.server.log.info(`workspace: ${cfg.workspaceRoot}`);
app.server.log.info(`db: ${cfg.dbPath}`);
if (!process.env.PIPAYA_TOKEN) app.server.log.info(`auth token: ${cfg.dataDir}/token`);
