import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { installCrashGuard } from "../src/crash-guard.ts";

describe("crash guard", () => {
	test("logs unhandled rejections and exceptions instead of letting the process die", () => {
		const target = new EventEmitter();
		const logged: { obj: any; msg: string }[] = [];
		installCrashGuard({ error: (obj, msg) => void logged.push({ obj, msg }) }, target as any);
		target.emit("unhandledRejection", new Error("stray"));
		target.emit("uncaughtException", new Error("boom"));
		target.emit("unhandledRejection", "plain string");
		expect(logged.map((l) => l.obj.err.message)).toEqual(["stray", "boom", "plain string"]);
		expect(logged[0]!.msg).toContain("unhandled promise rejection");
		expect(logged[1]!.msg).toContain("uncaught exception");
	});
});
