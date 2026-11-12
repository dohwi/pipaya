/**
 * Values a client extension keeps on this device only (secrets, `device` fields) are stored per server: the key typed in
 * for one server is not there when the same extension is installed on another. No server ever holds them, so no server
 * can hand them over. This device can: it finds what it keeps for the same extension under its other saved servers.
 */
import type { SettingField } from "./schema";
import { isDeviceOnlyField } from "./settings-store";

/** Where every server's list is stored on this device (`<key>.<serverId>`), the same key the host and the idle stores use. */
const LIST_KEY = "pipaya.extensions.v1";

export interface DeviceValuesSource {
	serverId: string;
	serverName: string;
	/** The device-only values that server has and this one lacks, by field key */
	values: Record<string, string>;
	/** Their labels, in the order of the fields */
	labels: string[];
}

const empty = (v: unknown) => v === undefined || v === null || v === "";

/**
 * Other saved servers on this device that hold device-only values this extension lacks here. Only fields that are empty
 * here are offered: a value already typed in for this server is never replaced.
 */
export function deviceValuesElsewhere(
	id: string,
	fields: readonly SettingField[] | undefined,
	have: Record<string, unknown>,
	here: string | null,
	servers: readonly { id: string; name: string }[],
	storage: Pick<Storage, "getItem">,
): DeviceValuesSource[] {
	const wanted = (fields ?? []).filter((f) => isDeviceOnlyField(f) && !f.readonly && f.type === "string" && empty(have[f.key]));
	if (!wanted.length) return [];
	const out: DeviceValuesSource[] = [];
	for (const server of servers) {
		if (server.id === here) continue;
		let list: unknown;
		try { list = JSON.parse(storage.getItem(`${LIST_KEY}.${server.id}`) ?? "[]"); } catch { continue; }
		if (!Array.isArray(list)) continue;
		const entry = list.find((e) => e && typeof e === "object" && (e as { package?: { manifest?: { id?: unknown } } }).package?.manifest?.id === id) as { settings?: unknown } | undefined;
		const theirs = entry?.settings && typeof entry.settings === "object" && !Array.isArray(entry.settings) ? (entry.settings as Record<string, unknown>) : null;
		if (!theirs) continue;
		const found = wanted.filter((f) => typeof theirs[f.key] === "string" && theirs[f.key] !== "");
		if (!found.length) continue;
		out.push({
			serverId: server.id,
			serverName: server.name,
			values: Object.fromEntries(found.map((f) => [f.key, theirs[f.key] as string])),
			labels: found.map((f) => f.label),
		});
	}
	return out;
}
