/**
 * Text logic of the composer, kept free of components so it can be unit-tested: which mention the caret is in
 * (#file or #imageN, @mention), replacing that token with a pick, and the highlight layer drawn under the textarea.
 */

export interface Mention {
	/** What was typed after the sigil */
	query: string;
	/** Index of the sigil in the text */
	start: number;
}

export interface SlashToken extends Mention {
	/** Only whitespace (or nothing) precedes the `/`, so whole-message commands like `/prompt:` or `/compact` apply. */
	atStart: boolean;
	/** Non-whitespace text follows the caret, so picking must splice rather than clear or run an argument-less command. */
	hasTrailing: boolean;
}

const PATTERNS = {
	file: /(?:^|\s)#([^\s#]*)$/,
	at: /(?:^|\s)@([^\s@]*)$/,
	image: /(?:^|\s)#([a-z0-9]*)$/,
} as const;
export type MentionKind = keyof typeof PATTERNS;

const SLASH_PATTERN = /(?:^|\s)\/([a-z][a-z0-9-]*(?::[A-Za-z0-9_.-]*)?|)$/i;

/** The mention of `kind` that ends at the caret, e.g. "look at #src/comp|" → { query: "src/comp", start: 8 }. */
export function mentionAt(kind: MentionKind, text: string, caret: number): Mention | null {
	const m = PATTERNS[kind].exec(text.slice(0, caret));
	return m ? { query: m[1]!, start: caret - m[1]!.length - 1 } : null;
}

/**
 * The `/command` or `/skill:` token that ends at the caret, whether at the start of the draft or after whitespace
 * (e.g. "fix this /orch|" or "/s|fix this"). Paths (`/a/b`, `/README.md`) and mid-word slashes (`a/b`, `http://`) do not match.
 */
