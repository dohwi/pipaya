import { expect, test } from "bun:test";
import { Glob } from "bun";

// What an extension owns stays out of the core. The one exception is the migration that hands old session names to the
// extension that used them: it has to name it, once, for data written before names left the core.
test("the server core does not name an extension or its tools", async () => {
	const pattern = /peer-tools|peer-names|peer_send|peer_read|ask-user|ask_user|prompt-templates|session-retention|quota-monitor/i;
	const ALLOWED = new Map([["db.ts", /peer-tools/i]]);
	const hits: string[] = [];
	for await (const file of new Glob("**/*.ts").scan({ cwd: "src", onlyFiles: true })) {
		let text = await Bun.file(`src/${file}`).text();
		const allowed = ALLOWED.get(file);
		if (allowed) text = text.split("\n").filter((l) => !allowed.test(l)).join("\n");
		if (pattern.test(text)) hits.push(file);
	}
	expect(hits).toEqual([]);
});
