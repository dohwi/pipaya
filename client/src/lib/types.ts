/* ---------- REST API shapes ---------- */

/** A named split-window arrangement of sessions, stored on the server so every client shows the same one. */
export interface Group {
	id: string;
	name: string;
	layout: import("./layout").Layout;
	createdAt: number;
	updatedAt: number;
}

export type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type SendMode = "prompt" | "steer" | "follow_up";

/** A model with the reasoning strength to run it at; the two are always chosen together. */
export interface ModelChoice extends ModelSelection {
	thinkingLevel?: ThinkingLevel;
}
export interface CompactionSettings {
	/** Compact automatically before a prompt when the context is nearly full */
	auto: boolean;
	/** The model (and strength) that writes the summary; null = the session's own model */
	model: ModelChoice | null;
	/** Auto-compaction runs once the context uses at least this percent of the model's window */
	thresholdPercent: number;
}
export interface CompactionSettingsInfo { settings: CompactionSettings; defaults: CompactionSettings }
export interface RetentionSettings {
	/** Delete sessions not used for `days` days */
	enabled: boolean;
	days: number;
	/** Only closed sessions; active ones are kept however old */
	onlyClosed: boolean;
}
export interface RetentionInfo {
	settings: RetentionSettings;
	defaults: RetentionSettings;
	/** When the last clean-up ran (ms); null = never */
	lastRun: number | null;
	lastDeleted: number;
	/** Sessions the policy would delete now */
	due: number;
}
export interface SystemModelSettings {
	/** The light model that writes session titles and roles; null = off */
	model: ModelChoice | null;
}
export interface SystemModelSettingsInfo { settings: SystemModelSettings; defaults: SystemModelSettings }


export interface Session {
	id: string;
	title: string;
	/** What this session's agent works on, written by the system model; "" until then */
	purpose: string;
	/** Absolute path inside the workspace root */
	cwd: string;
	provider: string;
	model: string;
	thinkingLevel: ThinkingLevel;
	systemPrompt: string;
	tools: string[];
	parentId: string | null;
	/** Closed sessions are hidden from the active list; reopen with PATCH closed=false */
	closed: boolean;
	/** Archived sessions stay open but sit in the sidebar's archive; a new message (or PATCH archived=false) brings them back */
	archived: boolean;
	/** Unix ms */
	createdAt: number;
	/** Unix ms */
	updatedAt: number;
}

export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	/** USD */
	cost: number;
	turns: number;
}

/** Server-side model context, not cumulative billing usage. null means it is not yet measurable. */
export interface ContextUsage {
	tokens: number | null;
	contextWindow: number;
}

/** Exact server-side instruction snapshot plus an auditable, historical file-read trace. */
export interface SessionContext {
	cwd: string;
	state: "preview" | "applied";
	capturedAt: number | null;
	systemPrompt: string;
	effectiveSystemPrompt: string;
	instructions: {
		path: string;
		scope: "global" | "ancestor" | "cwd";
		content: string;
		bytes: number;
	}[];
	warnings: { path: string; message: string }[];
	tools: string[];
	/** Skills advertised to the model in this session (frozen once applied). */
	skills: { name: string; description: string; path: string; scope: SkillScope }[];
	/** Exact `<available_skills>` block in the system prompt ("" when none). */
	skillsPrompt: string;
	readFiles: {
		path: string;
		reads: number;
		lastReadAt: number;
		ranges: { from: number; to: number }[];
	}[];
}

export type SkillScope = "global" | "project" | "builtin";

export interface SkillInfo {
	name: string;
	description: string;
	/** Absolute SKILL.md path. */
	path: string;
	scope: SkillScope;
	/** false = disable-model-invocation: never offered to the model, so on/off has no effect. */
	modelInvocable: boolean;
	/** Effective state in this project. */
	enabled: boolean;
	globalEnabled: boolean;
	/** Project override; null = follows the global default. */
	override: boolean | null;
	/** Override for the requested session only; null = none. */
	sessionOverride: boolean | null;
}

