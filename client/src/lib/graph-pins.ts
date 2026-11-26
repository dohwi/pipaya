/**
 * Manual card positions in the graph view (`pipaya.graph.pins`), kept on this device until "다시 배치".
 * Session card keys follow `s:<serverId>/<sessionId>`; closing or deleting a session drops its pin so
 * stale entries do not accumulate and a live GraphView stays in sync.
 */
import { removeDurableSetting, setDurableSetting } from "./durable-storage";

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
		if (Object.keys(pins).length > 0) {
			const json = JSON.stringify(pins);
			localStorage.setItem(GRAPH_PINS_KEY, json);
			void setDurableSetting(GRAPH_PINS_KEY, json);
		} else {
			localStorage.removeItem(GRAPH_PINS_KEY);
			void removeDurableSetting(GRAPH_PINS_KEY);
		}
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

/** Remove all saved graph pins belonging to a deleted server (sessions, server card, and role cards). */
export function forgetServerGraphPins(serverId: string): void {
	if (!serverId) return;
	const sessionPrefix = `s:${serverId}/`;
	const rolePrefix = `r:${serverId}/`;
	const serverCard = `v:${serverId}`;
	const pins = readGraphPins();
	const removed: string[] = [];
	for (const key of Object.keys(pins)) {
		if (key === serverCard || key.startsWith(sessionPrefix) || key.startsWith(rolePrefix)) {
			delete pins[key];
			removed.push(key);
		}
	}
	if (!removed.length) return;
	writeGraphPins(pins);
	for (const key of removed) {
		for (const fn of listeners) fn(key);
	}
}
