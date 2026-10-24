import Type, { type TSchema } from "typebox";
import { THINKING_LEVELS } from "./store.ts";

// ── Shared building blocks ──────────────────────────────────────────────────

export const Thinking = Type.Union(THINKING_LEVELS.map((l) => Type.Literal(l)));
export const PromptMode = Type.Union([Type.Literal("prompt"), Type.Literal("steer"), Type.Literal("follow_up")], {
	description: "prompt: start a run (session must be idle). steer: inject into the active run. follow_up: queue for after the active run.",
});

const Nullable = <T extends TSchema>(s: T) => Type.Union([s, Type.Null()]);

export const ErrorBody = Type.Object(
	{ error: Type.Object({ code: Type.String(), message: Type.String() }) },
	{ description: "Error response" },
);

/** Standard error responses for a route. */
export const errors = (...codes: (400 | 401 | 403 | 404 | 409 | 413 | 426 | 429 | 501 | 502)[]) =>
	Object.fromEntries(codes.map((c) => [c, { ...ErrorBody, description: ERROR_DESCRIPTIONS[c] }])) as Record<number, typeof ErrorBody>;
const ERROR_DESCRIPTIONS = {
	400: "Invalid request",
	401: "Missing or invalid token",
	403: "Refused",
	404: "Not found",
	409: "Conflict with current state",
	413: "Payload too large",
	426: "The client is too old for this server; update it",
	429: "Too many requests",
	501: "Not supported by this server",
	502: "The model provider failed",
} as const;

export const IdParams = Type.Object({ id: Type.String() });

// ── Sessions ────────────────────────────────────────────────────────────────

const sessionFields = {
	id: Type.String(),
	title: Type.String(),
	purpose: Type.String({ description: "What this session's agent works on, written by the system model (GET /system-model); empty until then" }),
	cwd: Type.String({ description: "Absolute path of the working directory" }),
	provider: Type.String(),
	model: Type.String(),
	thinkingLevel: Thinking,
	systemPrompt: Type.String(),
	tools: Type.Array(Type.String()),
	parentId: Nullable(Type.String()),
	closed: Type.Boolean({ description: "Closed sessions are hidden from the active list; reopen with PATCH closed=false" }),
	createdAt: Type.Integer({ description: "Unix ms" }),
	updatedAt: Type.Integer({ description: "Unix ms" }),
};
export const Session = Type.Object(sessionFields);

export const Usage = Type.Object({
	input: Type.Number(),
	output: Type.Number(),
	cacheRead: Type.Number(),
	cacheWrite: Type.Number(),
	totalTokens: Type.Number(),
	cost: Type.Number({ description: "USD" }),
	turns: Type.Integer(),
});

export const SessionStatus = Type.Object({
	running: Type.Boolean(),
	pendingToolCalls: Type.Array(Type.String()),
	pendingQuestions: Type.Integer(),
	streamingMessage: Type.Unknown({ description: "Partial assistant message while a run is streaming, else null. Lets late joiners catch up." }),
	queued: Type.Boolean(),
	lastError: Nullable(Type.String()),
	compacting: Type.Boolean({ description: "A manual or automatic compaction is writing its summary" }),
});

export const ContextUsage = Type.Object({ tokens: Nullable(Type.Integer()), contextWindow: Type.Integer() });
export const CompactBody = Type.Optional(Type.Object({ customInstructions: Type.Optional(Type.String({ maxLength: 2000 })) }, { additionalProperties: false }));
export const CompactResult = Type.Object({
	tokensBefore: Type.Integer(),
	context: ContextUsage,
	model: Type.Object({ provider: Type.String(), model: Type.String(), thinkingLevel: Type.Optional(Thinking), custom: Type.Boolean({ description: "false = the session's own model wrote the summary" }) }),
});

export const ActivityInfo = Type.Object({
	sessions: Type.Array(
		Type.Object({
			sessionId: Type.String(),
			running: Type.Boolean(),
			pendingQuestions: Type.Integer({ description: "questions waiting for the user's answer" }),
		}),
		{ description: "Only sessions that are running or waiting on the user" },
	),
});

