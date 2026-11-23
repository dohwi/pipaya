/** Worker side of image-resize.ts: one request in, one reply out. */
import { type PreviewResult, type ResizeLimits, previewToFit, resizeToFit } from "./image-resize-core.ts";

export type WorkerRequest =
	| { kind?: "fit"; bytes: Uint8Array; limits: Partial<ResizeLimits> }
	| { kind: "preview"; bytes: Uint8Array; maxDim: number; jpegQuality?: number };

declare const self: {
	onmessage: ((e: { data: WorkerRequest }) => void) | null;
	postMessage(m: { result: unknown }): void;
};

self.onmessage = async (e) => {
	try {
		const req = e.data;
		if (req.kind === "preview") {
			const result: PreviewResult | null = await previewToFit(req.bytes, req.maxDim, req.jpegQuality);
			self.postMessage({ result });
			return;
		}
		self.postMessage({ result: await resizeToFit(req.bytes, req.limits) });
	} catch {
		self.postMessage({ result: null });
	}
};
