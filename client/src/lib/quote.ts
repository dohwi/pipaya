/** Quoted replies, kept free of components so they can be unit-tested. */

const MAX_LINES = 4;
const MAX_CHARS = 240;

/** `> ` lines quoting `text` (shortened), followed by a blank line so the reply starts below it. */
export function makeQuote(text: string, who?: string): string {
	const flat = text.replace(/\r/g, "").trim();
	let cut = flat.split("\n").filter((l) => l.trim()).slice(0, MAX_LINES).join("\n");
	if (cut.length > MAX_CHARS) cut = `${cut.slice(0, MAX_CHARS).trimEnd()}…`;
	else if (cut.length < flat.length) cut += "…";
	const lines = cut.split("\n").map((l) => `> ${l}`);
	if (who) lines[0] = `> ${who}: ${cut.split("\n")[0]}`;
	return `${lines.join("\n")}\n\n`;
}

/** Splits leading `> ` quote lines off a sent message. */
export function splitQuote(text: string): { quote: string; rest: string } {
	const lines = text.split("\n");
	let i = 0;
	while (i < lines.length && lines[i]!.startsWith("> ")) i++;
	if (!i) return { quote: "", rest: text };
	return { quote: lines.slice(0, i).map((l) => l.slice(2)).join("\n"), rest: lines.slice(i).join("\n").replace(/^\n/, "") };
}
