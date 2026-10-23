import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, type App } from "../src/app.ts";
import type { Config } from "../src/config.ts";
import { BUILTIN_SKILLS_DIR, discoverSkills, parseFrontmatter, skillsPrompt } from "../src/skills.ts";
import { safeReadPath } from "../src/tools.ts";
import { ECHO_MODEL, echoProviderBody, startEchoUpstream } from "./support/openai-upstream.ts";

function fixture() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pipaya-skills-")));
	const home = join(root, "home");
	const repo = join(root, "repo");
	const cwd = join(repo, "packages", "app");
	mkdirSync(join(home, ".agents", "skills"), { recursive: true });
	mkdirSync(cwd, { recursive: true });
	mkdirSync(join(repo, ".git"));
	return { root, home, repo, cwd, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function skill(dir: string, name: string, fm: Record<string, string | boolean> = {}, body = "# Body\n") {
	mkdirSync(dir, { recursive: true });
	const meta = { name, description: `${name} does things. Use when needed.`, ...fm };
	const yaml = Object.entries(meta).map(([k, v]) => `${k}: ${typeof v === "string" ? JSON.stringify(v) : v}`).join("\n");
	writeFileSync(join(dir, "SKILL.md"), `---\n${yaml}\n---\n${body}`);
}

describe("skill discovery", () => {
	test("parses frontmatter, rejects missing/invalid", () => {
		expect(parseFrontmatter("---\nname: a\ndescription: >\n  x\n  y\n---\nbody")).toEqual({ name: "a", description: "x y\n" });
		expect(parseFrontmatter("no frontmatter")).toBeNull();
		expect(parseFrontmatter("---\n: : :\n  - [\n---\n")).toBeNull();
	});

	test("global + project from cwd up to the repo root; nearer wins; stops at the repo root", () => {
		const f = fixture();
		try {
			skill(join(f.home, ".agents", "skills", "alpha"), "alpha");
			skill(join(f.home, ".agents", "skills", "shared"), "shared", { description: "global one" });
			skill(join(f.cwd, ".agents", "skills", "shared"), "shared", { description: "project one" });
			skill(join(f.repo, ".agents", "skills", "beta"), "beta");
			skill(join(f.root, ".agents", "skills", "outside"), "outside"); // above the repo root
			const r = discoverSkills(f.cwd, { home: f.home, builtin: false });
			expect(r.project).toBe(f.repo);
			expect(r.skills.map((s) => [s.name, s.scope])).toEqual([["alpha", "global"], ["beta", "project"], ["shared", "project"]]);
			expect(r.skills.find((s) => s.name === "shared")!.description).toBe("project one");
			expect(r.warnings.some((w) => w.message.includes('name "shared" is already provided'))).toBe(true);
		} finally { f.cleanup(); }
	});

	test("reads the pi layout too: <project>/.pi/skills", () => {
		const f = fixture();
		try {
			skill(join(f.home, ".agents", "skills", "pi-global"), "pi-global");
			skill(join(f.home, ".agents", "skills", "std-global"), "std-global");
			skill(join(f.cwd, ".pi", "skills", "pi-project"), "pi-project");
			skill(join(f.repo, ".agents", "skills", "std-project"), "std-project");
			const r = discoverSkills(f.cwd, { home: f.home, builtin: false });
			expect(r.skills.map((s) => [s.name, s.scope])).toEqual([
				["pi-global", "global"], ["pi-project", "project"], ["std-global", "global"], ["std-project", "project"],
			]);
		} finally { f.cleanup(); }
	});

	test("global dir is not treated as a project dir when home is an ancestor of cwd; no repo => cwd bucket", () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "pipaya-skills-")));
		try {
			const home = join(root, "home");
			const cwd = join(home, "work", "x");
			mkdirSync(cwd, { recursive: true });
			skill(join(home, ".agents", "skills", "g"), "g");
			const r = discoverSkills(cwd, { home, builtin: false });
			expect(r.skills.map((s) => [s.name, s.scope])).toEqual([["g", "global"]]);
		} finally { rmSync(root, { recursive: true, force: true }); }
	});

	test("skips invalid names, missing descriptions, bad frontmatter; handles symlink loops and disable-model-invocation", () => {
		const f = fixture();
		try {
			const g = join(f.home, ".agents", "skills");
			skill(join(g, "Bad_Name"), "Bad_Name");
			skill(join(g, "nodesc"), "nodesc", { description: "" });
			mkdirSync(join(g, "plain"));
			writeFileSync(join(g, "plain", "SKILL.md"), "# no frontmatter");
			skill(join(g, "manual"), "manual", { "disable-model-invocation": true });
			skill(join(g, "nested", "deep"), "deep");
			symlinkSync(g, join(g, "nested", "loop"));
			const r = discoverSkills(f.cwd, { home: f.home, builtin: false });
			expect(r.skills.map((s) => s.name)).toEqual(["deep", "manual"]);
			expect(r.skills.find((s) => s.name === "manual")!.modelInvocable).toBe(false);
			expect(r.warnings.length).toBe(3);
		} finally { f.cleanup(); }
	});

	test("prompt block is one compact line per skill", () => {
		const text = skillsPrompt([{ name: "a", description: "x\n y", path: "/s/a/SKILL.md", baseDir: "/s/a", scope: "global" }]);
		expect(text).toContain("- a: x y (/s/a/SKILL.md)");
	});
});

