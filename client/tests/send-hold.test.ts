import { describe, expect, test } from "bun:test";
import { createSendHoldController, parseHoldToQueue, STEER_HOLD_MS } from "../src/lib/send-hold";

interface FakeTimers {
	nextId: number;
	tasks: Map<number, { fn: () => void; ms: number }>;
	setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
	clearTimer: (id: ReturnType<typeof setTimeout> | undefined) => void;
	fireAll: () => void;
}

function makeFakeTimers(): FakeTimers {
	const tasks = new Map<number, { fn: () => void; ms: number }>();
	let nextId = 1;
	return {
		get nextId() {
			return nextId;
		},
		tasks,
		setTimer(fn, ms) {
			const id = nextId++;
			tasks.set(id, { fn, ms });
			return id as unknown as ReturnType<typeof setTimeout>;
		},
		clearTimer(id) {
			if (id !== undefined) tasks.delete(id as unknown as number);
		},
		fireAll() {
			const entries = [...tasks.entries()];
			tasks.clear();
			for (const [, task] of entries) task.fn();
		},
	};
}

describe("parseHoldToQueue", () => {
	test("accepts only strict boolean true and normalizes falsy or malformed values to false", () => {
		expect(parseHoldToQueue(true)).toBe(true);
		expect(parseHoldToQueue(false)).toBe(false);
		expect(parseHoldToQueue(undefined)).toBe(false);
		expect(parseHoldToQueue(null)).toBe(false);
		expect(parseHoldToQueue(0)).toBe(false);
		expect(parseHoldToQueue("")).toBe(false);
		expect(parseHoldToQueue("true")).toBe(false);
		expect(parseHoldToQueue(1)).toBe(false);
		expect(parseHoldToQueue({})).toBe(false);
	});
});

