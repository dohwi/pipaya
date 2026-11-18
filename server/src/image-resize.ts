import type { ResizedImage, ResizeLimits } from "./image-resize-core.ts";

/** A decode + several encodes of a very large picture; past this the worker is given up on. */
const RESIZE_TIMEOUT_MS = 30_000;
/** An idle worker is let go after this, so its decoder memory is not held between rare bursts of pictures. */
const IDLE_MS = 5 * 60_000;

type Job = { bytes: Uint8Array; limits: Partial<ResizeLimits>; signal?: AbortSignal; resolve: (r: ResizedImage | null) => void };

/**
 * One worker thread, reused for every picture, one picture at a time. A fresh worker per picture leaked: Bun keeps an
 * event loop's timerfd/eventfd/epoll handles after `terminate()`, three file descriptors per worker for the server's life.
 * The worker is only replaced when it fails or hangs, and dropped after a quiet spell.
 */
class ResizePool {
	private worker: Worker | null = null;
	private queue: Job[] = [];
	private running: { job: Job; timer: ReturnType<typeof setTimeout>; onAbort: () => void } | null = null;
	private idle: ReturnType<typeof setTimeout> | undefined;

	run(job: Job): void {
		if (job.signal?.aborted) {
			job.resolve(null);
			return;
		}
		this.queue.push(job);
		// A queued picture that is no longer wanted is dropped before it costs the worker anything.
		job.signal?.addEventListener("abort", () => {
			const i = this.queue.indexOf(job);
			if (i >= 0) { this.queue.splice(i, 1); job.resolve(null); }
		}, { once: true });
		this.next();
	}

	private spawn(): Worker | null {
		if (this.worker) return this.worker;
		try {
			const w = new Worker(new URL("./image-resize-worker.ts", import.meta.url));
			w.unref?.(); // an idle worker must not keep the process alive
			w.onmessage = (e: MessageEvent) => this.settle((e.data?.result as ResizedImage | null) ?? null);
			w.onerror = () => this.fail();
			this.worker = w;
			return w;
		} catch {
			return null;
		}
	}

	private next(): void {
		if (this.running) return;
		const job = this.queue.shift();
		if (!job) {
			clearTimeout(this.idle);
			this.idle = setTimeout(() => this.drop(), IDLE_MS);
			this.idle.unref?.();
			return;
		}
		clearTimeout(this.idle);
		const worker = this.spawn();
		if (!worker) {
			job.resolve(null);
			this.next();
			return;
		}
		// The caller stops waiting at once; the worker finishes the picture (seconds at most) and its answer is ignored.
		const onAbort = () => job.resolve(null);
		job.signal?.addEventListener("abort", onAbort, { once: true });
		const timer = setTimeout(() => this.fail(), RESIZE_TIMEOUT_MS);
		this.running = { job, timer, onAbort };
		// The bytes are copied: the caller may keep using its buffer.
		worker.postMessage({ bytes: job.bytes, limits: job.limits });
	}

	private settle(result: ResizedImage | null): void {
		const r = this.running;
		if (!r) return;
		this.running = null;
		clearTimeout(r.timer);
		r.job.signal?.removeEventListener("abort", r.onAbort);
		r.job.resolve(result); // a no-op when the caller already gave up
		this.next();
	}

	/** The worker crashed or hung: the picture fails and the next one gets a fresh worker. */
	private fail(): void {
		this.drop();
		this.settle(null);
	}

	private drop(): void {
		clearTimeout(this.idle);
		this.worker?.terminate();
		this.worker = null;
	}
}

const pool = new ResizePool();

/**
 * Shrinks a picture to fit `limits` in a worker thread, so a big photo does not stall the server for seconds.
 * Null when the picture cannot be decoded, nothing fits, or the worker fails or times out.
 */
export function resizeImage(bytes: Uint8Array, limits: Partial<ResizeLimits> = {}, signal?: AbortSignal): Promise<ResizedImage | null> {
	return new Promise((resolve) => pool.run({ bytes, limits, signal, resolve }));
}
