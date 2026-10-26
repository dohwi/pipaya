import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Provider } from "@earendil-works/pi-ai";
import type { TSchema } from "typebox";

/**
 * Public API of a server extension. An extension is a `.ts`/`.js` file (or a folder with `index.ts`, or a folder whose
 * `package.json` lists entry files in `pipaya.extensions`) that
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
	/** Ask the user and wait for the answer (the client shows the question card for `toolCallId`). Rejects when the run is aborted. */
	ask(toolCallId: string, req: AskRequest, signal?: AbortSignal): Promise<string>;
}

export interface AskRequest {
	question: string;
	options?: string[];
	recommended?: string;
	allowFreeText?: boolean;
	/** Several questions at once; `question`/`options` describe the first one. */
	items?: { question: string; options?: string[]; recommended?: string; allowFreeText?: boolean }[];
}

/** A session as an extension sees it. */
export interface SessionInfo {
	id: string;
	title: string;
	/** What its agent works on (written by the system model); "" until then. */
	purpose: string;
	cwd: string;
	provider: string;
	model: string;
	thinkingLevel: string;
	/** Names of the tools the session's agent has. */
	tools: string[];
	closed: boolean;
	parentId: string | null;
	createdAt: number;
	/** Last use, unix ms. */
	updatedAt: number;
	/** The agent is working right now. */
	running: boolean;
	/** In use: running, or waiting for an answer from the user. Such a session is never deleted. */
	busy: boolean;
}

export interface SessionMessage {
	seq: number;
	role: string;
	createdAt: number;
	/** The stored message as the model saw it (`content` is a string or an array of blocks). */
	message: any;
}

export interface CreateSessionOptions {
	title?: string;
	/** Absolute, or relative to the default working directory. Default: the default working directory. */
	cwd?: string;
	/** `provider` and `model` go together. Default: the server's default model. */
	provider?: string;
	model?: string;
	thinkingLevel?: string;
	systemPrompt?: string;
	/** Tool names. Default: the default tool set. */
	tools?: string[];
	/** Session this one was started from (shown as its parent). */
	parentId?: string;
}

/** What `sessions.update` may change. `systemPrompt` and `tools` only before the first message. */
export interface SessionChanges {
	title?: string;
	purpose?: string;
	provider?: string;
	model?: string;
	thinkingLevel?: string;
	systemPrompt?: string;
	tools?: string[];
	/** true closes the session (stopping its work), false reopens it. */
	closed?: boolean;
}

/** Other sessions of this server. Works on any session, not only the one an event or tool call belongs to. */
export interface ExtensionSessions {
	/** Newest use first. `before` (unix ms) pages: only sessions last used before it. Default limit 1000. */
	list(opts?: { closed?: boolean; limit?: number; before?: number }): SessionInfo[];
	get(id: string): SessionInfo | undefined;
	/** The last `count` messages (default 10, at most 200), oldest first. `after` (a seq) returns the ones after it instead. */
	messages(id: string, count?: number, opts?: { after?: number }): SessionMessage[];
	/** Queue a user message in that session. Default mode: `follow_up` while it works, otherwise `prompt`. */
	send(id: string, text: string, mode?: PromptMode): Promise<void>;
	/** A new session. Resolves to it once it exists (it starts idle: `send` gives it work). */
	create(opts?: CreateSessionOptions): Promise<SessionInfo>;
	/** Change a session's settings; resolves to the updated session. */
	update(id: string, changes: SessionChanges): SessionInfo;
	/** Copy a session (up to message `atSeq`, default all) into a new one. */
	fork(id: string, opts?: { atSeq?: number; title?: string }): Promise<SessionInfo>;
	/** Stop its running agent. False when it was idle. */
	abort(id: string): boolean;
	/** Summarize its older messages now (not while it runs). */
	compact(id: string, instructions?: string): Promise<{ tokensBefore: number; tokensAfter: number | null }>;
	/** Questions its agent is waiting on (`ctx.ask`), oldest first. */
	questions(id: string): { toolCallId: string; question: string; options?: string[]; requestedAt: number }[];
	/** Answer one of them, as the user would. False when there is no such question or the answer is not allowed. */
	answer(id: string, toolCallId: string, answer: string | string[]): boolean;
	/** Delete a session. Returns false (and deletes nothing) when it is unknown or busy. */
	delete(id: string): boolean;
}

