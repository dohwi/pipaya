/** Host of an http(s) image URL, or null for anything that is not safe to offer as a loadable image. */
export function remoteImageHost(href: string): string | null {
	try {
		const u = new URL(href);
		return u.protocol === "http:" || u.protocol === "https:" ? u.host : null;
	} catch {
		return null;
	}
}
