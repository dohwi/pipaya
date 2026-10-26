import { saveFile } from "./save-file";

/** Save `value` as a JSON file through the browser's download. `pretty` indents it for people to read. */
export function download(value: unknown, filename: string, pretty = false): Promise<boolean> {
	return saveFile(new Blob([JSON.stringify(value, null, pretty ? 2 : undefined)], { type: "application/json" }), filename);
}
