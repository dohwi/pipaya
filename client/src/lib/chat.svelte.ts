import { errorText, ApiError, type Api } from "./api";
import { uid } from "./format";
import { LocalizedError, t } from "./i18n";
import type {
	AgentMessage,
	AssistantBlock,
	AssistantItem,
	AssistantMessage,
	ChatItem,
	CompactionResult,
	ContextUsage,
	PipayaEvent,
	FileRef,
	ImageBlock,
	StreamDelta,
	ToolRun,
	Usage,
	UserItem,
} from "./types";

/** Concatenate the text parts of a content array (or pass a string through). */
export function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((c) => (c && c.type === "text" ? String(c.text ?? "") : "")).join("");
}

function blocksOf(m: AssistantMessage): AssistantBlock[] {
	const out: AssistantBlock[] = [];
	for (const c of m.content ?? []) {
		if (c.type === "text") {
			if (c.text) out.push({ type: "text", text: c.text });
		} else if (c.type === "thinking") {
			out.push({ type: "thinking", text: c.redacted ? "(redacted)" : c.thinking, done: true });
		} else if (c.type === "toolCall") {
			out.push({ type: "tool", id: c.id, name: c.name, args: c.arguments ?? {} });
		}
	}
	return out;
}

function assistantFields(m: AssistantMessage) {
	return {
		blocks: blocksOf(m),
		stopReason: m.stopReason,
		error: m.stopReason === "error" || m.stopReason === "aborted" ? m.errorMessage : undefined,
		provider: m.provider,
		model: m.model,
		thinkingLevel: m.thinkingLevel,
		durationMs: m.durationMs,
		tokens: m.usage?.totalTokens,
		usage: m.usage,
		ts: m.timestamp,
	};
}

function userFields(m: Extract<AgentMessage, { role: "user" }>): { text: string; images: ImageBlock[]; files: FileRef[]; template?: { name: string; call: string } } {
	const images = Array.isArray(m.content) ? (m.content.filter((c) => c.type === "image") as ImageBlock[]) : [];
	const files: FileRef[] = [];
	let template: { name: string; call: string } | undefined;
	// The server appends a note when the user wrote /subagent:name or attached files; it is for the model, not for the transcript.
	const shown = Array.isArray(m.content)
		? m.content.filter((c) => {
				if (c?.type !== "text") return true;
				const s = String(c.text ?? "");
				if (s.startsWith("<pipaya-files>")) {
					try {
						const json = s.slice("<pipaya-files>".length, s.indexOf("</pipaya-files>"));
						for (const f of JSON.parse(json) as FileRef[]) if (f && typeof f.path === "string") files.push({ path: f.path, name: String(f.name ?? f.path), size: f.size, mimeType: f.mimeType });
					} catch { /* a note we cannot read is simply not shown */ }
					return false;
				}
				if (s.startsWith("<pipaya-template>")) {
					try {
						const j = JSON.parse(s.slice("<pipaya-template>".length, s.indexOf("</pipaya-template>")));
						if (j && typeof j.name === "string") template = { name: j.name, call: String(j.call ?? "") };
					} catch { /* an unreadable marker just means no note */ }
					return false;
				}
				return !s.startsWith("<pipaya-hint>");
			})
		: m.content;
	return { text: textOf(shown), images, files, ...(template ? { template } : {}) };
}

