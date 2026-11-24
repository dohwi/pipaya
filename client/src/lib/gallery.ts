const PIC = '<span class="wd-img"[^>]*>[^<]*</span>';
const PIC_ALL = new RegExp(PIC, "g");
/** Paragraphs made only of server pictures (separated by line breaks or blank lines), one or more in a row. */
const PIC_RUN = new RegExp(String.raw`(?:<p>\s*(?:${PIC}\s*(?:<br\s*/?>\s*)?)+</p>\s*)+`, "g");

/** Two or more pictures in a row become one swipeable strip (like a social-media post); a lone picture stays as is. */
export function groupPictures(html: string): string {
	return html.replace(PIC_RUN, (run) => {
		const pics = run.match(PIC_ALL) ?? [];
		if (pics.length < 2) return run;
		return `<div class="gallery" data-count="${pics.length}">${pics.join("")}</div>`;
	});
}
