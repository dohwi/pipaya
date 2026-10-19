import type { ResizedImage, ResizeLimits } from "./image-resize-core.ts";

/** A decode + several encodes of a very large picture; past this the worker is given up on. */
const RESIZE_TIMEOUT_MS = 30_000;

/**
 * Shrinks a picture to fit `limits` in a worker thread, so a big photo does not stall the server for seconds.
 * Null when the picture cannot be decoded, nothing fits, or the worker fails or times out.
 */
export function resizeImage(bytes: Uint8Array, limits: Partial<ResizeLimits> = {}, signal?: AbortSignal): Promise<ResizedImage | null> {
	return new Promise((resolve) => {
		if (signal?.aborted) return resolve(null);
		let worker: Worker;
		try {
			worker = new Worker(new URL("./image-resize-worker.ts", import.meta.url));
		} catch {
			return resolve(null);
		}
		let done = false;
		const finish = (r: ResizedImage | null) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			worker.terminate();
			resolve(r);
		};
		const onAbort = () => finish(null);
		const timer = setTimeout(() => finish(null), RESIZE_TIMEOUT_MS);
		signal?.addEventListener("abort", onAbort, { once: true });
		worker.onmessage = (e: MessageEvent) => finish((e.data?.result as ResizedImage | null) ?? null);
		worker.onerror = () => finish(null);
		// The bytes are copied: the caller may keep using its buffer.
		worker.postMessage({ bytes, limits });
	});
}
