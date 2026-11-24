import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { verticalFade } from "../src/lib/edge-fade";

// A minimal DOM: the action only touches these members of the node and its host.
type Attrs = Map<string, string>;
function el(): any {
	const attrs: Attrs = new Map();
	const listeners = new Map<string, () => void>();
	return {
		attrs,
		listeners,
		scrollHeight: 0,
		clientHeight: 0,
		scrollTop: 0,
		parentElement: null,
		closest: () => null,
		toggleAttribute(n: string, on: boolean) {
			if (on) attrs.set(n, "");
			else attrs.delete(n);
		},
		removeAttribute: (n: string) => void attrs.delete(n),
		addEventListener: (t: string, f: () => void) => void listeners.set(t, f),
		removeEventListener: (t: string) => void listeners.delete(t),
	};
}

const g = globalThis as any;
let frames: (() => void)[] = [];
let cancelled = 0;
let observers: { disconnected: boolean }[] = [];
const saved = { raf: g.requestAnimationFrame, caf: g.cancelAnimationFrame, ro: g.ResizeObserver, mo: g.MutationObserver };

beforeEach(() => {
	frames = [];
	cancelled = 0;
	observers = [];
	g.requestAnimationFrame = (f: () => void) => frames.push(f);
	g.cancelAnimationFrame = () => void cancelled++;
	class Obs {
		o = { disconnected: false };
		constructor(public cb: () => void) {
			observers.push(this.o);
		}
		observe() {}
		disconnect() {
			this.o.disconnected = true;
		}
	}
	g.ResizeObserver = Obs;
	g.MutationObserver = Obs;
});
afterEach(() => {
	g.requestAnimationFrame = saved.raf;
	g.cancelAnimationFrame = saved.caf;
	g.ResizeObserver = saved.ro;
	g.MutationObserver = saved.mo;
});

function setup(h: { scrollHeight: number; clientHeight: number; scrollTop: number }) {
	const host = el();
	const node = el();
	Object.assign(node, h, { closest: () => host });
	const act = verticalFade(node);
	return { host, node, act };
}
const state = (host: any) => [host.attrs.has("data-fade-top"), host.attrs.has("data-fade-bottom")];

describe("verticalFade", () => {
	test("no overflow: no fades", () => {
		const { host } = setup({ scrollHeight: 100, clientHeight: 100, scrollTop: 0 });
		expect(state(host)).toEqual([false, false]);
	});
	test("overflow of 1px or less counts as none", () => {
		const { host } = setup({ scrollHeight: 101, clientHeight: 100, scrollTop: 0 });
		expect(state(host)).toEqual([false, false]);
	});
	test("overflow at top: only bottom fade", () => {
		const { host } = setup({ scrollHeight: 300, clientHeight: 100, scrollTop: 0 });
		expect(state(host)).toEqual([false, true]);
	});
	test("middle: both fades, updated on scroll", () => {
		const { host, node } = setup({ scrollHeight: 300, clientHeight: 100, scrollTop: 0 });
		node.scrollTop = 100;
		node.listeners.get("scroll")!();
		expect(frames.length).toBe(1);
		node.listeners.get("scroll")!(); // coalesced
		expect(frames.length).toBe(1);
		frames[0]!();
		expect(state(host)).toEqual([true, true]);
	});
	test("bottom (scrollTop = max): only top fade", () => {
		const { host } = setup({ scrollHeight: 300, clientHeight: 100, scrollTop: 200 });
		expect(state(host)).toEqual([true, false]);
	});
	test("clientHeight 0 (hidden): clears fades", () => {
		const { host, node } = setup({ scrollHeight: 300, clientHeight: 100, scrollTop: 100 });
		expect(state(host)).toEqual([true, true]);
		node.clientHeight = 0;
		node.listeners.get("scroll")!();
		frames[0]!();
		expect(state(host)).toEqual([false, false]);
	});
	test("falls back to parentElement when there is no .vfade ancestor", () => {
		const parent = el();
		const node = el();
		Object.assign(node, { scrollHeight: 300, clientHeight: 100, scrollTop: 0, parentElement: parent });
		verticalFade(node);
		expect(parent.attrs.has("data-fade-bottom")).toBe(true);
	});
	test("no host at all does not throw", () => {
		const node = el();
		Object.assign(node, { scrollHeight: 300, clientHeight: 100 });
		expect(() => verticalFade(node).destroy()).not.toThrow();
	});
	test("works without ResizeObserver", () => {
		g.ResizeObserver = undefined;
		const { host } = setup({ scrollHeight: 300, clientHeight: 100, scrollTop: 0 });
		expect(state(host)).toEqual([false, true]);
	});
	test("destroy: cancels rAF, removes listener, disconnects, clears host", () => {
		const { host, node, act } = setup({ scrollHeight: 300, clientHeight: 100, scrollTop: 100 });
		node.listeners.get("scroll")!(); // a frame is pending
		act.destroy();
		expect(cancelled).toBe(1);
		expect(node.listeners.has("scroll")).toBe(false);
		expect(observers.every((o) => o.disconnected)).toBe(true);
		expect(observers.length).toBe(2);
		expect(state(host)).toEqual([false, false]);
	});
});
