import { describe, expect, test } from "bun:test";
import { modelDisplayName, modelRefName, providerDisplayName, splitModelRef } from "../src/lib/model-name";

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

describe("modelRefName and providerDisplayName", () => {
	test("a provider/model reference reads by the model's registered name", () => {
		expect(modelRefName(models, "echo/echo-model")).toBe("내 에코 모델");
		expect(modelRefName(models, "other/echo-model")).toBe("Other echo");
		expect(modelRefName(models, "gone/echo-model")).toBe("echo-model");
		expect(modelRefName(models, "echo-model")).toBe("echo-model"); // no provider: no match, the id
		expect(modelRefName(models, "")).toBe("");
		expect(modelRefName(models, null)).toBe("");
	});
	test("the id after the first slash keeps its own slashes", () => {
		const m = [{ provider: "router", id: "vendor/model-x", name: "Model X" }];
		expect(splitModelRef("router/vendor/model-x")).toEqual({ provider: "router", id: "vendor/model-x" });
		expect(modelRefName(m, "router/vendor/model-x")).toBe("Model X");
	});
	test("a connection reads by its name, else its id", () => {
		const p = [{ id: "fake", name: "Fake Cloud" }, { id: "blank", name: " " }];
		expect(providerDisplayName(p, "fake")).toBe("Fake Cloud");
		expect(providerDisplayName(p, "blank")).toBe("blank");
		expect(providerDisplayName(p, "gone")).toBe("gone");
		expect(providerDisplayName(p, undefined)).toBe("");
	});
});
