import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as photon from "@silvia-odwyer/photon-node";
import { openDb } from "../src/db.ts";
import { imageTool, ImageModelSettings } from "../src/image-generation.ts";
import { QuestionManager } from "../src/questions.ts";
import { formatSpilledOutput, spillText, truncateHeadBytes, truncateTailBytes } from "../src/spill.ts";
import { buildTools, DEFAULT_TOOLS, globFallback, TOGGLEABLE_TOOLS, TOOL_DEFS, withPathLock, type ReadTrackEntry } from "../src/tools.ts";

let root: string;
beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "pipaya-core-tools-"));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const mkDir = (name: string) => {
	const d = join(root, name);
	mkdirSync(d, { recursive: true });
	return d;
};

const exec = (tool: any, args: Record<string, unknown>, signal?: AbortSignal) =>
	tool.execute("call-1", args, signal) as Promise<{ content: any[]; details: any; isError?: boolean }>;

describe("UTF-8 safe truncation and spill", () => {
	test("truncateHeadBytes and truncateTailBytes never split multi-byte UTF-8 characters", () => {
		const sample = "a한글😀b테스트🚀c";
		const total = Buffer.byteLength(sample, "utf8");
		for (let max = 0; max <= total + 2; max++) {
			const h = truncateHeadBytes(sample, max);
			expect(h.text).not.toContain("\uFFFD");
			expect(Buffer.byteLength(h.text, "utf8")).toBeLessThanOrEqual(max);
			expect(h.truncated).toBe(max < total);

			const t = truncateTailBytes(sample, max);
			expect(t.text).not.toContain("\uFFFD");
			expect(Buffer.byteLength(t.text, "utf8")).toBeLessThanOrEqual(max);
			expect(t.truncated).toBe(max < total);
		}
	});

	test("spillText writes atomically and formatSpilledOutput includes head, tail, size and path", async () => {
		const spillDir = mkDir("spill");
		const big = Array.from({ length: 1000 }, (_, i) => `line-${i + 1}: 한글 데이터 테스트 payload`).join("\n");
		const res = await spillText(spillDir, "bash", big);
		expect(existsSync(res.path)).toBe(true);
		expect(res.lines).toBe(1000);
		expect(res.bytes).toBe(Buffer.byteLength(big, "utf8"));
		expect(readFileSync(res.path, "utf8")).toBe(big);

		const formatted = formatSpilledOutput(big, { path: res.path, headBytes: 200, tailBytes: 200, totalBytes: res.bytes, totalLines: res.lines });
		expect(formatted).toContain("line-1:");
		expect(formatted).toContain("line-1000:");
		expect(formatted).toContain(res.path);
		expect(formatted).toContain("1000 lines");
		expect(formatted).not.toContain("\uFFFD");
	});
});

describe("dynamic getCwd across tools", () => {
	test("tools resolve cwd dynamically per call when getCwd changes", async () => {
		const d1 = mkDir("dyn1");
		const d2 = mkDir("dyn2");
		writeFileSync(join(d1, "where.txt"), "dir-one");
		writeFileSync(join(d2, "where.txt"), "dir-two");
		let current = d1;
		const [read, ls, glob, bash] = buildTools(["read", "ls", "glob", "bash"], d1, [], { getCwd: () => current });

		expect((await exec(read, { path: "where.txt" })).content[0].text).toContain("dir-one");
		expect((await exec(ls, {})).content[0].text).toContain("where.txt");
		expect((await exec(glob, { pattern: "*.txt" })).content[0].text).toBe("where.txt");
		expect((await exec(bash, { command: "cat where.txt" })).content[0].text).toBe("dir-one");

		current = d2;
		expect((await exec(read, { path: "where.txt" })).content[0].text).toContain("dir-two");
		expect((await exec(bash, { command: "cat where.txt" })).content[0].text).toBe("dir-two");
	});
});