describe("read tool allow-list", () => {
	test("reads inside skill roots (and, with the restriction disabled, anywhere else)", () => {
		expect(safeReadPath("/w", "a.txt", [])).toBe("/w/a.txt");
		expect(safeReadPath("/w", "/s/a/SKILL.md", ["/s/a"])).toBe("/s/a/SKILL.md");
		expect(safeReadPath("/w", "/s/a/ref/x.md", ["/s/a"])).toBe("/s/a/ref/x.md");
		expect(safeReadPath("/w", "/s/b/SKILL.md", ["/s/a"])).toBe("/s/b/SKILL.md");
		expect(safeReadPath("/w", "/s/a/../b/x", ["/s/a"])).toBe("/s/b/x");
	});
});

describe("skills API", () => {
	test("list/toggle global+project, auth, validation, events; applies to running sessions on the next message", async () => {
		const f = fixture();
		const upstream = startEchoUpstream();
		const cfg: Config = { host: "0.0.0.0", port: 0, dataDir: f.root, dbPath: join(f.root, "app.db"),
			token: "skills-test", workspaceRoot: f.cwd, approvalTimeoutMs: 0, logLevel: "silent" };
		let app: App = await buildApp(cfg, { strictResponses: true, home: f.home, builtinSkills: false });
		const api = async (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: object, authorized = true) => {
			const res = await app.server.inject({ method, url, payload, headers: authorized ? { authorization: `Bearer ${cfg.token}` } : {} });
			return { status: res.statusCode, json: res.body ? res.json() : undefined };
		};
		const q = (extra = "") => `/skills?cwd=${encodeURIComponent(f.cwd)}${extra}`;
		try {
			skill(join(f.home, ".agents", "skills", "alpha"), "alpha");
			skill(join(f.repo, ".agents", "skills", "beta"), "beta");
			skill(join(f.repo, ".agents", "skills", "manual"), "manual", { "disable-model-invocation": true });
			expect((await api("GET", q(), undefined, false)).status).toBe(401);
			const missing = join(f.cwd, "not", "created", "yet");
			expect((await api("GET", `/skills?cwd=${encodeURIComponent(missing)}`)).json.cwd).toBe(f.cwd);
			writeFileSync(join(f.root, "file.txt"), "x");
			expect((await api("GET", `/skills?cwd=${encodeURIComponent(join(f.root, "file.txt"))}`)).json.cwd).toBe(f.root);

			const first = (await api("GET", q())).json;
			expect(first.skills.map((s: any) => [s.name, s.enabled])).toEqual([["alpha", true], ["beta", true], ["manual", true]]);
			expect(JSON.stringify(first)).not.toContain("baseDir");

			expect((await api("PUT", "/skills/nope", { scope: "global", enabled: false, cwd: f.cwd })).status).toBe(404);
			expect((await api("PUT", "/skills/Bad%20Name", { scope: "global", enabled: false, cwd: f.cwd })).status).toBe(400);
			expect((await api("PUT", "/skills/alpha", { scope: "global", enabled: null, cwd: f.cwd })).status).toBe(400);

			const off = (await api("PUT", "/skills/alpha", { scope: "global", enabled: false, cwd: f.cwd })).json;
			expect(off.skills.find((s: any) => s.name === "alpha")).toMatchObject({ enabled: false, globalEnabled: false, override: null });
			const forced = (await api("PUT", "/skills/alpha", { scope: "project", enabled: true, cwd: f.cwd })).json;
			expect(forced.skills.find((s: any) => s.name === "alpha")).toMatchObject({ enabled: true, globalEnabled: false, override: true });
			await api("PUT", "/skills/beta", { scope: "project", enabled: false, cwd: f.cwd });

			// Another project is unaffected by this project's overrides.
			const other = join(f.root, "other");
			mkdirSync(other);
			expect((await api("GET", `/skills?cwd=${encodeURIComponent(other)}`)).json.skills.find((s: any) => s.name === "alpha").enabled).toBe(false);

			const events = (await api("GET", "/events/history?limit=50")).json.events.filter((e: any) => e.type === "skills_updated");
			expect(events.length).toBe(3);
			expect(events[0].data).toMatchObject({ name: "alpha", scope: "global" });

			// Settings survive a restart.
			await app.close();
			app = await buildApp(cfg, { strictResponses: true, home: f.home, builtinSkills: false });
			const again = (await api("GET", q())).json;
			expect(again.skills.map((s: any) => [s.name, s.enabled, s.override])).toEqual([["alpha", true, true], ["beta", false, false], ["manual", true, null]]);

			// New sessions advertise enabled, model-invocable skills only.
			expect((await api("PUT", "/configuration/providers/echo", echoProviderBody(upstream.baseUrl))).status).toBe(200);
			expect((await api("PUT", "/configuration/defaults", { provider: "echo", model: ECHO_MODEL.id })).status).toBe(200);
			const id = (await api("POST", "/sessions", { cwd: f.cwd, tools: ["read"], systemPrompt: "Base" })).json.id as string;
			const preview = (await api("GET", `/sessions/${id}/context`)).json;
			expect(preview.skills.map((s: any) => s.name)).toEqual(["alpha"]);
			expect(preview.effectiveSystemPrompt).toContain("<available_skills>");
			expect(preview.effectiveSystemPrompt).toContain(join(f.home, ".agents", "skills", "alpha", "SKILL.md"));
			expect(preview.effectiveSystemPrompt).not.toContain("beta");

			expect((await api("POST", `/sessions/${id}/messages`, { text: "hi" })).status).toBe(202);
			await app.sessions.idle();
			expect(upstream.requests.at(-1)?.body.messages[0].content).toBe(preview.effectiveSystemPrompt);

			// Toggling afterwards is reflected right away in the context view and on the very next message.
			await api("PUT", "/skills/alpha", { scope: "project", enabled: false, cwd: f.cwd });
			const applied = (await api("GET", `/sessions/${id}/context`)).json;
			expect(applied.state).toBe("applied");
			expect(applied.skills).toEqual([]);
			expect(applied.effectiveSystemPrompt).not.toContain("available_skills");
			expect((await api("POST", `/sessions/${id}/messages`, { text: "again" })).status).toBe(202);
			await app.sessions.idle();
			expect(upstream.requests.at(-1)?.body.messages[0].content).toBe(applied.effectiveSystemPrompt);
			expect(upstream.requests.at(-1)?.body.messages[0].content).not.toContain("alpha");
			// ...and back on again.
			await api("PUT", "/skills/alpha", { scope: "project", enabled: null, cwd: f.cwd });
			await api("PUT", "/skills/alpha", { scope: "global", enabled: true, cwd: f.cwd });
			expect((await api("POST", `/sessions/${id}/messages`, { text: "third" })).status).toBe(202);
			await app.sessions.idle();
			expect(upstream.requests.at(-1)?.body.messages[0].content).toContain("- alpha: ");
			await api("PUT", "/skills/alpha", { scope: "project", enabled: false, cwd: f.cwd });
			const id2 = (await api("POST", "/sessions", { cwd: f.cwd, tools: ["read"] })).json.id as string;
			const fresh = (await api("GET", `/sessions/${id2}/context`)).json;
			expect(fresh.skills).toEqual([]);
			expect(fresh.effectiveSystemPrompt).not.toContain("available_skills");

			// Without the read tool a skill cannot be loaded, so none is advertised.
			const id3 = (await api("POST", "/sessions", { cwd: f.cwd, tools: ["ls"] })).json.id as string;
			await api("PUT", "/skills/alpha", { scope: "project", enabled: null, cwd: f.cwd });
			await api("PUT", "/skills/alpha", { scope: "global", enabled: true, cwd: f.cwd });
			expect((await api("GET", `/sessions/${id3}/context`)).json.skills).toEqual([]);
		} finally {
			await app.close();
			upstream.stop();
			f.cleanup();
		}
	});
});

