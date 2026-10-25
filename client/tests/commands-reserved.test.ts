import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// Built-in commands cannot be overridden by any extension: the server refuses the same names the client keeps.
test("the server reserves exactly the client's built-in command names", () => {
	const client = readFileSync(new URL("../src/lib/commands.ts", import.meta.url), "utf8");
	const server = readFileSync(new URL("../../server/src/extensions/host.ts", import.meta.url), "utf8");
	const list = (src: string, re: RegExp) => JSON.parse(re.exec(src)![1]!.replace(/'/g, '"')) as string[];
	const builtIn = list(client, /const DEFAULT_ORDER = (\[[^\]]*\])/);
	const reserved = list(server, /RESERVED_COMMANDS = Object\.freeze\((\[[^\]]*\])\)/);
	expect([...reserved].sort()).toEqual([...builtIn].sort());
});
