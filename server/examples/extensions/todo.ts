/**
 * Example server extension: a per-conversation todo list.
 *
 * Install: copy to ~/.pipaya/extensions/todo.ts (or <dataDir>/extensions/), then POST /server-extensions/reload.
 * It shows a tool the model can call, a policy hook, a /command, a client-callable method, per-session storage and
 * cleanup. The matching client side is client/examples/extensions/todo-view.json.
 */
export default (pi: any) => {
	const T = pi.Type;

	// A tool. `mutating: false` = no approval prompt, because it only writes this extension's own record.
	pi.registerTool({
		name: "todo_add",
		description: "Add an item to this conversation's todo list",
		parameters: T.Object({ text: T.String({ minLength: 1, maxLength: 200 }) }),
		mutating: false,
		execute: async (_toolCallId: string, params: { text: string }, ctx: any) => {
			ctx.appendEntry("todo", { text: params.text, done: false });
			return { content: [{ type: "text", text: `Added: ${params.text}` }] };
		},
	});

	// A policy: refuse the worst shell commands before they run. Return nothing to let a call through.
	pi.on("tool_call", (e: any) => {
		if (e.toolName === "bash" && /\brm\s+-rf\s+\/(\s|$)/.test(String(e.args?.command))) {
			return { block: true, reason: "Refused by the todo example's guard" };
		}
	});

	// A /command run by the server. Returning a string sends it to the model as the user's message.
	pi.registerCommand("todos", {
		description: "Ask the agent to summarize the todo list",
		handler: async (_args: string, ctx: any) => {
			const items = ctx.entries("todo").map((e: any) => `- ${e.data.text}`);
			return items.length ? `Here are my todos, suggest what to do first:\n${items.join("\n")}` : "My todo list is empty.";
		},
	});

	// A method a client extension can call with sdk.server.call("todo", "count").
	pi.registerMethod("count", (_params: unknown, ctx: any) => (ctx ? ctx.entries("todo").length : 0));

	pi.on("extension_unload", () => pi.log("todo example unloaded"));
};
