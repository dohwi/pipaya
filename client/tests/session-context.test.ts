import { describe, expect, test } from "bun:test";
import { Api } from "../src/lib/api";
import type { SessionContext } from "../src/lib/types";

const snapshot: SessionContext = {
	cwd: "/workspace/project", state: "applied", capturedAt: 1000,
	systemPrompt: "base", effectiveSystemPrompt: "base\nproject instructions",
	instructions: [{ path: "/workspace/project/AGENTS.md", scope: "cwd", content: "project instructions", bytes: 20 }],
	warnings: [], tools: ["read"], skills: [], agents: [], skillsPrompt: "", agentsPrompt: "",
	readFiles: [{ path: "/workspace/project/src/index.ts", reads: 1, lastReadAt: 2000, ranges: [{ from: 1, to: 20 }] }],
};

describe("session context REST contract", () => {
	test("loads the server snapshot with authentication, encoded ID and cancellation", async () => {
		const original = globalThis.fetch;
		let url = "";
		let request: RequestInit | undefined;
		globalThis.fetch = (async (input, init) => {
			url = String(input);
			request = init;
			return Response.json(snapshot);
		}) as typeof fetch;
		try {
			const controller = new AbortController();
			const api = new Api({ baseUrl: "http://100.64.0.1:8787", token: "secret" });
			expect(await api.sessionContext("id/with space", controller.signal)).toEqual(snapshot);
			expect(url).toBe("http://100.64.0.1:8787/sessions/id%2Fwith%20space/context");
			expect(request?.method).toBe("GET");
			expect(request?.headers).toEqual({ Authorization: "Bearer secret", "X-Pipaya-Protocol": "1" });
			expect(request?.body).toBeUndefined();
			expect(request?.signal).toBe(controller.signal);
		} finally { globalThis.fetch = original; }
	});

	test("propagates unsupported endpoint errors, never fabricates applied instructions", async () => {
		const original = globalThis.fetch;
		globalThis.fetch = (async () => Response.json({ error: { code: "not_found", message: "route not found" } }, { status: 404 })) as typeof fetch;
		try {
			const api = new Api({ baseUrl: "http://100.64.0.1:8787", token: "secret" });
			await expect(api.sessionContext("session")).rejects.toMatchObject({ status: 404, code: "not_found" });
		} finally { globalThis.fetch = original; }
	});
});

describe("skills REST contract", () => {
	const list = { cwd: "/w/p", project: "/w", warnings: [], skills: [] };
	const capture = async (run: (api: Api) => Promise<unknown>) => {
		const original = globalThis.fetch;
		const seen: { url: string; init?: RequestInit }[] = [];
		globalThis.fetch = (async (input, init) => { seen.push({ url: String(input), init }); return Response.json(list); }) as typeof fetch;
		try {
			await run(new Api({ baseUrl: "http://100.64.0.1:8787", token: "secret" }));
			return seen;
		} finally { globalThis.fetch = original; }
	};

	test("lists skills for a directory with authentication and cancellation", async () => {
		const controller = new AbortController();
		const [call] = await capture(api => api.skills("/w/my project", controller.signal));
		expect(call!.url).toBe("http://100.64.0.1:8787/skills?cwd=%2Fw%2Fmy+project");
		expect(call!.init?.method).toBe("GET");
		expect(call!.init?.signal).toBe(controller.signal);
		expect((call!.init!.headers as Record<string, string>).Authorization).toBe("Bearer secret");
		expect((await capture(api => api.skills()))[0]!.url).toBe("http://100.64.0.1:8787/skills");
	});

	test("toggles global and project scope; null clears a project override; names are encoded", async () => {
		const seen = await capture(async api => {
			await api.setSkill("pdf-tools", { scope: "global", enabled: false, cwd: "/w/p" });
			await api.setSkill("a/b", { scope: "project", enabled: null });
		});
		expect(seen[0]!.url).toBe("http://100.64.0.1:8787/skills/pdf-tools");
		expect(seen[0]!.init?.method).toBe("PUT");
		expect(JSON.parse(String(seen[0]!.init?.body))).toEqual({ scope: "global", enabled: false, cwd: "/w/p" });
		expect(seen[1]!.url).toBe("http://100.64.0.1:8787/skills/a%2Fb");
		expect(JSON.parse(String(seen[1]!.init?.body))).toEqual({ scope: "project", enabled: null });
	});
});