export const SessionDetail = Type.Object({
	...sessionFields, status: SessionStatus, usage: Usage,
	context: Type.Optional(ContextUsage),
	compaction: Type.Optional(Type.Object({ supported: Type.Boolean(), autoEnabled: Type.Boolean() })),
});

export const SessionContext = Type.Object({
	cwd: Type.String(),
	state: Type.Union([Type.Literal("preview"), Type.Literal("applied")]),
	capturedAt: Nullable(Type.Integer()),
	systemPrompt: Type.String({ description: "Base session prompt" }),
	effectiveSystemPrompt: Type.String({ description: "Base prompt plus ordered AGENTS.md instructions, re-read from disk (edits apply from the next run)" }),
	instructions: Type.Array(Type.Object({
		path: Type.String(),
		scope: Type.Union([Type.Literal("global"), Type.Literal("ancestor"), Type.Literal("cwd")]),
		content: Type.String(),
		bytes: Type.Integer({ minimum: 0 }),
	})),
	warnings: Type.Array(Type.Object({ path: Type.String(), message: Type.String() })),
	tools: Type.Array(Type.String()),
	skills: Type.Array(Type.Object({
		name: Type.String(),
		description: Type.String(),
		path: Type.String(),
		scope: Type.Union([Type.Literal("global"), Type.Literal("project"), Type.Literal("builtin")]),
	}), { description: "Skills advertised to the model in this session's prompt (empty for snapshots that predate skills)" }),
	skillsPrompt: Type.String({ description: "Exact <available_skills> block in the system prompt; empty when no skills are advertised" }),
	readFiles: Type.Array(Type.Object({
		path: Type.String(),
		reads: Type.Integer({ minimum: 1 }),
		lastReadAt: Type.Integer(),
		ranges: Type.Array(Type.Object({ from: Type.Integer({ minimum: 1 }), to: Type.Integer({ minimum: 1 }) })),
	}), { description: "Historical successful persisted read tool results, not a guarantee that these files remain in model context. Bash output is not inspected." }),
});

export const CreateSessionBody = Type.Object({
	title: Type.Optional(Type.String({ maxLength: 200 })),
	cwd: Type.Optional(Type.String({ description: "Absolute path of an existing directory anywhere on the server, or a path relative to the default working directory (created if missing). Omit for the default working directory." })),
	provider: Type.Optional(Type.String()),
	model: Type.Optional(Type.String()),
	thinkingLevel: Type.Optional(Thinking),
	systemPrompt: Type.Optional(Type.String({ maxLength: 100_000 })),
	tools: Type.Optional(Type.Array(Type.String(), { description: "Defaults to all tools. See GET /tools." })),
});

export const PatchSessionBody = Type.Object({
	title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
	purpose: Type.Optional(Type.String({ maxLength: 200, description: "What this session works on; \"\" clears it so the system model writes it again" })),
	provider: Type.Optional(Type.String()),
	model: Type.Optional(Type.String()),
	thinkingLevel: Type.Optional(Thinking),
	systemPrompt: Type.Optional(Type.String({ maxLength: 100_000, description: "Only before the first message (else 409)" })),
	tools: Type.Optional(Type.Array(Type.String(), { description: "Only before the first message (else 409)" })),
	closed: Type.Optional(Type.Boolean({ description: "true closes the session (aborting any run); false resumes it" })),
});

export const ListSessionsQuery = Type.Object({
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 50 })),
	before: Type.Optional(Type.Integer({ minimum: 0, description: "Cursor: the previous page's nextBefore" })),
	closed: Type.Optional(Type.Boolean({ description: "true = only closed sessions, false = only active ones; omit for both" })),
});

export const WorkspaceInfo = Type.Object({
	root: Type.String({ description: "The server's default working directory (see PUT /configuration/workdir)" }),
	home: Type.String({ description: "The server user's home directory, so clients can abbreviate it as ~" }),
	workdirs: Type.Array(
		Type.Object({
			path: Type.String({ description: 'Relative to the default working directory ("." is the directory itself); the absolute path when it lies elsewhere' }),
			cwd: Type.String(),
			active: Type.Integer(),
			closed: Type.Integer(),
			updatedAt: Type.Integer(),
		}),
	),
});

