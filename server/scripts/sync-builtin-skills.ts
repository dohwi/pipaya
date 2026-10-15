// Copies the client's extension docs into the built-in skill so the server stays self-contained.
// Run after editing client/docs/extension*.md:  bun scripts/sync-builtin-skills.ts
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const EXTENSION_DOCS = ["extension-architecture.md", "extensions.md", "extension-ui.md", "extension-screen-design.md", "notifications.md"];
export const CLIENT_DOCS = join(import.meta.dir, "..", "..", "client", "docs");
export const SKILL_REFERENCES = join(import.meta.dir, "..", "builtin-skills", "harness-client-extensions", "references");

if (import.meta.main) {
	mkdirSync(SKILL_REFERENCES, { recursive: true });
	for (const name of EXTENSION_DOCS) {
		// The copies sit outside client/docs, so drop the link to the docs index that is not bundled.
		const text = readFileSync(join(CLIENT_DOCS, name), "utf8").replace("[문서 지도](README.md) · ", "");
		writeFileSync(join(SKILL_REFERENCES, name), text);
	}
	console.log(`synced ${EXTENSION_DOCS.length} docs -> ${SKILL_REFERENCES}`);
}
