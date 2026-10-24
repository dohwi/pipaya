import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadComponents } from "../src/lib/extensions/components";
import { parsePackage } from "../src/lib/extensions/schema";

// The official extensions live in their own repository (pipaya-extensions). When it sits next to this one, every
// built package must still install and compile against this client; otherwise the check is skipped.
const root = process.env.PIPAYA_EXTENSIONS ?? join(import.meta.dir, "..", "..", "..", "pipaya-extensions");
const official = ["quota-monitor", "peer-names"].filter(id => existsSync(join(root, id, "dist", `${id}.json`)));

describe.skipIf(official.length === 0)("official client extensions", () => {
	for (const id of official) {
		test(`${id} parses, and its components compile and link`, async () => {
			const pkg = parsePackage(JSON.parse(await Bun.file(join(root, id, "dist", `${id}.json`)).text()));
			expect(pkg.manifest.id).toBe(id);
			if (!pkg.components) return;
			const kit = { ext: { id, data: null, settings: {}, language: "ko", dark: false } };
			const loaded = loadComponents(pkg, kit);
			expect(Object.keys(loaded).sort()).toEqual(Object.keys(pkg.components).sort());
			for (const mount of pkg.mounts ?? []) expect(typeof loaded[mount.component]).toBe("function");
		});
	}
});
