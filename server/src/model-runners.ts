import { createAssistantMessageEventStream, type Api, type AssistantMessage, type AssistantMessageEventStream, type Model, type SimpleStreamOptions, type TextContent } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ModelRegistry } from "./models.ts";
import type { ModelKind, ModelRunner } from "./extensions/types.ts";

/**
 * Models the core lists but does not run itself (today: image models). A server extension runs them
 * (`pi.registerModelRunner`); without one they cannot be used, and the session says so before a message is sent.
 */

/** The kind of a model the core does not run itself, or undefined for an ordinary chat model. */
export const modelKind = (registry: ModelRegistry, provider: string, id: string): ModelKind | undefined =>
	registry.isImageModel?.(provider, id) ? "image" : undefined;

const emptyUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });

/**
 * A reply made by an extension's runner, spoken in the chat stream protocol so storage, events, retry and abort need
 * no special case. The connection's address and key are resolved here: the extension never reads credentials itself.
 */
export function runnerStream(
	registry: ModelRegistry,
	run: ModelRunner,
	model: Model<Api>,
	messages: readonly AgentMessage[],
	options: SimpleStreamOptions | undefined,
	session: { id: string; cwd: string },
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const msg: AssistantMessage = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: emptyUsage(), stopReason: "stop", timestamp: Date.now() };
	stream.push({ type: "start", partial: msg });
	const fail = (reason: "error" | "aborted", message: string) => {
		msg.stopReason = reason;
		msg.errorMessage = message;
		stream.push({ type: "error", reason, error: msg });
	};
	void (async () => {
		try {
			const auth = await registry.models.getAuth(model, { signal: options?.signal });
			const headers = { ...(model.headers ?? {}), ...(auth?.auth.headers ?? {}) } as Record<string, string>;
			const out = await run({
				sessionId: session.id,
				cwd: session.cwd,
				model: { provider: model.provider, id: model.id, name: model.name, baseUrl: auth?.auth.baseUrl ?? model.baseUrl, ...(Object.keys(headers).length ? { headers } : {}) },
				...(auth?.auth.apiKey ? { apiKey: auth.auth.apiKey } : {}),
				messages: [...messages],
				...(options?.signal ? { signal: options.signal } : {}),
			});
			if (options?.signal?.aborted) return fail("aborted", "aborted");
			const text = typeof out?.text === "string" ? out.text : "";
			if (!text.trim()) return fail("error", "the model returned nothing");
			if (out.usage) {
				const input = Math.max(0, Math.floor(out.usage.input) || 0), output = Math.max(0, Math.floor(out.usage.output) || 0);
				msg.usage = { ...emptyUsage(), input, output, totalTokens: input + output };
			}
			const block: TextContent = { type: "text", text: "" };
			msg.content = [block];
			stream.push({ type: "text_start", contentIndex: 0, partial: msg });
			block.text = text;
			stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: msg });
			stream.push({ type: "text_end", contentIndex: 0, content: text, partial: msg });
			stream.push({ type: "done", reason: "stop", message: msg });
		} catch (e) {
			fail(options?.signal?.aborted ? "aborted" : "error", e instanceof Error ? e.message : String(e));
		}
	})();
	return stream;
}
