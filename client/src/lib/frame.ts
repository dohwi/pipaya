/**
 * Layout work shared by many components, batched so a window resize costs one layout pass per frame instead of one
 * per component: every `read` of a frame runs first, then every `write` (no read/write interleaving = no layout thrash).
 */
type Job = () => (() => void) | void;

const jobs = new Map<object, Job>();
let raf = 0;

function flush() {
	raf = 0;
	const batch = [...jobs.values()];
	jobs.clear();
	const writes: Array<() => void> = [];
	for (const job of batch) {
		const w = job();
		if (w) writes.push(w);
	}
	for (const w of writes) w();
}

/** Run `job` in the next frame (once per key per frame). It may return a function that does its DOM writes after all reads. */
export function schedule(key: object, job: Job) {
	jobs.set(key, job);
	if (!raf) raf = requestAnimationFrame(flush);
}

export function unschedule(key: object) {
	jobs.delete(key);
}

/** `<html data-resizing>` while the window is being resized, so heavy paint effects (masks) can pause meanwhile. */
if (typeof window !== "undefined") {
	let timer: ReturnType<typeof setTimeout> | undefined;
	window.addEventListener("resize", () => {
		document.documentElement.dataset.resizing = "";
		clearTimeout(timer);
		timer = setTimeout(() => delete document.documentElement.dataset.resizing, 150);
	});
}