export const DeleteSessionsBody = Type.Object(
	{ ids: Type.Array(Type.String(), { minItems: 1, maxItems: 500, description: "Sessions to delete; ones that are running or waiting for the user are skipped" }) },
	{ additionalProperties: false },
);
export const DeleteSessionsResult = Type.Object({ deleted: Type.Array(Type.String()), skipped: Type.Array(Type.String()) });

export const SessionList = Type.Object({
	sessions: Type.Array(Session),
	nextBefore: Nullable(Type.Integer()),
});

export const ForkBody = Type.Object({
	atSeq: Type.Optional(Type.Integer({ minimum: 0, description: "Copy messages with seq <= atSeq (default: all)" })),
	title: Type.Optional(Type.String({ maxLength: 200 })),
});

// ── Messages ────────────────────────────────────────────────────────────────

export const CancelQueuedBody = Type.Object({
	mode: Type.Union([Type.Literal("steer"), Type.Literal("follow_up")]),
	text: Type.String({ maxLength: 1_000_000 }),
});

export const SendBody = Type.Object({
	text: Type.String({ minLength: 1, maxLength: 1_000_000 }),
	mode: Type.Optional(PromptMode),
	images: Type.Optional(
		Type.Array(
			Type.Object({ type: Type.Literal("image"), data: Type.String({ description: "base64" }), mimeType: Type.String() }),
			{ maxItems: 8 },
		),
	),
	files: Type.Optional(
		Type.Array(
			Type.Object({ name: Type.String({ minLength: 1, maxLength: 255 }), data: Type.String({ description: "base64" }) }),
			{ maxItems: 8, description: "Saved under .pipaya/uploads/ in the session's working directory; the agent is told where" },
		),
	),
});
export const SendResult = Type.Object({ accepted: PromptMode });

export const MessagesQuery = Type.Object({
	after: Type.Optional(Type.Integer({ minimum: -1, description: "Return messages with seq greater than this" })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 5000, default: 1000 })),
});
export const StoredMessage = Type.Object({
	seq: Type.Integer(),
	role: Type.String(),
	createdAt: Type.Integer(),
	message: Type.Unknown({ description: "pi-agent-core AgentMessage (user | assistant | toolResult)" }),
});
export const MessageList = Type.Object({ messages: Type.Array(StoredMessage) });

export const QuestionsQuery = Type.Object({ sessionId: Type.Optional(Type.String()) });
export const DecisionParams = Type.Object({ id: Type.String(), toolCallId: Type.String() });

// ── Questions (ctx.ask) ────────────────────────────────────────────────────

export const QuestionItem = Type.Object({
	question: Type.String(),
	options: Type.Optional(Type.Array(Type.String())),
	recommended: Type.Optional(Type.String({ description: "The option the agent recommends" })),
	allowFreeText: Type.Boolean(),
});
export const QuestionRequest = Type.Object({
	sessionId: Type.String(),
	toolCallId: Type.String(),
	question: Type.String(),
	options: Type.Optional(Type.Array(Type.String())),
	recommended: Type.Optional(Type.String({ description: "The option the agent recommends" })),
	allowFreeText: Type.Boolean(),
	items: Type.Optional(Type.Array(QuestionItem, { description: "Present when several questions were asked at once" })),
	requestedAt: Type.Integer(),
});
export const QuestionList = Type.Object({ questions: Type.Array(QuestionRequest) });
export const QuestionAnswerBody = Type.Object({
	answer: Type.Optional(Type.String({ minLength: 1, maxLength: 10_000, description: "For a single question" })),
	answers: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 10_000 }), { description: "For several questions: one per item, in order" })),
});

// ── Models, providers, tools ────────────────────────────────────────────────

