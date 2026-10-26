import type { Database } from "bun:sqlite";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join, resolve, sep } from "node:path";
import Type from "typebox";
import type { EventBus } from "../events.ts";
import type { ModelRegistry } from "../models.ts";
import { DEFAULT_TOOLS, TOOL_DEFS, type ToolContext, type ToolDef } from "../tools.ts";
import { RETIRED_EXTENSIONS } from "./retired.ts";
import type {
	AskRequest, EventHandler, EventName, CommandResult, ExtensionAPI, ExtensionCommand, ExtensionCommandFamily, ExtensionContext, MessageNote, ExtensionFactory, ExtensionFlag, ExtensionGroups, ExtensionModels, ExtensionTerminals, ExtensionSessions, ExtensionSessionData, ExtensionTool, PromptMode, ServerEvent, ToolResult,
} from "./types.ts";

/** What the host needs from the session layer (set after both exist, to avoid a construction cycle). */
export interface SessionBridge {
	cwd(sessionId: string): string | undefined;
	send(sessionId: string, text: string, mode: PromptMode): Promise<unknown>;
	abort(sessionId: string): boolean;
	isRunning(sessionId: string): boolean;
	ask?(sessionId: string, toolCallId: string, req: AskRequest, signal?: AbortSignal): Promise<string>;
	sessions: ExtensionSessions;
	groups: ExtensionGroups;
	terminals: ExtensionTerminals;
	models: ExtensionModels;
	/** An OS / push notification from extension `source`; throws past the rate limit. */
	notify(source: string, n: { title: string; body?: string; sessionId?: string; key?: string; kind?: string }): void;
	defaultCwd(): string;
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
	/** The user's home directory (tests); defaults to the OS user home. */
	home?: string;
	env?: Record<string, string | undefined>;
	log?: (msg: string) => void;
	/** How long a client's method call may take (default 20 s; the client gives up after 15). */
	methodTimeoutMs?: number;
	/** The per-extension settings store (`/extensions/:id/settings`). */
	settings?: { get(id: string): Record<string, unknown> | undefined; save(id: string, value: unknown): Record<string, unknown> };
}

export interface ExtensionInfo {
	name: string;
	path: string;
	tools: string[];
	commands: { name: string; description?: string; args?: string }[];
	/** Command families (`/prefix:name`), by prefix. */
	commandFamilies: { prefix: string; label?: string }[];
	methods: string[];
	providers: string[];
	flags: { name: string; description?: string; type: "boolean" | "string"; value: boolean | string | undefined }[];
	events: string[];
	/** Id of the client extension this one needs on the device (`pipaya.companion` in its package.json). */
	companion?: string;
	/** From the package.json of a folder extension: shown on the settings page. */
	title?: string;
	version?: string;
	description?: string;
	/** `pipaya.descriptions` (language tag -> text). */
	descriptions?: Record<string, string>;
	/** `pipaya.settings`: the fields of the form the settings page shows (same shape as a client manifest's `settings`; the client validates them). */
	settings?: unknown[];
	/** Id of the shared settings object (`GET/PUT /extensions/:id/settings`) behind `settings`. */
	settingsId: string;
	/** True when the folder carries the client half itself (`pipaya.client`): `GET /server-extensions/:name/client` serves it. */
	clientPackage?: boolean;
	error?: string;
}

/** A client package a server extension carries is at most this big (the client's MAX_PACKAGE_BYTES plus slack for formatting). */
export const MAX_CLIENT_PACKAGE_BYTES = 2 * 1024 * 1024;

type PackageMeta = Pick<ExtensionInfo, "companion" | "title" | "version" | "description" | "descriptions" | "settings"> & { clientFile?: string };

interface Loaded extends ExtensionInfo {
	clientFile?: string;
	handlers: Map<EventName, EventHandler<any>[]>;
	toolDefs: Map<string, ExtensionTool>;
	commandDefs: Map<string, ExtensionCommand>;
	familyDefs: Map<string, ExtensionCommandFamily>;
	methodDefs: Map<string, (params: unknown, ctx: ExtensionContext | null) => unknown>;
	providerIds: Set<string>;
	flagDefs: Map<string, ExtensionFlag>;
	busOff: (() => void)[];
}

const ENTRY_FILES = ["index.ts", "index.js", "index.mjs"];
const SCRIPT_EXT = new Set([".ts", ".js", ".mjs"]);
const MAX_ERRORS = 100;
const FAMILY_NAME = /^[A-Za-z0-9_.-]{1,80}$/;
const MAX_FAMILY_ENTRIES = 500;
const METHOD_NAME = /^[A-Za-z0-9_-]{1,80}$/;
/**
 * The app's own slash commands (client `COMMANDS` in client/src/lib/commands.ts). An extension cannot take these names:
 * built-in commands are never overridden. client/tests/commands-reserved.test.ts keeps the two lists equal.
 */
