import { describe, expect, test } from "bun:test";
import { MAX_PER_DIR, MAX_RECENT, RECENT_TTL, pruneRecent, recentKey, type RecentTab } from "../src/lib/recent-tabs.svelte";

const now = 1_700_000_000_000;
const tab = (id: string, at: number, kind: RecentTab["kind"] = "session"): RecentTab => ({ id, kind, serverId: "srv", title: id, cwd: "/w", at });

describe("recently closed tabs", () => {
	test("only the last hour is offered back", () => {
		const list = [tab("old", now - RECENT_TTL - 1), tab("edge", now - RECENT_TTL + 1)];
		expect(pruneRecent(list, now).map((x) => x.id)).toEqual(["edge"]);
	});

	test("newest first, and the file keeps more than one folder shows", () => {
		const list = [tab("a", now - 3000), tab("b", now - 1000), tab("c", now - 2000), tab("d", now - 500)];
		expect(pruneRecent(list, now).map((x) => x.id)).toEqual(["d", "b", "c", "a"]);
		expect(MAX_RECENT).toBeGreaterThan(MAX_PER_DIR);
	});

	test("a malformed entry never shows", () => {
		const list = [{ id: "" }, { id: "x", kind: "nope", serverId: "s", title: "t", cwd: "/", at: now }, tab("ok", now)] as unknown as RecentTab[];
		expect(pruneRecent(list, now).map((x) => x.id)).toEqual(["ok"]);
	});

	test("nothing to show when everything expired", () => {
		expect(pruneRecent([tab("gone", now - RECENT_TTL * 2)], now)).toEqual([]);
	});

	test("a folder's own list is keyed by its server and path, never by one without the other", () => {
		expect(recentKey("srv", "/w")).not.toBe(recentKey("srv2", "/w"));
		expect(recentKey("srv", "/w")).not.toBe(recentKey("srv", "/w2"));
		// the separator can appear in neither a server id nor a path, so two pairs can never collide
		expect(recentKey("srv", "/w")).toBe("recent\u0000srv\u0000/w");
	});
});
