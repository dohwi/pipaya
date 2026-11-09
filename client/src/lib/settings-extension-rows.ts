import type { SettingsTabId } from "./settings-search";
import { t } from "./i18n";

/** One extension as the settings sidebar lists it under "확장". */
export type ExtensionRow = {
	id: string;
	name: string;
	live: boolean;
	builtin: boolean;
	update?: boolean;
	/** a server extension whose client half is not installed on this device (or a client one whose server half is missing) */
	half?: boolean;
	halfLabel?: string;
	/** one half of a server + client pair: shown with a clip, and a warning clip when the other half is missing */
	paired?: boolean;
	/** name of the other half of the pair, for the clip tooltip */
	partner?: string;
	/** the last row: the trunk line stops here */
	end?: boolean;
	/** where the clip leads: the other half of the pair (`install`: it is not installed, so open its install preview) */
	link?: { tab: SettingsTabId; id: string | null; install?: string };
};

/** A client extension of the listed server, reduced to what the list needs. */
export type InstalledInfo = { id: string; name: string; live: boolean };
/** An extension running inside the open server. */
export type ServerSideInfo = { name: string; title?: string; companion?: string };

/** What the rows need to know about updates and missing halves (lib/extension-updates). */
export interface UpdateLookup {
	clientIds(): ReadonlySet<string>;
	serverNames: ReadonlySet<string>;
	missingServerFor(clientId: string): { id: string; name: string } | undefined;
	clientName(clientId: string): string | undefined;
}

type Row = Omit<ExtensionRow, "end"> & { companion?: string };

/**
 * The extensions listed under the "확장" section, with server + client pairs kept flat: the client half sits right after
 * its server extension, both marked, and each row says where its other half is.
 *
 * `serverSide` is the listed server's extensions (the caller passes null while that server does not answer);
 * `installed` is that server's client extensions.
 */
export function extensionRows(
	installed: readonly InstalledInfo[],
	serverSide: readonly ServerSideInfo[] | null,
	updates: UpdateLookup,
): ExtensionRow[] {
	const have = (id: string | undefined) => !!id && installed.some((e) => e.id === id);
	const own: Row[] = installed.map((e) => ({
		id: e.id,
		name: e.name,
		live: e.live,
		builtin: false,
		update: updates.clientIds().has(e.id),
		half: !!updates.missingServerFor(e.id),
		halfLabel: t("서버 확장 필요"),
	}));
	const side: Row[] = (serverSide ?? []).map((n) => ({
		id: `srv:${n.name}`,
		companion: n.companion,
		name: n.title ?? n.name,
		live: true,
		builtin: false,
		update: updates.serverNames.has(n.name),
		halfLabel: t("클라이언트 확장 필요"),
		half: !!n.companion && !have(n.companion),
	}));
	const owned = (id: string) => side.some((n) => n.companion === id);
	// the open server's extensions, whichever tab is listed: a client extension on this device is paired with its server half
	const serverNow = serverSide ?? [];
	const rows: Row[] = own
		.filter((e) => !owned(e.id))
		.map((e) => {
			const missing = updates.missingServerFor(e.id);
			const here = serverNow.find((n) => n.companion === e.id);
			return {
				...e,
				paired: !!missing || !!here,
				partner: missing?.name ?? here?.title ?? here?.name,
				link: { tab: "srvext" as SettingsTabId, id: here ? `srv:${here.name}` : null },
			};
		});
	for (const n of side) {
		const mate = own.find((e) => e.id === n.companion);
		const companionName = installed.find((e) => e.id === n.companion)?.name;
		rows.push({
			...n,
			paired: !!n.companion,
			partner: mate?.name ?? companionName ?? (n.companion ? (updates.clientName(n.companion) ?? n.companion) : undefined),
			link: n.companion
				? mate || have(n.companion)
					? { tab: "srvext" as SettingsTabId, id: n.companion }
					: { tab: "srvext" as SettingsTabId, id: null, install: n.companion }
				: undefined,
		});
		if (mate) rows.push({ ...mate, paired: true, partner: n.name, link: { tab: "srvext" as SettingsTabId, id: n.id } });
	}
	return rows.map((e, i) => ({ ...e, end: i === rows.length - 1 }));
}