export const ModelInfo = Type.Object({
	provider: Type.String(),
	id: Type.String(),
	name: Type.String(),
	api: Type.String(),
	reasoning: Type.Boolean(),
	thinkingLevels: Type.Array(Thinking, { description: "Reasoning strengths this model accepts, weakest first; empty without reasoning" }),
	contextWindow: Type.Number(),
	maxTokens: Type.Number(),
	vision: Type.Boolean(),
	icon: Type.Optional(Type.String({ description: "Brand mark chosen for this model in its connection settings" })),
	configured: Type.Boolean({ description: "A usable credential exists for this model's provider" }),
	available: Type.Boolean({ description: "false = the connection's own model list no longer contains this model" }),
});
export const ModelsQuery = Type.Object({
	provider: Type.Optional(Type.String()),
	configured: Type.Optional(Type.Boolean({ description: "Only models that are ready to use" })),
});
export const ModelList = Type.Object({ models: Type.Array(ModelInfo) });

export const ProviderInfo = Type.Object({
	id: Type.String(),
	name: Type.String(),
	configured: Type.Boolean(),
	storedCredential: Nullable(Type.String({ description: "Credential type kept in SQLite, if any" })),
	accountEmail: Type.Optional(Type.String({ description: "Email of the signed-in (OAuth) account, when the provider reveals one" })),
	loginMethods: Type.Array(Type.Union([Type.Literal("api_key"), Type.Literal("oauth")]), { description: "How a client can sign in: \"api_key\" = paste a key (PUT credential), \"oauth\" = browser/device login (POST /providers/:id/login)" }),
	oauthLabel: Type.Optional(Type.String({ description: "Label of the OAuth option, e.g. \"Sign in with ChatGPT\"" })),
	builtin: Type.Boolean({ description: "Ships with the SDK (false = user-defined endpoint or extension)" }),
});
export const ProviderList = Type.Object({ providers: Type.Array(ProviderInfo) });
export const LoginStartBody = Type.Object({ type: Type.Union([Type.Literal("api_key"), Type.Literal("oauth")]) }, { additionalProperties: false });
export const LoginAnswerBody = Type.Object({ promptId: Type.Integer(), value: Type.String({ maxLength: 10_000 }) }, { additionalProperties: false });
export const LoginState = Type.Object({
	id: Type.String(),
	providerId: Type.String(),
	type: Type.Union([Type.Literal("api_key"), Type.Literal("oauth")]),
	status: Type.Union([Type.Literal("running"), Type.Literal("done"), Type.Literal("error"), Type.Literal("cancelled")]),
	events: Type.Array(Type.Unknown(), { description: "Announcements so far: {type:\"auth_url\",url} to open, {type:\"device_code\",userCode,verificationUri}, {type:\"info\"|\"progress\",message}" }),
	prompt: Nullable(Type.Unknown({ description: "Open question: {id,type:\"text\"|\"secret\"|\"manual_code\"|\"select\",message,options?}; answer it via POST /logins/:id/answer" })),
	error: Type.Optional(Type.String()),
});
export const CredentialBody = Type.Object({ key: Type.String({ minLength: 1 }) });
export const Ok = Type.Object({ ok: Type.Boolean() });

export const ToolList = Type.Object({
	tools: Type.Array(Type.Object({ name: Type.String(), description: Type.String() })),
	defaults: Type.Array(Type.String()),
});

/** Without the token only `ok` is returned: load figures are nobody's business but the owner's. */
export const Health = Type.Object({
	ok: Type.Boolean(),
	/** App version, wire-protocol version and the oldest client protocol still served (see version.ts). Public: a client must read them before it has a token. */
	version: Type.Optional(Type.String()),
	protocol: Type.Optional(Type.Integer()),
	minClientProtocol: Type.Optional(Type.Integer()),
	uptimeMs: Type.Optional(Type.Integer()),
	runningSessions: Type.Optional(Type.Integer()),
	subscribers: Type.Optional(Type.Integer()),
});

export const UpdateStatus = Type.Object({
	managed: Type.Boolean({ description: "The server can update itself and be restarted by its service manager" }),
	reason: Type.Optional(Type.Union([Type.Literal("disabled"), Type.Literal("unmanaged"), Type.Literal("not_git"), Type.Literal("detached"), Type.Literal("fetch_failed")])),
	ref: Nullable(Type.String()),
	current: Nullable(Type.String()),
	latest: Nullable(Type.String()),
	available: Type.Boolean(),
	checkedAt: Type.Integer(),
});
export const UpdateResult = Type.Object({ ok: Type.Boolean(), from: Type.String(), to: Type.String(), restarting: Type.Boolean() });
export const UpdateBody = Type.Object({ force: Type.Optional(Type.Boolean()) }, { additionalProperties: false });

