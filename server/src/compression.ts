import type { FastifyInstance } from "fastify";
import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";

const brotli = promisify(brotliCompress);
const gz = promisify(gzip);

/** Below this a compressed body saves less than the headers it costs. */
export const COMPRESS_MIN_BYTES = 1024;

/** Brotli where the client offers it (browsers only do over https), gzip otherwise; nothing for anything else. */
export function pickEncoding(accept: string | string[] | undefined): "br" | "gzip" | null {
	const offered = new Map<string, number>();
	for (const part of (Array.isArray(accept) ? accept.join(",") : (accept ?? "")).split(",")) {
		const [name, ...params] = part.trim().toLowerCase().split(";");
		if (!name) continue;
		const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
		offered.set(name, q ? Number(q.slice(2)) || 0 : 1);
	}
	if ((offered.get("br") ?? 0) > 0) return "br";
	if ((offered.get("gzip") ?? 0) > 0) return "gzip";
	return null;
}

/**
 * Compress JSON responses. Over a relayed tailnet path (a phone on mobile data is often 100ms+ away) a large list costs
 * more in transfer than in anything the server does: `/models` alone is ~0.5MB of JSON and ~25KB compressed.
 * Only whole JSON bodies are touched; streams (SSE, files, extension responses) pass as they are.
 */
export function registerCompression(server: FastifyInstance): void {
	server.addHook("onSend", async (req, reply, payload) => {
		if (req.method === "HEAD" || reply.hasHeader("content-encoding")) return payload;
		if (typeof payload !== "string" && !Buffer.isBuffer(payload)) return payload;
		const type = String(reply.getHeader("content-type") ?? "");
		if (!type.startsWith("application/json")) return payload;
		void reply.header("vary", appendVary(reply.getHeader("vary"), "Accept-Encoding"));
		if (Buffer.byteLength(payload) < COMPRESS_MIN_BYTES) return payload;
		const encoding = pickEncoding(req.headers["accept-encoding"]);
		if (!encoding) return payload;
		// Quality 4 and level 6: within a few ms for the largest list, close to the best ratio.
		const body = encoding === "br"
			? await brotli(payload, { params: { [constants.BROTLI_PARAM_QUALITY]: 4, [constants.BROTLI_PARAM_SIZE_HINT]: Buffer.byteLength(payload) } })
			: await gz(payload, { level: 6 });
		void reply.header("content-encoding", encoding);
		reply.removeHeader("content-length");
		return body;
	});
}

function appendVary(current: unknown, value: string): string {
	const list = String(current ?? "").split(",").map((v) => v.trim()).filter(Boolean);
	if (!list.some((v) => v.toLowerCase() === value.toLowerCase())) list.push(value);
	return list.join(", ");
}
