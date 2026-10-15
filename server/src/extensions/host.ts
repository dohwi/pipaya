import type { Database } from "bun:sqlite";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import Type from "typebox";
import type { EventBus } from "../events.ts";
import type { ModelRegistry } from "../models.ts";
import { DEFAULT_TOOLS, TOOL_DEFS, type ToolContext, type ToolDef } from "../tools.ts";
import type {
	EventHandler, EventName, ExtensionAPI, ExtensionCommand, ExtensionContext, ExtensionFactory, ExtensionFlag, ExtensionTool, PromptMode, ToolResult,
} from "./types.ts";

/** What the host needs from the session layer (set after both exist, to avoid a construction cycle). */
export interface SessionBridge {
	cwd(sessionId: string): string | undefined;
	send(sessionId: string, text: string, mode: PromptMode): Promise<unknown>;
	abort(sessionId: string): boolean;
	isRunning(sessionId: string): boolean;
}

export interface ExtensionHostOptions {
	db: Database;
	bus: EventBus;
	registry: ModelRegistry;
	dataDir: string;
	/** Directories scanned for extensions (each entry: `x.ts`/`x.js` or a folder). Missing directories are skipped. */
	dirs: string[];
	/** Extra explicit paths (files or folders). */
	paths?: string[];
	env?: Record<string, string | undefined>;
	log?: (msg: string) => void;
}

export interface ExtensionInfo {
	name: string;
	path: string;
	tools: string[];
	commands: { name: string; description?: string }[];
	methods: string[];
	providers: string[];
	flags: { name: string; description?: string; type: "boolean" | "string"; value: boolean | string | undefined }[];
	events: string[];
	error?: string;
}

interface Loaded extends ExtensionInfo {
	handlers: Map<EventName, EventHandler<any>[]>;
	toolDefs: Map<string, ExtensionTool>;
	commandDefs: Map<string, ExtensionCommand>;
	methodDefs: Map<string, (params: unknown, ctx: ExtensionContext | null) => unknown>;
	providerIds: Set<string>;
	flagDefs: Map<string, ExtensionFlag>;
	busOff: (() => void)[];
}

const ENTRY_FILES = ["index.ts", "index.js", "index.mjs"];
const SCRIPT_EXT = new Set([".ts", ".js", ".mjs"]);
const MAX_ERRORS = 100;

export class ExtensionHost {
	private loaded: Loaded[] = [];
	private bridge?: SessionBridge;
	private channels = new Map<string, Set<(data: unknown) => void>>();
	private version = 0;
	readonly errors: { at: number; extension: string; where: string; message: string }[] = [];
	private log: (msg: string) => void;

	constructor(private opts: ExtensionHostOptions) {
		this.log = opts.log ?? (() => {});
	}

	attach(bridge: SessionBridge): void {
		this.bridge = bridge;
	}

	/** Default places: `<dataDir>/extensions` and `~/.agents/extensions`. */
	static defaultDirs(dataDir: string, home = homedir()): string[] {
		return [join(dataDir, "extensions"), join(home, ".agents", "extensions")];
	}

	// ── loading ─────────────────────────────────────────────────────────────

	private discover(): { name: string; entry: string }[] {
		const out: { name: string; entry: string }[] = [];
		const seen = new Set<string>();
		const add = (name: string, entry: string) => { if (!seen.has(entry)) { seen.add(entry); out.push({ name, entry }); } };
		const fromDir = (dir: string, name: string) => {
			const pkg = join(dir, "package.json");
			if (existsSync(pkg)) {
				try {
					const listed = JSON.parse(readFileSync(pkg, "utf8"))?.pipaya?.extensions;
					if (Array.isArray(listed)) {
						for (const rel of listed) if (typeof rel === "string") add(`${name}/${basename(rel, extname(rel))}`, resolve(dir, rel));
						return;
					}
				} catch { /* fall through to index */ }
			}
			const index = ENTRY_FILES.map((f) => join(dir, f)).find((f) => existsSync(f));
			if (index) add(name, index);
		};
		const fromPath = (p: string) => {
			let st;
			try { st = statSync(p); } catch { return; }
			if (st.isDirectory()) fromDir(p, basename(p));
			else if (SCRIPT_EXT.has(extname(p))) add(basename(p, extname(p)), p);
		};
		for (const dir of this.opts.dirs) {
			let names: string[];
			try { names = readdirSync(dir).sort(); } catch { continue; }
			for (const n of names) if (!n.startsWith(".") && n !== "node_modules") fromPath(join(dir, n));
		}
		for (const p of this.opts.paths ?? []) fromPath(resolve(p));
		return out;
	}

