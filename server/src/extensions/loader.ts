// Loading an extension file so that a reload really picks up its edits.
//
// `import(path + "?v=" + n)` busts the module cache for that one file, but not for the files it imports: a folder
// extension with `rules.ts` next to `index.ts` kept running the old `rules.ts` after a reload, which is worse than a
// stale copy — the new index.ts and the old rules.ts disagree about their exports and the extension fails to load
// ("Export named 'groupsFrom' not found").
//
// So every relative import made from inside an extension folder is given the same `?v=` marker. A Bun plugin does
// that; the entry file itself is imported with the marker by the host. Bare specifiers (node_modules, `bun:sqlite`)
// are left alone: they do not change between reloads, and re-evaluating them would only cost memory.
import { dirname, resolve } from "node:path";

/** The query a reload adds. Only paths carrying it are treated as extension modules. */
const MARK = "?v=";

/** Folders whose relative imports get the marker (one per extension entry file). */
const folders = new Set<string>();
let version = 0;
let installed = false;

/** The path without its `?v=` marker. */
const bare = (path: string): string => {
	const at = path.indexOf(MARK);
	return at === -1 ? path : path.slice(0, at);
};

/**
 * Mark every relative import made from inside the folder of one of `entries` (extension entry files). Call it before
 * importing them; `v` must differ per reload so the marker differs too.
 */
export function markExtensionImports(entries: readonly string[], v: number): void {
	version = v;
	for (const entry of entries) folders.add(dirname(resolve(entry)));
	if (installed) return;
	installed = true;
	Bun.plugin({
		name: "pipaya-extension-reload",
		setup(build) {
			build.onResolve({ filter: /^\.{1,2}\// }, (args) => {
				// Only imports made from inside an extension folder: the server's own modules keep a single copy.
				const from = bare(args.importer);
				if (!folders.has(dirname(from))) return undefined;
				// Bun's `onResolve` gives no `resolveDir`, so the parent comes from the importer (minus its marker).
				return { path: `${resolve(dirname(from), args.path)}${MARK}${version}` };
			});
		},
	});
}
