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

function parseV6(host: string): number[] | null {
	const zone = host.indexOf("%");
	const clean = (zone >= 0 ? host.slice(0, zone) : host).toLowerCase();
	if (!clean || clean.split("::").length > 2) return null;
	const [leftRaw, rightRaw] = clean.split("::");
	const parseSide = (raw: string | undefined, allowV4Tail: boolean): number[] | null => {
		if (!raw) return [];
		const parts = raw.split(":");
		const words: number[] = [];
		for (let i = 0; i < parts.length; i++) {
			const part = parts[i]!;
			if (allowV4Tail && i === parts.length - 1 && part.includes(".")) {
				const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(part);
				if (!m) return null;
				const octets = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
				if (octets.some((n) => n > 255)) return null;
				words.push((octets[0]! << 8) | octets[1]!, (octets[2]! << 8) | octets[3]!);
			} else {
				if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
				words.push(parseInt(part, 16));
			}
		}
		return words;
	};
	const hasGap = rightRaw !== undefined;
	const left = parseSide(leftRaw, !hasGap);
	const right = hasGap ? parseSide(rightRaw, true) : [];
	if (!left || !right) return null;
	const missing = 8 - (left.length + right.length);
	if (hasGap ? missing < 1 : missing !== 0) return null;
	return [...left, ...Array<number>(missing).fill(0), ...right];
}

function privateV6(host: string): boolean {
	if (host.includes("%")) return true; // scoped zone index always names a local interface
	const w = parseV6(host);
	if (!w) return true; // fail closed on an unrecognised bracketed literal
	const [w0, w1, w2, w3, w4, w5, w6, w7] = w as [number, number, number, number, number, number, number, number];
	const v4In6 = (word: number) => privateV4(word >> 8, word & 0xff);
	// Unspecified (::), loopback (::1) and IPv4-compatible (::a.b.c.d / ::/96)
	if (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0) {
		return (w6 === 0 && (w7 === 0 || w7 === 1)) || v4In6(w6);
	}
	// IPv4-mapped (::ffff:0:0/96) and IPv4-translated (::ffff:0:0:0/96)
	if (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && ((w4 === 0 && w5 === 0xffff) || (w4 === 0xffff && w5 === 0))) {
		return v4In6(w6);
	}
	// NAT64: local-use 64:ff9b:1::/48 is always private; well-known 64:ff9b::/96 carries an IPv4 address in the low 32 bits
	if (w0 === 0x0064 && w1 === 0xff9b) {
		if (w2 === 1) return true;
		if (w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0) return v4In6(w6);
	}
	// 6to4 (2002::/16) embeds an IPv4 address in bits 16..47
	if (w0 === 0x2002) return v4In6(w1);
	// Discard-only (100::/64), benchmarking (2001:2::/48) and documentation (2001:db8::/32)
	if (w0 === 0x0100 && w1 === 0 && w2 === 0 && w3 === 0) return true;
	if (w0 === 0x2001 && ((w1 === 0x0002 && w2 === 0) || w1 === 0x0db8)) return true;
	return (w0 & 0xfe00) === 0xfc00 || // unique local fc00::/7 (includes Tailscale fd7a:115c:a1e0::/48)
		(w0 & 0xffc0) === 0xfe80 || // link-local fe80::/10
		(w0 & 0xff00) === 0xff00; // multicast
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