/** This extension's own small values on sessions (a name, a label, a marker): kept with the session, removed with it, invisible to other extensions. */
export interface ExtensionSessionData {
	/** `undefined` when unset. */
	get(sessionId: string, key: string): unknown;
	/** Any JSON value, at most 4000 characters once serialized; unknown sessions are refused. */
	set(sessionId: string, key: string, value: unknown): void;
	delete(sessionId: string, key: string): void;
	/** The value under `key` for every session that has one: `{ [sessionId]: value }`. */
	list(key: string): Record<string, unknown>;
}

/** A group: a named split-window layout. `sessionIds` are its session panes, `terminalIds` its terminal panes. */
export interface GroupInfo {
	id: string;
	name: string;
	sessionIds: string[];
	terminalIds: string[];
	/** The full layout tree: `{ type: "pane", sessionId }` | `{ type: "split", dir: "row"|"col", ratio, a, b }`. */
	layout: unknown;
	createdAt: number;
	updatedAt: number;
}

export interface ExtensionGroups {
	list(): GroupInfo[];
	get(id: string): GroupInfo | undefined;
	/** A new group with this layout (at least two panes). A session already in another group moves here. */
	create(opts: { name?: string; layout: unknown }): GroupInfo;
	update(id: string, changes: { name?: string; layout?: unknown }): GroupInfo;
	delete(id: string): boolean;
}

/** A shell running on the server (the same terminals clients show as panes). Ids start with `term_`. */
export interface TerminalInfo {
	id: string;
	title: string;
	cwd: string;
	/** Executable path of the shell. */
	shell: string;
	pty: boolean;
	pid: number;
	createdAt: number;
}

export interface ExtensionTerminals {
	/** Oldest first. Empty when terminals are turned off on this server. */
	list(): TerminalInfo[];
	get(id: string): TerminalInfo | undefined;
	/** A new shell. `cwd` is absolute or relative to the default working directory; `shell` one of `GET /terminals/info`. */
	create(opts?: { cwd?: string; shell?: string; title?: string; cols?: number; rows?: number }): TerminalInfo;
	rename(id: string, title: string): TerminalInfo;
	/** Type into it (as if the user did): `"ls\r"` runs `ls`. At most 64 KB per call. */
	write(id: string, data: string): void;
	/** Columns 2-1000, rows 1-500. Clients resize it back to their own size when they show it. */
	resize(id: string, cols: number, rows: number): void;
	/** End the shell for good. False when there is no such terminal. */
	close(id: string): boolean;
}

/** A model the server can use. */
export interface ModelSummary {
	provider: string;
	id: string;
	name: string;
	reasoning: boolean;
	thinkingLevels: string[];
	contextWindow: number;
	maxTokens: number;
	vision: boolean;
	/** A usable credential exists for its provider. */
	configured: boolean;
}

export interface CompleteRequest {
	/** A model role (see `/model-roles`), or the default model when neither this nor `provider`+`model` is given. */
	role?: string;
	provider?: string;
	model?: string;
	system?: string;
	input: string;
	maxTokens?: number;
	signal?: AbortSignal;
}

export interface ExtensionModels {
	list(opts?: { provider?: string }): Promise<ModelSummary[]>;
	/** One-shot completion: no session, no tools, no history. */
	complete(req: CompleteRequest): Promise<{ text: string; provider: string; model: string; usage: { input: number; output: number; totalTokens: number; cost: number } }>;
}

