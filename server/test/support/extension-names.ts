/**
 * What names one particular extension, and so must never appear in the app (code, comments, tests, docs, built-in
 * skills): its id, its package name, its title, its setting keys and the words of its feature. The app offers generic
 * hooks; an extension fills them with its own meaning. Used by client/tests/extensions-generic.test.ts and
 * server/test/core-neutral.test.ts, which are the only files allowed to name them (besides this one).
 *
 * KNOWN is the extensions repository as last checked, so the guard works where the app is checked out alone (CI). When
 * that repository is checked out beside the app (`extensions/` next to the app folder, or PIPAYA_EXTENSIONS), every
 * extension in it is added, so a new one is covered without touching this file.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

interface Known {
	id: string;
	title?: string;
	/** Setting keys; only the distinctive (camelCase) ones are looked for, see `distinctive`. */
	keys?: string[];
	/** Words of its feature that mean nothing in the app (its roles, its own markup). */
	words?: string[];
}

const KNOWN: Known[] = [
	{
		id: "server-sync",
		title: "Server Sync",
		keys: ["remoteUrl", "shareCode", "followerName", "syncApp", "syncMcpServers", "syncExtensions", "syncLocalExtensions", "syncAgent", "syncProviders", "syncSecrets", "shareSecrets"],
		words: ["follower", "followers", "팔로워", "기준 서버"],
	},
	{ id: "quota-monitor", title: "Quota Monitor", keys: ["pollSeconds"] },
	{ id: "guard", title: "Guard" },
	{ id: "prompt-templates", title: "Prompt Templates" },
	// no longer in the repository: their job is the app's own now (server/src/extensions/retired.ts) or they were dropped
	{ id: "peer-tools", title: "Peer Tools" },
	{ id: "peer-names", title: "Peer Names", words: ["mark-agent", "mark-member", "peerbubble"] },
	{ id: "ask-user", title: "Ask User" },
	{ id: "session-retention", title: "Session Retention" },
	// kept as a single file in ~/.agents/extensions
	{ id: "korean" },
	// Not listed: `voice-input` and `image-generation` were extensions once and are the app's own features now, under
	// the same words (server/src/voice-input.ts). Only the settings page that warns about an old copy names the id.
];

/** Setting keys that are part of a documented SDK contract (the `http-write` permission), not one extension's. */
const CONTRACT_KEYS = new Set(["httpOrigin", "httpToken"]);

/** A one-word key (`role`, `language`) is an ordinary word; only a camelCase key is distinctive enough to look for. */
const distinctive = (key: string) => /^[a-z]+[A-Z]/.test(key) && !CONTRACT_KEYS.has(key);

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Word boundaries only work around ASCII words: `\b` never fires next to Hangul. */
const word = (s: string, flags = "") => new RegExp(/^[\x00-\x7f]+$/.test(s) ? `\\b${escapeRe(s)}\\b` : escapeRe(s), flags);

function readJson(path: string): any {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}

/** Every extension of the repository checked out beside the app, if it is there. */
function fromRepository(appRoot: string): Known[] {
	const root = process.env.PIPAYA_EXTENSIONS ?? join(appRoot, "..", "extensions");
	if (!existsSync(root)) return [];
	const found: Known[] = [];
	for (const dir of readdirSync(root, { withFileTypes: true })) {
		if (!dir.isDirectory()) continue;
		const pkg = readJson(join(root, dir.name, "package.json"));
		const manifest = readJson(join(root, dir.name, "manifest.json"));
		if (!pkg?.pipaya && !manifest?.id) continue;
		const settings = [...(pkg?.pipaya?.settings ?? []), ...(manifest?.settings ?? [])] as { key?: unknown }[];
		found.push({
			id: typeof manifest?.id === "string" ? manifest.id : dir.name,
			title: pkg?.pipaya?.title ?? manifest?.name,
			keys: settings.map((s) => s.key).filter((k): k is string => typeof k === "string"),
		});
	}
	return found;
}

export interface NameRule {
	/** What it names, for the failure message. */
	label: string;
	re: RegExp;
}

/**
 * The rules, built from each id by one pattern, never listed by hand:
 * - an id of two or more words (`server-sync`): with its dashes, case-insensitive (`server-sync`,
 *   `pipaya-extension-server-sync`), or as one camelCase word (`serverSync`, `ServerSync`). Not with underscores: the
 *   app's own built-in tools took over some of these jobs under their own names (`ask_user`);
 * - a one-word id (`guard`) is an ordinary word, so only where it is used as an id: quoted, as a package name or a file
 *   name (`"guard"`, `pipaya-extension-guard`, `/guard.ts`);
 * - its title as written (`Server Sync`): lower case is ordinary prose (the app's own server sync);
 * - its camelCase setting keys and the words of its feature.
 */
export function extensionNameRules(appRoot: string): NameRule[] {
	const rules: NameRule[] = [];
	const seen = new Set<string>();
	const add = (label: string, re: RegExp) => {
		const key = `${re.source}/${re.flags}`;
		if (!seen.has(key)) (seen.add(key), rules.push({ label, re }));
	};
	for (const ext of [...KNOWN, ...fromRepository(appRoot)]) {
		const parts = ext.id.toLowerCase().split(/[-_.]/).filter(Boolean);
		if (parts.length > 1) {
			add(ext.id, new RegExp(`\\b${parts.map(escapeRe).join("-")}\\b`, "i"));
			const camel = parts.map((p, i) => (i === 0 ? p : p[0]!.toUpperCase() + p.slice(1))).join("");
			add(ext.id, new RegExp(`\\b[${camel[0]}${camel[0]!.toUpperCase()}]${escapeRe(camel.slice(1))}\\b`));
		} else {
			add(ext.id, new RegExp(`["'\`]${escapeRe(ext.id)}["'\`]|pipaya-extension-${escapeRe(ext.id)}\\b|/${escapeRe(ext.id)}\\.ts\\b`, "i"));
		}
		if (ext.title) add(ext.id, word(ext.title));
		for (const key of (ext.keys ?? []).filter(distinctive)) add(`${ext.id} setting ${key}`, word(key));
		for (const w of ext.words ?? []) add(`${ext.id} word ${w}`, word(w, "i"));
	}
	return rules;
}

/** The labels of the rules a text breaks. */
export const namesIn = (text: string, rules: NameRule[]): string[] => [...new Set(rules.filter((r) => r.re.test(text)).map((r) => r.label))];
