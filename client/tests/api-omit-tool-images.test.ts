import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Api } from "../src/lib/api";

let server: ReturnType<typeof Bun.serve>;
let seen: string[] = [];

beforeAll(() => {
	server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: (req) => {
			const u = new URL(req.url);
			seen.push(`${u.pathname}${u.search}`);
			return Response.json({ messages: [] });
		},
	});
});
afterAll(() => server.stop(true));

describe("Api message readers omit inline tool images", () => {
	test("messages, tailMessages, recentMessages and messagesAfter always send omitToolImages=true (including falsy 0 cursors)", async () => {
		seen = [];
		const api = new Api({ baseUrl: `http://127.0.0.1:${server.port}`, token: "t" });

		await api.messages("s1");
		await api.messages("s1", 0);
		await api.tailMessages("s1", 12);
		await api.tailMessages("s1", 100, 0);
		await api.recentMessages("s1", 6);
		await api.messagesAfter("s1", 0, 50);

		expect(seen).toEqual([
			"/sessions/s1/messages?limit=5000&omitToolImages=true",
			"/sessions/s1/messages?limit=5000&omitToolImages=true&after=0",
			"/sessions/s1/messages?limit=5000&tail=12&turn=true&omitToolImages=true",
			"/sessions/s1/messages?limit=5000&tail=100&turn=true&omitToolImages=true&before=0",
			"/sessions/s1/messages?tail=6&omitToolImages=true",
			"/sessions/s1/messages?after=0&limit=50&omitToolImages=true",
		]);
	});
});