export const RESERVED_COMMANDS = Object.freeze(["new", "resume", "rename", "close", "cd", "compact", "retry", "stop", "cancel", "fork", "tree", "copy", "delete"]);
/** A method a client waits on must answer: the client gives up after 15 s, so the server stops waiting a little later. */
const METHOD_TIMEOUT_MS = 20_000;
const MAX_ENTRY_PAGE = 1000;

const str = (v: unknown, max: number): string | undefined => (typeof v === "string" && v.trim() && v.length <= max ? v : undefined);

/** What a folder extension's package.json tells the settings page (all optional, none of it trusted). */
function packageMeta(json: any, dir?: string): PackageMeta {
	const meta = json?.pipaya;
	const out: PackageMeta = {};
	const c = meta?.companion;
	if (typeof c === "string" && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(c) && c.length <= 80) out.companion = c;
	const title = str(meta?.title, 80); if (title) out.title = title;
	const version = str(json?.version, 40); if (version) out.version = version;
	const description = str(json?.description, 500); if (description) out.description = description;
	if (meta?.descriptions && typeof meta.descriptions === "object" && !Array.isArray(meta.descriptions)) {
		const d: Record<string, string> = {};
		for (const [k, v] of Object.entries(meta.descriptions).slice(0, 10)) { const t = str(v, 500); if (t && k.length <= 35) d[k] = t; }
		if (Object.keys(d).length) out.descriptions = d;
	}
	if (Array.isArray(meta?.settings) && meta.settings.length <= 20) out.settings = meta.settings;
	// `pipaya.client`: a built client package inside the folder (relative, never outside it).
	const client = meta?.client;
	if (dir && typeof client === "string" && /^(?!.*(^|\/)\.\.?(\/|$))[\w.-]+(\/[\w.-]+)*\.json$/.test(client)) {
		const file = resolve(dir, client);
		if (file.startsWith(resolve(dir) + sep)) out.clientFile = file;
	}
	return out;
}

export class ExtensionHost {
	private loaded: Loaded[] = [];
	/** The extensions that loaded without an error; asked on every tool call and model call, so kept rather than filtered each time. */
	private running: Loaded[] = [];
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