export interface SkillList {
	cwd: string;
	project: string;
	skills: SkillInfo[];
	warnings: { path: string; message: string }[];
}

/** Commands a server extension finds at run time (`pi.registerCommands`), e.g. `/snip:<name>`, for one folder. */
export interface CommandFamily {
	prefix: string;
	label?: string;
	extension: string;
	entries: { name: string; description?: string; args?: string }[];
}

export interface CompactionResult {
	tokensBefore: number;
	/** Which model wrote the summary; custom=false means the session's own model */
	model?: { provider: string; model: string; thinkingLevel?: ThinkingLevel; custom: boolean };
	context: ContextUsage;
}

export interface SessionDetail extends Session {
	/** Absent when the session's model is no longer registered. */
	context?: ContextUsage;
	compaction?: { supported: boolean; autoEnabled: boolean };
	status: {
		running: boolean;
		/** Includes manual and automatic compaction. */
		compacting: boolean;
		pendingToolCalls: string[];
		pendingQuestions: number;
		/** Partial assistant message while a run is streaming, else null. Lets late joiners catch up. */
		streamingMessage: unknown;
		queued: boolean;
		lastError: string | null;
	};
	usage: Usage;
}

export interface WorkspaceInfo {
	/** The server's default working directory */
	root: string;
	/** The server user's home directory, for showing paths as ~/… */
	home?: string;
	workdirs: {
		/** Relative to the root ("." is the root itself) */
		path: string;
		cwd: string;
		active: number;
		closed: number;
		updatedAt: number;
	}[];
}

export interface ModelInfo {
	provider: string;
	id: string;
	name: string;
	api: string;
	reasoning: boolean;
	/** Reasoning strengths the model accepts, weakest first; empty without reasoning. */
	thinkingLevels: ThinkingLevel[];
	contextWindow: number;
	maxTokens: number;
	vision: boolean;
	/** Makes pictures instead of text */
	imageGeneration: boolean;
	/** The server can run it now. false: an image model with no server extension that runs image models (older servers leave it out) */
	runnable?: boolean;
	/** Brand mark chosen in the connection settings; absent = picked from the id */
	icon?: string;
	/** A usable credential exists for this model's provider */
	configured: boolean;
	/** false = the connection's own model list no longer has it. */
	available: boolean;
}

export interface ProviderInfo {
	id: string;
	name: string;
	configured: boolean;
	storedCredential: string | null;
	/** Email of the signed-in (OAuth) account, when the provider reveals one */
	accountEmail?: string;
	/** "api_key": interactive key setup, "oauth": browser/device sign-in */
	loginMethods?: ("api_key" | "oauth")[];
	oauthLabel?: string;
	/** Ships with the SDK (false = user-defined endpoint or extension) */
	builtin?: boolean;
}

export type LoginEvent =
	| { type: "info"; message: string; links?: { url: string; label?: string }[] }
	| { type: "auth_url"; url: string; instructions?: string }
	| { type: "device_code"; userCode: string; verificationUri: string }
	| { type: "progress"; message: string };
export type LoginPrompt = { id: number; message: string; placeholder?: string } & (
	| { type: "text" | "secret" | "manual_code" }
	| { type: "select"; options: { id: string; label: string; description?: string }[] }
);
export interface LoginState {
	id: string;
	providerId: string;
	type: "api_key" | "oauth";
	status: "running" | "done" | "error" | "cancelled";
	events: LoginEvent[];
	prompt: LoginPrompt | null;
	error?: string;
}

export interface ActivityInfo {
	sessions: { sessionId: string; running: boolean; pendingQuestions: number }[];
	/** Finished or failed while no device was looking; the server clears it when any device reads the session */
	unread: { sessionId: string; kind: "done" | "failed" }[];
}

/* ---------- model connection settings (GET /configuration) ---------- */

export type ApiFormat = "openai-completions" | "openai-responses" | "anthropic-messages";

