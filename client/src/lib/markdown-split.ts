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

/** The top-level blocks of `src`, separators dropped. */
export function blocksOf(src: string): string[] {
	return lexer().lex(src).filter((t) => t.type !== "space").map((t) => t.raw);
}
