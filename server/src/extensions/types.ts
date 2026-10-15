import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Provider } from "@earendil-works/pi-ai";
import type { TSchema } from "typebox";

/**
 * Public API of a server extension. An extension is a `.ts`/`.js` file (or a folder with `index.ts`) that
 * default-exports `(pi: ExtensionAPI) => void | Promise<void>`. It runs inside the server process with the
 * server's full privileges, like any code you install: only load extensions you trust.
 */

export type PromptMode = "prompt" | "steer" | "follow_up";

/** What every handler, tool and command receives besides its own payload. */
export interface ExtensionContext {
	sessionId: string;
	cwd: string;
	/** Persist a custom entry on this session (survives restarts; not sent to the model). Also published as `extension_entry`. */
	appendEntry(type: string, data: unknown): void;
	/** Entries this extension stored on this session, oldest first. */
	entries(type?: string): { id: number; type: string; data: unknown; createdAt: number }[];
	/** Queue a user message. Starts a run when the session is idle (`prompt`), otherwise use `steer`/`follow_up`. */
	sendUserMessage(text: string, mode?: PromptMode): Promise<void>;
	/** Stop the running agent. */
	abort(): boolean;
	/** True while the agent is working. */
	isRunning(): boolean;
}

export interface ToolResult {
	content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[];
	details?: Record<string, unknown>;
}

export interface ExtensionTool {
	/** Same name as a built-in tool (`read`, `bash`, …) replaces it. */
	name: string;
	label?: string;
	description: string;
	/** A typebox schema (use `pi.Type`). */
	parameters: TSchema;
	/** Mutating tools need approval in `ask` mode and are blocked in `readonly`. Default true (safe). */
	mutating?: boolean;
	/** Part of the default tool set of new sessions. Default true. */
	defaultActive?: boolean;
	execute(
		toolCallId: string,
		params: any,
		ctx: ExtensionContext,
		signal?: AbortSignal,
		onUpdate?: (partial: ToolResult) => void,
	): Promise<ToolResult> | ToolResult;
}

export interface ExtensionCommand {
	description?: string;
	/** Return a string (or `{ prompt }`) to send it to the model as the user's message; return nothing to just handle it. */
	handler(args: string, ctx: ExtensionContext): Promise<void | string | { prompt: string }> | void | string | { prompt: string };
}

export interface ExtensionFlag {
	description?: string;
	type?: "boolean" | "string";
	default?: boolean | string;
}

// ── events ──────────────────────────────────────────────────────────────────

export interface EventMap {
	/** A user message arrived. Return `{ text }` to rewrite it or `{ handled: true }` to swallow it. */
	input: [{ sessionId: string; text: string; mode: PromptMode }, void | { text?: string; handled?: boolean }];
	/** Before a prompt starts the agent. Add context for this run only. */
	before_agent_start: [
		{ sessionId: string; text: string },
		void | { systemPrompt?: string; appendSystemPrompt?: string; message?: string },
	];
	/** Just before each model call. Return `{ messages }` to change what the model sees (nothing is stored). */
	context: [{ sessionId: string; messages: AgentMessage[] }, void | { messages: AgentMessage[] }];
	/** Before a tool runs. `args` may be edited in place. Return `{ block: true, reason }` to stop it. */
	tool_call: [{ sessionId: string; toolCallId: string; toolName: string; args: any }, void | { block?: boolean; reason?: string }];
	/** After a tool ran. Return fields to replace parts of the result. */
	tool_result: [
		{ sessionId: string; toolCallId: string; toolName: string; args: any; content: any[]; details: unknown; isError: boolean },
		void | { content?: any[]; details?: unknown; isError?: boolean },
	];
	/** Raw agent loop events: agent_start, agent_end, turn_start, turn_end, message_start, message_end, tool_execution_start, tool_execution_end. */
	agent_start: [{ sessionId: string }, void];
	agent_end: [{ sessionId: string; messageCount: number }, void];
	turn_start: [{ sessionId: string }, void];
	turn_end: [{ sessionId: string; message: AgentMessage }, void];
	message_end: [{ sessionId: string; message: AgentMessage; seq: number }, void];
	/** Before a compaction summary is written. Return `{ cancel: true }` or your own `{ summary }`. */
	session_before_compact: [
		{ sessionId: string; reason: "manual" | "threshold"; messages: AgentMessage[]; previousSummary: string | null; instructions?: string },
		void | { cancel?: boolean; summary?: string },
	];
	session_compact: [{ sessionId: string; summary: string; tokensBefore: number }, void];
	session_start: [{ sessionId: string }, void];
	session_shutdown: [{ sessionId: string }, void];
	session_fork: [{ sessionId: string; from: string }, void];
	/** Server finished loading/reloading all extensions. */
	extensions_loaded: [{ names: string[] }, void];
}
export type EventName = keyof EventMap;
export type EventHandler<E extends EventName> = (event: EventMap[E][0], ctx: ExtensionContext) => EventMap[E][1] | Promise<EventMap[E][1]>;

export interface ExtensionAPI {
	/** typebox, so tool schemas need no import: `pi.Type.Object({ ... })`. */
	Type: typeof import("typebox").default;
	/** Name of this extension (file or folder name). */
	name: string;
	on<E extends EventName>(event: E, handler: EventHandler<E>): void;
	registerTool(tool: ExtensionTool): void;
	/** A `/name args` message typed by the user. */
	registerCommand(name: string, command: ExtensionCommand): void;
	/** Callable by clients: `POST /server-extensions/:extension/methods/:name`. */
	registerMethod(name: string, handler: (params: unknown, ctx: ExtensionContext | null) => unknown | Promise<unknown>): void;
	/** A model provider (custom endpoint, proxy, OAuth login …). Same shape as pi-ai's `Provider`. */
	registerProvider(provider: Provider): void;
	unregisterProvider(id: string): void;
	/** The original built-in tool, e.g. to wrap `bash` from an override of the same name. */
	builtinTool(name: string, cwd: string): import("@earendil-works/pi-agent-core").AgentTool<any> | undefined;
	registerFlag(name: string, flag?: ExtensionFlag): void;
	/** Value of a flag: environment `HARNESS_FLAG_<NAME>`, otherwise the default. */
	getFlag(name: string): boolean | string | undefined;
	/** Publish a custom event to clients (`extension_event`). `sessionId: null` = global. */
	emit(sessionId: string | null, type: string, data?: unknown, opts?: { ephemeral?: boolean }): void;
	/** In-process event bus shared by all extensions. */
	events: {
		on(channel: string, handler: (data: unknown) => void): () => void;
		emit(channel: string, data?: unknown): void;
	};
	/** Where this extension may keep files (created on first use). */
	dataDir: string;
	log(...args: unknown[]): void;
}

export type ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>;