	async load(): Promise<ExtensionInfo[]> {
		await this.unloadAll();
		const v = ++this.version;
		for (const { name, entry } of this.discover()) {
			const ext = this.blank(name, entry);
			this.loaded.push(ext);
			try {
				const mod = await import(`${entry}?v=${v}`);
				const factory: ExtensionFactory | undefined = typeof mod.default === "function" ? mod.default : undefined;
				if (!factory) throw new Error("the file must `export default` a function (pi) => { ... }");
				await factory(this.apiFor(ext));
			} catch (e) {
				ext.error = e instanceof Error ? e.message : String(e);
				this.recordError(name, "load", e);
				this.cleanup(ext); // a half-registered extension must not stay active
			}
		}
		this.opts.bus.publish(null, "extensions_updated", { names: this.loaded.map((l) => l.name) });
		await this.emit("extensions_loaded", { names: this.loaded.filter((l) => !l.error).map((l) => l.name) }, null);
		return this.list();
	}

	async reload(): Promise<ExtensionInfo[]> {
		return this.load();
	}

	private blank(name: string, path: string): Loaded {
		return {
			name, path, tools: [], commands: [], methods: [], providers: [], flags: [], events: [],
			handlers: new Map(), toolDefs: new Map(), commandDefs: new Map(), methodDefs: new Map(),
			providerIds: new Set(), flagDefs: new Map(), busOff: [],
		};
	}

	private cleanup(ext: Loaded): void {
		for (const id of ext.providerIds) this.opts.registry.models.deleteProvider(id);
		for (const off of ext.busOff) off();
		ext.handlers.clear(); ext.toolDefs.clear(); ext.commandDefs.clear(); ext.methodDefs.clear();
		ext.providerIds.clear(); ext.flagDefs.clear(); ext.busOff = [];
		ext.tools = []; ext.commands = []; ext.methods = []; ext.providers = []; ext.flags = []; ext.events = [];
	}

	private async unloadAll(): Promise<void> {
		for (const ext of this.loaded) {
			// Let the extension release what it opened before its handlers are dropped.
			for (const h of ext.error ? [] : ext.handlers.get("extension_unload") ?? []) {
				try { await Promise.race([Promise.resolve(h({ name: ext.name }, null as unknown as ExtensionContext)), new Promise((r) => setTimeout(r, 2000))]); }
				catch (e) { this.recordError(ext.name, "on:extension_unload", e); }
			}
			this.cleanup(ext);
		}
		this.loaded = [];
		this.channels.clear();
	}

	async shutdown(): Promise<void> {
		await this.unloadAll();
	}

	list(): ExtensionInfo[] {
		return this.loaded.map(({ name, path, tools, commands, methods, providers, flags, events, error }) => ({
			name, path, tools, commands, methods, providers,
			flags: flags.map((f) => ({ ...f, value: this.flagValue(f.name) })), events, ...(error ? { error } : {}),
		}));
	}

	private active(): Loaded[] {
		return this.loaded.filter((l) => !l.error);
	}

	private recordError(extension: string, where: string, e: unknown): void {
		const message = e instanceof Error ? e.message : String(e);
		this.errors.push({ at: Date.now(), extension, where, message });
		if (this.errors.length > MAX_ERRORS) this.errors.shift();
		this.log(`extension ${extension} (${where}): ${message}`);
		try { this.opts.bus.publish(null, "extension_error", { extension, where, message }, { ephemeral: true }); } catch { /* never fail the caller */ }
	}

	// ── API handed to an extension ──────────────────────────────────────────

	private flagValue(name: string): boolean | string | undefined {
		const def = this.loaded.flatMap((l) => (l.flagDefs.has(name) ? [l.flagDefs.get(name)!] : []))[0];
		const raw = (this.opts.env ?? process.env)[`PIPAYA_FLAG_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`];
		if (raw === undefined) return def?.default;
		return def?.type === "string" ? raw : !["0", "false", ""].includes(raw.toLowerCase());
	}

