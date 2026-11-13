import { expect, test } from "bun:test";
import { Glob } from "bun";
import { join } from "node:path";
import { extensionNameRules, namesIn } from "./support/extension-names.ts";

const APP = join(import.meta.dir, "..", "..");

/**
 * What an extension owns stays out of the server, migrations, comments, tests, the built-in skills and the docs
 * included: its id, title, setting keys and the words of its feature (rules: support/extension-names.ts). An example
 * uses a made-up extension. The client has the same guard (client/tests/extensions-generic.test.ts).
 */
test("the server, its skills and the docs do not name an extension or its feature", async () => {
	const rules = extensionNameRules(APP);
	// the guard and its list, and the list of old extensions the server no longer loads (it has to name them)
	const SKIP = new Set(["server/test/core-neutral.test.ts", "server/test/support/extension-names.ts", "server/src/extensions/retired.ts"]);
	const hits: string[] = [];
	for (const glob of ["server/{src,test,builtin-skills,examples}/**/*", "docs/**/*", "*.md"]) {
		for await (const file of new Glob(glob).scan({ cwd: APP, onlyFiles: true })) {
			if (/\.(png|jpe?g|gif|webp|ico|icns|woff2?)$/i.test(file) || file.includes("node_modules/") || SKIP.has(file)) continue;
			const lines = (await Bun.file(join(APP, file)).text()).split("\n");
			lines.forEach((line, i) => {
				const names = namesIn(line, rules);
				if (names.length) hits.push(`${file}:${i + 1} ${names.join(", ")}`);
			});
		}
	}
	expect(hits).toEqual([]);
});
