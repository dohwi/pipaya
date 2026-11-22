import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, type App } from "../src/app.ts";
import type { Config } from "../src/config.ts";
import { RETIRED_EXTENSIONS } from "../src/extensions/retired.ts";
import { discoverTemplates, expandTemplate, limitTemplateText, runPromptTemplate } from "../src/templates.ts";
import { ECHO_MODEL, echoProviderBody, startEchoUpstream } from "./support/openai-upstream.ts";

describe("Prompt templates", () => {
	let dir: string;
	let home: string;
	let repo: string;
	let sub: string;

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "pipaya-templates-"));
		home = join(dir, "home");
		repo = join(dir, "repo");
		sub = join(repo, "packages", "web");
		mkdirSync(join(home, ".agents", "templates"), { recursive: true });
		mkdirSync(join(repo, ".git"), { recursive: true });
		mkdirSync(join(repo, ".agents", "templates"), { recursive: true });
		mkdirSync(join(sub, ".agents", "templates"), { recursive: true });
	});

	afterAll(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("discovers nearest project over repo root over global, marking overridden entries", () => {
		writeFileSync(join(home, ".agents", "templates", "review.md"), "---\ndescription: Global review\n---\nGlobal $ARGUMENTS\n");
		writeFileSync(join(home, ".agents", "templates", "standup.md"), "Summarize yesterday and today.\n");
		writeFileSync(join(repo, ".agents", "templates", "review.md"), "---\ndescription: Repo review\n---\nRepo $ARGUMENTS\n");
		writeFileSync(join(sub, ".agents", "templates", "review.md"), "---\ndescription: Web review\n---\nWeb $ARGUMENTS\n");

		const { templates, warnings } = discoverTemplates(sub, { home });
		expect(warnings).toEqual([]);
		const winners = templates.filter((t) => !t.overridden);
		expect(winners.map((t) => `${t.name}:${t.scope}:${t.description}`)).toEqual([
			"review:project:Web review",
			"standup:global:Summarize yesterday and today.",
		]);
		expect(templates.filter((t) => t.name === "review" && t.overridden).length).toBe(2);
	});

	test("stops at repository root and warns on invalid names or empty bodies", () => {
		mkdirSync(join(dir, ".agents", "templates"), { recursive: true });
		writeFileSync(join(dir, ".agents", "templates", "outside.md"), "Should not be discovered\n");
		writeFileSync(join(home, ".agents", "templates", "Bad_Name.md"), "Invalid name\n");
		writeFileSync(join(home, ".agents", "templates", "empty.md"), "---\ndescription: Empty\n---\n   \n");

		const { templates, warnings } = discoverTemplates(sub, { home });
		expect(templates.some((t) => t.name === "outside")).toBe(false);
		expect(warnings.some((w) => w.path.endsWith("Bad_Name.md"))).toBe(true);
		expect(warnings.some((w) => w.path.endsWith("empty.md"))).toBe(true);
	});

	test("expands $ARGUMENTS, appends when omitted, and truncates past 60k chars", () => {
		expect(expandTemplate("Review $ARGUMENTS carefully.", "src/a.ts")).toBe("Review src/a.ts carefully.");
		expect(expandTemplate("Summarize this.", "diff --git")).toBe("Summarize this.\n\ndiff --git");
		expect(expandTemplate("Hello.", "")).toBe("Hello.");
		const cut = limitTemplateText("a".repeat(60_050));
		expect(cut.endsWith("\n[cut]")).toBe(true);
		expect(cut.length).toBe(60_006);
	});

	test("runPromptTemplate resolves /prompt:name with note and title", () => {
		const res = runPromptTemplate("/prompt:review src/app.ts", sub, home);
		expect(res).toEqual({
			prompt: "Web src/app.ts",
			note: { text: "Prompt template: review", collapse: true, data: { name: "review" } },
			title: "review",
		});
		expect(runPromptTemplate("/prompt:missing foo", sub, home)).toBeNull();
	});
});