// The server stores a denied/blocked call as an ordinary error result with these messages
// (see server/src/sessions.ts), so recognise them to show "denied" after a reload too.
const DENIED = /^(The user denied "|"[^"]+" is disabled: this session is read-only|Run aborted|Approval timed out)/;

function toolRunFrom(m: Extract<AgentMessage, { role: "toolResult" }>): ToolRun {
	const output = textOf(m.content);
	const denied = m.isError && !m.details?.exitCode && DENIED.test(output.trim());
	return {
		state: denied ? "denied" : m.isError ? "error" : "done",
		output: denied ? "" : output,
		denyReason: denied ? output.trim() : undefined,
		details: m.details,
		durationMs: m.durationMs,
	};
}

/**
 * Transcript + live state for one session. Persisted messages come from REST; SSE events keep it current.
 * Events that arrive while a (re)load is in flight are buffered and replayed afterwards; `seq` de-duplicates.
 */
export class ChatState {
	items = $state<ChatItem[]>([]);
	tools = $state<Record<string, ToolRun>>({});
	queued = $state<{ mode: "steer" | "follow_up"; text: string }[]>([]);
	running = $state(false);
	/** Bumped when the user sends something (prompt / steer / queue): the list jumps to the bottom, even if it was scrolled up. */
	bottomRequest = $state(0);
	requestBottom(): void {
		this.bottomRequest++;
	}
	/** True once the first load finished. */
	ready = $state(false);
	loadError = $state("");
	/** The session no longer exists on the server. */
	notFound = $state(false);
	usage = $state<Usage | null>(null);
	context = $state<ContextUsage | undefined>(undefined);
	compaction = $state<{ supported: boolean; autoEnabled: boolean } | null>(null);
	compactionError = $state("");
	private serverCompacting = $state(false);
	private compactRequest = $state(false);
	private contextRevision = 0;
	private contextRefreshToken = 0;

	get compacting(): boolean {
		return this.serverCompacting || this.compactRequest;
	}

	/** Key of the "/compact" bubble while a compaction is in progress; the result lands in the transcript under it. */
	compactKey = $state<string | null>(null);

	/** Never send /compact as a user prompt: the server must rebuild and persist model context. */
	async compact(customInstructions?: string): Promise<CompactionResult> {
		if (this.running || this.compacting) throw new LocalizedError(t("진행 중인 작업이 끝난 뒤 압축하세요"));
		this.compactRequest = true;
		this.compactionError = "";
		const revision = ++this.contextRevision;
		try {
			const result = await this.api.compactSession(this.id, customInstructions);
			if (revision === this.contextRevision) {
				this.contextRevision++;
				this.context = result.context;
			}
			return result;
		} catch (e) {
			this.compactionError = e instanceof ApiError && (e.status === 404 || e.status === 501)
				? t("이 서버는 컨텍스트 압축을 지원하지 않습니다. BE 연동이 필요합니다")
				: errorText(e);
			throw new Error(this.compactionError);
		} finally {
			this.compactRequest = false;
			// A lost HTTP response may still have committed server-side. Reconcile without retrying it.
			void this.refreshContext();
		}
	}

	async refreshContext(): Promise<void> {
		const refreshToken = ++this.contextRefreshToken;
		const revision = this.contextRevision;
		try {
			const detail = await this.api.getSession(this.id);
			if (revision !== this.contextRevision || refreshToken !== this.contextRefreshToken) return;
			this.context = detail.context;
			this.compaction = detail.compaction ?? null;
			this.serverCompacting = detail.status.compacting ?? false;
		} catch {
			/* Reconnect/load will reconcile; never retry a potentially committed compaction. */
		}
	}

	private lastSeq = -1;
	private syncing = false;
	private buffer: PipayaEvent[] = [];
	private token = 0;

	constructor(
		readonly id: string,
		private api: Api,
	) {}

	get streaming(): boolean {
		const last = this.items[this.items.length - 1];
		return !!last && last.kind === "assistant" && last.streaming;
	}

	get lastAssistant(): AssistantItem | null {
		for (let i = this.items.length - 1; i >= 0; i--) {
			const it = this.items[i]!;
			if (it.kind === "assistant") return it;
		}
		return null;
	}

	async load(): Promise<void> {
		const token = ++this.token;
		this.syncing = true;
		this.buffer = [];
		this.loadError = "";
		this.notFound = false;
		try {
			const [msgs, detail, approvals, questions, entries] = await Promise.all([
				this.api.messages(this.id),
				this.api.getSession(this.id),
				this.api.approvals(),
				this.api.questions(),
				Promise.resolve().then(() => this.api.serverExtensionEntries(this.id)).catch(() => []), // a server without extensions has none
			]);
			if (token !== this.token) return;

			const items: ChatItem[] = [];
			const tools: Record<string, ToolRun> = {};
			for (const { seq, message, createdAt } of msgs) this.ingest(items, tools, seq, message, createdAt);

			const st = detail.status;
			for (const id of st.pendingToolCalls) tools[id] ??= { state: "running", output: "" };
			for (const a of approvals) {
				if (a.sessionId === this.id) tools[a.toolCallId] = { state: "awaiting_approval", output: "" };
			}
			for (const q of questions) {
				if (q.sessionId === this.id) tools[q.toolCallId] = { state: "awaiting_approval", output: "", question: q };
			}
			// Extension records sit among the messages by the time they were made (they are not messages themselves).
			for (const en of entries) this.insertEntry(items, en);
			const partial = st.streamingMessage as AssistantMessage | null;
			if (st.running && partial && partial.role === "assistant") {
				items.push({ kind: "assistant", key: `s${uid()}`, seq: null, streaming: true, ...assistantFields(partial) });
			}

			this.items = items;
			this.tools = tools;
			this.lastSeq = msgs.length ? msgs[msgs.length - 1]!.seq : -1;
			this.running = st.running;
			this.usage = detail.usage;
			this.context = detail.context;
			this.compaction = detail.compaction ?? null;
			this.serverCompacting = st.compacting ?? false;
			this.contextRevision++;
			this.queued = [];
			this.ready = true;
		} catch (e) {
			if (token !== this.token) return;
			this.notFound = e instanceof ApiError && e.status === 404;
			this.loadError = errorText(e) || t("불러오지 못했습니다");
		} finally {
			if (token === this.token) {
				this.syncing = false;
				for (const e of this.buffer.splice(0)) this.reduce(e);
			}
		}
	}

	apply(e: PipayaEvent): void {
		if (this.syncing) this.buffer.push(e);
		else this.reduce(e);
	}

	addOptimisticUser(text: string, images: ImageBlock[], files: FileRef[] = []): void {
		this.items.push({ kind: "user", key: `u${uid()}`, seq: null, text, images, files, ts: Date.now(), fresh: true });
	}

	dropOptimisticUser(): void {
		const i = this.items.findIndex((x) => x.kind === "user" && x.seq === null);
		if (i >= 0) this.items.splice(i, 1);
	}

	private ingest(items: ChatItem[], tools: Record<string, ToolRun>, seq: number, m: AgentMessage, ts: number) {
		if (m.role === "user") {
			items.push({ kind: "user", key: `m${seq}`, seq, ts: m.timestamp ?? ts, ...userFields(m) });
		} else if (m.role === "assistant") {
			items.push({ kind: "assistant", key: `m${seq}`, seq, streaming: false, ...assistantFields(m) });
		} else if (m.role === "toolResult") {
			tools[m.toolCallId] = toolRunFrom(m);
		}
	}

	private insertEntry(items: ChatItem[], en: { id: number; extension: string; type: string; data: unknown; createdAt: number }) {
		if (items.some((x) => x.kind === "entry" && x.id === en.id)) return;
		const item: ChatItem = { kind: "entry", key: `e${en.id}`, id: en.id, extension: en.extension, entryType: en.type, data: en.data, ts: en.createdAt };
		let at = items.length;
		while (at > 0 && items[at - 1]!.ts > en.createdAt && items[at - 1]!.kind !== "entry") at--;
		items.splice(at, 0, item);
	}

	/** A record a server extension just stored on this conversation. */
	addEntry(en: { id: number; extension: string; type: string; data: unknown; createdAt?: number }): void {
		this.insertEntry(this.items, { ...en, createdAt: en.createdAt ?? Date.now() });
	}

	private streamItem(): AssistantItem | null {
		const last = this.items[this.items.length - 1];
		return last && last.kind === "assistant" && last.streaming ? last : null;
	}

	private ensureStream(): AssistantItem {
		let item = this.streamItem();
		if (!item) {
			this.items.push({
				kind: "assistant",
				key: `s${uid()}`,
				seq: null,
				blocks: [],
				streaming: true,
				stopReason: "pending",
				ts: Date.now(),
				fresh: true,
			});
			item = this.streamItem()!;
		}
		return item;
	}

	private applyDelta(item: AssistantItem, ev: StreamDelta) {
		const i = ev.contentIndex ?? item.blocks.length;
		const cur = item.blocks[i];
		switch (ev.type) {
			case "text_start":
				item.blocks[i] = { type: "text", text: "" };
				break;
			case "text_delta":
				if (cur?.type === "text") cur.text += ev.delta ?? "";
				else item.blocks[i] = { type: "text", text: ev.delta ?? "" };
				break;
			case "text_end":
				if (cur?.type === "text") cur.text = ev.content ?? cur.text;
				break;
			case "thinking_start":
				item.blocks[i] = { type: "thinking", text: "", done: false };
				break;
			case "thinking_delta":
				if (cur?.type === "thinking") cur.text += ev.delta ?? "";
				else item.blocks[i] = { type: "thinking", text: ev.delta ?? "", done: false };
				break;
			case "thinking_end":
				if (cur?.type === "thinking") {
					cur.text = ev.content ?? cur.text;
					cur.done = true;
				}
				break;
			case "toolcall_start":
				item.blocks[i] = { type: "tool", id: "", name: "", args: {} };
				break;
			case "toolcall_end":
				if (ev.toolCall) {
					item.blocks[i] = { type: "tool", id: ev.toolCall.id, name: ev.toolCall.name, args: ev.toolCall.arguments ?? {} };
				}
				break;
		}
	}

	private reduce(e: PipayaEvent): void {
		const d = e.data;
		switch (e.type) {
			case "context_updated":
				this.contextRevision++;
				this.context = d.context;
				break;

			case "compaction_started":
				this.contextRevision++;
				this.serverCompacting = true;
				this.compactionError = "";
				break;

			case "compaction_finished":
				this.contextRevision++;
				this.serverCompacting = false;
				this.compactionError = "";
				this.context = d.context;
				if (d.usage) this.usage = d.usage;
				break;

			case "compaction_failed":
				this.contextRevision++;
				this.serverCompacting = false;
				this.compactionError = d.aborted ? t("컨텍스트 압축을 취소했습니다") : (d.errorMessage || t("컨텍스트 압축에 실패했습니다"));
				break;

			case "run_started":
				this.contextRevision++;
				this.running = true;
				break;

			case "run_limit":
				// The server stopped a runaway run; say why, since the abort alone would look like a plain stop.
				if (typeof d.reason === "string") this.items.push({ kind: "notice", key: `n${uid()}`, text: d.reason, ts: e.ts });
				break;

			case "run_finished": {
				this.running = false;
				const s = this.streamItem();
				if (s) s.streaming = false;
				for (const run of Object.values(this.tools)) {
					if (run.state === "running" || run.state === "awaiting_approval" || run.state === "pending") run.state = "skipped";
				}
				this.queued = [];
				if (d.status === "error" && d.error) {
					const last = this.lastAssistant;
					if (!last || last.stopReason !== "error") {
						this.items.push({ kind: "notice", key: `n${uid()}`, text: d.error, ts: e.ts });
					}
				}
				break;
			}

			case "message_start":
				if (d.message?.role === "assistant") this.ensureStream();
				break;

			case "message_update":
				this.applyDelta(this.ensureStream(), d.event as StreamDelta);
				break;

			case "message_queued":
				this.queued.push({ mode: d.mode === "steer" ? "steer" : "follow_up", text: String(d.text ?? "") });
				break;

			case "message_dequeued": {
				const i = this.queued.findIndex((x) => x.mode === (d.mode === "steer" ? "steer" : "follow_up") && x.text === String(d.text ?? ""));
				if (i >= 0) this.queued.splice(i, 1);
				break;
			}

			case "message_end": {
				const seq = d.seq as number;
				const m = d.message as AgentMessage;
				if (seq <= this.lastSeq) break;
				this.lastSeq = seq;
				this.contextRevision++;
				// Newly appended inputs/tool results are not reflected in the previous measurement, but blanking it
				// would flash "—" in the status line while working; keep the last value until the next assistant usage.
				if (this.context !== undefined && m.role === "assistant" && m.usage?.totalTokens) {
					this.context = { ...this.context, tokens: m.usage.totalTokens };
				}
				if (m.role === "user") {
					const text = textOf(m.content);
					const q = this.queued.findIndex((x) => x.text.trim() === text.trim());
					if (q >= 0) this.queued.splice(q, 1);
					const opt = this.items.find((x): x is UserItem => x.kind === "user" && x.seq === null);
					if (opt) {
						opt.seq = seq;
						// A template call was typed short but stored expanded: show what was really sent.
						const full = userFields(m);
						if (full.template) Object.assign(opt, { text: full.text, template: full.template });
					} else {
						this.items.push({ kind: "user", key: `m${seq}`, seq, ts: m.timestamp ?? e.ts, fresh: true, ...userFields(m) });
					}
				} else if (m.role === "assistant") {
					const s = this.streamItem();
					if (s) {
						Object.assign(s, assistantFields(m), { seq, streaming: false });
					} else {
						this.items.push({ kind: "assistant", key: `m${seq}`, seq, streaming: false, fresh: true, ...assistantFields(m) });
					}
				} else if (m.role === "toolResult") {
					const prev = this.tools[m.toolCallId];
					this.tools[m.toolCallId] = prev?.state === "denied" ? { ...toolRunFrom(m), state: "denied", output: "", denyReason: prev.denyReason ?? toolRunFrom(m).denyReason } : toolRunFrom(m);
				}
				break;
			}

			case "tool_execution_start": {
				const prev = this.tools[d.toolCallId];
				if (prev?.state !== "awaiting_approval") this.tools[d.toolCallId] = { state: "running", output: "" };
				break;
			}

			case "approval_requested":
				this.tools[d.toolCallId] = { ...this.tools[d.toolCallId], output: "", state: "awaiting_approval" };
				break;

			case "approval_resolved": {
				const prev = this.tools[d.toolCallId] ?? { output: "" };
				this.tools[d.toolCallId] = d.approved
					? { ...prev, state: "running" }
					: { ...prev, state: "denied", denyReason: d.reason };
				break;
			}

			case "question_requested":
				this.tools[d.toolCallId] = {
					...this.tools[d.toolCallId],
					output: "",
					state: "awaiting_approval",
					question: { question: d.question, options: d.options, recommended: d.recommended, allowFreeText: d.allowFreeText, items: d.items },
				};
				break;

			case "question_resolved": {
				const { question: _asked, ...prev } = this.tools[d.toolCallId] ?? { output: "" };
				this.tools[d.toolCallId] = { ...prev, state: "running" } as ToolRun;
				break;
			}

			case "tool_execution_update": {
				const prev = this.tools[d.toolCallId];
				if (prev) prev.output = textOf(d.partialResult?.content);
				break;
			}

			case "tool_execution_end": {
				const prev = this.tools[d.toolCallId];
				const denied = prev?.state === "denied";
				const state = denied ? "denied" : d.isError ? "error" : "done";
				this.tools[d.toolCallId] = {
					...prev,
					state,
					output: denied ? "" : textOf(d.result?.content),
					denyReason: denied ? (prev?.denyReason ?? textOf(d.result?.content)) : undefined,
					details: d.result?.details,
					durationMs: d.durationMs,
				};
				break;
			}
		}
	}
}
