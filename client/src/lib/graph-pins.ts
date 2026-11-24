/**
 * Manual card positions in the graph view (`pipaya.graph.pins`), kept on this device until "다시 배치".
 * Session card keys follow `s:<serverId>/<sessionId>`; closing or deleting a session drops its pin so
 * stale entries do not accumulate and a live GraphView stays in sync.
 */
export const GRAPH_PINS_KEY = "pipaya.graph.pins";

export type GraphPin = { x: number; y: number };
export type GraphPins = Record<string, GraphPin>;

export const graphSessionPinKey = (serverId: string, sessionId: string): string => `s:${serverId}/${sessionId}`;

const listeners = new Set<(key: string) => void>();

export function onGraphPinForgotten(fn: (key: string) => void): () => void {
	listeners.add(fn);
	return () => {
		listeners.delete(fn);
	};
}

export function readGraphPins(): GraphPins {
	try {
		const raw = JSON.parse(localStorage.getItem(GRAPH_PINS_KEY) ?? "{}");
		return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as GraphPins) : {};
	} catch {
		return {};
	}
}

export function writeGraphPins(pins: GraphPins): void {
	try {
		localStorage.setItem(GRAPH_PINS_KEY, JSON.stringify(pins));
	} catch {
		/* private mode: the pins last this visit */
	}
}

/** Remove the saved graph pin for a closed or deleted session (no-op when absent). */
export function forgetGraphPin(serverId: string, sessionId: string): void {
	if (!serverId || !sessionId) return;
	const key = graphSessionPinKey(serverId, sessionId);
	const pins = readGraphPins();
	if (Object.hasOwn(pins, key)) {
		delete pins[key];
		writeGraphPins(pins);
	}
	for (const fn of listeners) fn(key);
}