export interface CustomModel {
	id: string;
	name?: string;
	contextWindow: number;
	maxTokens: number;
	reasoning: boolean;
	vision: boolean;
	/** Makes pictures instead of text */
	imageGeneration?: boolean;
	/** Brand mark chosen for this model; absent = picked from the id */
	icon?: string;
	/** Came from the upstream's model list: the id is fixed */
	fromUpstream?: boolean;
	/** Reasoning strengths the model accepts; absent = the server looks the name up, else minimal..high */
	thinkingLevels?: ThinkingLevel[];
	/** The OpenRouter model this one corresponds to. null = none (manual values); absent = matched by name. */
	catalogId?: string | null;
	/** Response only: the upstream's model list no longer contains this model */
	unavailable?: boolean;
	/** Response only: where the strengths come from. */
	thinkingSource?: { kind: "custom" | "catalog" | "default"; catalogId?: string; levels: ThinkingLevel[] };
}

/** One entry of the server's bundled OpenRouter catalog (GET /configuration/catalog) */
export interface CatalogModel {
	id: string;
	name: string;
	contextWindow: number;
	maxTokens: number;
	reasoning: boolean;
	vision: boolean;
	/** An image-generation model */
	image: boolean;
	levels: string[];
}

/** Body of PUT /configuration/providers/:id */
export interface CustomProviderInput {
	name: string;
	baseUrl: string;
	api: ApiFormat;
	authRequired: boolean;
	models: CustomModel[];
}

export interface CustomProvider extends CustomProviderInput {
	id: string;
	/** A usable credential exists (or none is required) */
	configured: boolean;
	hasStoredKey: boolean;
}

export interface ModelSelection {
	provider: string;
	model: string;
}

/** The server's default for new chats: a model and, optionally, the reasoning strength to start it at. */
export interface DefaultModelSelection extends ModelSelection {
	thinkingLevel?: ThinkingLevel;
}

export interface WorkdirInfo {
	/** Saved on the server; null = the startup default is in use */
	saved: string | null;
	/** Where a new session starts, and what relative paths resolve against */
	effective: string;
	/** The server's startup default (PIPAYA_WORKSPACE) */
	fallback: string;
}

export interface DirListing {
	path: string;
	parent: string | null;
	home: string;
	entries: { name: string; path: string }[];
	truncated: boolean;
}

export interface ConfigurationInfo {
	providers: CustomProvider[];
	workdir?: WorkdirInfo;
	/** Saved on the server; null = none */
	defaults: DefaultModelSelection | null;
	/** What new sessions really use (saved default, else the server's startup default) */
	effectiveDefaults: DefaultModelSelection | null;
	/** Which agent tools can be switched off and which are locked on */
	tools: ToolsInfo;
}

export interface ToolsInfo {
	toggleable: string[];
	locked: string[];
	disabled: string[];
}

export interface ConnectionResult {
	ok: boolean;
	durationMs: number;
	text?: string;
	error?: string;
}

export interface ToolInfo {
	name: string;
	description: string;
	mutating: boolean;
}

/** A question to the user (ctx.ask) the agent is waiting on. */
export interface Question {
	sessionId: string;
	toolCallId: string;
	question: string;
	options?: string[];
	/** The option the agent recommends. */
	recommended?: string;
	allowFreeText: boolean;
	/** Several questions asked at once: shown as tabs. */
	items?: { question: string; options?: string[]; recommended?: string; allowFreeText: boolean }[];
	requestedAt: number;
}

/* ---------- pi-ai message shapes (the API types them as `unknown`) ---------- */

