/** Worker side of image-resize.ts: one request in, one reply out. */
import { type ResizeLimits, resizeToFit } from "./image-resize-core.ts";

declare const self: { onmessage: ((e: { data: { bytes: Uint8Array; limits: Partial<ResizeLimits> } }) => void) | null; postMessage(m: unknown): void };

self.onmessage = async (e) => {
	try {
		self.postMessage({ result: await resizeToFit(e.data.bytes, e.data.limits) });
	} catch {
		self.postMessage({ result: null });
	}
};
