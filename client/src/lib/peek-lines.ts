/** Escape sequences (colours, cursor moves) a terminal would act on; they never span a line break. */
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;

/**
 * The last `n` non-blank lines of a text, trailing space and terminal escapes taken off, each cut to `max` characters
 * (with an ellipsis): what a work box's live preview shows of a command's output or a thought.
 *
 * A running command's output grows to megabytes and the preview asks again on every update, so only the end of the
 * text is read: a window from the end, starting after a line break, grown until it holds `n` whole lines.
 */
export function peekLines(text: string, n: number, max = 400): string[] {
	for (let size = 4096; ; size *= 4) {
		const from = Math.max(0, text.length - size);
		let chunk = text;
		if (from > 0) {
			const nl = text.indexOf("\n", from);
			// the window holds part of one line only: read further back
			if (nl < 0) continue;
			chunk = text.slice(nl + 1);
		}
		const lines = chunk
			.replace(ANSI, "")
			.split(/\r?\n/)
			.map((l) => l.trimEnd())
			.filter((l) => l.trim());
		if (lines.length >= n || from === 0) return lines.slice(-n).map((l) => (l.length > max ? `${l.slice(0, max - 1)}…` : l));
	}
}