	private discover(): { name: string; entry: string; meta: PackageMeta }[] {
		const out: { name: string; entry: string; meta: PackageMeta }[] = [];
		const seen = new Set<string>();
		const add = (name: string, entry: string, meta: PackageMeta = {}) => { if (!seen.has(entry)) { seen.add(entry); out.push({ name, entry, meta }); } };
		const fromDir = (dir: string, name: string) => {
			const pkg = join(dir, "package.json");
			let companion: PackageMeta = {};
			if (existsSync(pkg)) {
				try {
					const json = JSON.parse(readFileSync(pkg, "utf8"));
					const meta = json?.pipaya;
					companion = packageMeta(json, dir);
					const listed = meta?.extensions;
					if (Array.isArray(listed)) {
						for (const rel of listed) if (typeof rel === "string") add(`${name}/${basename(rel, extname(rel))}`, resolve(dir, rel), companion);
						return;
					}
				} catch { /* fall through to index */ }
			}
			const index = ENTRY_FILES.map((f) => join(dir, f)).find((f) => existsSync(f));
			if (index) add(name, index, companion);
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
		for (const { name, entry, meta } of this.discover()) {
			if (RETIRED_EXTENSIONS.has(name.split("/")[0]!)) { this.log(`extension ${name} is built into the server now; not loading it (you can delete it)`); continue; }
			const ext = this.blank(name, entry);
			Object.assign(ext, meta);
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
		this.running = this.loaded.filter((l) => !l.error);
		this.opts.bus.publish(null, "extensions_updated", { names: this.loaded.map((l) => l.name) });
		await this.emit("extensions_loaded", { names: this.loaded.filter((l) => !l.error).map((l) => l.name) }, null);
		return this.list();
	}

	async reload(): Promise<ExtensionInfo[]> {
		return this.load();
	}

	private blank(name: string, path: string): Loaded {
		return {
			name, path, settingsId: name.split("/")[0]!, tools: [], commands: [], commandFamilies: [], methods: [], providers: [], flags: [], events: [],
			handlers: new Map(), toolDefs: new Map(), commandDefs: new Map(), familyDefs: new Map(), methodDefs: new Map(),
			providerIds: new Set(), flagDefs: new Map(), busOff: [],
		};
	}

	private cleanup(ext: Loaded): void {
		for (const id of ext.providerIds) this.opts.registry.models.deleteProvider(id);
		for (const off of ext.busOff) off();
		ext.handlers.clear(); ext.toolDefs.clear(); ext.commandDefs.clear(); ext.familyDefs.clear(); ext.methodDefs.clear();
		ext.providerIds.clear(); ext.flagDefs.clear(); ext.busOff = [];
		ext.tools = []; ext.commands = []; ext.commandFamilies = []; ext.methods = []; ext.providers = []; ext.flags = []; ext.events = [];
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
		this.running = [];
		this.channels.clear();
	}

	async shutdown(): Promise<void> {
		await this.unloadAll();
	}

	list(): ExtensionInfo[] {
		return this.loaded.map(({ name, path, tools, commands, commandFamilies, methods, providers, flags, events, companion, title, version, description, descriptions, settings, settingsId, clientFile, error }) => ({
			name, path, tools, commands, commandFamilies, methods, providers, settingsId, ...(companion ? { companion } : {}), ...(clientFile && existsSync(clientFile) ? { clientPackage: true } : {}),
			...(title ? { title } : {}), ...(version ? { version } : {}), ...(description ? { description } : {}), ...(descriptions ? { descriptions } : {}), ...(settings ? { settings } : {}),
			flags: flags.map((f) => ({ ...f, value: this.flagValue(f.name) })), events, ...(error ? { error } : {}),
		}));
	}

	private active(): Loaded[] {
		return this.running;
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
		const bridgeSessions = (): ExtensionSessions => {
			if (!this.bridge) throw new Error("sessions are not ready");
			return this.bridge.sessions;
		};
		const bridged = (what: string): SessionBridge => {
			if (!this.bridge) throw new Error(`${what} are not ready`);
			return this.bridge;
		};
		const sessionData: ExtensionSessionData = {
			get: (sid, key) => {
				const row = this.opts.db.query("SELECT value FROM extension_session_data WHERE session_id = $sid AND extension = $ext AND key = $key").get({ sid, ext: ext.name, key }) as { value: string } | null;
				return row ? JSON.parse(row.value) : undefined;
			},
			set: (sid, key, value) => {
				const text = JSON.stringify(value ?? null);
				if (text.length > 4000) throw new Error("a session value is at most 4000 characters");
				if (typeof key !== "string" || !key || key.length > 80) throw new Error("key must be 1-80 characters");
				try {
					this.opts.db.query("INSERT INTO extension_session_data (session_id, extension, key, value) VALUES ($sid, $ext, $key, $value) ON CONFLICT (session_id, extension, key) DO UPDATE SET value = excluded.value").run({ sid, ext: ext.name, key, value: text });
				} catch { throw new Error("unknown session"); }
			},
			delete: (sid, key) => void this.opts.db.query("DELETE FROM extension_session_data WHERE session_id = $sid AND extension = $ext AND key = $key").run({ sid, ext: ext.name, key }),
			list: (key) => Object.fromEntries((this.opts.db.query("SELECT session_id, value FROM extension_session_data WHERE extension = $ext AND key = $key").all({ ext: ext.name, key }) as { session_id: string; value: string }[]).map((r) => [r.session_id, JSON.parse(r.value)])),
		};
		const own = (what: string, name: string, has: boolean) => { if (has) throw new Error(`${what} "${name}" is already registered by this extension`); };
		return {
			Type: Type as ExtensionAPI["Type"],
			name: ext.name,
			dataDir: this.ensureDataDir(ext.name),
			settings: ((): ExtensionAPI["settings"] => {
				const id = ext.name.split("/")[0]!;
				const store = () => {
					if (!this.opts.settings) throw new Error("settings are not available");
					return this.opts.settings;
				};
				return {
					id,
					get: () => store().get(id) ?? {},
					set: (value) => {
						const saved = store().save(id, value);
						this.opts.bus.publish(null, "extension_settings_updated", { id, action: "saved" });
						return saved;
					},
					onChange: (handler) => {
						const off = this.opts.bus.subscribe((e) => {
							if (e.type !== "extension_settings_updated" || (e.data as { id?: string })?.id !== id) return;
							try { handler(store().get(id) ?? {}); } catch (err) { this.recordError(ext.name, "settings:onChange", err); }
						});
						ext.busOff.push(off);
						return off;
					},
				};
			})(),
			home: this.opts.home ?? homedir(),
			defaultCwd: () => this.bridge?.defaultCwd() ?? process.cwd(),
			sessions: new Proxy({} as ExtensionSessions & { data: ExtensionSessionData }, {
				get: (_t, prop) => (prop === "data" ? sessionData : (bridgeSessions() as unknown as Record<string | symbol, unknown>)[prop]),
			}),
			get groups(): ExtensionGroups {
				return bridged("groups").groups;
			},
			get models(): ExtensionModels {
				return bridged("models").models;
			},
			get terminals(): ExtensionTerminals {
				return bridged("terminals").terminals;
			},
			subscribe: (handler, o) => {
				const types = o?.types?.length ? new Set(o.types) : null;
				const off = this.opts.bus.subscribe((e) => {
					if (types && !types.has(e.type)) return;
					try { void Promise.resolve(handler(e as ServerEvent)).catch((err) => this.recordError(ext.name, "subscribe", err)); } catch (err) { this.recordError(ext.name, "subscribe", err); }
				}, o?.sessionId);
				ext.busOff.push(off);
				return off;
			},
			notify: (n) => {
				if (!this.bridge) throw new Error("notifications are not ready");
				this.bridge.notify(ext.name, n);
			},
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
				if (RESERVED_COMMANDS.includes(name.toLowerCase())) throw new Error(`command "/${name}" is built into the app and cannot be overridden`);
				own("command", name, ext.commandDefs.has(name));
				ext.commandDefs.set(name, command);
				ext.commands.push({ name, description: command.description, ...(command.args ? { args: command.args } : {}) });
			},
			registerCommands: (prefix, family) => {
				if (!/^[a-z][a-z0-9-]{0,19}$/.test(prefix)) throw new Error(`invalid command prefix "${prefix}"`);
				if (prefix === "skill") throw new Error(`command prefix "${prefix}" is reserved`);
				own("command family", prefix, ext.familyDefs.has(prefix));
				for (const other of this.loaded) if (other !== ext && other.familyDefs.has(prefix)) throw new Error(`command prefix "${prefix}" is already used by ${other.name}`);
				ext.familyDefs.set(prefix, family);
				ext.commandFamilies.push({ prefix, ...(family.label ? { label: family.label } : {}) });
			},
			registerMethod: (name, handler) => {
				if (typeof name !== "string" || !METHOD_NAME.test(name)) throw new Error(`invalid method name "${name}"`);
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
			ask: (toolCallId, req, signal) => bridge?.ask ? bridge.ask(sessionId, toolCallId, req, signal) : Promise.reject(new Error("asking the user is not available")),
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

	/** Tools every session gets, whatever list it was created with. */
	alwaysTools(): string[] {
		return this.active().flatMap((e) => [...e.toolDefs.values()].filter((t) => t.alwaysActive).map((t) => t.name));
	}

	/** Extension tools the user may switch off in the settings. */
	switchableTools(): string[] {
		return this.active().flatMap((e) => [...e.toolDefs.values()].filter((t) => t.switchable).map((t) => t.name));
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

	commands(): { name: string; description?: string; args?: string; extension: string }[] {
		return this.active().flatMap((e) => e.commands.map((c) => ({ ...c, extension: e.name })));
	}

	/** Every command family's entries for `cwd`, e.g. `{ prefix: "prompt", entries: [{ name: "review" }] }`. A failing family lists nothing. */
	async commandEntries(cwd: string): Promise<{ prefix: string; label?: string; extension: string; entries: { name: string; description?: string; args?: string }[] }[]> {
		const out: { prefix: string; label?: string; extension: string; entries: { name: string; description?: string; args?: string }[] }[] = [];
		for (const ext of this.active()) {
			for (const [prefix, family] of ext.familyDefs) {
				let entries: { name: string; description?: string; args?: string }[] = [];
				try {
					const raw = await Promise.race([Promise.resolve(family.list(cwd)), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("list timed out")), 5000))]);
					entries = (Array.isArray(raw) ? raw : [])
						.filter((c) => c && typeof c.name === "string" && FAMILY_NAME.test(c.name))
						.slice(0, MAX_FAMILY_ENTRIES)
						.map((c) => ({ name: c.name, ...(typeof c.description === "string" ? { description: c.description.slice(0, 300) } : {}), ...(typeof c.args === "string" ? { args: c.args.slice(0, 60) } : {}) }));
				} catch (e) {
					this.recordError(ext.name, `commands:${prefix}`, e);
				}
				out.push({ prefix, ...(family.label ? { label: family.label } : {}), extension: ext.name, entries });
			}
		}
		return out;
	}

	/** `/name args` or `/prefix:name args` → the handler's outcome, or undefined when no extension owns that command. */
	async runCommand(sessionId: string, text: string): Promise<{ handled: true; prompt?: string; note?: MessageNote; title?: string } | undefined> {
		const fam = /^\/([a-z][a-z0-9-]{0,19}):([A-Za-z0-9_.-]{1,80})(?:\s+([\s\S]*))?$/.exec(text.trim());
		if (fam) {
			for (const ext of this.active()) {
				const family = ext.familyDefs.get(fam[1]!);
				if (!family) continue;
				try {
					return this.commandOutcome(await family.run(fam[2]!, (fam[3] ?? "").trim(), this.context(sessionId, ext.name)));
				} catch (e) {
					this.recordError(ext.name, `commands:${fam[1]}`, e);
					throw e;
				}
			}
			return undefined;
		}
		const m = /^\/([A-Za-z0-9_-]{1,40})(?:\s+([\s\S]*))?$/.exec(text.trim());
		if (!m) return undefined;
		for (const ext of this.active()) {
			const cmd = ext.commandDefs.get(m[1]!);
			if (!cmd) continue;
			try {
				return this.commandOutcome(await cmd.handler((m[2] ?? "").trim(), this.context(sessionId, ext.name)));
			} catch (e) {
				this.recordError(ext.name, `command:${m[1]}`, e);
				throw e;
			}
		}
		return undefined;
	}

	private commandOutcome(res: CommandResult): { handled: true; prompt?: string; note?: MessageNote; title?: string } {
		if (typeof res === "string") return { handled: true, prompt: res };
		if (!res || typeof res !== "object" || typeof res.prompt !== "string") return { handled: true };
		return { handled: true, prompt: res.prompt, ...(res.note ? { note: res.note } : {}), ...(typeof res.title === "string" ? { title: res.title } : {}) };
	}

	async callMethod(extension: string, name: string, params: unknown, sessionId: string | null): Promise<{ found: boolean; result?: unknown }> {
		const ext = this.active().find((e) => e.name === extension);
		const fn = ext?.methodDefs.get(name);
		if (!ext || !fn) return { found: false };
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const call = Promise.resolve(fn(params, sessionId ? this.context(sessionId, ext.name) : null));
			const ms = this.opts.methodTimeoutMs ?? METHOD_TIMEOUT_MS;
			const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`method ${name} did not answer within ${ms} ms`)), ms); });
			return { found: true, result: (await Promise.race([call, late])) ?? null };
		} catch (e) {
			this.recordError(ext.name, `method:${name}`, e);
			throw e;
		} finally {
			clearTimeout(timer);
		}
	}

	/**
	 * Entries extensions stored on a session, oldest first, for clients that want to render them. Filtered in SQL (a long
	 * session can hold thousands); `after` (an entry id) and `limit` page through them.
	 */
	allEntries(sessionId: string, extension?: string, type?: string, page: { after?: number; limit?: number } = {}): { id: number; extension: string; type: string; data: unknown; createdAt: number }[] {
		const limit = Math.min(Math.max(1, Math.floor(page.limit ?? MAX_ENTRY_PAGE)), MAX_ENTRY_PAGE);
		const rows = this.opts.db.query(
			`SELECT id, extension, type, data, created_at FROM extension_entries
			 WHERE session_id = $sid AND ($ext IS NULL OR extension = $ext) AND ($type IS NULL OR type = $type) AND id > $after
			 ORDER BY id LIMIT $limit`,
		).all({ sid: sessionId, ext: extension || null, type: type || null, after: page.after ?? 0, limit }) as
			{ id: number; extension: string; type: string; data: string; created_at: number }[];
		return rows.map((r) => ({ id: r.id, extension: r.extension, type: r.type, data: JSON.parse(r.data), createdAt: r.created_at }));
	}

	/** The client package a server extension carries (`pipaya.client`), as parsed JSON; undefined when it has none. */
	clientPackage(extension: string): unknown {
		const file = this.loaded.find((e) => e.name === extension || e.name.split("/")[0] === extension)?.clientFile;
		if (!file) return undefined;
		let st;
		try { st = statSync(file); } catch { return undefined; }
		if (!st.isFile() || st.size > MAX_CLIENT_PACKAGE_BYTES) throw new Error(`the client package is missing or over ${MAX_CLIENT_PACKAGE_BYTES} bytes`);
		return JSON.parse(readFileSync(file, "utf8"));
	}

	ensureDataDir(extension: string): string {
		const dir = join(this.opts.dataDir, "extension-data", extension.replace(/[^\w.-]+/g, "_"));
		mkdirSync(dir, { recursive: true });
		return dir;
	}
}
