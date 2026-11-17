/**
 * What the crash screen offers to copy: enough to tell which list or part broke without a debugger. A production build
 * throws Svelte errors as a bare URL (`https://svelte.dev/e/each_key_duplicate`), so the stack is the only lead to the
 * component; the screen and the last place opened are added for context. Pure, so tests can import it.
 */

export interface CrashContext {
	/** When the error was caught (ms since epoch) */
	at: number;
	/** Page address without the query (it can hold a token) */
	url: string;
	userAgent: string;
	/** The client build (`app.version`), when known */
	version?: string;
}

/** The message, its Svelte error code when it has one, and the stack (top frames only: they name the component). */
export function crashReport(error: unknown, ctx: CrashContext, maxFrames = 12): string {
	const err = error instanceof Error ? error : null;
	const message = err ? err.message : String(error);
	const code = /svelte\.dev\/e\/([a-z_]+)/.exec(message)?.[1] ?? (/^([a-z]+(?:_[a-z]+)+)\b/.exec(message)?.[1] ?? "");
	const stack = (err?.stack ?? "")
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l && l !== message && !l.startsWith(`${err?.name}: `))
		.slice(0, maxFrames);
	return [
		`error: ${message.split("\n")[0]}`,
		...(code ? [`code: ${code}`] : []),
		`at: ${new Date(ctx.at).toISOString()}`,
		...(ctx.version ? [`version: ${ctx.version}`] : []),
		`url: ${ctx.url.split("?")[0]}`,
		`agent: ${ctx.userAgent}`,
		...(stack.length ? ["stack:", ...stack.map((l) => `  ${l}`)] : []),
	].join("\n");
}
