import { saveFile } from "./save-file";

/** Save `value` as a JSON file (a native dialog in the app, the browser's download otherwise). `pretty` indents it for people to read. A failure is shown as a toast. */
export async function download(value: unknown, filename: string, pretty = false): Promise<boolean> {
	try {
		return await saveFile(new Blob([JSON.stringify(value, null, pretty ? 2 : undefined)], { type: "application/json" }), filename);
	} catch (e) {
		const [{ app }, { t }, { errorText }] = await Promise.all([import("./store.svelte"), import("./i18n"), import("./api")]);
		app.toast(`${t("저장하지 못했습니다")}: ${errorText(e)}`, "error");
		return false;
	}
}