	private apiFor(ext: Loaded): ExtensionAPI {
		const own = (what: string, name: string, has: boolean) => { if (has) throw new Error(`${what} "${name}" is already registered by this extension`); };
		return {
			Type: Type as ExtensionAPI["Type"],
			name: ext.name,
			dataDir: this.ensureDataDir(ext.name),
			on: (event, handler) => {
				const list = ext.handlers.get(event) ?? [];
				list.push(handler as EventHandler<any>);
				ext.handlers.set(event, list);
				if (!ext.events.includes(event)) ext.events.push(event);
			},
			registerTool: (tool) => {
				if (!/^[A-Za-z0-9_-]{1,64}$/.test(tool.name)) throw new Error(`invalid tool name "${tool.name}"`);
				own("tool", tool.name, ext.toolDefs.has(tool.name));
				ext.toolDefs.set(tool.name, tool);
				ext.tools.push(tool.name);
			},
			registerCommand: (name, command) => {
				if (!/^[A-Za-z0-9_-]{1,40}$/.test(name)) throw new Error(`invalid command name "${name}"`);
				own("command", name, ext.commandDefs.has(name));
				ext.commandDefs.set(name, command);
				ext.commands.push({ name, description: command.description });
			},
			registerMethod: (name, handler) => {
				own("method", name, ext.methodDefs.has(name));
				ext.methodDefs.set(name, handler);
				ext.methods.push(name);
			},
			registerProvider: (provider) => {
				this.opts.registry.models.setProvider(provider);
				ext.providerIds.add(provider.id);
				if (!ext.providers.includes(provider.id)) ext.providers.push(provider.id);
				this.opts.bus.publish(null, "provider_updated", { id: provider.id, configured: true });
			},
			unregisterProvider: (id) => {
				if (!ext.providerIds.delete(id)) return;
				ext.providers = ext.providers.filter((p) => p !== id);
				this.opts.registry.models.deleteProvider(id);
			},
			builtinTool: (name, cwd) => TOOL_DEFS[name]?.create(cwd),
			registerFlag: (name, flag = {}) => {
				ext.flagDefs.set(name, flag);
				ext.flags.push({ name, description: flag.description, type: flag.type ?? (typeof flag.default === "string" ? "string" : "boolean"), value: undefined });
			},
			getFlag: (name) => this.flagValue(name),
			emit: (sessionId, type, data, o) => {
				this.opts.bus.publish(sessionId, "extension_event", { extension: ext.name, type, data: data ?? null }, { ephemeral: o?.ephemeral });
			},
			events: {
				on: (channel, handler) => {
					const set = this.channels.get(channel) ?? new Set();
					set.add(handler);
					this.channels.set(channel, set);
					const off = () => set.delete(handler);
					ext.busOff.push(off);
					return off;
				},
				emit: (channel, data) => {
					for (const h of [...(this.channels.get(channel) ?? [])]) {
						try { void Promise.resolve(h(data)).catch((e) => this.recordError(ext.name, `events:${channel}`, e)); } catch (e) { this.recordError(ext.name, `events:${channel}`, e); }
					}
				},
			},
			log: (...args) => this.log(`[${ext.name}] ${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}`),
		};
	}

	// ── context ─────────────────────────────────────────────────────────────

	context(sessionId: string, extension: string, cwdOverride?: string): ExtensionContext {
		const bridge = this.bridge;
		const db = this.opts.db;
		return {
			sessionId,
			cwd: cwdOverride ?? bridge?.cwd(sessionId) ?? "",
			appendEntry: (type, data) => {
				const createdAt = Date.now();
				const res = db.query("INSERT INTO extension_entries (session_id, extension, type, data, created_at) VALUES ($sid, $ext, $type, $data, $t)")
					.run({ sid: sessionId, ext: extension, type, data: JSON.stringify(data ?? null), t: createdAt });
				this.opts.bus.publish(sessionId, "extension_entry", { id: Number(res.lastInsertRowid), extension, type, data: data ?? null, createdAt });
			},
			entries: (type) => {
				const rows = (type
					? db.query("SELECT id, type, data, created_at FROM extension_entries WHERE session_id = $sid AND extension = $ext AND type = $type ORDER BY id").all({ sid: sessionId, ext: extension, type })
					: db.query("SELECT id, type, data, created_at FROM extension_entries WHERE session_id = $sid AND extension = $ext ORDER BY id").all({ sid: sessionId, ext: extension })) as
					{ id: number; type: string; data: string; created_at: number }[];
				return rows.map((r) => ({ id: r.id, type: r.type, data: JSON.parse(r.data), createdAt: r.created_at }));
			},
			sendUserMessage: async (text, mode) => {
				if (!bridge) throw new Error("sessions are not ready");
				await bridge.send(sessionId, text, mode ?? (bridge.isRunning(sessionId) ? "follow_up" : "prompt"));
			},
			abort: () => bridge?.abort(sessionId) ?? false,
			isRunning: () => bridge?.isRunning(sessionId) ?? false,
		};
	}

	// ── events ──────────────────────────────────────────────────────────────

