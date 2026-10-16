import { describe, expect, test } from "bun:test";
import { agentHint, HINT_OPEN, mentionedAgents } from "../src/subagent.ts";
import { mentionedSkills, skillCallHint } from "../src/skills.ts";

describe("/subagent:name mentions", () => {
	const names = ["explore", "review-bot"];

	test("finds known helpers once, in order", () => {
		expect(mentionedAgents("/subagent:review-bot check this, then /subagent:explore it. /subagent:explore again", names)).toEqual(["review-bot", "explore"]);
	});

	test("ignores unknown names, prices and mid-word dollars", () => {
		expect(mentionedAgents("costs $5 and /subagent:nobody, a/subagent:explore, $explore", names)).toEqual([]);
	});

	test("accepts trailing punctuation", () => {
		expect(mentionedAgents("ask /subagent:explore.", names)).toEqual(["explore"]);
	});

	test("hint names the helpers and carries the marker clients hide", () => {
		const hint = agentHint(["explore"]);
		expect(hint.startsWith(HINT_OPEN)).toBe(true);
		expect(hint).toContain('agent="explore"');
	});
});

describe("/skill:name calls", () => {
	const names = ["pipaya-usage", "release-notes"];

	test("finds known skills once, anywhere after whitespace", () => {
		expect(mentionedSkills("/skill:release-notes then /skill:pipaya-usage. /skill:release-notes", names)).toEqual(["release-notes", "pipaya-usage"]);
	});

	test("ignores unknown names, mid-word and plain commands", () => {
		expect(mentionedSkills("/skill:nobody a/skill:pipaya-usage /skill: /compact", names)).toEqual([]);
	});

	test("hint inlines the skill text under the marker clients hide", () => {
		const hint = skillCallHint({ name: "pipaya-usage", path: "/s/pipaya-usage/SKILL.md" }, "# Body", HINT_OPEN);
		expect(hint.startsWith(HINT_OPEN)).toBe(true);
		expect(hint).toContain("/skill:pipaya-usage");
		expect(hint).toContain("# Body");
		expect(hint).toContain("/s/pipaya-usage");
	});
});
