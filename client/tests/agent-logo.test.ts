import { describe, expect, test } from "bun:test";
import { logoModelOf } from "../src/lib/agent-logo";
import type { AssistantItem, ChatItem, Session } from "../src/lib/types";

const session = (provider: string, model: string): Session => ({ provider, model }) as Session;
const reply = (provider: string, model: string): ChatItem => ({ kind: "assistant", provider, model }) as AssistantItem;
const draft = { provider: "p/draft", model: "draft-model" };

describe("agent badge logo", () => {
	test("the session's current model wins, even before the next reply", () => {
		// a reply from the old model is still the last thing in the transcript
		expect(logoModelOf(session("p/a", "a-1"), [reply("p/a", "a-1")], draft)).toEqual({ provider: "p/a", model: "a-1" });
		// the model was just switched: the logo follows at once
		expect(logoModelOf(session("p/b", "b-1"), [reply("p/a", "a-1")], draft)).toEqual({ provider: "p/b", model: "b-1" });
	});
	test("the last reply stands in while the session list does not hold the session yet", () => {
		const items = [reply("p/a", "a-1"), { kind: "notice", text: "x" } as ChatItem, reply("p/b", "b-1")];
		expect(logoModelOf(undefined, items, draft)).toEqual({ provider: "p/b", model: "b-1" });
	});
	test("no session and no reply: the caller's own model (the draft)", () => {
		expect(logoModelOf(undefined, undefined, draft)).toEqual(draft);
		expect(logoModelOf(undefined, [], draft)).toEqual(draft);
		expect(logoModelOf(undefined, [{ kind: "assistant", model: undefined } as ChatItem], draft)).toEqual(draft);
	});
});
