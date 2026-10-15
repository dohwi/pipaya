import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("closed chats permanent deletion", () => {
	test("PaletteSpec defines ondelete handler", () => {
		const storeSrc = readFileSync(resolve(__dirname, "../src/lib/store.svelte.ts"), "utf-8");
		expect(storeSrc).toContain("ondelete?: (item: PaletteItem) => void | Promise<void>;");
	});

	test("resume command configures ondelete with permanent removal and toast", () => {
		const cmdSrc = readFileSync(resolve(__dirname, "../src/lib/commands.ts"), "utf-8");
		expect(cmdSrc).toContain("ondelete: async (it) => {");
		expect(cmdSrc).toContain("const ok = await app.remove(it.id);");
		expect(cmdSrc).toContain('app.toast(t("대화를 영구 삭제했습니다"));');
		expect(cmdSrc).toContain("items: app.palette.items.filter((x) => x.id !== it.id)");
	});

	test("Palette component renders X button when ondelete is provided", () => {
		const palSrc = readFileSync(resolve(__dirname, "../src/components/Palette.svelte"), "utf-8");
		expect(palSrc).toContain("{#if spec.ondelete}");
		expect(palSrc).toContain('class="del"');
		expect(palSrc).toContain("void spec?.ondelete?.(it);");
		expect(palSrc).toContain('e.key === "Delete" && e.shiftKey && spec?.ondelete');
	});

	test("server store delete cleans up all dependent tables", () => {
		const srvStoreSrc = readFileSync(resolve(__dirname, "../../server/src/store.ts"), "utf-8");
		expect(srvStoreSrc).toContain('DELETE FROM messages WHERE session_id = $id');
		expect(srvStoreSrc).toContain('DELETE FROM session_contexts WHERE session_id = $id');
		expect(srvStoreSrc).toContain('DELETE FROM events WHERE session_id = $id');
		expect(srvStoreSrc).toContain('DELETE FROM sessions WHERE id = $id');
	});
});
