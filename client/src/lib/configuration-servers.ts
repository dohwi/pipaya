/**
 * How a configuration document (an extension's settings sync, an app backup) changes the saved servers. Pure, so the
 * store only has to save the result and reconnect; tokens never travel in a document and are kept from the servers held.
 */
import { normalizeUrl } from "./api";
import { uid } from "./format";
import type { Server } from "./store-model";

type Entry = { name: string; baseUrl: string };

const sameUrl = (a: Server, b: Entry) => normalizeUrl(a.baseUrl) === b.baseUrl;

/**
 * Merge into `held` in place: a known address takes the document's name, a new one is added without a token. Nothing is
 * removed. In place, because the live connections hold the very server objects they were opened with.
 */
export function mergeServers(held: Server[], incoming: readonly Entry[]): void {
	for (const server of incoming) {
		const existing = held.find((s) => sameUrl(s, server));
		if (existing) existing.name = server.name;
		else held.push({ ...server, id: uid(), token: "" });
	}
}

/** Replace: the document's list wins (in its order); a server already held keeps its id and token. */
export function replaceServers(held: readonly Server[], incoming: readonly Entry[]): Server[] {
	return incoming.map((s) => {
		const old = held.find((x) => sameUrl(x, s));
		return { ...s, id: old?.id ?? uid(), token: old?.token ?? "" };
	});
}
