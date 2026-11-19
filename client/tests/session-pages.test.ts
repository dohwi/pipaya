import { expect, test } from "bun:test";
import { Api } from "../src/lib/api";
import type { Session } from "../src/lib/types";

const row = (n: number) => ({ id: String(n).padStart(3, "0") }) as Session;

test("all-session readers pass both cursor fields and the closed filter beyond page 1", async () => {
	const api = new Api({ baseUrl: "", token: "" });
	const first = Array.from({ length: 200 }, (_, i) => row(201 - i));
	const calls: unknown[][] = [];
	api.listSessions = async (...args) => {
		calls.push(args);
		return calls.length === 1 ? { sessions: first, nextBefore: 0, nextBeforeId: "002" } : { sessions: [row(1)], nextBefore: null };
	};
	expect(await api.allSessions(true)).toEqual([...first, row(1)]);
	expect(calls).toEqual([[200, true, undefined, undefined], [200, true, 0, "002"]]);
});

test("a legacy time-only page is followed; a repeated cursor never loops or duplicates rows", async () => {
	const api = new Api({ baseUrl: "", token: "" });
	let count = 0;
	api.listSessions = async () => ({ sessions: [row(++count === 1 ? 2 : 1), row(2)], nextBefore: 4 });
	expect(await api.allSessions()).toEqual([row(2), row(1)]);
	expect(count).toBe(2);
});