describe("read tool hardening", () => {
	test("outputs line numbers, strips CRLF \\r, and truncates from the head with accurate offset", async () => {
		const d = mkDir("read-test");
		writeFileSync(join(d, "crlf.txt"), "alpha\r\nbeta\r\ngamma\r\n");
		const [read] = buildTools(["read"], d);
		const r = await exec(read, { path: "crlf.txt" });
		expect(r.content[0].text).toBe("   1│alpha\n   2│beta\n   3│gamma\n   4│");
		expect(r.content[0].text).not.toContain("\r");

		// >50 KB file: head truncation must keep line 1 and give exact next offset.
		const longLines = Array.from({ length: 1000 }, (_, i) => `L${i + 1} ${"x".repeat(120)}`).join("\n");
		writeFileSync(join(d, "large.txt"), longLines);
		const bigRes = await exec(read, { path: "large.txt" });
		expect(bigRes.content[0].text).toContain("   1│L1 ");
		expect(bigRes.details.from).toBe(1);
		expect(bigRes.details.to).toBeGreaterThan(100);
		expect(bigRes.details.to).toBeLessThan(1000);
		expect(bigRes.content[0].text).toContain(`continue with offset=${bigRes.details.to + 1}]`);
	});

	test("detects binary files via NUL byte in first 8 KB", async () => {
		const d = mkDir("read-bin");
		const buf = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01, 0x02, 0x03]);
		writeFileSync(join(d, "prog.bin"), buf);
		const [read] = buildTools(["read"], d);
		const r = await exec(read, { path: "prog.bin" });
		expect(r.content[0].text).toContain("binary file");
		expect(r.details.binary).toBe(true);
	});

	test("rejects >20 MB text files cleanly", async () => {
		const d = mkDir("read-huge");
		const huge = join(d, "huge.txt");
		writeFileSync(huge, Buffer.alloc(21 * 1024 * 1024, 0x61));
		const [read] = buildTools(["read"], d);
		await expect(exec(read, { path: "huge.txt" })).rejects.toThrow(/20 MB/);
	});
});

describe("edit and write hardening", () => {
	test("edit and write do not set executionMode sequential, and withPathLock serializes same-path only", async () => {
		const d = mkDir("lock-test");
		const [write, edit] = buildTools(["write", "edit"], d);
		expect(write!.executionMode).toBeUndefined();
		expect(edit!.executionMode).toBeUndefined();

		const events: string[] = [];
		const sameA = withPathLock("k1", async () => {
			events.push("a:start");
			await Bun.sleep(40);
			events.push("a:end");
		});
		const sameB = withPathLock("k1", async () => {
			events.push("b:start");
			events.push("b:end");
		});
		const otherC = withPathLock("k2", async () => {
			events.push("c:start");
			events.push("c:end");
		});
		await Promise.all([sameA, sameB, otherC]);
		expect(events.indexOf("a:end")).toBeLessThan(events.indexOf("b:start"));
		expect(events.indexOf("c:end")).toBeLessThan(events.indexOf("a:end"));
	});

	test("atomic write preserves file mode and cleans up temp files", async () => {
		const d = mkDir("atomic-mode");
		const f = join(d, "script.sh");
		writeFileSync(f, "#!/bin/sh\necho hi\n");
		chmodSync(f, 0o755);
		const [edit] = buildTools(["edit"], d);
		await exec(edit, { path: "script.sh", oldText: "echo hi", newText: "echo bye" });
		expect(statSync(f).mode & 0o777).toBe(0o755);
		expect(readdirSync(d)).toEqual(["script.sh"]);
	});

	test("staleness check rejects edit when file changed on disk since read", async () => {
		const d = mkDir("stale");
		const f = join(d, "doc.txt");
		writeFileSync(f, "hello world\n");
		const tracker = new Map<string, ReadTrackEntry>();
		const [read, edit] = buildTools(["read", "edit"], d, [], { readTracker: tracker });

		await exec(read, { path: "doc.txt" });
		// Modify externally
		writeFileSync(f, "hello world! modified externally\n");
		await expect(exec(edit, { path: "doc.txt", oldText: "hello", newText: "hi" })).rejects.toThrow(/modified on disk/);

		// Re-read updates tracker and allows edit
		await exec(read, { path: "doc.txt" });
		const res = await exec(edit, { path: "doc.txt", oldText: "hello", newText: "hi" });
		expect(res.content[0].text).toContain("Edited doc.txt");
		expect(res.content[0].text).toContain("   1│hi world! modified externally");
		// Subsequent edit succeeds because edit updated tracker
		await exec(edit, { path: "doc.txt", oldText: "hi", newText: "hey" });
		expect(readFileSync(f, "utf8")).toBe("hey world! modified externally\n");
	});

	test("staged matching: line-number prefix strip, CRLF preservation, and unique indent-insensitive block", async () => {
		const d = mkDir("staged");
		const [edit] = buildTools(["edit"], d);

		// Stage 2: accidental read line-number prefix
		const f1 = join(d, "prefixed.ts");
		writeFileSync(f1, "const a = 1;\nconst b = 2;\n");
		await exec(edit, { path: "prefixed.ts", oldText: "   1│const a = 1;\n   2│const b = 2;", newText: "const a = 10;\nconst b = 20;" });
		expect(readFileSync(f1, "utf8")).toBe("const a = 10;\nconst b = 20;\n");

		// Stage 3: CRLF preserved when model sends LF
		const f2 = join(d, "win.txt");
		writeFileSync(f2, "one\r\ntwo\r\nthree\r\n");
		await exec(edit, { path: "win.txt", oldText: "one\ntwo", newText: "ONE\nTWO" });
		expect(readFileSync(f2, "utf8")).toBe("ONE\r\nTWO\r\nthree\r\n");

		// Stage 4: unique whitespace/indent-insensitive match preserves base indent delta
		const f3 = join(d, "indent.ts");
		writeFileSync(f3, "function f() {\n\t\tif (ok) {\n\t\t\treturn 1;\n\t\t}\n}\n");
		await exec(edit, {
			path: "indent.ts",
			oldText: "if (ok) {\n  return 1;\n}",
			newText: "if (ok) {\n  return 2;\n}",
		});
		expect(readFileSync(f3, "utf8")).toBe("function f() {\n\t\tif (ok) {\n\t\t  return 2;\n\t\t}\n}\n");
	});

	test("replaceAll, atomic edits[], mismatch closest candidate, and ambiguous line numbers", async () => {
		const d = mkDir("batch");
		const f = join(d, "code.ts");
		writeFileSync(f, "const x = 1;\nconst y = 2;\nconst x = 1;\nconst z = 3;\n");
		const [edit] = buildTools(["edit"], d);

		// Ambiguous without replaceAll lists line numbers
		await expect(exec(edit, { path: "code.ts", oldText: "const x = 1;", newText: "const x = 9;" })).rejects.toThrow(/lines 1, 3/);

		// replaceAll replaces both
		const rep = await exec(edit, { path: "code.ts", oldText: "const x = 1;", newText: "const x = 9;", replaceAll: true });
		expect(rep.details.replacements).toBe(2);
		expect(readFileSync(f, "utf8")).toBe("const x = 9;\nconst y = 2;\nconst x = 9;\nconst z = 3;\n");

		// Atomic edits[]: second edit fails -> file untouched!
		const before = readFileSync(f, "utf8");
		await expect(
			exec(edit, {
				path: "code.ts",
				edits: [
					{ oldText: "const y = 2;", newText: "const y = 20;" },
					{ oldText: "const z = 999;", newText: "const z = 30;" },
				],
			}),
		).rejects.toThrow(/edits\[1\].*Closest candidate/s);
		expect(readFileSync(f, "utf8")).toBe(before);

		// Atomic edits[]: both succeed
		const ok = await exec(edit, {
			path: "code.ts",
			edits: [
				{ oldText: "const y = 2;", newText: "const y = 20;" },
				{ oldText: "const z = 3;", newText: "const z = 30;" },
			],
		});
		expect(ok.details.edits).toBe(2);
		expect(readFileSync(f, "utf8")).toBe("const x = 9;\nconst y = 20;\nconst x = 9;\nconst z = 30;\n");

		// Validation: both oldText and edits rejected
		await expect(
			exec(edit, { path: "code.ts", oldText: "a", newText: "b", edits: [{ oldText: "a", newText: "b" }] }),
		).rejects.toThrow(/not both/);
	});
});

