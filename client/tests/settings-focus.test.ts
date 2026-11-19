import { describe, expect, test } from "bun:test";
import { settingsTarget } from "../src/lib/graph-detail";
import { byData, focusTargets } from "../src/lib/settings-focus";

const custom = { id: "local", models: [{ id: "qwen" }] } as never;

describe("settingsTarget", () => {
	test("a server opens its info section", () => {
		expect(settingsTarget({ kind: "server", label: "a" }, {})).toEqual({ tab: "info", focus: null });
	});
	test("a provider lands on its own row when it has one, else on the connection list", () => {
		expect(settingsTarget({ kind: "provider", label: "local" }, { custom })).toEqual({ tab: "models", focus: { kind: "provider", provider: "local" } });
		expect(settingsTarget({ kind: "provider", label: "anthropic" }, { builtin: { storedCredential: "oauth" } })).toEqual({ tab: "models", focus: { kind: "provider", provider: "anthropic" } });
		expect(settingsTarget({ kind: "provider", label: "openai" }, { builtin: { storedCredential: null } })).toEqual({ tab: "models", focus: { kind: "connections" } });
	});
	test("a model lands on its row in an added connection's list, else on its connection", () => {
		expect(settingsTarget({ kind: "model", label: "qwen", provider: "local" }, { custom })).toEqual({ tab: "models", focus: { kind: "model", provider: "local", model: "qwen" } });
		expect(settingsTarget({ kind: "model", label: "gone", provider: "local" }, { custom })).toEqual({ tab: "models", focus: { kind: "provider", provider: "local" } });
		expect(settingsTarget({ kind: "model", label: "opus", provider: "anthropic" }, { builtin: { storedCredential: "api_key" } })).toEqual({ tab: "models", focus: { kind: "provider", provider: "anthropic" } });
		expect(settingsTarget({ kind: "model", label: "gpt", provider: "openai" }, {})).toEqual({ tab: "models", focus: { kind: "connections" } });
	});
	test("a role lands on its row; a project role on the list, a made-up one on the delegate settings", () => {
		expect(settingsTarget({ kind: "subagent", label: "explore" }, { roleScope: "global" })).toEqual({ tab: "tools", focus: { kind: "role", name: "explore" } });
		expect(settingsTarget({ kind: "subagent", label: "explore" }, {})).toEqual({ tab: "tools", focus: { kind: "role", name: "explore" } });
		expect(settingsTarget({ kind: "subagent", label: "mine" }, { roleScope: "project" })).toEqual({ tab: "tools", focus: { kind: "roles" } });
		expect(settingsTarget({ kind: "subagent", label: "x", free: true }, {})).toEqual({ tab: "tools", focus: { kind: "delegate" } });
	});
});

describe("focusTargets", () => {
	test("a model prefers its row, then its connection, then the list", () => {
		expect(focusTargets({ kind: "model", provider: "p", model: "a/b" })).toEqual({ want: ['[data-model="p/a/b"]', '[data-provider="p"]'], fallback: '[data-focus="connections"]' });
	});
	test("a role falls back to the role list", () => {
		expect(focusTargets({ kind: "role", name: "r" })).toEqual({ want: ['[data-role="r"]'], fallback: '[data-focus="roles"]' });
	});
	test("quotes in a value are escaped", () => {
		expect(byData("model", 'a"b\\c')).toBe('[data-model="a\\"b\\\\c"]');
	});
});
