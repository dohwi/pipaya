import { afterEach, describe, expect, test } from "bun:test";
import { moveBundledServer, readBundledBind, startBundledServer } from "../src/lib/local-server";

const g = globalThis as any;
const calls: { cmd: string; args: unknown }[] = [];

/** Pretend to be inside the Tauri webview: `invoke` goes through window.__TAURI_INTERNALS__. */
function inTauri(handler: (cmd: string, args: unknown) => unknown) {
	g.window = { __TAURI_INTERNALS__: { invoke: async (cmd: string, args: unknown) => (calls.push({ cmd, args }), handler(cmd, args)), transformCallback: () => 0 } };
}
afterEach(() => {
	delete g.window;
	calls.length = 0;
});

describe("bundled server", () => {
	test("a browser or mobile build has none and never calls Tauri", async () => {
		expect(await startBundledServer()).toBeNull();
		expect(await readBundledBind()).toBeNull();
		expect(calls).toEqual([]);
	});

	test("the desktop app starts it and learns its address and token", async () => {
		inTauri(() => ({ baseUrl: "http://127.0.0.1:8788", token: "t" }));
		expect(await startBundledServer()).toEqual({ baseUrl: "http://127.0.0.1:8788", token: "t" });
		expect(calls.map((c) => c.cmd)).toEqual(["local_server"]);
	});

	test("a build without the sidecar falls back to the manual flow instead of failing", async () => {
		inTauri(() => { throw new Error("bundled server not found"); });
		expect(await startBundledServer()).toBeNull();
		expect(await readBundledBind()).toBeNull();
	});

	test("the listening address is read as it is", async () => {
		inTauri(() => ({ host: "", port: 8788 }));
		expect(await readBundledBind()).toEqual({ host: "", port: 8788 });
	});

	test("moving it passes the new address and reports the reason when it cannot", async () => {
		inTauri((cmd) => (cmd === "set_local_server_bind" ? { baseUrl: "http://0.0.0.0:9000", token: "t2" } : null));
		expect(await moveBundledServer("0.0.0.0", 9000)).toEqual({ baseUrl: "http://0.0.0.0:9000", token: "t2" });
		expect(calls[0]).toEqual({ cmd: "set_local_server_bind", args: { host: "0.0.0.0", port: 9000 } });
		inTauri(() => { throw "port in use"; });
		await expect(moveBundledServer("", 1)).rejects.toBe("port in use");
	});
});