describe("grep, ls, glob, bash hardening", () => {
	test("grep supports ignoreCase, fixedStrings, filesOnly, context, head truncation and spillDir", async () => {
		const d = mkDir("grep-test");
		const spillDir = mkDir("grep-spill");
		writeFileSync(join(d, "a.txt"), "first\nHello (world)\nthird\n");
		const many = Array.from({ length: 260 }, (_, i) => `match-line-${i + 1}`).join("\n");
		writeFileSync(join(d, "many.txt"), many);

		const [grep] = buildTools(["grep"], d, [], { spillDir });
		expect((await exec(grep, { pattern: "not-present-anywhere" })).content[0].text).toBe("(no matches)");
		expect((await exec(grep, { pattern: "hello", ignoreCase: true, path: "a.txt" })).content[0].text).toContain("Hello (world)");
		expect((await exec(grep, { pattern: "(world)", fixedStrings: true, path: "a.txt" })).content[0].text).toContain("Hello (world)");
		expect((await exec(grep, { pattern: "Hello", filesOnly: true, path: "a.txt" })).content[0].text.trim()).toBe("a.txt");
		const withCtx = await exec(grep, { pattern: "Hello", context: 1, path: "a.txt" });
		expect(withCtx.content[0].text).toContain("first");
		expect(withCtx.content[0].text).toContain("third");

		// Invalid regex throws stderr instead of returning matches
		await expect(exec(grep, { pattern: "[unclosed" })).rejects.toThrow();

		// Head-first cap at 200 lines + spill
		const capped = await exec(grep, { pattern: "match-line-", path: "many.txt" });
		expect(capped.content[0].text).toContain("match-line-1");
		expect(capped.content[0].text).not.toContain("match-line-250");
		expect(capped.details.spillPath).toBeTruthy();
		expect(existsSync(capped.details.spillPath)).toBe(true);
	});

	test("ls follows symlinked directories and caps at 500 entries", async () => {
		const d = mkDir("ls-test");
		const targetDir = mkDir("ls-target");
		symlinkSync(targetDir, join(d, "link-to-dir"));
		symlinkSync(join(d, "nonexistent"), join(d, "broken-link"));
		const [ls] = buildTools(["ls"], d);
		const r = await exec(ls, {});
		expect(r.content[0].text).toContain("link-to-dir/");
		expect(r.content[0].text).toContain("broken-link");

		const bigDir = mkDir("ls-many");
		for (let i = 0; i < 510; i++) writeFileSync(join(bigDir, `f-${String(i).padStart(4, "0")}.txt`), "");
		const [lsBig] = buildTools(["ls"], bigDir);
		const rBig = await exec(lsBig, {});
		expect(rBig.content[0].text).toContain("[10 more entries omitted]");
		expect(rBig.details.shown).toBe(500);
	});

	test("glob tool is registered in TOOL_DEFS, DEFAULT_TOOLS, TOGGLEABLE_TOOLS and works with rg and fallback", async () => {
		expect(TOOL_DEFS.glob).toBeDefined();
		expect(DEFAULT_TOOLS).toContain("glob");
		expect(TOGGLEABLE_TOOLS).toContain("glob");

		const d = mkDir("glob-test");
		mkdirSync(join(d, "src"), { recursive: true });
		mkdirSync(join(d, "node_modules/pkg"), { recursive: true });
		mkdirSync(join(d, ".git"), { recursive: true });
		writeFileSync(join(d, "src/a.ts"), "");
		writeFileSync(join(d, "src/b.ts"), "");
		writeFileSync(join(d, "src/c.md"), "");
		writeFileSync(join(d, "node_modules/pkg/ignored.ts"), "");
		writeFileSync(join(d, ".git/config.ts"), "");

		const [glob] = buildTools(["glob"], d);
		expect(glob!.executionMode).toBeUndefined();
		const r = await exec(glob, { pattern: "*.ts" });
		expect(r.content[0].text).toBe("src/a.ts\nsrc/b.ts");

		const limited = await exec(glob, { pattern: "*.ts", limit: 1 });
		expect(limited.content[0].text).toContain("src/a.ts");
		expect(limited.content[0].text).toContain("[1 more files omitted]");

		const none = await exec(glob, { pattern: "*.rs" });
		expect(none.content[0].text).toBe("(no matches)");

		// Fallback skips .git and node_modules
		const fb = await globFallback(d, "*.ts");
		expect(fb.map((p) => p.slice(d.length + 1)).sort()).toEqual(["src/a.ts", "src/b.ts"]);
	});

	test("bash spills >50 KB output when spillDir is set, and truncates UTF-8 safely otherwise", async () => {
		const d = mkDir("bash-spill-cwd");
		const spillDir = mkDir("bash-spill");
		const [bashWithSpill] = buildTools(["bash"], d, [], { spillDir });
		const [bashNoSpill] = buildTools(["bash"], d);

		const cmd = `bun -e 'for (let i = 1; i <= 2500; i++) console.log("줄-" + i + ": " + "한글😀".repeat(6))'`;
		const r1 = await exec(bashWithSpill, { command: cmd });
		expect(r1.details.truncated).toBe(true);
		expect(r1.details.spillPath).toBeTruthy();
		expect(existsSync(r1.details.spillPath)).toBe(true);
		expect(r1.content[0].text).toContain("줄-1:");
		expect(r1.content[0].text).toContain("줄-2500:");
		expect(r1.content[0].text).not.toContain("\uFFFD");

		const r2 = await exec(bashNoSpill, { command: cmd });
		expect(r2.details.truncated).toBe(true);
		expect(r2.details.spillPath).toBeUndefined();
		expect(r2.content[0].text).not.toContain("\uFFFD");
	});
});

