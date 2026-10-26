import { expect, test } from "bun:test";
import { Glob } from "bun";

// What an extension owns stays out of the core, migrations included.
test("the server core does not name an extension or its tools", async () => {
	const pattern = /peer-tools|peer-names|ask-user|prompt-templates|session-retention|quota-monitor/i;
	const hits: string[] = [];
	for await (const file of new Glob("**/*.ts").scan({ cwd: "src", onlyFiles: true })) {
		if (file === "extensions/retired.ts") continue; // the list of old extensions the server no longer loads
		if (pattern.test(await Bun.file(`src/${file}`).text())) hits.push(file);
	}
	expect(hits).toEqual([]);
});
