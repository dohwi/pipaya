import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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
	test("outputs line numbers, strips CRLF \\r, handles empty file and trailing newline without phantom line, and truncates from head", async () => {
		const d = mkDir("read-test");
		writeFileSync(join(d, "crlf.txt"), "alpha\r\nbeta\r\ngamma\r\n");
		writeFileSync(join(d, "empty.txt"), "");
		const [read] = buildTools(["read"], d);

		const r = await exec(read, { path: "crlf.txt" });
		expect(r.content[0].text).toBe("   1│alpha\n   2│beta\n   3│gamma");
		expect(r.details.totalLines).toBe(3);
		expect(r.details.to).toBe(3);
		expect(r.content[0].text).not.toContain("\r");

		const emptyRes = await exec(read, { path: "empty.txt" });
		expect(emptyRes.content[0].text).toBe("(empty file)");
		expect(emptyRes.details.totalLines).toBe(0);

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

	test("detects binary files via NUL byte, UTF-16 BOM (clear encoding note), or high invalid UTF-8 ratio without flagging short Latin-1 text", async () => {
		const d = mkDir("read-bin");
		writeFileSync(join(d, "prog.bin"), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01, 0x02, 0x03]));
		writeFileSync(join(d, "utf16.bin"), Buffer.from([0xff, 0xfe, 0x41, 0x00, 0x42, 0x00]));
		writeFileSync(join(d, "badutf8.bin"), Buffer.from(Array.from({ length: 100 }, () => 0xfe)));
		writeFileSync(join(d, "latin1.txt"), Buffer.from("café naïve résumé\n", "latin1"));
		const [read] = buildTools(["read"], d);

		const rNul = await exec(read, { path: "prog.bin" });
		expect(rNul.content[0].text).toContain("binary file");
		expect(rNul.details.binary).toBe(true);

		const rUtf16 = await exec(read, { path: "utf16.bin" });
		expect(rUtf16.content[0].text).toContain("unsupported encoding (UTF-16)");
		expect(rUtf16.details.encoding).toBe("utf-16");

		const rBad = await exec(read, { path: "badutf8.bin" });
		expect(rBad.content[0].text).toContain("binary file");
		expect(rBad.details.binary).toBe(true);

		const rLatin1 = await exec(read, { path: "latin1.txt" });
		expect(rLatin1.details.binary).toBeUndefined();
		expect(rLatin1.content[0].text).toContain("   1│");
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

	test("atomic write preserves file mode, symlinks, hardlinks, and cleans up temp files", async () => {
		const d = mkDir("atomic-mode");
		const f = join(d, "script.sh");
		writeFileSync(f, "#!/bin/sh\necho hi\n");
		chmodSync(f, 0o755);
		const [write, edit] = buildTools(["write", "edit"], d);
		await exec(edit, { path: "script.sh", oldText: "echo hi", newText: "echo bye" });
		expect(statSync(f).mode & 0o777).toBe(0o755);
		expect(readdirSync(d)).toEqual(["script.sh"]);

		// 0o600 mode preserved
		const secret = join(d, "secret.conf");
		writeFileSync(secret, "k=1\n", { mode: 0o600 });
		chmodSync(secret, 0o600);
		await exec(edit, { path: "secret.conf", oldText: "k=1", newText: "k=2" });
		expect(statSync(secret).mode & 0o777).toBe(0o600);

		// Symlink preserved: writing/editing through symlink updates real target and keeps symlink intact
		const targetDir = mkDir("atomic-sym-target");
		const realFile = join(targetDir, "real.md");
		writeFileSync(realFile, "hello symlink\n");
		const linkPath = join(d, "AGENTS.md");
		symlinkSync(realFile, linkPath);
		await exec(edit, { path: "AGENTS.md", oldText: "hello symlink", newText: "edited symlink" });
		expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
		expect(readlinkSync(linkPath)).toBe(realFile);
		expect(readFileSync(realFile, "utf8")).toBe("edited symlink\n");
		await exec(write, { path: "AGENTS.md", content: "rewritten via symlink\n" });
		expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
		expect(readFileSync(realFile, "utf8")).toBe("rewritten via symlink\n");

		// Hardlink preserved (nlink > 1 writes in-place)
		const h1 = join(d, "hard1.txt");
		const h2 = join(d, "hard2.txt");
		writeFileSync(h1, "hard-orig\n");
		linkSync(h1, h2);
		await exec(edit, { path: "hard1.txt", oldText: "hard-orig", newText: "hard-new" });
		expect(statSync(h1).ino).toBe(statSync(h2).ino);
		expect(readFileSync(h2, "utf8")).toBe("hard-new\n");

		// Read-only parent directory (0555): writable target succeeds in-place, read-only target still throws EACCES
		if (typeof process.getuid === "function" && process.getuid() !== 0) {
			const roDir = mkDir("ro-parent");
			const writableFile = join(roDir, "ok.txt");
			const roFile = join(roDir, "locked.txt");
			writeFileSync(writableFile, "before\n");
			writeFileSync(roFile, "locked\n");
			chmodSync(writableFile, 0o644);
			chmodSync(roFile, 0o444);
			chmodSync(roDir, 0o555);
			try {
				const [roEdit] = buildTools(["edit"], roDir);
				await exec(roEdit, { path: "ok.txt", oldText: "before", newText: "after" });
				expect(readFileSync(writableFile, "utf8")).toBe("after\n");
				await expect(exec(roEdit, { path: "locked.txt", oldText: "locked", newText: "hacked" })).rejects.toThrow();
			} finally {
				chmodSync(roDir, 0o755);
				chmodSync(roFile, 0o644);
			}
		}
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

	test("staged matching: strict prefix strip (no TSV corruption), CRLF boundary alignment, and safe Stage 4 indent matching", async () => {
		const d = mkDir("staged");
		const [edit] = buildTools(["edit"], d);

		// Stage 2: strict consecutive `│` read prefix stripped, recorded in details.match + fallback notice
		const f1 = join(d, "prefixed.ts");
		writeFileSync(f1, "const a = 1;\nconst b = 2;\n");
		const rPrefix = await exec(edit, { path: "prefixed.ts", oldText: "   1│const a = 1;\n   2│const b = 2;", newText: "const a = 10;\nconst b = 20;" });
		expect(readFileSync(f1, "utf8")).toBe("const a = 10;\nconst b = 20;\n");
		expect(rPrefix.details.match).toBe("prefix");
		expect(rPrefix.content[0].text).toContain("matched via prefix fallback");

		// TSV with `10\tone` must NOT be misidentified as read line-number prefix!
		const fTsv = join(d, "data.tsv");
		writeFileSync(fTsv, "one\ntwo\n");
		await expect(exec(edit, { path: "data.tsv", oldText: "10\tone\n11\ttwo", newText: "10\tONE\n11\tTWO" })).rejects.toThrow(/not found/);
		expect(readFileSync(fTsv, "utf8")).toBe("one\ntwo\n");

		// Stage 3: CRLF preserved when model sends LF, including leading `\n` on CRLF pair (no `\r\r\n` corruption)
		const f2 = join(d, "win.txt");
		writeFileSync(f2, "a\r\nb\r\nc\r\n");
		const rCrlf = await exec(edit, { path: "win.txt", oldText: "\nb\nc", newText: "\nB\nC" });
		expect(readFileSync(f2, "utf8")).toBe("a\r\nB\r\nC\r\n");
		expect(rCrlf.details.match).toBe("crlf");
		expect(rCrlf.content[0].text).toContain("matched via crlf fallback");

		// Stage 4: unique space-indent match preserves base indent delta AND leaves outside mixed EOLs untouched
		const f3 = join(d, "indent.ts");
		writeFileSync(f3, "header\r\nfunction f() {\n    if (ok) {\n      return 1;\n    }\n}\r\n");
		const rIndent = await exec(edit, {
			path: "indent.ts",
			oldText: "if (ok) {\n  return 1;\n}",
			newText: "if (ok) {\n  return 2;\n}",
		});
		expect(readFileSync(f3, "utf8")).toBe("header\r\nfunction f() {\n    if (ok) {\n      return 2;\n    }\n}\r\n");
		expect(rIndent.details.match).toBe("indent");
		expect(rIndent.content[0].text).toContain("matched via indent fallback");

		// Stage 4: refuses when tab vs space indentation conflicts
		const fTab = join(d, "tabs.ts");
		writeFileSync(fTab, "function f() {\n\t\tif (ok) {\n\t\t\treturn 1;\n\t\t}\n}\n");
		await expect(
			exec(edit, { path: "tabs.ts", oldText: "if (ok) {\n  return 1;\n}", newText: "if (ok) {\n  return 2;\n}" }),
		).rejects.toThrow(/not found/);

		// Stage 4: refuses when indent delta is not constant across lines (prevents flattening nested indentation)
		const fNested = join(d, "nested.ts");
		writeFileSync(fNested, "\tif (a) {\n\t\tb();\n\t}\n");
		await expect(
			exec(edit, { path: "nested.ts", oldText: "if (a) {\nb();\n}", newText: "if (a) {\nc();\n}" }),
		).rejects.toThrow(/not found/);
		expect(readFileSync(fNested, "utf8")).toBe("\tif (a) {\n\t\tb();\n\t}\n");
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

		// Exit code 2 with partial matches (e.g. an unreadable file alongside a matching file) returns matches + warning
		if (typeof process.getuid === "function" && process.getuid() !== 0) {
			const partialDir = mkDir("grep-partial");
			writeFileSync(join(partialDir, "ok.txt"), "needle-hit\n");
			const unreadable = join(partialDir, "nope.txt");
			writeFileSync(unreadable, "secret\n");
			chmodSync(unreadable, 0o000);
			try {
				const [grepPartial] = buildTools(["grep"], partialDir);
				const pr = await exec(grepPartial, { pattern: "needle-hit" });
				expect(pr.content[0].text).toContain("ok.txt:1:needle-hit");
				expect(pr.content[0].text).toContain("[warning: partial results");
				expect(pr.details.partial).toBe(true);
			} finally {
				chmodSync(unreadable, 0o644);
			}
		}

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

	test("glob tool is registered in TOOL_DEFS, DEFAULT_TOOLS, TOGGLEABLE_TOOLS and matches identically between rg and fallback", async () => {
		expect(TOOL_DEFS.glob).toBeDefined();
		expect(DEFAULT_TOOLS).toContain("glob");
		expect(TOGGLEABLE_TOOLS).toContain("glob");

		const d = mkDir("glob-test");
		mkdirSync(join(d, "src"), { recursive: true });
		mkdirSync(join(d, ".github"), { recursive: true });
		mkdirSync(join(d, "node_modules/pkg"), { recursive: true });
		mkdirSync(join(d, ".git"), { recursive: true });
		writeFileSync(join(d, "root.ts"), "");
		writeFileSync(join(d, ".env"), "");
		writeFileSync(join(d, ".github/ci.yml"), "");
		writeFileSync(join(d, "src/a.ts"), "");
		writeFileSync(join(d, "src/b.ts"), "");
		writeFileSync(join(d, "src/c.md"), "");
		writeFileSync(join(d, "node_modules/pkg/ignored.ts"), "");
		writeFileSync(join(d, ".git/config.ts"), "");

		const [glob] = buildTools(["glob"], d);
		expect(glob!.executionMode).toBeUndefined();

		// Recursive **/*.ts matches root and nested files identically in rg and fallback (and skips hidden dotfiles)
		const rRec = await exec(glob, { pattern: "**/*.ts" });
		expect(rRec.content[0].text).toBe("root.ts\nsrc/a.ts\nsrc/b.ts");
		const fbRec = await globFallback(d, "**/*.ts");
		expect(fbRec.map((p) => p.slice(d.length + 1)).sort()).toEqual(["root.ts", "src/a.ts", "src/b.ts"]);

		// Hidden dotfiles skipped by default in both rg and fallback, included when pattern names a dot segment
		expect((await exec(glob, { pattern: "**/*" })).content[0].text).not.toContain(".env");
		expect((await globFallback(d, "**/*")).map((p) => p.slice(d.length + 1))).not.toContain(".env");
		expect((await exec(glob, { pattern: ".github/**" })).content[0].text).toBe(".github/ci.yml");
		expect((await globFallback(d, ".github/**")).map((p) => p.slice(d.length + 1))).toEqual([".github/ci.yml"]);
		expect((await exec(glob, { pattern: ".*" })).content[0].text).toBe(".env");
		expect((await globFallback(d, ".*")).map((p) => p.slice(d.length + 1))).toEqual([".env"]);

		// Top-level *.ts matches only top-level files identically in rg and fallback
		const rTop = await exec(glob, { pattern: "*.ts" });
		expect(rTop.content[0].text).toBe("root.ts");
		const fbTop = await globFallback(d, "*.ts");
		expect(fbTop.map((p) => p.slice(d.length + 1)).sort()).toEqual(["root.ts"]);

		// Scoped path: "src" with pattern "*.ts" matches files directly inside src/
		const rSub = await exec(glob, { pattern: "*.ts", path: "src" });
		expect(rSub.content[0].text).toBe("src/a.ts\nsrc/b.ts");
		const fbSub = await globFallback(join(d, "src"), "*.ts");
		expect(fbSub.map((p) => p.slice(d.length + 1)).sort()).toEqual(["src/a.ts", "src/b.ts"]);

		const limited = await exec(glob, { pattern: "**/*.ts", limit: 1 });
		expect(limited.content[0].text).toContain("root.ts");
		expect(limited.content[0].text).toContain("[2 more files omitted]");

		const none = await exec(glob, { pattern: "**/*.rs" });
		expect(none.content[0].text).toBe("(no matches)");
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
