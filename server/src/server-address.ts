import { networkInterfaces } from "node:os";
import { isLoopback } from "./auth-throttle.ts";

type Interfaces = ReturnType<typeof networkInterfaces>;

const WILDCARD = new Set(["0.0.0.0", "::", "[::]", ""]);

/**
 * Addresses another device could use to reach a server bound to `host:port`: one `http://<ip>:<port>` per IPv4
 * address of this machine (LAN, VPN) when bound to every interface, the bound address itself when bound to one,
 * nothing when bound to loopback only. Link-local (169.254.x.x) and loopback addresses are left out.
 */
export function reachableUrls(host: string, port: number, interfaces: Interfaces = networkInterfaces()): string[] {
	const h = host.trim().toLowerCase();
	if (h === "localhost" || isLoopback(h)) return [];
	const url = (address: string) => `http://${address.includes(":") ? `[${address}]` : address}:${port}`;
	if (!WILDCARD.has(h)) return [url(h.replace(/^\[|\]$/g, ""))];
	const out: string[] = [];
	for (const list of Object.values(interfaces)) {
		for (const a of list ?? []) {
			if (a.internal || a.family !== "IPv4" || isLoopback(a.address) || a.address.startsWith("169.254.")) continue;
			const u = url(a.address);
			if (!out.includes(u)) out.push(u);
		}
	}
	return out;
}