describe("ask_user and QuestionManager hardening", () => {
	test("ask_user rejects both question and questions, and serializes concurrent calls per session", async () => {
		const order: string[] = [];
		let releaseFirst!: () => void;
		const firstGate = new Promise<void>((r) => { releaseFirst = r; });

		const [ask] = buildTools(["ask_user"], root, [], {
			sessionId: "sess-ask-mutex",
			async ask(id, req) {
				order.push(`start:${id}:${req.question}`);
				if (id === "c1") await firstGate;
				order.push(`end:${id}`);
				return "ok";
			},
		});
		expect(ask!.executionMode).toBeUndefined();

		await expect(
			exec(ask, { question: "Q1?", questions: [{ question: "A?" }, { question: "B?" }] }),
		).rejects.toThrow(/not both/);

		const p1 = ask!.execute("c1", { question: "First?" }, undefined as never);
		await Bun.sleep(10);
		const p2 = ask!.execute("c2", { question: "Second?" }, undefined as never);
		await Bun.sleep(10);
		expect(order).toEqual(["start:c1:First?"]);
		releaseFirst();
		await Promise.all([p1, p2]);
		expect(order).toEqual(["start:c1:First?", "end:c1", "start:c2:Second?", "end:c2"]);
	});

	test("QuestionManager.answer guards non-string elements without throwing TypeError", () => {
		const qm = new QuestionManager({ publish() {} } as any);
		void qm.ask({
			sessionId: "s1",
			toolCallId: "t1",
			question: "Q1?",
			allowFreeText: true,
			items: [
				{ question: "Q1?", allowFreeText: true },
				{ question: "Q2?", allowFreeText: true },
			],
		});
		expect(qm.answer("s1", "t1", { answers: ["yes", 123 as any] })).toBe("invalid");
		expect(qm.answer("s1", "t1", { answers: ["yes", undefined as any] })).toBe("invalid");
		expect(qm.answer("s1", "t1", { answers: ["yes", "no"] })).toBe("ok");

		void qm.ask({ sessionId: "s1", toolCallId: "t2", question: "Single?", allowFreeText: true });
		expect(qm.answer("s1", "t2", { answer: 42 as any })).toBe("invalid");
		expect(qm.answer("s1", "t2", { answer: "done" })).toBe("ok");
	});
});

