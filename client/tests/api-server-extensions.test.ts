import { afterAll, beforeAll, expect, test } from "bun:test";
import { Api } from "../src/lib/api";

/** A server before the fix lists an extension kept in both of its folders twice (the settings nav crashed on it). */
let server: ReturnType<typeof Bun.serve>;
const ext = (name: string, title: string) => ({ name, title, tools: [], commands: [], commandFamilies: [], methods: [], providers: [], flags: [], events: [], settingsId: name });
beforeAll(() => {
	server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: () => Response.json({ extensions: [ext("dupx", "first"), ext("other", "Other"), ext("dupx", "second")], commands: [] }),
	});
});
afterAll(() => server.stop(true));

test("serverExtensions lists each name once, the first entry winning", async () => {
	const r = await new Api({ baseUrl: `http://127.0.0.1:${server.port}`, token: "t" }).serverExtensions();
	expect(r.extensions.map((e) => `${e.name}:${e.title}`)).toEqual(["dupx:first", "other:Other"]);
});
