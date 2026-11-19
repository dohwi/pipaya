import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

/** What compiled components import instead of `svelte/internal/client` (resolved to src/lib/each-guard.ts). */
export const GUARD_ID = "\0pipaya-each-guard";
const RUNTIME = fileURLToPath(new URL("../src/lib/each-guard.ts", import.meta.url));
const IMPORT = /^import \* as \$ from ['"]svelte\/internal\/client['"];?$/m;

/**
 * The compiled code of one component with its each blocks guarded: the runtime import points at the guard and every
 * `$.each(` names the component (`where`) and the block's place in it, so a repeated key is reported, not thrown.
 * Null when the code has no each block. Throws when the compiler's output no longer looks as expected (a Svelte update):
 * the build fails instead of shipping unguarded lists. Line count is kept (the source map stays usable).
 */
export function guardEachBlocks(code: string, where: string): string | null {
	if (!code.includes("$.each(")) return null;
	if (!IMPORT.test(code)) throw new Error(`each guard: ${where} has no \`import * as $ from "svelte/internal/client"\`; update scripts/each-guard-plugin.ts`);
	let n = 0;
	return code
		.replace(IMPORT, `import * as $ from ${JSON.stringify(GUARD_ID)};`)
		.replace(/\$\.each\(/g, () => `$.each_in(${JSON.stringify(`${where}#${++n}`)}, `);
}

/** Vite plugin: runs after the Svelte compiler on the app's own components (dependencies are left alone). */
export function eachGuard(): Plugin {
	return {
		name: "pipaya-each-guard",
		enforce: "post",
		resolveId: (id) => (id === GUARD_ID ? RUNTIME : null),
		transform(code, id) {
			if (id.includes("?") || !id.endsWith(".svelte") || id.includes("/node_modules/")) return null;
			const where = id.replace(/\\/g, "/").replace(/^.*\/src\//, "");
			const out = guardEachBlocks(code, where);
			return out === null ? null : { code: out, map: null };
		},
	};
}