describe("session-scoped skill overrides", () => {
	test("apply to one session only, win over project/global, validate input, die with the session", async () => {
		const f = fixture();
		const upstream = startEchoUpstream();
		const cfg: Config = { host: "0.0.0.0", port: 0, dataDir: f.root, dbPath: join(f.root, "app.db"),
			token: "skills-test", workspaceRoot: f.cwd, approvalTimeoutMs: 0, logLevel: "silent" };
		const app: App = await buildApp(cfg, { strictResponses: true, home: f.home, builtinSkills: false });
		const api = async (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: object) => {
			const res = await app.server.inject({ method, url, payload, headers: { authorization: `Bearer ${cfg.token}` } });
			return { status: res.statusCode, json: res.body ? res.json() : undefined };
		};
		const names = async (id: string) => (await api("GET", `/sessions/${id}/context`)).json.skills.map((k: any) => k.name);
		try {
			skill(join(f.home, ".agents", "skills", "alpha"), "alpha");
			expect((await api("PUT", "/configuration/providers/echo", echoProviderBody(upstream.baseUrl))).status).toBe(200);
			expect((await api("PUT", "/configuration/defaults", { provider: "echo", model: ECHO_MODEL.id })).status).toBe(200);
			const a = (await api("POST", "/sessions", { cwd: f.cwd, tools: ["read"] })).json.id as string;
			const b = (await api("POST", "/sessions", { cwd: f.cwd, tools: ["read"] })).json.id as string;
			const put = (id: string | undefined, enabled: boolean | null) =>
				api("PUT", "/skills/alpha", { scope: "session", enabled, cwd: f.cwd, ...(id ? { sessionId: id } : {}) });

			expect((await put(undefined, false)).status).toBe(400);
			expect((await put("no-such-session", false)).status).toBe(404);

			const off = (await put(a, false)).json;
			expect(off.skills[0]).toMatchObject({ enabled: false, globalEnabled: true, override: null, sessionOverride: false });
			expect(await names(a)).toEqual([]);
			expect(await names(b)).toEqual(["alpha"]);
			// Without sessionId the list ignores session overrides.
			expect((await api("GET", `/skills?cwd=${encodeURIComponent(f.cwd)}`)).json.skills[0]).toMatchObject({ enabled: true, sessionOverride: null });
			expect((await api("GET", `/skills?cwd=${encodeURIComponent(f.cwd)}&sessionId=${a}`)).json.skills[0]).toMatchObject({ enabled: false, sessionOverride: false });

			// Session override beats a project override that says the opposite; removing it falls back.
			await api("PUT", "/skills/alpha", { scope: "global", enabled: false, cwd: f.cwd });
			expect((await put(a, true)).json.skills[0]).toMatchObject({ enabled: true, globalEnabled: false, sessionOverride: true });
			expect(await names(a)).toEqual(["alpha"]);
			expect(await names(b)).toEqual([]);
			expect((await put(a, null)).json.skills[0]).toMatchObject({ enabled: false, sessionOverride: null });

			// Deleting the session removes its overrides.
			await put(b, true);
			expect((await api("DELETE", `/sessions/${b}`)).status).toBe(204);
			const raw = new (await import("bun:sqlite")).Database(cfg.dbPath, { readonly: true, strict: true });
			try {
				expect(raw.query("SELECT COUNT(*) AS n FROM session_skills WHERE session_id = $id").get({ id: b })).toEqual({ n: 0 });
				expect(raw.query("SELECT COUNT(*) AS n FROM session_skills WHERE session_id = $id").get({ id: a })).toEqual({ n: 0 });
			} finally { raw.close(); }
		} finally {
			await app.close();
			upstream.stop();
			f.cleanup();
		}
	});
});

