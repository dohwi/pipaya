import { expect, test } from "bun:test";
import { GIT_LIMITS } from "../src/lib/git-limits";

// the server's caps (GIT_LIMITS in server/src/git-routes.ts): a client that asks for more than the server gives would
// show a "show more" button that never grows the list
const server = await Bun.file(new URL("../../server/src/git-routes.ts", import.meta.url)).text();
const num = (key: string) => Number(new RegExp(`${key}: (\\d+)`).exec(server.slice(server.indexOf("export const GIT_LIMITS")))?.[1]);

test("the client's limits equal the server's", () => {
	expect(GIT_LIMITS.branches).toBe(num("branches"));
	expect(GIT_LIMITS.commitsPage).toBe(num("commitsPage"));
	expect(GIT_LIMITS.commitsMax).toBe(num("commitsMax"));
});

test("the pages add up to the cap", () => {
	expect(GIT_LIMITS.commitsMax % GIT_LIMITS.commitsPage).toBe(0);
});
