/**
 * Which extension packages the user agreed to run on THIS device.
 *
 * The installed list and the on/off choices are shared through the server, so anything that can write them (another
 * device's token, an extension holding `server-api`) could otherwise make every device start code nobody here agreed
 * to; a `ui-components` package runs in the app itself and can read this device's server tokens. So a package only
 * starts by itself when its exact contents were switched on here before. Turning it on by hand is the approval.
 *
 * Kept per device (not per server): the same bytes approved once are the same code wherever they come from.
 */
import { canonical, sha256 } from "./fingerprint";
import type { ExtensionPackage } from "./schema";

export const APPROVALS_KEY = "pipaya.extensions.approved";
/** An id is never approved for more packages than this; the oldest entries make room. */
const MAX_ENTRIES = 200;

const digests = new WeakMap<ExtensionPackage, string>();
/** SHA-256 of the package's canonical JSON, cached per package object (a package with assets can be megabytes). */
export function packageDigest(pkg: ExtensionPackage): string {
	let d = digests.get(pkg);
	if (d === undefined) digests.set(pkg, (d = sha256(canonical(pkg))));
	return d;
}

function read(storage: Storage): Record<string, string> | null {
	try {
		const raw = storage.getItem(APPROVALS_KEY);
		if (raw === null) return null;
		const value: unknown = JSON.parse(raw);
		if (!value || typeof value !== "object" || Array.isArray(value)) return {};
		return Object.fromEntries(Object.entries(value).filter((e): e is [string, string] => typeof e[1] === "string"));
	} catch {
		return {};
	}
}

function write(storage: Storage, map: Record<string, string>) {
	const entries = Object.entries(map);
	try { storage.setItem(APPROVALS_KEY, JSON.stringify(Object.fromEntries(entries.slice(-MAX_ENTRIES)))); } catch { /* storage full: asked again next time */ }
}

export function isApproved(pkg: ExtensionPackage, storage: Storage = localStorage): boolean {
	return read(storage)?.[pkg.manifest.id] === packageDigest(pkg);
}

export function approve(pkg: ExtensionPackage, storage: Storage = localStorage): void {
	const map = read(storage) ?? {};
	const id = pkg.manifest.id;
	delete map[id]; // re-insert last, so trimming drops the oldest
	map[id] = packageDigest(pkg);
	write(storage, map);
}

/**
 * First run of a version that asks: the packages already switched on here were running with this device's consent, so
 * they are recorded once and keep starting. Does nothing once any record exists.
 */
export function seedApprovals(running: readonly ExtensionPackage[], storage: Storage = localStorage): void {
	if (read(storage) !== null) return;
	const map: Record<string, string> = {};
	for (const pkg of running) map[pkg.manifest.id] = packageDigest(pkg);
	write(storage, map);
}