describe("generate_image reference image validation", () => {
	test("validates magic bytes and resizes oversized reference images", async () => {
		const d = mkDir("imggen-val");
		writeFileSync(join(d, "fake.png"), "not actually a png");
		writeFileSync(join(d, "pic.bmp"), Buffer.concat([Buffer.from("BM"), Buffer.alloc(60)]));

		// Oversized PNG (3000x1500) that must be resized before sending
		const px = new Uint8Array(3000 * 1500 * 4);
		let x = 12345;
		for (let i = 0; i < px.length; i += 4) {
			x = (Math.imul(x, 1103515245) + 12345) >>> 0;
			px[i] = x >>> 8; px[i + 1] = x >>> 16; px[i + 2] = x >>> 24; px[i + 3] = 255;
		}
		writeFileSync(join(d, "big.png"), Buffer.from(new photon.PhotonImage(px, 3000, 1500).get_bytes()));

		const fakeModel = {
			id: "img-1",
			name: "Img",
			api: "openrouter-images",
			provider: "mock",
			baseUrl: "https://openrouter.ai/api/v1",
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		};
		const receivedInputs: any[] = [];
		const fakeRegistry = {
			isImageModel: () => true,
			models: {
				getModel: () => fakeModel,
				generateImages: async (_m: any, req: any) => {
					receivedInputs.push(req.input);
					return {
						stopReason: "stop",
						output: [{
							type: "image",
							mimeType: "image/png",
							data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
						}],
					};
				},
			},
		} as any;

		const db = openDb(":memory:");
		const settings = new ImageModelSettings(db, fakeRegistry);
		settings.set({ model: { provider: "mock", model: "img-1" } });
		const tool = imageTool(fakeRegistry, settings).create(d);

		await expect(exec(tool, { prompt: "edit", images: ["fake.png"] })).rejects.toThrow(/not a valid PNG, JPEG, GIF or WebP/);
		await expect(exec(tool, { prompt: "edit", images: ["pic.bmp"] })).rejects.toThrow(/BMP/);

		const res = await exec(tool, { prompt: "edit big", images: ["big.png"] });
		expect(res.details).toMatchObject({ model: "mock/img-1" });
		expect(res.details.paths).toHaveLength(1);
		expect(receivedInputs).toHaveLength(1);
		const sentImg = receivedInputs[0][1];
		expect(sentImg.type).toBe("image");
		// Resized payload must be well under 5 MB base64
		expect(Buffer.byteLength(sentImg.data, "utf8")).toBeLessThan(5 * 1024 * 1024);
		db.close();
	});
});