// ── Events ──────────────────────────────────────────────────────────────────

export const PipayaEventSchema = Type.Object(
	{
		id: Type.Integer({ description: "Global cursor for persisted events; 0 for ephemeral events" }),
		sessionId: Nullable(Type.String()),
		type: Type.String(),
		ts: Type.Integer(),
		data: Type.Unknown({ description: "Shape depends on `type`; see GET /events/types" }),
	},
	{ description: "Event envelope" },
);

export const StreamQuery = Type.Object({
	after: Type.Optional(Type.Integer({ minimum: 0, description: "Replay persisted events with id > after, then go live. Same as the Last-Event-ID header." })),
	types: Type.Optional(Type.String({ description: "Comma-separated event types to receive" })),
	token: Type.Optional(Type.String({ description: "Auth token, for EventSource which cannot set headers" })),
});
export const HistoryQuery = Type.Object({
	sessionId: Type.Optional(Type.String()),
	after: Type.Optional(Type.Integer({ minimum: 0, default: 0 })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000, default: 200 })),
});
export const HistoryResult = Type.Object({ events: Type.Array(PipayaEventSchema), latestId: Type.Integer() });

const Message = Type.Unknown({ description: "pi-agent-core AgentMessage" });
const ToolRef = { toolCallId: Type.String(), toolName: Type.String() };

export interface EventDef {
	type: string;
	/** false = delivered live only (id 0), never replayed. */
	persisted: boolean;
	description: string;
	data: TSchema;
}

