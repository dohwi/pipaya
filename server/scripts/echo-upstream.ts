/**
 * Starts the test-only echo model server (server/test/support/openai-upstream.ts) on its own and keeps it running.
 * The first stdout line is `READY <json>` with the provider body and model id; the screen smoke test
 * (scripts/e2e-smoke.py) reads it and registers it. Stops on SIGTERM/SIGINT. Not part of the shipped server.
 */
import { echoProviderBody, ECHO_MODEL, startEchoUpstream } from "../test/support/openai-upstream.ts";

const upstream = startEchoUpstream();
console.log(`READY ${JSON.stringify({ model: ECHO_MODEL.id, provider: echoProviderBody(upstream.baseUrl) })}`);
const stop = () => {
	upstream.stop();
	process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