export interface TextBlock {
	type: "text";
	text: string;
}
export interface ThinkingBlock {
	type: "thinking";
	thinking: string;
	redacted?: boolean;
}
export interface ImageBlock {
	type: "image";
	data: string;
	mimeType: string;
}
export interface ToolCallBlock {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

export interface UserMessage {
	role: "user";
	content: string | (TextBlock | ImageBlock)[];
	timestamp: number;
}

export type StopReason = "pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred";

export interface AssistantMessage {
	role: "assistant";
	content: (TextBlock | ThinkingBlock | ToolCallBlock)[];
	provider?: string;
	model?: string;
	/** Reasoning strength the reply was written with; absent for models without reasoning and for older replies. */
	thinkingLevel?: ThinkingLevel;
	stopReason: StopReason;
	errorMessage?: string;
	durationMs?: number;
	timestamp: number;
	usage?: {
		input: number;
		output: number;
		totalTokens: number;
		cacheRead?: number;
		cacheWrite?: number;
		cost?: { total: number };
	};
}

export interface ToolResultMessage {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: (TextBlock | ImageBlock)[];
	details?: Record<string, unknown>;
	isError: boolean;
	durationMs?: number;
	timestamp: number;
}

export type AgentMessage = UserMessage | AssistantMessage | ToolResultMessage;

/* ---------- event envelope ---------- */

export interface PipayaEvent<T = any> {
	id: number;
	sessionId: string | null;
	type: string;
	ts: number;
	data: T;
}

export interface StreamDelta {
	type: string;
	contentIndex?: number;
	delta?: string;
	content?: string;
	toolCall?: ToolCallBlock;
	reason?: string;
}

/* ---------- UI model ---------- */

/** `call`: what the user typed (e.g. `/snip:review x`); `collapse`: the text is long and starts folded. */
export interface MessageNote { text: string; call: string; collapse?: boolean; data?: unknown }

export type ToolState = "pending" | "awaiting_input" | "running" | "done" | "error" | "skipped";

export interface ToolRun {
	state: ToolState;
	/** Streaming output while running, final output once done. */
	output: string;
	/** Pictures the tool returned (the `read` tool on an image file). */
	images?: ImageBlock[];
	details?: Record<string, unknown>;
	durationMs?: number;
	/** Set while a call using ctx.ask waits for the user (state is "awaiting_input"). */
	question?: Pick<Question, "question" | "options" | "recommended" | "allowFreeText" | "items">;
}

export interface UserItem {
	kind: "user";
	key: string;
	seq: number | null;
	text: string;
	images: ImageBlock[];
	/** Files attached to this message, saved in the session's working directory */
	files?: FileRef[];
	/** A note a server extension stored with the message (`pipaya-note`): shown on it, never sent to the model. */
	note?: MessageNote;
	ts: number;
	fresh?: boolean;
}

/** A file being sent: base64 bytes, saved by the server in the session's working directory. */
export interface UploadFile {
	name: string;
	data: string;
	size: number;
	mimeType: string;
}

/** A file in a session's working directory (`path` is relative to it). */
export interface FileRef {
	path: string;
	name: string;
	size?: number;
	mimeType?: string;
}

export interface AssistantItem {
	kind: "assistant";
	key: string;
	seq: number | null;
	blocks: AssistantBlock[];
	streaming: boolean;
	stopReason: StopReason;
	error?: string;
	/** The provider/model that wrote this reply, kept so the logo above it stays the one used at the time. */
	provider?: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	durationMs?: number;
	tokens?: number;
	usage?: AssistantMessage["usage"];
	ts: number;
	fresh?: boolean;
}

export interface NoticeItem {
	kind: "notice";
	key: string;
	text: string;
	ts: number;
	/** Absent = an error. */
	tone?: "ok" | "error";
}

/** A record a server extension stored on the conversation (`ctx.appendEntry`), drawn by a client extension's renderer. */
export interface EntryItem {
	kind: "entry";
	key: string;
	id: number;
	extension: string;
	entryType: string;
	data: unknown;
	ts: number;
}

/** One step of agent work: a thought or a tool call. Back-to-back steps share one work box. */
export type Step = { kind: "think"; text: string; done: boolean } | { kind: "tool"; id: string; name: string; args: Record<string, unknown> };

/** One entry in the rendered transcript. */
export type ChatItem = UserItem | AssistantItem | NoticeItem | EntryItem;

export type AssistantBlock =
	| { type: "text"; text: string }
	| { type: "thinking"; text: string; done: boolean }
	| { type: "tool"; id: string; name: string; args: Record<string, unknown> };