/** Machine-readable event payload catalog exposed through /events/types. */
export const EVENTS: EventDef[] = [
	{ type: "device_revoked", persisted: false, description: "A device was removed from the device list; that device should stop reporting to this server", data: Type.Object({ deviceId: Type.String() }) },
	{ type: "notification", persisted: false, description: "Live OS notification addressed to one device; do not replay", data: Type.Object({ deviceId: Type.String(), notification: Type.Object({ id: Type.String(), at: Type.Integer(), source: Type.String(), title: Type.String(), body: Type.Optional(Type.String()), kind: Type.Optional(Type.String()), sessionId: Type.Optional(Type.String()), key: Type.Optional(Type.String()) }) }) },
	{
		type: "configuration_updated", persisted: true,
		description: "Custom provider or default model settings changed (no secrets; refetch GET /configuration)",
		data: Type.Object({ scope: Type.Union([Type.Literal("provider"), Type.Literal("defaults"), Type.Literal("workdir"), Type.Literal("model-roles"), Type.Literal("compaction"), Type.Literal("system-model")]), roles: Type.Optional(Type.Unknown()), id: Type.Optional(Type.String()), action: Type.Optional(Type.String()), defaults: Type.Optional(Type.Unknown()), effectiveDefaults: Type.Optional(Type.Unknown()), saved: Type.Optional(Type.Unknown()), effective: Type.Optional(Type.Unknown()), fallback: Type.Optional(Type.Unknown()) }),
	},
	{
		type: "skills_updated", persisted: true,
		description: "A skill was switched on/off globally, for a project or for one session (event sessionId is null; the payload's sessionId names the session for scope session; refetch GET /skills). Also published (empty name, source \"files\") when files under ~/.agents or a project's .agents/.pi change on disk, e.g. a skill or prompt template was added or edited (refetch GET /skills and GET /server-extensions/commands). Running sessions pick the change up on their next message",
		data: Type.Object({ name: Type.String(), scope: Type.Union([Type.Literal("global"), Type.Literal("project")]), project: Type.String(), source: Type.Optional(Type.Literal("files")) }),
	},
	{
		type: "extension_settings_updated", persisted: true,
		description: "An extension's settings were saved or deleted (sessionId is null; refetch GET /extensions/settings)",
		data: Type.Object({ id: Type.String(), action: Type.Union([Type.Literal("saved"), Type.Literal("deleted")]) }),
	},
	{
		type: "client_settings_updated", persisted: true,
		description: "A server-scoped client setting changed (sessionId is null; refetch GET /client-settings/:key). `origin` is the device that wrote it, so it can skip its own echo",
		data: Type.Object({ key: Type.String(), updatedAt: Type.Integer(), origin: Type.Optional(Type.String()) }),
	},
	{
		type: "locales_updated", persisted: true,
		description: "A UI language pack was saved or deleted (sessionId is null; refetch GET /locales, then GET /locales/:tag for changed packs)",
		data: Type.Object({ tag: Type.String(), action: Type.Union([Type.Literal("saved"), Type.Literal("deleted")]), updatedAt: Type.Integer() }),
	},
	{ type: "group_created", persisted: true, description: "A session group was created (sessionId is null)", data: Type.Object({ id: Type.String(), name: Type.String(), layout: Type.Unknown(), createdAt: Type.Integer(), updatedAt: Type.Integer() }) },
	{ type: "group_updated", persisted: true, description: "A group was renamed, re-laid-out, or lost a session (sessionId is null)", data: Type.Object({ id: Type.String(), name: Type.String(), layout: Type.Unknown(), createdAt: Type.Integer(), updatedAt: Type.Integer() }) },
	{ type: "group_deleted", persisted: true, description: "A group was deleted, or emptied (sessionId is null)", data: Type.Object({ id: Type.String() }) },
	{ type: "terminal_created", persisted: false, description: "A terminal was opened on the server (sessionId is null)", data: Type.Object({ id: Type.String(), title: Type.String(), cwd: Type.String(), shell: Type.String(), pty: Type.Boolean(), pid: Type.Integer(), createdAt: Type.Integer() }) },
	{ type: "terminal_updated", persisted: false, description: "A terminal was renamed (sessionId is null)", data: Type.Object({ id: Type.String(), title: Type.String(), cwd: Type.String(), shell: Type.String(), pty: Type.Boolean(), pid: Type.Integer(), createdAt: Type.Integer() }) },
	{ type: "terminal_closed", persisted: false, description: "A terminal's shell exited or was closed (sessionId is null)", data: Type.Object({ id: Type.String(), exitCode: Type.Union([Type.Integer(), Type.Null()]) }) },
	{ type: "session_created", persisted: true, description: "A session was created", data: Session },
	{ type: "session_updated", persisted: true, description: "Session settings changed", data: Session },
	{ type: "session_deleted", persisted: true, description: "A session was deleted (sessionId is null)", data: Type.Object({ id: Type.String() }) },
	{
		type: "session_forked",
		persisted: true,
		description: "Emitted on the new session after copying history",
		data: Type.Object({ from: Type.String(), atSeq: Nullable(Type.Integer()), messages: Type.Integer() }),
	},
	{ type: "extensions_updated", persisted: false, description: "Server extensions were (re)loaded; refetch GET /server-extensions (sessionId is null)", data: Type.Object({ names: Type.Array(Type.String()) }) },
	{ type: "extension_error", persisted: false, description: "A server extension threw in a hook, command or method (sessionId is null)", data: Type.Object({ extension: Type.String(), where: Type.String(), message: Type.String() }) },
	{ type: "extension_event", persisted: true, description: "A custom event an extension published for clients (`ephemeral` ones are live only)", data: Type.Object({ extension: Type.String(), type: Type.String(), data: Type.Unknown() }) },
	{ type: "extension_entry", persisted: true, description: "An extension stored a custom entry on the session (see GET /sessions/:id/extension-entries)", data: Type.Object({ id: Type.Integer(), extension: Type.String(), type: Type.String(), data: Type.Unknown(), createdAt: Type.Integer() }) },
	{ type: "compaction_started", persisted: true, description: "A compaction began writing its summary", data: Type.Object({ reason: Type.Union([Type.Literal("manual"), Type.Literal("threshold")]) }) },
	{ type: "compaction_finished", persisted: true, description: "The summary is saved; the model now sees it instead of the older messages", data: Type.Object({ tokensBefore: Type.Integer(), context: ContextUsage, usage: Usage }) },
	{ type: "compaction_failed", persisted: true, description: "A compaction failed or was cancelled; the context is unchanged", data: Type.Object({ aborted: Type.Boolean(), errorMessage: Type.Optional(Type.String()) }) },
	{ type: "context_updated", persisted: true, description: "The size of what the model will see changed", data: Type.Object({ context: ContextUsage }) },
	{ type: "run_started", persisted: true, description: "The agent began working", data: Type.Object({ mode: Type.String() }) },
	{
		type: "run_finished",
		persisted: true,
		description: "The run ended. Safe point to treat the session as idle",
		data: Type.Object({
			status: Type.Union([Type.Literal("ok"), Type.Literal("error"), Type.Literal("aborted")]),
			error: Nullable(Type.String()),
			durationMs: Type.Integer(),
			usage: Usage,
		}),
	},
	{ type: "agent_start", persisted: true, description: "pi-agent-core lifecycle", data: Type.Object({}) },
	{ type: "agent_end", persisted: true, description: "pi-agent-core lifecycle", data: Type.Object({ messageCount: Type.Integer() }) },
	{ type: "turn_start", persisted: true, description: "One LLM call plus its tool executions begins", data: Type.Object({}) },
	{
		type: "turn_end",
		persisted: true,
		description: "A turn finished",
		data: Type.Object({ message: Message, toolResults: Type.Array(Type.Unknown()) }),
	},
	{ type: "message_start", persisted: true, description: "A message began (user, assistant or toolResult)", data: Type.Object({ message: Message }) },
	{
		type: "message_update",
		persisted: false,
		description:
			"Streaming delta of the assistant message. `event.type` is one of start, text_start/delta/end, thinking_start/delta/end, toolcall_start/delta/end, done, error. The heavy `partial` snapshot is removed; rebuild by appending deltas.",
		data: Type.Object({
			event: Type.Object({
				type: Type.String(),
				contentIndex: Type.Optional(Type.Integer()),
				delta: Type.Optional(Type.String()),
				content: Type.Optional(Type.String()),
				toolCall: Type.Optional(Type.Unknown()),
				reason: Type.Optional(Type.String()),
			}),
		}),
	},
	{
		type: "message_end",
		persisted: true,
		description: "A message is complete and stored. `seq` matches GET /sessions/:id/messages",
		data: Type.Object({ seq: Type.Integer(), message: Message }),
	},
	{ type: "tool_execution_start", persisted: true, description: "A tool started", data: Type.Object({ ...ToolRef, args: Type.Unknown() }) },
	{
		type: "tool_execution_update",
		persisted: false,
		description: "Partial tool output, e.g. streaming bash output",
		data: Type.Object({ ...ToolRef, partialResult: Type.Unknown() }),
	},
	{
		type: "tool_execution_end",
		persisted: true,
		description: "A tool finished or was blocked",
		data: Type.Object({ ...ToolRef, result: Type.Unknown(), isError: Type.Boolean(), durationMs: Type.Optional(Type.Number()) }),
	},
	{ type: "question_requested", persisted: true, description: "The agent asked the user a question (ctx.ask); answer with POST /sessions/:id/questions/:toolCallId", data: QuestionRequest },
	{
		type: "question_resolved",
		persisted: true,
		description: "A question was answered or its run was aborted",
		data: Type.Object({
			toolCallId: Type.String(),
			answered: Type.Boolean(),
			source: Type.Union([Type.Literal("user"), Type.Literal("abort")]),
		}),
	},
	{
		type: "message_queued",
		persisted: true,
		description: "A steer or follow_up message was accepted during a run",
		data: Type.Object({ mode: Type.String(), text: Type.String() }),
	},
	{
		type: "message_dequeued",
		persisted: true,
		description: "A queued steer or follow_up message was cancelled before it was delivered",
		data: Type.Object({ mode: Type.String(), text: Type.String() }),
	},
	{
		type: "provider_updated",
		persisted: true,
		description: "A provider credential was set or removed (sessionId is null)",
		data: Type.Object({ id: Type.String(), configured: Type.Boolean() }),
	},
];

export const EventTypeList = Type.Object({
	events: Type.Array(
		Type.Object({ type: Type.String(), persisted: Type.Boolean(), description: Type.String(), data: Type.Unknown({ description: "JSON Schema of `data`" }) }),
	),
});

