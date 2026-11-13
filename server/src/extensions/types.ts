import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Provider } from "@earendil-works/pi-ai";
import type { TSchema } from "typebox";
import type { NotificationKind } from "../notifications.ts";

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

/** HTTP methods an extension route can answer (`"*"` = every one of them). */
export type RouteMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * An HTTP endpoint the extension serves from the pipaya server itself, at `/x/<extension>/<path>`: a webhook, a small
 * dashboard, a REST API for another program. The handler is a web-standard `fetch` handler (the same shape `Bun.serve`
 * takes), so it can stream, set headers and return any content type.
 */
export interface ExtensionRoute {
	/** One method, a list, or `"*"` for all (default `"GET"`). */
	method?: RouteMethod | RouteMethod[] | "*";
	/**
	 * Path under `/x/<extension>`, starting with `/`. Segments may be `:name` parameters and the last may be `*`
	 * (the rest of the path, in `params["*"]`). `/` is the extension's root.
	 */
	path: string;
	/**
	 * Without a token. Default `false`: the caller needs the server's token (admin or a paired device), like any other
	 * API. A public route is reachable by anyone who can reach the server: check a secret of your own (e.g. a webhook
	 * signature) before acting.
	 */
	public?: boolean;
	handler(req: Request, ctx: RouteContext): Response | Promise<Response> | unknown | Promise<unknown>;
}

export interface RouteContext {
	/** `:name` segments (and `*`) of the matched path. */
	params: Record<string, string>;
	/** The parsed query string. */
	query: URLSearchParams;
	/** `null` for the admin token or a public route without one, otherwise the paired device's id. */
	device: string | null;
	/** Whether a valid token came with the request (always true for a non-public route). */
	authenticated: boolean;
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
	/**
	 * An HTTP endpoint at `/x/<extension>/<path>` on the pipaya server (see `ExtensionRoute`). Return a `Response`, or
	 * any other value to send it as JSON. Removed on reload.
	 */
	registerRoute(route: ExtensionRoute): void;
	/** A model provider (custom endpoint, proxy, OAuth login …). Same shape as pi-ai's `Provider`. */
	registerProvider(provider: Provider): void;
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
	notify(n: { title: string; body?: string; sessionId?: string; key?: string; kind?: NotificationKind }): void;
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
	/**
	 * The page of this extension in Settings → Extensions, above its settings form: live state and actions that do not
	 * belong in the settings object. Absent on a server older than the feature: test `typeof pi.ui?.setPanel === "function"`.
	 */
	ui?: ExtensionUi;
	/**
	 * The server's own REST API, called in-process with the admin's rights: the same routes, validation, events and side
	 * effects as a client's request, without a network hop or a token. Prefer it over touching the database or the data
	 * folder directly.
	 */
	api: ExtensionServerApi;
	/** Where this server listens and how other devices may reach it. */
	server: { info(): ExtensionServerInfo };
	log(...args: unknown[]): void;
}

export type ApiMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface ExtensionServerApi {
	/**
	 * `method path` against this server, e.g. `request("GET", "/sessions")` or `request("PUT", "/mcp", body)`. `path` is a
	 * server route starting with `/` (an absolute URL is refused); `body` is sent as JSON; `query` is appended to the path.
	 * Resolves with the status and the body (parsed when it is JSON, `null` when empty, text otherwise) for every status,
	 * errors included; rejects only when the request cannot be made (a bad path, a stream route, the extension unloaded).
	 */
	request<T = unknown>(method: ApiMethod, path: string, body?: unknown, opts?: { query?: Record<string, string | number | boolean | null | undefined>; signal?: AbortSignal }): Promise<{ status: number; body: T }>;
}

export interface ExtensionServerInfo {
	/** The port the server is bound to. */
	port: number;
	/** The address it is bound to (`0.0.0.0` = every interface). */
	host: string;
	/** `http://<ip>:<port>` for each of this machine's IPv4 addresses another device could use (LAN, VPN); empty when bound to loopback only. */
	urls: string[];
}

/**
 * A declarative node of the page (same data the client's extension UI renders): `{ type, id, ...fields, children? }` with
 * the types `stack grid card tabs form text badge divider code alert progress stat table list button input textarea select
 * checkbox` (see pipaya-client-extensions, ui.md). Every text field may be a string, or `{ "ko": "...", "en": "..." }`
 * for the language in use; a plain string is also looked up in `pipaya.translations`. At most 200 nodes, 8 levels, 60 KB
 * of JSON, ids `[a-z][a-z0-9-]{0,39}` unique in the tree. The client validates it again and shows nothing when it is refused.
 */
export type ExtensionPanelNode = { type: string; id: string; [field: string]: unknown };

/** What the user did on the page: a button (`action`), a field (`change`) or a form (`submit`, with every field's value). */
export type ExtensionPanelEvent =
	| { type: "action"; id: string }
	| { type: "change"; id: string; value: string | boolean }
	| { type: "submit"; id: string; values: Record<string, string | boolean> };

export interface ExtensionUi {
	/** Show this tree on the extension's page, or `null` to remove it. Replaces the previous one and is pushed to open clients at once; an identical tree is not pushed again. Throws on a tree over the limits. */
	setPanel(node: ExtensionPanelNode | null): void;
	/** The handler for what the user does on the page (a button, a form). One handler; a later call replaces it. A throwing handler is reported to the user as an error on the page. */
	onEvent(handler: (event: ExtensionPanelEvent) => void | Promise<void>): void;
}

export type ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>;