export interface ServerEvent {
	/** Persisted events have a growing id; live-only ones (streaming deltas) have 0. */
	id: number;
	sessionId: string | null;
	type: string;
	ts: number;
	data: unknown;
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
	/** Part of the default tool set of new sessions. Default true. */
	defaultActive?: boolean;
	/** Given to every session, also ones created before the extension was installed. Default false. */
	alwaysActive?: boolean;
	/** The user may switch it off in the settings (for every session). Default false. */
	switchable?: boolean;
	execute(
		toolCallId: string,
		params: any,
		ctx: ExtensionContext,
		signal?: AbortSignal,
		onUpdate?: (partial: ToolResult) => void,
	): Promise<ToolResult> | ToolResult;
}

/** What a command handler returns: nothing (handled), the prompt to send instead, or the prompt plus a note shown with it. */
export type CommandResult = void | string | { prompt: string; note?: MessageNote; title?: string };

export interface ExtensionCommand {
	description?: string;
	/** Argument hint shown in the menu, e.g. `<file>`. */
	args?: string;
	/** Return a string (or `{ prompt }`) to send it to the model as the user's message; return nothing to just handle it. */
	handler(args: string, ctx: ExtensionContext): Promise<CommandResult> | CommandResult;
}

/** One entry of a command family (`pi.registerCommands`), listed for a working directory. */
export interface CommandEntry {
	/** Without the prefix: `review` for `/snip:review`. Letters, digits, `-`, `_`, `.` */
	name: string;
	description?: string;
	args?: string;
}

/**
 * A family of commands that share a prefix and are found at run time, e.g. `/snip:<name>` for every snippet file of a
 * project. `list` is asked for the menu (per working directory); `run` handles `/prefix:name args`.
 */
export interface ExtensionCommandFamily {
	/** Shown as the menu heading and tag, e.g. "Snippets". */
	label?: string;
	list(cwd: string): CommandEntry[] | Promise<CommandEntry[]>;
	run(name: string, args: string, ctx: ExtensionContext): Promise<CommandResult> | CommandResult;
}

/**
 * A note shown with a user message instead of (or above) its text, e.g. "used snippet: review". It is stored with the
 * message for the client only; the model never sees it.
 */
export interface MessageNote {
	/** Short line shown on the message. */
	text: string;
	/** Collapse the message text under the note (for long expanded prompts). */
	collapse?: boolean;
	/** Anything the client extension that renders it needs. */
	data?: unknown;
}

export interface ExtensionFlag {
	description?: string;
	type?: "boolean" | "string";
	default?: boolean | string;
}

// ── events ──────────────────────────────────────────────────────────────────

export interface EventMap {
	/** A user message arrived. Return `{ text }` to rewrite it or `{ handled: true }` to swallow it. */
	input: [
		{ sessionId: string; text: string; mode: PromptMode },
		/**
		 * `title`: what to cut the session title from when this message starts it (default: the text). `parts`: extra text
		 * blocks for the model, stored with the message after `text`; the client hides blocks that start with `<pipaya-`.
		 * `note`: a line shown on the message for the user (never sent to the model).
		 */
		void | { text?: string; handled?: boolean; parts?: { type: "text"; text: string }[]; title?: string; note?: MessageNote },
	];
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
	/** This extension is being unloaded (reload or shutdown). Close timers and files you opened. */
	extension_unload: [{ name: string }, void];
	/** Server finished loading/reloading all extensions. */
	extensions_loaded: [{ names: string[] }, void];
}
export type EventName = keyof EventMap;
export type EventHandler<E extends EventName> = (event: EventMap[E][0], ctx: ExtensionContext) => EventMap[E][1] | Promise<EventMap[E][1]>;

/**
 * What a model runner gets for one reply: the model as the connection describes it, with the connection's address and
 * key already resolved, and the conversation so far. It answers with the reply's text (markdown) and may write files
 * into `cwd` (e.g. a picture, linked from the text).
 */
export interface ModelRunRequest {
	sessionId: string;
	cwd: string;
	model: { provider: string; id: string; name: string; baseUrl: string; headers?: Record<string, string> };
	/** The connection's key, when it has one. */
	apiKey?: string;
	/** The conversation as the model would see it (user and assistant messages, pictures as base64 blocks). */
	messages: AgentMessage[];
	signal?: AbortSignal;
}
export interface ModelRunResult {
	text: string;
	usage?: { input: number; output: number };
}
/** Runs every model of one kind (today: "image", models a connection marks as making pictures). */
export type ModelRunner = (req: ModelRunRequest) => Promise<ModelRunResult>;
export type ModelKind = "image";

