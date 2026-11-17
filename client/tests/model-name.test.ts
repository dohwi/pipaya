import { describe, expect, test } from "bun:test";
import { modelDisplayName } from "../src/lib/model-name";

const models = [
	{ provider: "echo", id: "echo-model", name: "내 에코 모델" },
	{ provider: "other", id: "echo-model", name: "Other echo" },
	{ provider: "bare", id: "no-name", name: "  " },
];

describe("modelDisplayName", () => {
	test("the registered name of the exact provider and id", () => {
		expect(modelDisplayName(models, "echo", "echo-model")).toBe("내 에코 모델");
		expect(modelDisplayName(models, "other", "echo-model")).toBe("Other echo");
	});
	test("no registered match: the recorded id", () => {
		expect(modelDisplayName(models, "gone", "echo-model")).toBe("echo-model");
		expect(modelDisplayName(models, undefined, "echo-model")).toBe("echo-model");
		expect(modelDisplayName([], "echo", "gpt-x")).toBe("gpt-x");
	});
	test("a blank registered name falls back to the id; no id is empty", () => {
		expect(modelDisplayName(models, "bare", "no-name")).toBe("no-name");
		expect(modelDisplayName(models, "echo", undefined)).toBe("");
	});
});
