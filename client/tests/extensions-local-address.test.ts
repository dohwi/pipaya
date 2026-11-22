import { describe, expect, test } from "bun:test";
import { isLocalUrl } from "../src/lib/extensions/local-address";

const check = (raw: string) => isLocalUrl(new URL(raw));

describe("isLocalUrl", () => {
	test("marks loopback, RFC1918, link-local, Tailscale and local-suffix names as local", () => {
		for (const u of [
			"http://localhost:8787/",
			"http://sub.localhost/",
			"http://127.0.0.1:8317/",
			"http://0x7f000001/",
			"http://2130706433/",
			"http://0.0.0.0/",
			"http://10.0.0.5/",
			"http://172.16.0.1/",
			"http://192.168.1.1/",
			"http://169.254.169.254/latest/meta-data/",
			"http://100.85.51.107:8787/",
			"https://ubuntu.tailb4b2ac.ts.net/",
			"http://nas/",
			"http://printer.local/",
		]) {
			expect(check(u), u).toBe(true);
		}
	});

	test("marks IPv6 loopback, ULA, link-local, IPv4-compatible, IPv4-translated, NAT64 and 6to4 private addresses as local", () => {
		for (const u of [
			"http://[::1]:8787/",
			"http://[::]/",
			"http://[fd7a:115c:a1e0::1]/",
			"http://[fe80::1]/",
			"http://[::ffff:127.0.0.1]/",
			"http://[::ffff:100.85.51.107]/",
			"http://[::127.0.0.1]/",
			"http://[::192.168.1.1]/",
			"http://[::ffff:0:127.0.0.1]/",
			"http://[64:ff9b::10.0.0.1]/",
			"http://[64:ff9b:1::1]/",
			"http://[2002:7f00:1::1]/",
			"http://[2002:c0a8:101::1]/",
			"http://[2001:db8::1]/",
		]) {
			expect(check(u), u).toBe(true);
		}
	});

	test("allows public IPv4, public IPv6 and public NAT64/6to4 destinations", () => {
		for (const u of [
			"https://api.openai.com/v1/models",
			"http://8.8.8.8/",
			"http://100.63.255.255/",
			"http://172.32.0.1/",
			"http://[2606:4700:4700::1111]/",
			"http://[::ffff:8.8.8.8]/",
			"http://[64:ff9b::8.8.8.8]/",
			"http://[2002:0808:0808::1]/",
		]) {
			expect(check(u), u).toBe(false);
		}
	});
});
