/**
 * Splitting a streaming markdown answer (no DOM needed, so it is unit-tested on its own). See renderStreaming in markdown.ts.
 */
import { Lexer } from "marked";

/** The renderer's options (markdown.ts builds its Marked from these): block boundaries depend on them. */
export const MARKED_OPTIONS = { gfm: true, breaks: true } as const;
const lexer = () => new Lexer(MARKED_OPTIONS);

/**
 * Where a streaming answer can be cut into a settled head and a tail that is still being written: the start of its
 * last top-level block. Blocks before it no longer change as tokens arrive, so they are rendered once (and cached)
 * while only the tail is parsed again each frame. Returns 0 when the text cannot be split safely: one block only, or
 * reference-style link definitions, which make an earlier block depend on a later one.
 */
export function streamSplit(src: string): number {
	if (/^ {0,3}\[[^\]]+\]:/m.test(src)) return 0;
	const tokens = lexer().lex(src);
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
	const m = /\n {0,3}(`{1,2}|~{1,2})$/.exec(src);
	if (!m) return src;
	const tokens = lexer().lex(src);
	const last = tokens[tokens.length - 1];
	if (last?.type !== "code" || !last.raw.endsWith(m[0])) return src;
	return src.slice(0, m.index);
}

/** A last line that is only a block marker so far: heading hashes, quote, list bullet or number, rule, table pipes. */
const MARKER_LINE = /(?:^|\n) {0,3}(?:#{1,6}|>|[-*+]|\d{1,9}[.)]?|[-*_]{2,}|[|:\- \t]*\|[|:\- \t]*)[ \t]*$/;

/**
 * A block marker typed on its own line changes shape with every character: `#` is an empty h1, `##` a smaller h2,
 * `--` a paragraph that becomes a rule at `---`. The block below then jumps by a few pixels per token. Hide such a
 * marker-only last line until text follows it. Code (an open fence) keeps its lines as they are.
 */
export function hideMarkerTail(src: string): string {
	const m = MARKER_LINE.exec(src);
	if (!m) return src;
	const last = lexer().lex(src).at(-1);
	if (!last || last.type === "code") return src;
	return src.slice(0, m.index);
}

/** The top-level blocks of `src`, separators dropped. */
export function blocksOf(src: string): string[] {
	return lexer().lex(src).filter((t) => t.type !== "space").map((t) => t.raw);
}