describe("createSendHoldController", () => {
	test("menu mode (holdToQueue=false): tap steers, long-press opens menu and swallows trailing click", () => {
		const timers = makeFakeTimers();
		const events: string[] = [];
		const ctrl = createSendHoldController({
			canHold: () => true,
			holdToQueue: () => false,
			vibrate: () => events.push("vibrate"),
			onOpenMenu: () => events.push("menu"),
			onDirectQueue: () => events.push("queue"),
			onSteer: () => events.push("steer"),
			setTimer: timers.setTimer,
			clearTimer: timers.clearTimer,
		});

		// Short tap: release before threshold
		ctrl.start();
		expect(ctrl.pending).toBe(true);
		expect([...timers.tasks.values()][0]?.ms).toBe(STEER_HOLD_MS);
		ctrl.cancel();
		expect(ctrl.pending).toBe(false);
		let prevented = false;
		expect(ctrl.handleClick(() => { prevented = true; })).toBe(true);
		expect(prevented).toBe(false);
		expect(events).toEqual(["steer"]);

		// Long press: fires menu, swallows trailing click, subsequent tap steers again
		events.length = 0;
		ctrl.start();
		timers.fireAll();
		expect(ctrl.pending).toBe(false);
		expect(events).toEqual(["vibrate", "menu"]);
		ctrl.cancel();
		expect(ctrl.handleClick(() => { prevented = true; })).toBe(false);
		expect(prevented).toBe(true);
		expect(events).toEqual(["vibrate", "menu"]);

		prevented = false;
		expect(ctrl.handleClick(() => { prevented = true; })).toBe(true);
		expect(prevented).toBe(false);
		expect(events).toEqual(["vibrate", "menu", "steer"]);
	});

	test("direct queue mode (holdToQueue=true): long-press queues directly without opening menu and swallows click", () => {
		const timers = makeFakeTimers();
		const events: string[] = [];
		const ctrl = createSendHoldController({
			canHold: () => true,
			holdToQueue: () => true,
			vibrate: () => events.push("vibrate"),
			onOpenMenu: () => events.push("menu"),
			onDirectQueue: () => events.push("queue"),
			onSteer: () => events.push("steer"),
			setTimer: timers.setTimer,
			clearTimer: timers.clearTimer,
		});

		ctrl.start();
		timers.fireAll();
		expect(events).toEqual(["vibrate", "queue"]);
		ctrl.cancel();

		let prevented = false;
		expect(ctrl.handleClick(() => { prevented = true; })).toBe(false);
		expect(prevented).toBe(true);
		expect(events).toEqual(["vibrate", "queue"]);
	});

	test("desktop / disabled / empty input (canHold=false): never schedules hold timer and click still steers", () => {
		const timers = makeFakeTimers();
		const events: string[] = [];
		const ctrl = createSendHoldController({
			canHold: () => false,
			holdToQueue: () => true,
			onOpenMenu: () => events.push("menu"),
			onDirectQueue: () => events.push("queue"),
			onSteer: () => events.push("steer"),
			setTimer: timers.setTimer,
			clearTimer: timers.clearTimer,
		});

		ctrl.start();
		expect(ctrl.pending).toBe(false);
		expect(timers.tasks.size).toBe(0);
		expect(ctrl.handleClick()).toBe(true);
		expect(events).toEqual(["steer"]);
	});

	test("canHold turning false mid-hold prevents firing when timer expires", () => {
		const timers = makeFakeTimers();
		const events: string[] = [];
		let permitted = true;
		const ctrl = createSendHoldController({
			canHold: () => permitted,
			holdToQueue: () => true,
			vibrate: () => events.push("vibrate"),
			onOpenMenu: () => events.push("menu"),
			onDirectQueue: () => events.push("queue"),
			onSteer: () => events.push("steer"),
			setTimer: timers.setTimer,
			clearTimer: timers.clearTimer,
		});

		ctrl.start();
		permitted = false;
		timers.fireAll();
		expect(events).toEqual([]);
		// Because hold did not fire, longPressed stays false
		expect(ctrl.handleClick()).toBe(true);
		expect(events).toEqual(["steer"]);
	});

	test("cancel between a fired hold and pointerup click (e.g. reactive sending=true) still swallows trailing click", () => {
		const timers = makeFakeTimers();
		const events: string[] = [];
		const ctrl = createSendHoldController({
			canHold: () => true,
			holdToQueue: () => true,
			onOpenMenu: () => events.push("menu"),
			onDirectQueue: () => {
				events.push("queue");
				// Mirrors SendControls $effect running hold.cancel() when sending flips true synchronously
				ctrl.cancel();
			},
			onSteer: () => events.push("steer"),
			setTimer: timers.setTimer,
			clearTimer: timers.clearTimer,
		});

		ctrl.start();
		timers.fireAll();
		expect(events).toEqual(["queue"]);
		ctrl.cancel(); // pointerup
		let prevented = false;
		expect(ctrl.handleClick(() => { prevented = true; })).toBe(false);
		expect(prevented).toBe(true);
		expect(events).toEqual(["queue"]);
	});

	test("reset cancels pending hold and clears longPressed state (unmount cleanup)", () => {
		const timers = makeFakeTimers();
		const events: string[] = [];
		const ctrl = createSendHoldController({
			canHold: () => true,
			holdToQueue: () => true,
			onOpenMenu: () => events.push("menu"),
			onDirectQueue: () => events.push("queue"),
			onSteer: () => events.push("steer"),
			setTimer: timers.setTimer,
			clearTimer: timers.clearTimer,
		});

		ctrl.start();
		ctrl.reset();
		expect(ctrl.pending).toBe(false);
		timers.fireAll();
		expect(events).toEqual([]);

		// After hold fires, reset clears longPressed so a fresh click isn't swallowed
		ctrl.start();
		timers.fireAll();
		expect(events).toEqual(["queue"]);
		ctrl.reset();
		expect(ctrl.handleClick()).toBe(true);
		expect(events).toEqual(["queue", "steer"]);
	});

	test("overlapping start calls replace previous timer and fire once", () => {
		const timers = makeFakeTimers();
		const events: string[] = [];
		const ctrl = createSendHoldController({
			canHold: () => true,
			holdToQueue: () => true,
			onOpenMenu: () => events.push("menu"),
			onDirectQueue: () => events.push("queue"),
			onSteer: () => events.push("steer"),
			setTimer: timers.setTimer,
			clearTimer: timers.clearTimer,
		});

		ctrl.start();
		ctrl.start();
		expect(timers.tasks.size).toBe(1);
		timers.fireAll();
		expect(events).toEqual(["queue"]);
	});

	test("callback throwing inside onDirectQueue still marks longPressed and swallows trailing click", () => {
		const timers = makeFakeTimers();
		const events: string[] = [];
		const ctrl = createSendHoldController({
			canHold: () => true,
			holdToQueue: () => true,
			onOpenMenu: () => events.push("menu"),
			onDirectQueue: () => {
				events.push("queue");
				throw new Error("boom");
			},
			onSteer: () => events.push("steer"),
			setTimer: timers.setTimer,
			clearTimer: timers.clearTimer,
		});

		ctrl.start();
		expect(() => timers.fireAll()).toThrow("boom");
		expect(ctrl.pending).toBe(false);
		let prevented = false;
		expect(ctrl.handleClick(() => { prevented = true; })).toBe(false);
		expect(prevented).toBe(true);
		expect(events).toEqual(["queue"]);
	});

	test("dynamic holdToQueue toggle takes effect for the active hold without recreating controller", () => {
		const timers = makeFakeTimers();
		const events: string[] = [];
		let direct = false;
		const ctrl = createSendHoldController({
			canHold: () => true,
			holdToQueue: () => direct,
			onOpenMenu: () => events.push("menu"),
			onDirectQueue: () => events.push("queue"),
			onSteer: () => events.push("steer"),
			setTimer: timers.setTimer,
			clearTimer: timers.clearTimer,
		});

		ctrl.start();
		timers.fireAll();
		ctrl.reset();

		direct = true;
		ctrl.start();
		timers.fireAll();
		expect(events).toEqual(["menu", "queue"]);
	});
});
