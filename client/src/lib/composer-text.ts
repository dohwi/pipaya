/**
 * Text logic of the composer, kept free of components so it can be unit-tested: which mention the caret is in
 * (@file, $agent, #image), replacing that token with a pick, and the highlight layer drawn under the textarea.
 */

export interface Mention {
	/** What was typed after the sigil */
	query: string;
	/** Index of the sigil in the text */
	start: number;
}

const PATTERNS = {
	file: /(?:^|\s)@([^\s@]*)$/,
	agent: /(?:^|\s)\$([a-z0-9-]*)$/,
	image: /(?:^|\s)#([a-z0-9]*)$/,
} as const;
export type MentionKind = keyof typeof PATTERNS;

/** The mention of `kind` that ends at the caret, e.g. "look at @src/comp|" → { query: "src/comp", start: 8 }. */
export function mentionAt(kind: MentionKind, text: string, caret: number): Mention | null {
	const m = PATTERNS[kind].exec(text.slice(0, caret));
	return m ? { query: m[1]!, start: caret - m[1]!.length - 1 } : null;
}

/**
 * Put `insert` where the mention starts, up to the caret. A following space is folded into the insert's own trailing
 * space; `keepSpace` keeps it (a folder pick leaves the menu open to keep drilling down). Returns the new text and caret.
 */
export function replaceMention(text: string, caret: number, mention: Mention, insert: string, keepSpace = false): { text: string; caret: number } {
	const before = text.slice(0, mention.start);
	const after = text.slice(caret);
	return { text: before + insert + after.replace(/^ /, keepSpace ? " " : ""), caret: before.length + insert.length };
}

/** Put `token` at `pos`, with a space on each side where it would otherwise touch a word. */
export function insertToken(text: string, pos: number, token: string): { text: string; caret: number } {
	const before = text.slice(0, pos);
	const after = text.slice(pos);
	const pre = before && !/\s$/.test(before) ? " " : "";
	const post = after && !/^\s/.test(after) ? " " : after ? "" : " ";
	return { text: before + pre + token + post + after, caret: (before + pre + token + post).length };
}

/** Splits sent text into plain pieces and `#imageN` tokens that refer to one of `images` attached images. */
export function splitImageTokens(text: string, images: number): { text: string; img: boolean }[] {
	const out: { text: string; img: boolean }[] = [];
	let last = 0;
	for (const m of text.matchAll(/(^|\s)(#image(\d+))(?=\s|$)/g)) {
		const n = Number(m[3]);
		if (n < 1 || n > images) continue;
		const start = m.index + m[1].length;
		if (start > last) out.push({ text: text.slice(last, start), img: false });
		out.push({ text: m[2], img: true });
		last = start + m[2].length;
	}
	if (last < text.length) out.push({ text: text.slice(last), img: false });
	return out;
}

const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export interface Known {
	templates: readonly { name: string }[];
	skills: readonly { name: string }[];
	agents: readonly { name: string }[];
	/** How many images are attached (#image1..#imageN are valid) */
	images: number;
	/** Paths picked from the @ menu: only these exact tokens are marked */
	paths: readonly string[];
}

/**
 * The text as HTML for the layer under the textarea: escaped, with tokens that refer to something real wrapped in a
 * `<mark>` of their kind. A trailing newline keeps the layer's height in step with a textarea that ends in a newline.
 */
export function mirrorHtml(text: string, known: Known): string {
	return (
		esc(text).replace(/(^|\s)(@[^\s@]+|\$[a-z0-9-]+|\/skill:[a-z0-9-]+|\/prompt:[a-z0-9-]+|#image(\d+))(?=\s|$)/g, (m, lead: string, tok: string, n?: string) => {
			if (tok.startsWith("/prompt:")) return known.templates.some((k) => k.name === tok.slice(8)) ? `${lead}<mark class="skill">${tok}</mark>` : m;
			if (tok.startsWith("/skill:")) return known.skills.some((k) => k.name === tok.slice(7)) ? `${lead}<mark class="skill">${tok}</mark>` : m;
			if (tok.startsWith("$")) return known.agents.some((a) => a.name === tok.slice(1)) ? `${lead}<mark class="agent">${tok}</mark>` : m;
			if (n !== undefined) return Number(n) >= 1 && Number(n) <= known.images ? `${lead}<mark class="img">${tok}</mark>` : m;
			return known.paths.some((p) => esc(`@${p}`) === tok) ? `${lead}<mark class="file">${tok}</mark>` : m;
		}) + "\n"
	);
}
