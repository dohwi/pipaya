import type { AssistantBlock, Step } from "./types";

export type Segment = { kind: "text"; text: string; i: number } | { kind: "work"; steps: Step[]; i: number };

/**
 * A reply's blocks as the rows it renders: text keeps its place, and the thoughts and tool calls between two pieces of
 * text share one work box. `i` is the block's index, a stable key while the reply streams (-1 = the stand-in box).
 * While `live` and nothing has arrived yet, an empty work box stands in for "the agent is thinking".
 */
export function segmentsOf(blocks: readonly AssistantBlock[], live: boolean): Segment[] {
	const out: Segment[] = [];
	blocks.forEach((block, i) => {
		if (block.type === "text") return void out.push({ kind: "text", text: block.text, i });
		const step: Step = block.type === "thinking" ? { kind: "think", text: block.text, done: block.done } : { kind: "tool", id: block.id, name: block.name, args: block.args };
		const prev = out[out.length - 1];
		if (prev?.kind === "work") prev.steps.push(step);
		else out.push({ kind: "work", steps: [step], i });
	});
	if (live && !out.length) out.push({ kind: "work", steps: [], i: -1 });
	return out;
}

/** The text of a reply, the way "copy" and "reply" take it: its text blocks only, a blank line apart. */
export const plainTextOf = (blocks: readonly AssistantBlock[]): string =>
	blocks
		.filter((b): b is Extract<AssistantBlock, { type: "text" }> => b.type === "text")
		.map((b) => b.text)
		.join("\n\n");