	/**
	 * Runs every handler of `event` in load order. `step` folds each non-empty result into the caller's state
	 * (and may return true to stop). A throwing handler is logged and skipped; it never breaks the agent.
	 */
	async emit(event: EventName, payload: any, sessionId: string | null, step?: (result: any) => boolean | void): Promise<void> {
		for (const ext of this.active()) {
			for (const handler of ext.handlers.get(event) ?? []) {
				try {
					const result = await handler(payload, sessionId ? this.context(sessionId, ext.name) : (null as unknown as ExtensionContext));
					if (result !== undefined && result !== null && step && step(result) === true) return;
				} catch (e) {
					this.recordError(ext.name, `on:${event}`, e);
				}
			}
		}
	}

	/** Fire and forget, for observation-only events. */
	notify(event: EventName, payload: any, sessionId: string | null): void {
		if (!this.has(event)) return;
		void this.emit(event, payload, sessionId);
	}

	has(event: EventName): boolean {
		return this.active().some((e) => e.handlers.has(event));
	}

	// ── tools ───────────────────────────────────────────────────────────────

	toolDefs(): Record<string, ToolDef> {
		const defs: Record<string, ToolDef> = { ...TOOL_DEFS };
		for (const ext of this.active()) {
			for (const t of ext.toolDefs.values()) defs[t.name] = this.wrapTool(ext.name, t);
		}
		return defs;
	}

	defaultTools(): string[] {
		const names = new Set(DEFAULT_TOOLS);
		for (const ext of this.active()) for (const t of ext.toolDefs.values()) if (t.defaultActive === false) names.delete(t.name); else names.add(t.name);
		return [...names];
	}

	private wrapTool(extension: string, t: ExtensionTool): ToolDef {
		return {
			name: t.name,
			description: t.description,
			mutating: t.mutating ?? true,
			create: (cwd, _roots, ctx?: ToolContext): AgentTool<any> => ({
				name: t.name,
				label: t.label ?? t.name,
				description: t.description,
				parameters: t.parameters,
				execute: async (toolCallId, params, signal, onUpdate) => {
					const ectx = this.context(ctx?.sessionId ?? "", extension, cwd);
					const out: ToolResult = await t.execute(toolCallId, params, ectx, signal, onUpdate ? (p) => onUpdate({ content: p.content as any, details: p.details ?? {} }) : undefined);
					return { content: out.content as any, details: out.details ?? {} };
				},
			}),
		};
	}

	// ── commands & methods ──────────────────────────────────────────────────

	commands(): { name: string; description?: string; extension: string }[] {
		return this.active().flatMap((e) => e.commands.map((c) => ({ ...c, extension: e.name })));
	}

	/** `/name args` → the handler's outcome, or undefined when no extension owns that command. */
	async runCommand(sessionId: string, text: string): Promise<{ handled: true; prompt?: string } | undefined> {
		const m = /^\/([A-Za-z0-9_-]{1,40})(?:\s+([\s\S]*))?$/.exec(text.trim());
		if (!m) return undefined;
		for (const ext of this.active()) {
			const cmd = ext.commandDefs.get(m[1]!);
			if (!cmd) continue;
			try {
				const res = await cmd.handler((m[2] ?? "").trim(), this.context(sessionId, ext.name));
				const prompt = typeof res === "string" ? res : res && typeof res === "object" ? res.prompt : undefined;
				return { handled: true, prompt };
			} catch (e) {
				this.recordError(ext.name, `command:${m[1]}`, e);
				throw e;
			}
		}
		return undefined;
	}

	async callMethod(extension: string, name: string, params: unknown, sessionId: string | null): Promise<{ found: boolean; result?: unknown }> {
		const ext = this.active().find((e) => e.name === extension);
		const fn = ext?.methodDefs.get(name);
		if (!ext || !fn) return { found: false };
		try {
			return { found: true, result: (await fn(params, sessionId ? this.context(sessionId, ext.name) : null)) ?? null };
		} catch (e) {
			this.recordError(ext.name, `method:${name}`, e);
			throw e;
		}
	}

	/** Every entry extensions stored on a session, for clients that want to render them. */
	allEntries(sessionId: string, extension?: string, type?: string): { id: number; extension: string; type: string; data: unknown; createdAt: number }[] {
		const rows = this.opts.db.query("SELECT id, extension, type, data, created_at FROM extension_entries WHERE session_id = $sid ORDER BY id").all({ sid: sessionId }) as
			{ id: number; extension: string; type: string; data: string; created_at: number }[];
		return rows
			.filter((r) => (!extension || r.extension === extension) && (!type || r.type === type))
			.map((r) => ({ id: r.id, extension: r.extension, type: r.type, data: JSON.parse(r.data), createdAt: r.created_at }));
	}

	ensureDataDir(extension: string): string {
		const dir = join(this.opts.dataDir, "extension-data", extension.replace(/[^\w.-]+/g, "_"));
		mkdirSync(dir, { recursive: true });
		return dir;
	}
}
