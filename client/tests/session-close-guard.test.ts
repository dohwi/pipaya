import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { compileModule } from "svelte/compiler";
import ts from "typescript";
import type {
	CloseHold,
	CloseHoldInput,
	decideCloseHold as decideCloseHoldType,
	SessionCloseGuard as SessionCloseGuardType,
} from "../src/lib/session-close-guard.svelte";

let SessionCloseGuard: typeof SessionCloseGuardType;
let decideCloseHold: typeof decideCloseHoldType;
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
	const mod = await import(file);
	SessionCloseGuard = mod.SessionCloseGuard;
	decideCloseHold = mod.decideCloseHold;
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

	test("scheduled hold carries scheduledCount and pinned details, including combinations with working/asking", async () => {
		const holds: Record<string, CloseHoldInput> = {
			"srv-a:s1": { hold: "scheduled", scheduledCount: 2, pinned: false },
			"srv-a:s2": { hold: "scheduled", scheduledCount: 1, pinned: true },
			"srv-a:s3": { hold: "working", scheduledCount: 3, pinned: false },
			"srv-a:s4": { hold: "scheduled", scheduledCount: -2 },
		};
		const guard = new SessionCloseGuard(
			(id, sid) => holds[`${sid}:${id}`] ?? null,
			(id) => `Title ${id}`,
		);

		const p1 = guard.request("s1", "srv-a");
		expect(guard.ask?.hold).toBe("scheduled");
		expect(guard.ask?.scheduledCount).toBe(2);
		expect(guard.ask?.pinned).toBe(false);
		guard.ask!.cancel();
		expect(await p1).toBe(false);

		const p2 = guard.request("s2", "srv-a");
		expect(guard.ask?.hold).toBe("scheduled");
		expect(guard.ask?.scheduledCount).toBe(1);
		expect(guard.ask?.pinned).toBe(true);
		guard.ask!.confirm();
		expect(await p2).toBe(true);

		const p3 = guard.request("s3", "srv-a");
		expect(guard.ask?.hold).toBe("working");
		expect(guard.ask?.scheduledCount).toBe(3);
		expect(guard.ask?.pinned).toBe(false);
		guard.ask!.cancel();
		expect(await p3).toBe(false);

		const p4 = guard.request("s4", "srv-a");
		expect(guard.ask?.hold).toBe("scheduled");
		expect(guard.ask?.scheduledCount).toBe(0);
		expect(guard.ask?.pinned).toBe(false);
		guard.ask!.cancel();
		expect(await p4).toBe(false);
	});

	test("async holdOf blocks concurrent requests, settles null/hold, and respects cancelTarget/cancelServer mid-flight", async () => {
		let calls = 0;
		let finish!: (v: CloseHoldInput) => void;
		const guard = new SessionCloseGuard(
			() => {
				calls++;
				return new Promise<CloseHoldInput>((resolve) => {
					finish = resolve;
				});
			},
			(id) => `Chat ${id}`,
		);

		// Concurrent request while async lookup is pending is refused without calling holdOf again.
		const p1 = guard.request("s1", "srv-a");
		expect(calls).toBe(1);
		expect(guard.ask).toBeNull();
		expect(await guard.request("s2", "srv-a")).toBe(false);
		expect(calls).toBe(1);

		// Non-matching cancels leave pending intact.
		guard.cancelServer("srv-b");
		guard.cancelTarget("srv-a", "s2");
		finish({ hold: "scheduled", scheduledCount: 1 });
		await new Promise((r) => setTimeout(r, 0));
		expect(guard.ask?.hold).toBe("scheduled");
		expect(guard.ask?.scheduledCount).toBe(1);
		guard.ask!.confirm();
		expect(await p1).toBe(true);

		// cancelTarget during in-flight async lookup prevents opening a stale dialog.
		const p2 = guard.request("s1", "srv-a");
		guard.cancelTarget("srv-a", "s1");
		finish({ hold: "scheduled", scheduledCount: 2 });
		expect(await p2).toBe(false);
		expect(guard.ask).toBeNull();

		// cancelServer during in-flight async lookup prevents opening a stale dialog.
		const p3 = guard.request("s1", "srv-a");
		guard.cancelServer("srv-a");
		finish("working");
		expect(await p3).toBe(false);
		expect(guard.ask).toBeNull();

		// Async lookup resolving to null allows closing immediately.
		const p4 = guard.request("s1", "srv-a");
		finish(null);
		expect(await p4).toBe(true);
		expect(guard.ask).toBeNull();
	});

	test("sync throw and async rejection in holdOf resolve false and do not wedge the guard", async () => {
		let mode: "throw" | "reject" | "ok" = "throw";
		const guard = new SessionCloseGuard(
			() => {
				if (mode === "throw") throw new Error("sync boom");
				if (mode === "reject") return Promise.reject(new Error("async boom"));
				return { hold: "scheduled", scheduledCount: 1 };
			},
			() => "Chat",
		);

		expect(await guard.request("s1", "srv-a")).toBe(false);
		expect(guard.ask).toBeNull();

		mode = "reject";
		expect(await guard.request("s1", "srv-a")).toBe(false);
		expect(guard.ask).toBeNull();

		mode = "ok";
		const p = guard.request("s1", "srv-a");
		expect(guard.ask?.hold).toBe("scheduled");
		guard.ask!.confirm();
		expect(await p).toBe(true);
	});

	test("decideCloseHold follows priority asking > working > scheduled > pinned and ignores schedules for terminals", () => {
		const base = { terminal: false, pinned: false, awaiting: 0, running: false, compacting: false, scheduledCount: 0 };
		expect(decideCloseHold(base)).toBeNull();
		expect(decideCloseHold({ ...base, pinned: true })).toEqual({ hold: "pinned", pinned: true });
		expect(decideCloseHold({ ...base, scheduledCount: 2 })).toEqual({ hold: "scheduled", scheduledCount: 2, pinned: false });
		expect(decideCloseHold({ ...base, scheduledCount: 2, pinned: true })).toEqual({ hold: "scheduled", scheduledCount: 2, pinned: true });
		expect(decideCloseHold({ ...base, running: true, scheduledCount: 1, pinned: true })).toEqual({ hold: "working", scheduledCount: 1, pinned: true });
		expect(decideCloseHold({ ...base, compacting: true, scheduledCount: 3 })).toEqual({ hold: "working", scheduledCount: 3, pinned: false });
		expect(decideCloseHold({ ...base, awaiting: 1, running: true, scheduledCount: 2 })).toEqual({ hold: "asking", scheduledCount: 2, pinned: false });
		expect(decideCloseHold({ ...base, terminal: true, scheduledCount: 5 })).toBeNull();
		expect(decideCloseHold({ ...base, terminal: true, pinned: true, scheduledCount: 5 })).toEqual({ hold: "pinned-terminal", pinned: true });
	});
});
