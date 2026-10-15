import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { AuthEvent, AuthPrompt, AuthType, MutableModels } from "@earendil-works/pi-ai";
import { badRequest, conflict, notFound } from "./errors.ts";

const LOGIN_TIMEOUT_MS = 10 * 60_000;
const FINISHED_KEEP_MS = 60_000;

export type LoginPrompt = { id: number } & (
	| { type: "text" | "secret" | "manual_code"; message: string; placeholder?: string }
	| { type: "select"; message: string; options: { id: string; label: string; description?: string }[] }
);

export interface LoginState {
	id: string;
	providerId: string;
	type: AuthType;
	status: "running" | "done" | "error" | "cancelled";
	/** Everything the flow has announced so far (links to open, device codes, progress), oldest first. */
	events: AuthEvent[];
	/** The question the flow is waiting on, if any. */
	prompt: LoginPrompt | null;
	error?: string;
}

interface Flow extends LoginState {
	abort: AbortController;
	answer?: { id: number; resolve: (v: string) => void; reject: (e: Error) => void };
	nextPromptId: number;
	timer: ReturnType<typeof setTimeout>;
}

/**
 * Runs pi-ai's provider login flows (OAuth, or API-key setup with extra prompts) on the server and
 * lets any client drive them over HTTP: the client polls the state, opens links, and answers prompts.
 * One flow per provider; starting another one cancels the previous.
 */
export class ProviderLogins {
	private flows = new Map<string, Flow>();

	constructor(private models: MutableModels, private onChange: (providerId: string) => void | Promise<void>, private opts: { agentName?: string; deviceId?: () => string } = {}) {}

	start(providerId: string, type: AuthType): LoginState {
		const provider = this.models.getProvider(providerId);
		if (!provider) throw notFound("provider");
		const auth = type === "oauth" ? provider.auth.oauth : provider.auth.apiKey?.login ? provider.auth.apiKey : undefined;
		if (!auth) throw badRequest(type === "oauth" ? "this provider has no OAuth login" : "this provider has no interactive key setup");
		for (const f of this.flows.values()) if (f.providerId === providerId && f.status === "running") this.cancel(f.id);

		const abort = new AbortController();
		const flow: Flow = {
			id: randomUUID(), providerId, type, status: "running", events: [], prompt: null,
			abort, nextPromptId: 1,
			timer: setTimeout(() => this.cancel(flow.id), LOGIN_TIMEOUT_MS),
		};
		this.flows.set(flow.id, flow);

		const interaction = {
			signal: abort.signal,
			notify: (event: AuthEvent) => { flow.events.push(event); if (flow.events.length > 50) flow.events.shift(); },
			prompt: (p: AuthPrompt) => new Promise<string>((resolve, reject) => {
				if (abort.signal.aborted) return reject(new Error("cancelled"));
				const id = flow.nextPromptId++;
				const { signal, ...shown } = p;
				flow.prompt = { id, ...shown } as LoginPrompt;
				const settle = () => { if (flow.answer?.id === id) { flow.answer = undefined; flow.prompt = null; } };
				const onAbort = () => { settle(); reject(new Error("cancelled")); };
				abort.signal.addEventListener("abort", onAbort, { once: true });
				signal?.addEventListener("abort", onAbort, { once: true }); // e.g. a manual_code prompt the callback server already answered
				flow.answer = {
					id,
					resolve: (v) => { settle(); resolve(v); },
					reject: (e) => { settle(); reject(e); },
				};
			}),
		};

		void this.models.login(providerId, type, interaction, { agentName: this.opts.agentName, getDeviceId: this.opts.deviceId })
			.then(() => { flow.status = "done"; })
			.catch((e) => {
				if (flow.status !== "running") return;
				flow.status = abort.signal.aborted ? "cancelled" : "error";
				// The message is shown to the owner who started the login; credentials are never part of it.
				if (flow.status === "error") flow.error = e instanceof Error ? e.message.slice(0, 500) : "login failed";
			})
			.finally(() => {
				clearTimeout(flow.timer);
				flow.prompt = null;
				flow.answer = undefined;
				setTimeout(() => this.flows.delete(flow.id), FINISHED_KEEP_MS).unref?.();
				void this.onChange(providerId);
			});
		return this.view(flow);
	}

	get(id: string): LoginState {
		return this.view(this.find(id));
	}

	answer(id: string, promptId: number, value: string): LoginState {
		const flow = this.find(id);
		if (flow.status !== "running" || flow.answer?.id !== promptId) throw conflict("that question is no longer open");
		flow.answer.resolve(value);
		return this.view(flow);
	}

	cancel(id: string): LoginState {
		const flow = this.find(id);
		if (flow.status === "running") {
			flow.status = "cancelled";
			flow.abort.abort();
		}
		return this.view(flow);
	}

	private find(id: string): Flow {
		const flow = this.flows.get(id);
		if (!flow) throw notFound("login");
		return flow;
	}

	private view(f: Flow): LoginState {
		return { id: f.id, providerId: f.providerId, type: f.type, status: f.status, events: [...f.events], prompt: f.prompt, ...(f.error ? { error: f.error } : {}) };
	}
}

/** The stable ID of this server installation, created on first use (some providers want one at login). */
export function deviceId(db: Database): string {
	const row = db.query("SELECT data FROM settings WHERE key = 'device_id'").get() as { data: string } | null;
	if (row) return JSON.parse(row.data);
	const id = randomUUID();
	db.query("INSERT INTO settings (key, data) VALUES ('device_id', $data)").run({ data: JSON.stringify(id) });
	return id;
}