describe("skill injection end to end", () => {
	test("model sees the enabled skills and can read them outside cwd; follows on/off changes live (also after eviction/restart/fork); nothing else leaks", async () => {
		const f = fixture();
		const upstream = startEchoUpstream();
		const cfg: Config = { host: "0.0.0.0", port: 0, dataDir: f.root, dbPath: join(f.root, "app.db"),
			token: "e2e", workspaceRoot: f.cwd, approvalTimeoutMs: 0, logLevel: "silent" };
		const open = () => buildApp(cfg, { strictResponses: true, home: f.home, builtinSkills: false });
		let app: App = await open();
		const api = async (method: "GET" | "POST" | "PUT", url: string, payload?: object) => {
			const res = await app.server.inject({ method, url, payload, headers: { authorization: `Bearer ${cfg.token}` } });
			return { status: res.statusCode, json: res.body ? res.json() : undefined };
		};
		const send = async (id: string, text: string) => {
			expect((await api("POST", `/sessions/${id}/messages`, { text })).status).toBe(202);
			await app.sessions.idle();
		};
		const lastToolResult = (id: string) => (api("GET", `/sessions/${id}/messages`) as Promise<any>)
			.then((r) => JSON.stringify(r.json).includes("SECRET-SKILL-BODY"));
		try {
			const dir = join(f.home, ".agents", "skills", "secret-skill");
			skill(dir, "secret-skill", {}, "SECRET-SKILL-BODY\n");
			mkdirSync(join(dir, "ref"));
			writeFileSync(join(dir, "ref", "more.md"), "REFERENCE-BODY");
			skill(join(f.home, ".agents", "skills", "off-skill"), "off-skill", {}, "OFF-BODY\n");
			writeFileSync(join(f.root, "private.txt"), "PRIVATE");
			await api("PUT", "/skills/off-skill", { scope: "global", enabled: false, cwd: f.cwd });
			await api("PUT", "/configuration/providers/echo", echoProviderBody(upstream.baseUrl));
			await api("PUT", "/configuration/defaults", { provider: "echo", model: ECHO_MODEL.id });

			const id = (await api("POST", "/sessions", { cwd: f.cwd })).json.id as string; // default tools include read
			const skillFile = join(dir, "SKILL.md");
			await send(id, `!read ${JSON.stringify({ path: skillFile })}`);

			// The model received the enabled skill and not the disabled one.
			const system = upstream.requests[0]!.body.messages[0].content as string;
			expect(system).toContain("<available_skills>");
			expect(system).toContain(`(${skillFile})`);
			expect(system).not.toContain("off-skill");
			// ...and reading it outside the working directory worked, including its bundled references.
			expect(await lastToolResult(id)).toBe(true);
			await send(id, `!read ${JSON.stringify({ path: join(dir, "ref", "more.md") })}`);
			expect(JSON.stringify((await api("GET", `/sessions/${id}/messages`)).json)).toContain("REFERENCE-BODY");

			// (Reads outside cwd are no longer blocked: the restriction is disabled, so there is nothing to assert here.)

			// Turning the skill off applies to this same session on its next message: not advertised, not readable.
			await api("PUT", "/skills/secret-skill", { scope: "global", enabled: false, cwd: f.cwd });
			expect((await api("GET", `/sessions/${id}/context`)).json.skills).toEqual([]);
			await send(id, `!read ${JSON.stringify({ path: skillFile })}`);
			expect(upstream.requests.at(-1)!.body.messages[0].content).not.toContain("secret-skill");

			// Same after the session was evicted from memory and the server restarted (settings live in the DB).
			await api("PUT", "/skills/secret-skill", { scope: "global", enabled: true, cwd: f.cwd });
			const manager = app.sessions as unknown as { live: Map<string, { lastActive: number }>; evictIdle(): void };
			manager.live.get(id)!.lastActive = 0;
			manager.evictIdle();
			await app.close();
			app = await open();
			await send(id, `!read ${JSON.stringify({ path: skillFile })}`);
			expect(upstream.requests.at(-1)!.body.messages[0].content).toBe(system);

			// Turning it off while the session is cold, then restarting, also holds.
			await api("PUT", "/skills/secret-skill", { scope: "project", enabled: false, cwd: f.cwd });
			await app.close();
			app = await open();
			await send(id, "cold");
			expect(upstream.requests.at(-1)!.body.messages[0].content).not.toContain("secret-skill");

			// A fork follows the current settings too; so does a brand-new session.
			const fork = (await api("POST", `/sessions/${id}/fork`, { atSeq: 0 })).json.id as string;
			expect((await api("GET", `/sessions/${fork}/context`)).json.skills).toEqual([]);
			await api("PUT", "/skills/secret-skill", { scope: "project", enabled: null, cwd: f.cwd });
			expect((await api("GET", `/sessions/${fork}/context`)).json.skills.map((k: any) => k.name)).toEqual(["secret-skill"]);
			await send(fork, `!read ${JSON.stringify({ path: skillFile })}`);
			expect(JSON.stringify((await api("GET", `/sessions/${fork}/messages`)).json)).toContain("SECRET-SKILL-BODY");
			const fresh = (await api("POST", "/sessions", { cwd: f.cwd })).json.id as string;
			expect((await api("GET", `/sessions/${fresh}/context`)).json.skills.map((k: any) => k.name)).toEqual(["secret-skill"]);
		} finally {
			await app.close();
			upstream.stop();
			f.cleanup();
		}
	});
});