export function slashAt(text: string, caret: number): SlashToken | null {
	const pos = Math.max(0, Math.min(caret, text.length));
	const head = text.slice(0, pos);
	const m = SLASH_PATTERN.exec(head);
	if (!m) return null;
	const query = m[1]!;
	const tail = text.slice(pos);
	// Don't split an ASCII command/skill word in half (e.g. clicking inside `/mo|del gpt` or `/skill:or|chestrate`),
	// while still allowing `/` right before existing text (`/|fix this`) or before non-ASCII text (`/orch|추가적으로`).
	if (query.length > 0 && /^[A-Za-z0-9_:-]/.test(tail)) return null;
	const start = pos - query.length - 1;
	return {
		query,
		start,
		atStart: head.slice(0, start).trim().length === 0,
		hasTrailing: tail.trim().length > 0,
	};
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

const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The known `@name` a token starts with: the longest name, not cut out of a longer ASCII word (`@미나랑` is `@미나` plus a particle). */
export function knownMention(token: string, names: readonly string[]): string | null {
	const low = token.toLowerCase();
	let best: string | null = null;
	for (const n of names) {
		const l = n.toLowerCase();
		if (!low.startsWith(l) || (best && n.length <= best.length)) continue;
		if (/[a-z0-9_-]$/.test(l) && /^[a-z0-9_-]/.test(low.slice(l.length))) continue;
		best = n;
	}
	return best;
}

/** A run of message text: plain, or a token the chat draws as a chip (`@name` of a known session or group, `#imageN`, `#path`, `/skill:name`). */
export type TextPart = { text: string; kind?: "mention" | "image" | "file" | "skill"; name?: string };

/** A `#` token that reads as a file path: has a `/` or ends in an extension (`#src/a.ts`, `#README.md`), not `#96` or `#main`. */
const FILE_TOKEN = /^(?=[^\s#]*[A-Za-z])[^\s#]*(?:\/[^\s#]*|\.[A-Za-z0-9]{1,8})$/;

/**
 * A sent message cut into plain runs and the tokens the composer marks, by the same rules: a token starts the text or
 * follows whitespace; `@name` only for a known name (`@미나랑` is `@미나` plus "랑"; `a@b.c` is no mention), `#imageN` only
 * for an attached image (1..images), `#path` only when it reads as a path, and `/skill:name` only for a skill the
 * server confirmed it injected (`<pipaya-hint>`). Trailing particles/punctuation stay text.
 */
export function splitTokens(text: string, known: { names: readonly string[]; images?: number; skills?: readonly string[] }): TextPart[] {
	const hasSkills = !!known.skills?.length && text.includes("/skill:");
	if (!/[@#]/.test(text) && !hasSkills) return [{ text }];
	const out: TextPart[] = [];
	let plain = "";
	let last = 0;
	const push = (at: number, part: TextPart) => {
		plain += text.slice(last, at);
		if (plain) out.push({ text: plain });
		plain = "";
		out.push(part);
		last = at + part.text.length;
	};
	for (const m of text.matchAll(/(^|\s)(?:([@#])([^\s@#]+)|\/skill:([a-z0-9]+(?:-[a-z0-9]+)*)(?![A-Za-z0-9_/-]))/g)) {
		const at = m.index! + m[1]!.length;
		if (m[4]) {
			if (known.skills?.includes(m[4])) push(at, { text: `/skill:${m[4]}`, kind: "skill", name: m[4] });
			continue;
		}
		const body = m[3]!;
		if (m[2] === "@") {
			const hit = knownMention(body, known.names);
			if (hit) push(at, { text: `@${body.slice(0, hit.length)}`, kind: "mention", name: hit });
			continue;
		}
		const img = /^image(\d+)(?![\w./-])/.exec(body);
		if (img) {
			const n = Number(img[1]);
			if (n >= 1 && n <= (known.images ?? 0)) push(at, { text: `#${img[0]}`, kind: "image", name: img[1] });
			continue;
		}
		const path = body.replace(/[.,;:!?)\]}'"]+$/, "");
		if (FILE_TOKEN.test(path)) push(at, { text: `#${path}`, kind: "file", name: path });
	}
	plain += text.slice(last);
	if (plain) out.push({ text: plain });
	return out;
}

export interface Known {
	/** `prefix:name` of the command-family entries (`/snip:review`) that exist */
	commands: readonly string[];
	skills: readonly { name: string }[];
	/** Tokens an extension offers after `@` (without the `@`) */
	mentions: readonly string[];
	/** How many images are attached (#image1..#imageN are valid) */
	images: number;
	/** Paths picked from the # menu: only these exact tokens are marked */
	paths: readonly string[];
}

const MIRROR_TOKEN = /(^|\s)(#image(\d+)(?=\s|$)|#[^\s#]+|@[^\s@]+|\/skill:[^\s]+|\/[a-z][a-z0-9-]*:[A-Za-z0-9_.-]+)(?=\s|$)/g;
const MIRROR_SKILL = /^\/skill:([a-z0-9]+(?:-[a-z0-9]+)*)(?![A-Za-z0-9_/-])(.*)$/;

/**
 * The text as HTML for the layer under the textarea: escaped, with tokens that refer to something real wrapped in a
 * `<mark>` of their kind. A trailing newline keeps the layer's height in step with a textarea that ends in a newline.
 */
export function mirrorHtml(text: string, known: Known): string {
	const escaped = esc(text);
	if (!escaped.includes("#") && !escaped.includes("@") && !escaped.includes("/")) return `${escaped}\n`;
	let commandSet: Set<string> | undefined;
	let skillSet: Set<string> | undefined;
	let escapedMentions: string[] | undefined;
	let pathSet: Set<string> | undefined;
	return (
		escaped.replace(MIRROR_TOKEN, (m, lead: string, tok: string, n?: string) => {
			if (tok.startsWith("/") && !tok.startsWith("/skill:")) {
				commandSet ??= new Set(known.commands);
				return commandSet.has(tok.slice(1)) ? `${lead}<mark class="skill">${tok}</mark>` : m;
			}
			if (tok.startsWith("/skill:")) {
				const sm = MIRROR_SKILL.exec(tok);
				if (!sm) return m;
				skillSet ??= new Set(known.skills.map((k) => k.name));
				return skillSet.has(sm[1]!) ? `${lead}<mark class="skill">/skill:${sm[1]}</mark>${sm[2]}` : m;
			}
			if (tok.startsWith("@")) {
				const rest = tok.slice(1);
				escapedMentions ??= known.mentions.map(esc);
				const hit = knownMention(rest, escapedMentions);
				return hit ? `${lead}<mark class="mention">@${hit}</mark>${rest.slice(hit.length)}` : m;
			}
			if (n !== undefined && Number(n) >= 1 && Number(n) <= known.images) return `${lead}<mark class="img">${tok}</mark>`;
			pathSet ??= new Set(known.paths.map((p) => esc(`#${p}`)));
			return pathSet.has(tok) ? `${lead}<mark class="file">${tok}</mark>` : m;
		}) + "\n"
	);
}

/** `#image1`-style reserved words refer to attachments by position (1-based). */
const IMG_TOKEN = /#image(\d+)\b/g;
const IMG_TOKEN_OPT_LEAD = /([ \t]?)#image(\d+)\b/g;

/** The image at 1-based position `gone` was removed: drop its token (and the space before it) and renumber the later ones. */
export function dropImageToken(text: string, gone: number): string {
	if (!text.includes("#image")) return text;
	return text.replace(IMG_TOKEN_OPT_LEAD, (m, lead: string, nStr: string) => {
		const n = Number(nStr);
		if (n === gone) return "";
		if (n > gone) return `${lead}#image${n - 1}`;
		return m;
	});
}

/**
 * A message handed back to the input after it was not sent (its run was stopped), merged with what is typed now: the
 * returned text goes first (it was written first), what is typed follows. Pictures are added after the ones already
 * attached, so the message's `#imageN` tokens are renumbered to their new places.
 */
export function mergeReturned(current: string, imagesBefore: number, back: { text: string; images: number }): string {
	const shifted = imagesBefore ? back.text.replace(IMG_TOKEN, (m, n) => (Number(n) >= 1 && Number(n) <= back.images ? `#image${Number(n) + imagesBefore}` : m)) : back.text;
	return current.trim() ? `${shifted.replace(/\s+$/, "")}\n${current}` : shifted;
}

const SKILL_TOKEN_RE = /(?:^|\s)\/skill:([a-z0-9]+(?:-[a-z0-9]+)*)(?![A-Za-z0-9_/-])/g;

/** Names written as `/skill:name` in a message, in order of appearance, without repeats. Matches the server's parser. */
export function extractSkillNames(text: string, knownNames?: readonly string[]): string[] {
	if (!text.includes("/skill:")) return [];
	const out: string[] = [];
	for (const m of text.matchAll(SKILL_TOKEN_RE)) {
		const name = m[1]!;
		if (knownNames && !knownNames.includes(name)) continue;
		if (!out.includes(name)) out.push(name);
	}
	return out;
}
