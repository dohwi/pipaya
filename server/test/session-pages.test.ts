import { expect, test } from "bun:test";
import { openDb } from "../src/db.ts";
import { SessionStore } from "../src/store.ts";

test("equal timestamps across a page boundary: the id breaks ties; legacy before stays exclusive", () => {
	const db = openDb(":memory:");
	try {
		const store = new SessionStore(db);
		const insert = db.prepare("INSERT INTO sessions (id, title, cwd, provider, model, thinking_level, system_prompt, tools, created_at, updated_at, closed) VALUES (?, '', '/', 'p','m','off','','[]',0,?,?)");
		for (let n = 0; n < 201; n++) insert.run(String(n).padStart(3, "0"), 1, 1);
		insert.run("older", 0, 1); insert.run("active", 1, 0);
		const first = store.list({ limit: 200, closed: true });
		expect(first).toHaveLength(200);
		const last = first.at(-1)!;
		const rest = (beforeId?: string) => store.list({ limit: 200, closed: true, before: last.updatedAt, beforeId }).map((s) => s.id);
		expect(rest(last.id)).toEqual(["000", "older"]);
		expect(rest()).toEqual(["older"]);
	} finally { db.close(); }
});