describe("skills picked up from disk without restarting", () => {
	test("a skill created, edited or deleted while a session is live shows up on the next message", async () => {
		const f = fixture();
		const upstream = startEchoUpstream();
		const cfg: Config = { host: "0.0.0.0", port: 0, dataDir: f.root, dbPath: join(f.root, "app.db"),
			token: "disk", workspaceRoot: f.cwd, approvalTimeoutMs: 0, logLevel: "silent" };
		const app: App = await buildApp(cfg, { strictResponses: true, home: f.home, builtinSkills: false });
		const api = async (method: "GET" | "POST" | "PUT", url: string, payload?: object) => {
			const res = await app.server.inject({ method, url, payload, headers: { authorization: `Bearer ${cfg.token}` } });
			return { status: res.statusCode, json: res.body ? res.json() : undefined };
		};
		const send = async (id: string, text: string) => {
			expect((await api("POST", `/sessions/${id}/messages`, { text })).status).toBe(202);
			await app.sessions.idle();
			return upstream.requests.at(-1)!.body.messages[0].content as string;
		};
		try {
			await api("PUT", "/configuration/providers/echo", echoProviderBody(upstream.baseUrl));
			await api("PUT", "/configuration/defaults", { provider: "echo", model: ECHO_MODEL.id });
			const id = (await api("POST", "/sessions", { cwd: f.cwd })).json.id as string;
			const global = join(f.home, ".agents", "skills");

			expect(await send(id, "one")).not.toContain("available_skills");

			skill(join(global, "fresh-skill"), "fresh-skill", { description: "first description" });
			const added = await send(id, "two");
			expect(added).toContain("- fresh-skill: ");
			expect(added).toContain("first description");
			expect((await api("GET", `/sessions/${id}/context`)).json.skills.map((k: any) => k.name)).toEqual(["fresh-skill"]);

			// Unchanged skills leave the prompt byte-identical (prompt cache stays valid).
			expect(await send(id, "three")).toBe(added);

			skill(join(global, "fresh-skill"), "fresh-skill", { description: "second description" });
			const edited = await send(id, "four");
			expect(edited).toContain("second description");
			expect(edited).not.toContain("first description");

			skill(join(f.cwd, ".agents", "skills", "proj-skill"), "proj-skill");
			expect(await send(id, "five")).toContain("- proj-skill: ");

			rmSync(join(global, "fresh-skill"), { recursive: true });
			const removed = await send(id, "six");
			expect(removed).not.toContain("fresh-skill");
			expect(removed).toContain("proj-skill");

			// The conversation history keeps exactly one system message; nothing piles up.
			const sys = ((await api("GET", `/sessions/${id}/messages`)).json.messages as any[]).filter((m) => m.role === "system");
			expect(sys.length).toBeLessThanOrEqual(1);
		} finally {
			await app.close();
			upstream.stop();
			f.cleanup();
		}
	});
});

