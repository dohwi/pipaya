/** Save `value` as a JSON file through the browser's download. `pretty` indents it for people to read. */
export function download(value: unknown, filename: string, pretty = false) {
	const blob = new Blob([JSON.stringify(value, null, pretty ? 2 : undefined)], { type: "application/json" });
	const url = URL.createObjectURL(blob);
	let link: HTMLAnchorElement | undefined;
	try {
		link = document.createElement("a");
		link.href = url;
		link.download = filename;
		document.body.append(link);
		link.click();
	} finally {
		link?.remove();
		URL.revokeObjectURL(url);
	}
}
