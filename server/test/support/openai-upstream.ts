/**
 * Test-only local OpenAI-compatible upstream (chat completions, streaming SSE).
 * The server under test reaches it through a normal custom provider
 * (PUT /configuration/providers/:id), exactly like any real endpoint.
 *
 *   "hello"            -> streams "Echo: hello"
 *   "!bash <command>"  -> streams a bash tool call, then summarises the tool result
 *   "!<tool> {json}"   -> streams a call to any other tool with JSON args
 */
export interface UpstreamRequest {
	path: string;
	authorization: string | null;
	body: any;
}

export interface EchoUpstream {
	/** Base URL to register as a provider (`.../v1`). */
	baseUrl: string;
	requests: UpstreamRequest[];
	stop(): void;
}

export const ECHO_MODEL = {
	id: "echo-model",
	name: "Echo",
	contextWindow: 8192,
	maxTokens: 1024,
	reasoning: false,
	vision: false,
};

/** Provider payload for PUT /configuration/providers/:id pointing at the fixture. */
export const echoProviderBody = (baseUrl: string, name = "Echo upstream") => ({
	name,
	baseUrl,
	api: "openai-completions" as const,
	authRequired: false,
	models: [ECHO_MODEL],
});

const textOf = (content: unknown): string => {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content.map((c: any) => (c?.type === "text" ? c.text : "")).join("");
	return "";
};

type Plan = { text: string; tool?: { name: string; args: string } };

function plan(messages: any[]): Plan {
	const last = messages[messages.length - 1];
	const input = textOf(last?.content);
	if (last?.role === "tool") {
		const call = messages
			.filter((m) => m.role === "assistant" && Array.isArray(m.tool_calls))
			.flatMap((m) => m.tool_calls)
			.find((c: any) => c.id === last.tool_call_id);
		const name = call?.function?.name ?? last.name ?? "tool";
		return { text: `Tool ${name} finished:\n${input.slice(0, 500)}` };
	}
	const m = /^!(\w+)\s+(.*)$/s.exec(input);
	if (last?.role === "user" && m) {
		const [, name, rest] = m as unknown as [string, string, string];
		try {
			const args = name === "bash" && !rest.trimStart().startsWith("{") ? { command: rest } : JSON.parse(rest);
			return { text: `Running ${name}…`, tool: { name, args: JSON.stringify(args) } };
		} catch {
			return { text: `Could not parse tool arguments: ${rest}` };
		}
	}
	return { text: `Echo: ${input}` };
}

function chunks(p: Plan, callId: string): object[] {
	const base = { id: "chatcmpl-echo", object: "chat.completion.chunk", created: 1, model: ECHO_MODEL.id };
	const out: object[] = [];
	const pieces = p.text.match(/[\s\S]{1,8}/g) ?? [""];
	pieces.forEach((text, i) => out.push({ ...base, choices: [{ index: 0, delta: i === 0 ? { role: "assistant", content: text } : { content: text }, finish_reason: null }] }));
	if (p.tool) {
		out.push({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: callId, type: "function", function: { name: p.tool.name, arguments: "" } }] }, finish_reason: null }] });
		out.push({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: p.tool.args } }] }, finish_reason: null }] });
	}
	out.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: p.tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 4, completion_tokens: pieces.length, total_tokens: 4 + pieces.length } });
	return out;
}

export function startEchoUpstream(): EchoUpstream {
	const requests: UpstreamRequest[] = [];
	let calls = 0;
	const server = Bun.serve({
		hostname: "0.0.0.0",
		port: 0,
		async fetch(req) {
			const path = new URL(req.url).pathname;
			const body: any = await req.json().catch(() => null);
			requests.push({ path, authorization: req.headers.get("authorization"), body });
			if (!path.endsWith("/chat/completions") || !body) return new Response("not found", { status: 404 });
			const frames = chunks(plan(body.messages ?? []), `call_echo_${++calls}`);
			let cancelled = false;
			const enc = new TextEncoder();
			return new Response(new ReadableStream({
				async start(controller) {
					for (const f of frames) {
						if (cancelled) return;
						controller.enqueue(enc.encode(`data: ${JSON.stringify(f)}\n\n`));
						await Bun.sleep(1);
					}
					if (!cancelled) {
						controller.enqueue(enc.encode("data: [DONE]\n\n"));
						controller.close();
					}
				},
				cancel() { cancelled = true; },
			}), { headers: { "content-type": "text/event-stream" } });
		},
	});
	return { baseUrl: `http://127.0.0.1:${server.port}/v1`, requests, stop: () => server.stop(true) };
}
