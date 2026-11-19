import type { ProviderImages } from "@earendil-works/pi-ai";
import { sniffImage } from "./image-file.ts";

/** OpenAI Images is a one-shot API. Never retry a generation or try another endpoint after an ambiguous failure. */
export const openAIImages: ProviderImages = {
	async generateImages(model, { input }, options) {
		const prompt = input.flatMap((c) => c.type === "text" ? [c.text] : []).join("\n");
		const refs = input.filter((c) => c.type === "image");
		const headers = new Headers();
		if (options?.apiKey) headers.set("authorization", `Bearer ${options.apiKey}`);
		for (const source of [model.headers, options?.headers]) {
			for (const [key, value] of Object.entries(source ?? {})) {
				if (value === null) headers.delete(key); else headers.set(key, value);
			}
		}
		let body: string | FormData;
		if (refs.length) {
			body = new FormData();
			body.set("model", model.id);
			body.set("prompt", prompt);
			for (const [i, ref] of refs.entries()) {
				const bytes = Buffer.from(ref.data, "base64");
				const info = sniffImage(bytes);
				if (!info) throw new Error("Invalid reference image");
				body.append("image[]", new Blob([bytes], { type: info.mimeType }), `ref-${i + 1}.${info.mimeType.slice(6)}`);
			}
			headers.delete("content-type"); // fetch supplies the multipart boundary
		} else {
			headers.set("content-type", "application/json");
			body = JSON.stringify({ model: model.id, prompt });
		}
		const route = refs.length ? "edits" : "generations";
		const res = await (options?.fetch ?? fetch)(`${model.baseUrl.replace(/\/+$/, "")}/images/${route}`, { method: "POST", headers, body, signal: options?.signal, redirect: "error" });
		if (!res.ok) {
			await res.body?.cancel().catch(() => {});
			throw new Error(`OpenAI Images ${route}: HTTP ${res.status}`); // never reflect upstream bodies or headers
		}
		const result = await res.json().catch(() => null) as { data?: { b64_json?: unknown }[] } | null;
		if (!Array.isArray(result?.data) || !result.data.length) throw new Error("OpenAI Images returned no picture");
		const output = result.data.map((item) => {
			const data = item?.b64_json;
			if (typeof data !== "string") throw new Error("OpenAI Images returned no inline image data");
			const info = sniffImage(Buffer.from(data, "base64"));
			if (!info) throw new Error("OpenAI Images returned invalid image data");
			return { type: "image" as const, data, mimeType: info.mimeType };
		});
		return { api: model.api, provider: model.provider, model: model.id, output, stopReason: "stop", timestamp: Date.now() };
	},
};
