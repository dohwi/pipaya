import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { AccountEmails, emailFromJwt, lookupEmail } from "../src/account-email.ts";

const jwt = (claims: object) => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;

describe("account email", () => {
	test("reads the email from a JWT, including OpenAI's profile claim", () => {
		expect(emailFromJwt(jwt({ email: "a@b.com" }))).toBe("a@b.com");
		expect(emailFromJwt(jwt({ "https://api.openai.com/profile": { email: "o@b.com" } }))).toBe("o@b.com");
	});
	test("opaque, malformed or oversized tokens give nothing", () => {
		expect(emailFromJwt("sk-ant-opaque")).toBeUndefined();
		expect(emailFromJwt("a.!!!.c")).toBeUndefined();
		expect(emailFromJwt(jwt({ email: "x".repeat(400) }))).toBeUndefined();
		expect(emailFromJwt(jwt({ email: 5 }))).toBeUndefined();
	});
	test("API keys have no account", async () => {
		expect(await lookupEmail("openai", { type: "api_key", key: "k" })).toBeUndefined();
		expect(await lookupEmail("openai", undefined)).toBeUndefined();
	});
	test("an OAuth credential with a JWT access token yields its email", async () => {
		expect(await lookupEmail("openai", { type: "oauth", access: jwt({ email: "a@b.com" }), refresh: "r", expires: 0 })).toBe("a@b.com");
	});
	test("remembers per provider, replaces on a new sign-in, and forgets on removal", async () => {
		const db = new Database(":memory:", { strict: true });
		db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, data TEXT NOT NULL)");
		const e = new AccountEmails(db);
		await e.refresh("openai", { type: "oauth", access: jwt({ email: "a@b.com" }), refresh: "r", expires: 0 });
		expect(e.get("openai")).toBe("a@b.com");
		await e.refresh("openai", { type: "oauth", access: "opaque", refresh: "r", expires: 0 });
		expect(e.get("openai")).toBeUndefined();
		e.set("openai", "c@d.com");
		e.clear("openai");
		expect(e.get("openai")).toBeUndefined();
	});
	test("a sign-in from before emails were remembered is looked up once", async () => {
		const db = new Database(":memory:", { strict: true });
		db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, data TEXT NOT NULL)");
		const e = new AccountEmails(db);
		let calls = 0;
		const cred = async () => { calls++; return { type: "oauth" as const, access: "opaque", refresh: "r", expires: 0 }; };
		expect(await e.backfill("openai", cred)).toBeUndefined();
		expect(await e.backfill("openai", cred)).toBeUndefined();
		expect(calls).toBe(1);
	});
});
