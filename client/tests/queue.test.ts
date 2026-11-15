import { describe, expect, test } from "bun:test";
import { orderQueued, queuedShown } from "../src/lib/queue";

describe("queue", () => {
	test("steers come first, each mode numbered from 1", () => {
		const q = orderQueued([{ mode: "follow_up", text: "a" }, { mode: "steer", text: "b" }, { mode: "follow_up", text: "c" }]);
		expect(q.map((x) => `${x.mode}${x.n}:${x.text}`)).toEqual(["steer1:b", "follow_up1:a", "follow_up2:c"]);
	});

	test("queuedShown drops the blocks the server adds for the model", () => {
		const hint = "<pipaya-hint>The user mentioned other sessions:\n- @미나 · idle</pipaya-hint>";
		expect(queuedShown(`@미나 봐 줘${hint}`)).toBe("@미나 봐 줘");
		expect(queuedShown(`요약해 줘<pipaya-schedule>sent by a scheduled task</pipaya-schedule>`)).toBe("요약해 줘");
		expect(queuedShown("그대로 <b>태그</b>")).toBe("그대로 <b>태그</b>");
	});
});
