/**
 * Splitting a streaming markdown answer (no DOM needed, so it is unit-tested on its own). See renderStreaming in markdown.ts.
 */
import { Marked, Tokenizer, type MarkedExtension, type Token, type Tokens } from "marked";

/** The renderer's options (markdown.ts builds its Marked from these): block boundaries depend on them. */
export const MARKED_OPTIONS = { gfm: true, breaks: true } as const;

/**
 * No indented code blocks. Models indent lists and paragraphs by four spaces (`    1. step`) far more often than they
 * mean a code block (they fence code), and CommonMark turns those lines into a grey `<pre>`. A block indented by four
 * spaces is therefore parsed again with the indent taken off, as ordinary blocks. Fenced code is not touched.
 */
export const NO_INDENTED_CODE: MarkedExtension = {
	tokenizer: {
		code(src) {
			const tok = Tokenizer.prototype.code.call(this, src);
			if (!tok) return false;
			// The blocks inside sit where the indented block stood: blocks of their own (paragraphs, not loose text).
			const state = this.lexer.state;
			const top = state.top;
			state.top = true;
			try {
				// Each pass takes four columns off, so a deeper indent ends after a few passes; inline parts are lexed with the rest.
				return { type: "indented", raw: tok.raw, text: tok.text, tokens: this.lexer.blockTokens(tok.text, []) } as unknown as Tokens.Code;
			} finally {
				state.top = top;
			}
		},
	},
	extensions: [{ name: "indented", renderer(token) { return this.parser.parse(token.tokens ?? []); } }],
};

/** Full-width and CJK punctuation (`）`, `。`, `」`, ...): never part of a bare URL. */
const CJK_PUNCT = /[\u3000-\u303f\uff01-\uff0f\uff1a-\uff20\uff3b-\uff40\uff5b-\uff65]/u;
/** Characters after which a non-ASCII run is still a path or query part (`/wiki/서울`, `?q=한글`). */
const URL_JOIN = /[/?=&#%+\-_.~:]/;

/**
 * Where a bare URL really ends. GFM only stops a URL at a space, so in Korean text the particle written right after it
 * (`https://x.com/a에서`, `(https://x.com/pull/1)에`) becomes part of the link. The URL is cut at CJK punctuation, and
 * before a non-ASCII letter that follows an ASCII one other than a path or query separator.
 */
export function bareUrlEnd(url: string): number {
	const chars = [...url];
	let end = 0;
	for (let i = 0; i < chars.length; i++) {
		const c = chars[i]!;
		if (CJK_PUNCT.test(c)) break;
		const prev = chars[i - 1];
		if (c.charCodeAt(0) > 0x7f && prev !== undefined && prev.charCodeAt(0) <= 0x7f && !URL_JOIN.test(prev)) break;
		end += c.length;
	}
	return end;
}

/** Bare URLs end where Korean text resumes (see `bareUrlEnd`); `<...>` autolinks and mail addresses are untouched. */
export const BARE_URL_END: MarkedExtension = {
	tokenizer: {
		url(src) {
			const tok = Tokenizer.prototype.url.call(this, src);
			if (!tok || tok.href.startsWith("mailto:")) return tok;
			let raw = tok.raw.slice(0, bareUrlEnd(tok.raw));
			if (raw === tok.raw) return tok;
			// The cut may leave `)` or `.` at the end: take those off the way GFM does.
			const backpedal = this.rules.inline._backpedal;
			for (let prev = ""; prev !== raw; ) {
				prev = raw;
				raw = backpedal.exec(raw)?.[0] ?? "";
			}
			if (!raw) return false;
			const href = tok.href.startsWith("http://") && raw.startsWith("www.") ? `http://${raw}` : raw;
			return { type: "link", raw, text: raw, href, autolink: true, tokens: [{ type: "text", raw, text: raw }] } as Tokens.Link;
		},
	},
};

/** Same options and extension as the renderer, so the blocks split here are the blocks it draws. */
const splitter = new Marked(MARKED_OPTIONS, NO_INDENTED_CODE, BARE_URL_END);
const lex = (src: string) => splitter.lexer(src);

/**
 * Where a streaming answer can be cut into a settled head and a tail that is still being written: the start of its
 * last top-level block. Blocks before it no longer change as tokens arrive, so they are rendered once (and cached)
 * while only the tail is parsed again each frame. Returns 0 when the text cannot be split safely: one block only, or
 * reference-style link definitions, which make an earlier block depend on a later one.
 */
export function streamSplit(src: string): number {
	// any indent: an indented block is parsed as ordinary blocks, so a definition inside one counts too
	if (/^[ \t]*\[[^\]]+\]:/m.test(src)) return 0;
	const tokens = lex(src);
	// The last real block; the separator before it ("space") belongs to the head.
	let end = tokens.length - 1;
	while (end >= 0 && tokens[end]!.type === "space") end--;
	if (end <= 0) return 0;
	let at = 0;
	for (let i = 0; i < end; i++) at += tokens[i]!.raw.length;
	// The lexer's raw pieces add up to the input; if they ever do not, do not guess.
	return src.startsWith(tokens.slice(0, end).map((t) => t.raw).join("")) ? at : 0;
}

/**
 * While the closing fence of a code block is being typed, its first one or two backticks are still code text: they
 * would add a line that vanishes once the third arrives, bouncing the height (and the pinned scroll) by a line every
 * block. Hide that unfinished fence until it is complete.
 */
export function hideFenceTail(src: string): string {
	// any indent: a fence inside an indented block is a fence too (see NO_INDENTED_CODE)
	const m = /\n[ \t]*(`{1,2}|~{1,2})$/.exec(src);
	if (!m) return src;
	const last = lastBlock(src);
	// the indented block's code has its indent taken off, so match the fence characters on their own line
	if (last?.type !== "code" || !new RegExp(`\\n[ \\t]*${m[1]}$`).test(last.raw)) return src;
	return src.slice(0, m.index);
}

/** A last line that is only a block marker so far: heading hashes, quote, list bullet or number, rule, table pipes. */
const MARKER_LINE = /(?:^|\n)[ \t]*(?:#{1,6}|>|[-*+]|\d{1,9}[.)]?|[-*_]{2,}|[|:\- \t]*\|[|:\- \t]*)[ \t]*$/;

/**
 * A block marker typed on its own line changes shape with every character: `#` is an empty h1, `##` a smaller h2,
 * `--` a paragraph that becomes a rule at `---`. The block below then jumps by a few pixels per token. Hide such a
 * marker-only last line until text follows it. Code (an open fence) keeps its lines as they are.
 */
export function hideMarkerTail(src: string): string {
	const m = MARKER_LINE.exec(src);
	if (!m) return src;
	const last = lastBlock(src);
	if (!last || last.type === "code") return src;
	return src.slice(0, m.index);
}

/** The last block that is drawn: inside an indented block, its own last block (it is drawn as those blocks). */
function lastBlock(src: string): Token | undefined {
	const last = (tokens: Token[]) => [...tokens].reverse().find((t) => t.type !== "space");
	let t = last(lex(src));
	while (t?.type === "indented") t = last((t as Tokens.Generic).tokens ?? []);
	return t;
}

/** The top-level blocks of `src`, separators dropped. */
export function blocksOf(src: string): string[] {
	return lex(src).filter((t) => t.type !== "space").map((t) => t.raw);
}
