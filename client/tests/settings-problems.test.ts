import { describe, expect, test } from "bun:test";
import { modelProblem, settingsProblems } from "../src/lib/settings-problems";

const model = (provider: string, id: string) => ({ provider, id }) as never;
const prov = (id: string, configured: boolean) => ({ id, name: id, configured, storedCredential: null });

describe("settings problems", () => {
	const models = [model("a", "m1")];
	const providers = [prov("a", true), prov("b", false)];

	test("nothing chosen, or a working model, is no problem", () => {
		expect(modelProblem(null, models, providers)).toBeNull();
		expect(modelProblem({ provider: "a", model: "m1" }, models, providers)).toBeNull();
	});
	test("a connection without a key, a removed model and a removed connection are told apart", () => {
		expect(modelProblem({ provider: "b", model: "x" }, models, providers)).toBe("no-key");
		expect(modelProblem({ provider: "a", model: "gone" }, models, providers)).toBe("missing");
		expect(modelProblem({ provider: "z", model: "x" }, models, providers)).toBe("missing");
	});
	test("each of the three roles is listed on its own", () => {
		const list = settingsProblems({
			defaults: { provider: "b", model: "x" },
			compaction: { model: { provider: "a", model: "gone" } },
			system: { model: null },
			models,
			providers,
		});
		expect(list.map((p) => [p.role, p.kind])).toEqual([["default", "no-key"], ["compaction", "missing"]]);
	});
});
