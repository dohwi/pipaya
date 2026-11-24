import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { compileModule } from "svelte/compiler";
import ts from "typescript";
import type { CloseHold, SessionCloseGuard as SessionCloseGuardType } from "../src/lib/session-close-guard.svelte";

let SessionCloseGuard: typeof SessionCloseGuardType;
let dir: string;

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "pipaya-close-guard-"));
	const srcPath = resolve("src/lib/session-close-guard.svelte.ts");
	const build = await Bun.build({
		entrypoints: [srcPath],
		target: "bun",
		plugins: [
			{
				name: "runes",
				setup(builder) {
					builder.onLoad({ filter: /session-close-guard\.svelte\.ts$/ }, async ({ path }) => {
						const raw = await Bun.file(path).text();
						const transpiled = ts.transpileModule(raw, {
							compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
						}).outputText;
						return { contents: compileModule(transpiled, { filename: path, generate: "client" }).js.code, loader: "js" };
					});
				},
			},
		],
	});
	if (!build.success) throw new Error(build.logs.join("\n"));
	const file = join(dir, "session-close-guard.mjs");
	await writeFile(file, await build.outputs[0]!.text());
	SessionCloseGuard = (await import(file)).SessionCloseGuard;
});

afterAll(async () => {
	if (dir) await rm(dir, { recursive: true, force: true });
});

describe("SessionCloseGuard (multi-server)", () => {
	test("idle session closes immediately without prompt and forwards serverId", async () => {
		const seen: [string, string][] = [];
		const guard = new SessionCloseGuard(
			(id, serverId) => {
				seen.push([id, serverId]);
				return null;
			},
			() => "unused",
		);
		expect(await guard.request("s1", "srv-a")).toBe(true);
		expect(seen).toEqual([["s1", "srv-a"]]);
		expect(guard.ask).toBeNull();
	});

	test("working session asks with its own serverId and title, rejects concurrent requests, and settles once", async () => {
		const holds: Record<string, CloseHold> = { "srv-a:s1": "working", "srv-b:s1": "asking" };
		const titles: Record<string, string> = { "srv-a:s1": "Alpha", "srv-b:s1": "Beta" };
		const guard = new SessionCloseGuard(
			(id, sid) => holds[`${sid}:${id}`] ?? null,
			(id, sid) => titles[`${sid}:${id}`] ?? "",
		);

		const p = guard.request("s1", "srv-b");
		expect(guard.ask?.serverId).toBe("srv-b");
		expect(guard.ask?.title).toBe("Beta");
		expect(guard.ask?.hold).toBe("asking");

		// A second close request while the first dialog is open is refused rather than queued.
		expect(await guard.request("s1", "srv-a")).toBe(false);

		const ask = guard.ask!;
		ask.confirm();
		ask.cancel(); // duplicate settle is a no-op
		expect(await p).toBe(true);
		expect(guard.ask).toBeNull();
	});

	test("cancelServer cancels only a confirmation belonging to the removed server", async () => {
		const guard = new SessionCloseGuard(
			() => "working",
			(id, sid) => `${sid}/${id}`,
		);
		const p = guard.request("s1", "srv-a");
		guard.cancelServer("srv-b");
		expect(guard.ask).not.toBeNull();

		guard.cancelServer("srv-a");
		expect(await p).toBe(false);
		expect(guard.ask).toBeNull();
	});

	test("pinned conversation and terminal holds prompt and cancelTarget cancels only the matching tab", async () => {
		const holds: Record<string, CloseHold> = {
			"srv-a:s1": "pinned",
			"srv-a:term-1": "pinned-terminal",
		};
		const titles: Record<string, string> = {
			"srv-a:s1": "Pinned chat",
			"srv-a:term-1": "zsh",
		};
		const guard = new SessionCloseGuard(
			(id, sid) => holds[`${sid}:${id}`] ?? null,
			(id, sid) => titles[`${sid}:${id}`] ?? "",
		);

		const p1 = guard.request("s1", "srv-a");
		expect(guard.ask?.hold).toBe("pinned");
		expect(guard.ask?.title).toBe("Pinned chat");
		guard.cancelTarget("srv-b", "s1");
		guard.cancelTarget("srv-a", "other");
		expect(guard.ask).not.toBeNull();
		guard.cancelTarget("srv-a", "s1");
		expect(await p1).toBe(false);
		expect(guard.ask).toBeNull();

		const p2 = guard.request("term-1", "srv-a");
		expect(guard.ask?.hold).toBe("pinned-terminal");
		expect(guard.ask?.title).toBe("zsh");
		guard.ask!.confirm();
		expect(await p2).toBe(true);
		expect(guard.ask).toBeNull();
	});
});
