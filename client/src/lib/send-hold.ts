/**
 * Long-press state machine for the composer's running-state send (steer) button on touch devices.
 *
 * Tap fires `onSteer`. Holding for `STEER_HOLD_MS` either opens the steer/queue chooser (`holdToQueue = false`)
 * or queues directly (`holdToQueue = true`), and suppresses the trailing click event on lift.
 */
export const STEER_HOLD_MS = 380;

export function parseHoldToQueue(raw: unknown): boolean {
	return raw === true;
}

export interface SendHoldOptions {
	/** Whether a long-press is currently permitted (coarse pointer, running, has input, online, not sending). */
	canHold: () => boolean;
	/** True = long-press queues directly; false = long-press opens the steer/queue menu. */
	holdToQueue: () => boolean;
	onOpenMenu: () => void;
	onDirectQueue: () => void;
	onSteer: () => void;
	vibrate?: () => void;
	holdMs?: number;
	setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
	clearTimer?: (id: ReturnType<typeof setTimeout> | undefined) => void;
}

export interface SendHoldController {
	/** Start waiting for a long-press (call on pointerdown). */
	start(): void;
	/** Cancel any pending hold timer without clearing an already-fired `longPressed` flag (pointerup/leave/cancel). */
	cancel(): void;
	/** Cancel any pending hold timer and clear `longPressed` (mode/input/disabled change or unmount). */
	reset(): void;
	/** Handle button click: swallows the trailing click after a long-press, otherwise runs `onSteer`. Returns true if steer ran. */
	handleClick(preventDefault?: () => void): boolean;
	/** Visible for tests. */
	readonly pending: boolean;
}

export function createSendHoldController(opts: SendHoldOptions): SendHoldController {
	const holdMs = opts.holdMs ?? STEER_HOLD_MS;
	const schedule = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
	const unschedule = opts.clearTimer ?? ((id) => clearTimeout(id));
	let timer: ReturnType<typeof setTimeout> | undefined;
	let longPressed = false;

	function cancel() {
		if (timer !== undefined) {
			unschedule(timer);
			timer = undefined;
		}
	}

	function reset() {
		cancel();
		longPressed = false;
	}

	function start() {
		longPressed = false;
		cancel();
		if (!opts.canHold()) return;
		timer = schedule(() => {
			timer = undefined;
			if (!opts.canHold()) return;
			longPressed = true;
			opts.vibrate?.();
			if (opts.holdToQueue()) {
				opts.onDirectQueue();
			} else {
				opts.onOpenMenu();
			}
		}, holdMs);
	}

	function handleClick(preventDefault?: () => void): boolean {
		if (longPressed) {
			longPressed = false;
			preventDefault?.();
			return false;
		}
		opts.onSteer();
		return true;
	}

	return {
		start,
		cancel,
		reset,
		handleClick,
		get pending() {
			return timer !== undefined;
		},
	};
}