describe("built-in skills", () => {
	const BUILTIN = "pipaya-client-extensions";

	test("ship with the server: valid, lowest priority, referenced docs exist", () => {
		const f = fixture();
		try {
			const r = discoverSkills(f.cwd, { home: f.home });
			expect(r.warnings).toEqual([]);
			const builtin = r.skills.find((s) => s.name === BUILTIN)!;
			expect(builtin).toMatchObject({ scope: "builtin", modelInvocable: true });
			expect(builtin.path.startsWith(BUILTIN_SKILLS_DIR)).toBe(true);
			const body = readFileSync(builtin.path, "utf8");
			const refs = [...body.matchAll(/`(references\/[\w.-]+\.md)`/g)].map((m) => m[1]!);
			expect(refs.length).toBeGreaterThan(0);
			for (const ref of new Set(refs)) expect(existsSync(join(builtin.baseDir, ref))).toBe(true);
		} finally {
			f.cleanup();
		}
	});

	test("pipaya-usage ships with valid frontmatter and existing references", () => {
		const f = fixture();
		try {
			const r = discoverSkills(f.cwd, { home: f.home });
			expect(r.warnings).toEqual([]);
			const usage = r.skills.find((s) => s.name === "pipaya-usage")!;
			expect(usage).toMatchObject({ scope: "builtin", modelInvocable: true });
			const refs = [...readFileSync(usage.path, "utf8").matchAll(/`(references\/[\w.-]+\.md)`/g)].map((m) => m[1]!);
			expect(refs.length).toBeGreaterThan(0);
			for (const ref of new Set(refs)) expect(existsSync(join(usage.baseDir, ref))).toBe(true);
		} finally {
			f.cleanup();
		}
	});

	test("a global or project skill with the same name wins without a warning", () => {
		const f = fixture();
		try {
			skill(join(f.home, ".agents", "skills", BUILTIN), BUILTIN, { description: "my override" });
			const r = discoverSkills(f.cwd, { home: f.home });
			expect(r.warnings).toEqual([]);
			expect(r.skills.find((s) => s.name === BUILTIN)).toMatchObject({ scope: "global", description: "my override" });
			expect(discoverSkills(f.cwd, { home: f.home, builtin: false }).skills.some((s) => s.name === BUILTIN)).toBe(true);
		} finally {
			f.cleanup();
		}
	});

	test("on by default in any directory, advertised to the model, readable outside cwd, can be switched off", async () => {
		const f = fixture();
		const upstream = startEchoUpstream();
		const cfg: Config = { host: "0.0.0.0", port: 0, dataDir: f.root, dbPath: join(f.root, "app.db"),
			token: "builtin", workspaceRoot: f.cwd, approvalTimeoutMs: 0, logLevel: "silent" };
		const app: App = await buildApp(cfg, { strictResponses: true, home: f.home });
		const api = async (method: "GET" | "POST" | "PUT", url: string, payload?: object) => {
			const res = await app.server.inject({ method, url, payload, headers: { authorization: `Bearer ${cfg.token}` } });
			return { status: res.statusCode, json: res.body ? res.json() : undefined };
		};
		const send = async (id: string, text: string) => {
			expect((await api("POST", `/sessions/${id}/messages`, { text })).status).toBe(202);
			await app.sessions.idle();
		};
		try {
			await api("PUT", "/configuration/providers/echo", echoProviderBody(upstream.baseUrl));
			await api("PUT", "/configuration/defaults", { provider: "echo", model: ECHO_MODEL.id });
			const listed = (await api("GET", `/skills?cwd=${encodeURIComponent(f.cwd)}`)).json;
			expect(listed.warnings).toEqual([]);
			expect(listed.skills.find((s: any) => s.name === BUILTIN)).toMatchObject({ scope: "builtin", enabled: true, globalEnabled: true, override: null });

			const id = (await api("POST", "/sessions", { cwd: f.cwd })).json.id as string;
			expect((await api("GET", `/sessions/${id}/context`)).json.skills.map((k: any) => [k.name, k.scope])).toEqual([[BUILTIN, "builtin"], ["pipaya-server-extensions", "builtin"], ["pipaya-usage", "builtin"]]);
			await send(id, "hi");
			expect(JSON.stringify((await api("GET", `/sessions/${id}/context`)).json.effectiveSystemPrompt)).toContain(`- ${BUILTIN}: `);

			const file = join(BUILTIN_SKILLS_DIR, BUILTIN, "references", "extension-architecture.md");
			await send(id, `!read ${JSON.stringify({ path: file })}`);
			expect(JSON.stringify((await api("GET", `/sessions/${id}/messages`)).json)).toContain("확장 구조와 변경 가이드");

			await api("PUT", `/skills/${BUILTIN}`, { scope: "global", enabled: false, cwd: f.cwd });
			expect((await api("GET", `/sessions/${id}/context`)).json.skills).toEqual([expect.objectContaining({ name: "pipaya-server-extensions" }), expect.objectContaining({ name: "pipaya-usage" })]);
			await api("PUT", `/skills/${BUILTIN}`, { scope: "global", enabled: true, cwd: f.cwd });
			expect((await api("GET", `/sessions/${id}/context`)).json.skills.map((k: any) => k.name)).toEqual([BUILTIN, "pipaya-server-extensions", "pipaya-usage"]);
		} finally {
			await app.close();
			upstream.stop();
			f.cleanup();
		}
	});
});