describe("templates routes & session expansion", () => {
	let app: App;
	let dir: string;
	let home: string;
	let ws: string;
	let upstream: ReturnType<typeof startEchoUpstream>;

	const api = async (method: any, url: string, payload?: unknown) => {
		const res = await app.server.inject({
			method,
			url,
			headers: { authorization: "Bearer test-token", ...(payload !== undefined ? { "content-type": "application/json" } : {}) },
			...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
		});
		return { status: res.statusCode, json: res.body ? res.json() : undefined };
	};
	const idle = async (id: string) => {
		for (let i = 0; i < 300; i++) {
			if (!(await api("GET", `/sessions/${id}/status`)).json.running) return;
			await Bun.sleep(20);
		}
		throw new Error("never idle");
	};

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), "pipaya-tpl-routes-"));
		home = join(dir, "home");
		ws = join(dir, "ws");
		mkdirSync(home, { recursive: true });
		mkdirSync(join(ws, ".git"), { recursive: true });
		mkdirSync(join(dir, "data", "extensions", "prompt-templates"), { recursive: true });
		writeFileSync(join(dir, "data", "extensions", "prompt-templates", "index.ts"), "export default () => {};");
		upstream = startEchoUpstream();
		const cfg: Config = { host: "0.0.0.0", port: 0, dataDir: join(dir, "data"), dbPath: join(dir, "db.sqlite"), token: "test-token", workspaceRoot: ws, logLevel: "silent" };
		app = await buildApp(cfg, { strictResponses: true, home });
		await api("PUT", "/configuration/providers/echo", echoProviderBody(upstream.baseUrl));
		await api("PUT", "/configuration/defaults", { provider: "echo", model: ECHO_MODEL.id });
	});

	afterAll(async () => {
		await app.close();
		upstream.stop();
		rmSync(dir, { recursive: true, force: true });
	});

	test("retires the old prompt-templates extension without loading it", async () => {
		expect(RETIRED_EXTENSIONS.has("prompt-templates")).toBe(true);
		const exts = (await api("GET", "/server-extensions")).json.extensions;
		expect(exts.some((e: any) => e.name === "prompt-templates")).toBe(false);
	});

	test("creates, updates, lists, expands in sessions, and deletes templates", async () => {
		const created = await api("POST", "/templates", {
			name: "code-review",
			scope: "global",
			description: "Review changes",
			body: "Check $ARGUMENTS for bugs.",
		});
		expect(created.status).toBe(200);
		expect(created.json.templates).toHaveLength(1);
		expect(created.json.templates[0]).toMatchObject({ name: "code-review", scope: "global", description: "Review changes", overridden: false });
		expect(readFileSync(join(home, ".agents", "templates", "code-review.md"), "utf8")).toContain("Check $ARGUMENTS for bugs.");

		// Session message expansion + note + auto-title
		const sid = (await api("POST", "/sessions", { cwd: ws })).json.id as string;
		await api("POST", `/sessions/${sid}/messages`, { text: "/prompt:code-review auth.ts" });
		await idle(sid);
		const msgs = (await api("GET", `/sessions/${sid}/messages`)).json.messages.map((m: any) => m.message);
		const user = JSON.stringify(msgs.find((m: any) => m.role === "user"));
		expect(user).toContain("Check auth.ts for bugs.");
		expect(user).toContain("<pipaya-note>");
		expect(user).toContain("/prompt:code-review auth.ts");
		expect((await api("GET", `/sessions/${sid}`)).json.title).toBe("code-review");

		// Unknown template passes through as typed
		const sid2 = (await api("POST", "/sessions", { cwd: ws })).json.id as string;
		await api("POST", `/sessions/${sid2}/messages`, { text: "/prompt:missing hi" });
		await idle(sid2);
		const msgs2 = (await api("GET", `/sessions/${sid2}/messages`)).json.messages.map((m: any) => m.message);
		const user2 = JSON.stringify(msgs2.find((m: any) => m.role === "user"));
		expect(user2).toContain("/prompt:missing hi");
		expect(user2).not.toContain("<pipaya-note>");

		const dup = await api("POST", "/templates", { name: "code-review", scope: "global", body: "Dup" });
		expect(dup.status).toBe(409);

		const proj = await api("POST", "/templates", { name: "code-review", scope: "project", body: "Project review $ARGUMENTS" });
		expect(proj.status).toBe(200);
		expect(proj.json.templates.find((t: any) => t.scope === "global").overridden).toBe(true);

		const updated = await api("PUT", "/templates/code-review", { scope: "project", description: "Updated", body: "Updated body" });
		expect(updated.status).toBe(200);
		expect(updated.json.templates.find((t: any) => t.scope === "project").description).toBe("Updated");

		const del = await api("DELETE", "/templates/code-review?scope=project");
		expect(del.status).toBe(200);
		expect(del.json.templates.find((t: any) => t.scope === "global").overridden).toBe(false);
	});
});
