/**
 * Whether a URL points into the user's own networks: this machine, the LAN, the tailnet. `network` reaches the internet;
 * these addresses need `network-local` as well, so an extension granted "internet access" cannot quietly talk to a
 * router's admin page, a NAS or the pipaya server itself.
 *
 * Only what the URL says can be checked here: the browser resolves names itself, so a public name that resolves to a
 * private address (DNS rebinding) is not caught. The names below cover the usual private ones.
 */

const LOCAL_SUFFIXES = [".localhost", ".local", ".lan", ".home", ".internal", ".intranet", ".corp", ".home.arpa", ".ts.net"];

function privateV4(a: number, b: number): boolean {
	return a === 0 || a === 10 || a === 127 ||
		(a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT, Tailscale
		(a === 169 && b === 254) || // link-local
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168) ||
		(a === 198 && (b === 18 || b === 19)) || // benchmarking, used by some LAN gear
		a >= 224; // multicast and reserved
}

function v4(host: string): [number, number] | null {
	const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
	return m ? [Number(m[1]), Number(m[2])] : null;
}

function privateV6(host: string): boolean {
	const h = host.toLowerCase();
	if (h === "::" || h === "::1") return true;
	// IPv4-mapped (::ffff:a.b.c.d is normalised by URL to ::ffff:xxxx:xxxx)
	const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
	if (mapped) { const hi = parseInt(mapped[1]!, 16); return privateV4(hi >> 8, hi & 0xff); }
	const dotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(h);
	if (dotted) { const p = v4(dotted[1]!); return !!p && privateV4(...p); }
	const first = parseInt(h.split(":")[0] || "0", 16);
	return (first & 0xfe00) === 0xfc00 || // unique local fc00::/7
		(first & 0xffc0) === 0xfe80 || // link-local fe80::/10
		(first & 0xff00) === 0xff00; // multicast
}

/** `url` must already be a parsed http(s) URL (URL normalises 0x7f.1, 2130706433 and the like to dotted IPv4). */
export function isLocalUrl(url: URL): boolean {
	const host = url.hostname.toLowerCase().replace(/\.$/, "");
	if (host.startsWith("[") && host.endsWith("]")) return privateV6(host.slice(1, -1));
	const p = v4(host);
	if (p) return privateV4(...p);
	if (host === "localhost" || !host.includes(".")) return true; // a bare name is resolved on the LAN
	return LOCAL_SUFFIXES.some(s => host.endsWith(s));
}