export interface ExtensionAPI {
	/** typebox, so tool schemas need no import: `pi.Type.Object({ ... })`. */
	Type: typeof import("typebox").default;
	/** Name of this extension (file or folder name). */
	name: string;
	on<E extends EventName>(event: E, handler: EventHandler<E>): void;
	registerTool(tool: ExtensionTool): void;
	/** A `/name args` message typed by the user. The app's built-in names (`new`, `compact`, …) are refused. */
	registerCommand(name: string, command: ExtensionCommand): void;
	/** A family of `/prefix:name args` commands found at run time (see `ExtensionCommandFamily`). */
	registerCommands(prefix: string, family: ExtensionCommandFamily): void;
	/** Callable by clients: `POST /server-extensions/:extension/methods/:name`. */
	registerMethod(name: string, handler: (params: unknown, ctx: ExtensionContext | null) => unknown | Promise<unknown>): void;
	/** A model provider (custom endpoint, proxy, OAuth login …). Same shape as pi-ai's `Provider`. */
	registerProvider(provider: Provider): void;
	/**
	 * Run the models of a kind the core knows but does not run itself. `"image"`: models marked as making pictures.
	 * Without a runner those models are listed but cannot be used. One runner per kind; removed when the extension unloads.
	 */
	registerModelRunner(kind: ModelKind, run: ModelRunner): void;
	unregisterProvider(id: string): void;
	/** The original built-in tool, e.g. to wrap `bash` from an override of the same name. */
	builtinTool(name: string, cwd: string): import("@earendil-works/pi-agent-core").AgentTool<any> | undefined;
	registerFlag(name: string, flag?: ExtensionFlag): void;
	/** Value of a flag: environment `PIPAYA_FLAG_<NAME>`, otherwise the default. */
	getFlag(name: string): boolean | string | undefined;
	/** Publish a custom event to clients (`extension_event`). `sessionId: null` = global. */
	emit(sessionId: string | null, type: string, data?: unknown, opts?: { ephemeral?: boolean }): void;
	/** In-process event bus shared by all extensions. */
	events: {
		on(channel: string, handler: (data: unknown) => void): () => void;
		emit(channel: string, data?: unknown): void;
	};
	/** Every session of this server: list, read, create, change, message, stop, delete. */
	sessions: ExtensionSessions & { data: ExtensionSessionData };
	/** Session groups (split-window layouts): list, create, change, delete. */
	groups: ExtensionGroups;
	/** The server's terminals: list, open, type into, resize, rename, close. */
	terminals: ExtensionTerminals;
	/** The models the server can use, and one-shot completions on them. */
	models: ExtensionModels;
	/** Every server event (the same stream clients get from `/events`); `types` narrows it. Returns the unsubscribe. */
	subscribe(handler: (event: ServerEvent) => void, opts?: { sessionId?: string; types?: string[] }): () => void;
	/** An OS / push notification to the user's devices (same rules as client extensions: 5 per 10 s). */
	notify(n: { title: string; body?: string; sessionId?: string; key?: string; kind?: "task_completed" | "task_failed" | "user_request" | "info" }): void;
	/** The user's home directory. */
	home: string;
	/** The server's default working directory (where a new session starts). */
	defaultCwd(): string;
	/** Where this extension may keep files (created on first use). */
	dataDir: string;
	/**
	 * Settings shared with clients: the object behind `GET/PUT /extensions/:id/settings` for id `settings.id` (default:
	 * this extension's name). A client extension with the same id and `settingsScope: "server"` edits the same object.
	 * `onChange` fires when anyone saves it.
	 */
	settings: {
		readonly id: string;
		get(): Record<string, unknown>;
		set(value: Record<string, unknown>): Record<string, unknown>;
		onChange(handler: (value: Record<string, unknown>) => void): () => void;
	};
	log(...args: unknown[]): void;
}

export type ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>;
