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
/**
 * What the server stores. auto: run everything. ask: a mutating tool waits for approval only when it reaches outside the
 * session's working directory. readonly: mutating tools are blocked (API / PIPAYA_APPROVAL only; the apps do not offer it).
 */
export type ApprovalPolicy = "auto" | "ask" | "readonly";
/** The two modes the apps offer. */
export type ApprovalMode = "ask" | "auto";
export type SendMode = "prompt" | "steer" | "follow_up";

/** What the server deletes by itself: sessions not used for `days` days (only closed ones when `onlyClosed`). */
export interface RetentionPolicy { enabled: boolean; days: number; onlyClosed: boolean }
/** A model with the reasoning strength to run it at; the two are always chosen together. */
export interface ModelChoice extends ModelSelection {
	thinkingLevel?: ThinkingLevel;
}
/** Tools a helper may be given. write/edit/bash change things and follow the session approval policy. */
export type SubAgentTool = "read" | "grep" | "ls" | "write" | "edit" | "bash";
export interface SubAgentDef {
	/** What the main agent passes as `agent`: lowercase letters, digits and dashes. */
	name: string;
	/** Shown to the main agent so it knows when to pick this helper. */
	description: string;
	enabled: boolean;
	/** The helper's model and strength; null = the model of the conversation that called it. */
	model: ModelChoice | null;
	tools: SubAgentTool[];
	/** Model calls before the helper is stopped. */
	maxTurns: number;
	/** Extra instructions appended to the built-in read-only research prompt. */
	prompt: string;
}
export interface SubAgentSettings {
	/** Master switch for the `delegate` tool */
	enabled: boolean;
	agents: SubAgentDef[];
}
export interface CompactionSettings {
	/** Compact automatically before a prompt when the context is nearly full */
	auto: boolean;
	/** The model (and strength) that writes the summary; null = the session's own model */
	model: ModelChoice | null;
}
export interface CompactionSettingsInfo { settings: CompactionSettings; defaults: CompactionSettings }
export interface SubAgentSettingsInfo { settings: SubAgentSettings; defaults: SubAgentSettings; toolChoices: SubAgentTool[] }

export interface RetentionInfo { policy: RetentionPolicy; lastRun: number | null; lastDeleted: number; due: number }

export interface Session {
	id: string;
	title: string;
	/** Absolute path inside the workspace root */
	cwd: string;
	provider: string;
	model: string;
	thinkingLevel: ThinkingLevel;
	systemPrompt: string;
	tools: string[];
	approval: ApprovalPolicy;
	parentId: string | null;
	/** Closed sessions are hidden from the active list; reopen with PATCH closed=false */
	closed: boolean;
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
	/** Enabled sub-agents advertised to the model. */
	agents: { name: string; description: string }[];
	/** Exact `<available_skills>` block in the system prompt ("" when none). */
	skillsPrompt: string;
	/** Exact `# Sub-agents` block in the system prompt ("" when none). */
	agentsPrompt: string;
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

export interface TemplateInfo {
	name: string;
	description: string;
	/** Absolute path of the template .md file. */
	path: string;
	scope: "global" | "project";
}

export interface TemplateList {
	cwd: string;
	templates: TemplateInfo[];
	warnings: { path: string; message: string }[];
}

export interface CompactionResult {
	tokensBefore: number;
	/** Which model wrote the summary; custom=false means the session's own model */
	model?: { provider: string; model: string; thinkingLevel?: ThinkingLevel; custom: boolean };
	context: ContextUsage;
}

export interface SessionDetail extends Session {
	/** Optional for compatibility with servers predating pi compaction. */
	context?: ContextUsage;
	compaction?: { supported: boolean; autoEnabled: boolean };
	status: {
		running: boolean;
		/** Includes manual and automatic compaction; absent on older servers. */
		compacting?: boolean;
		pendingToolCalls: string[];
		pendingApprovals: number;
		pendingQuestions?: number;
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
	/** Reasoning strengths the model accepts, weakest first. Missing on older servers: then every level is offered. */
	thinkingLevels?: ThinkingLevel[];
	contextWindow: number;
	maxTokens: number;
	vision: boolean;
	/** A usable credential exists for this model's provider */
	configured: boolean;
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
	sessions: { sessionId: string; running: boolean; pendingApprovals: number; pendingQuestions?: number }[];
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
	/** Came from the upstream's model list: the id is fixed */
	fromUpstream?: boolean;
	/** Reasoning strengths the model accepts; absent = the server looks the name up, else minimal..high */
	thinkingLevels?: ThinkingLevel[];
	/** The OpenRouter model this one corresponds to. null = none (manual values); absent = matched by name. */
	catalogId?: string | null;
	/** Response only: where the strengths come from. Absent on older servers. */
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
	/** Tool approval new sessions start with; saved on the server (older servers omit it) */
	approval?: { saved: ApprovalPolicy | null; effective: ApprovalPolicy; fallback: ApprovalPolicy };
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

/** An `ask_user` question the agent is waiting on. */
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

export interface Approval {
	sessionId: string;
	toolCallId: string;
	toolName: string;
	args: unknown;
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

export type ToolState = "pending" | "awaiting_approval" | "running" | "done" | "error" | "denied" | "skipped";

export interface ToolRun {
	state: ToolState;
	/** Streaming output while running, final output once done. */
	output: string;
	details?: Record<string, unknown>;
	durationMs?: number;
	denyReason?: string;
	/** Set while an `ask_user` call waits for the user (state is "awaiting_approval"). */
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
	/** Set when the text is an expanded prompt template: its name and the short call the user typed. */
	template?: { name: string; call: string };
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
