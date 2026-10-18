/**
 * Pure helpers for "is there a newer client build?". No Tauri, no runes, so they are unit-tested directly.
 *
 * Desktop uses the Tauri updater (signed). Android cannot silently install, so it reads the `latest`
 * release (the only release; it always holds the newest stable build) from the GitHub API and hands the APK link to the system. The release body written by
 * .github/workflows/client-release.yml contains a `Version: X.Y.Z` line, which is what is compared here.
 */
export const REPO = "dohwi/pipaya";
export const RELEASE_API = `https://api.github.com/repos/${REPO}/releases/tags/latest`;
/** The only place an APK link may point to; anything else in the API response is ignored. */
export const DOWNLOAD_PREFIX = `https://github.com/${REPO}/releases/download/latest/`;
export const APK_NAME = "pipaya-android-arm64.apk";

export interface ReleaseInfo {
	version: string;
	apkUrl: string | null;
}

export function parseVersion(value: string): [number, number, number] | null {
	const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value.trim());
	return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** True only when both are valid versions and `latest` is strictly greater. */
export function isNewer(latest: string, current: string): boolean {
	const a = parseVersion(latest);
	const b = parseVersion(current);
	if (!a || !b) return false;
	for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
	return false;
}

/** Reads the GitHub "release by tag" response. Returns null when it does not look like our release. */
export function parseRelease(json: unknown): ReleaseInfo | null {
	if (!json || typeof json !== "object") return null;
	const { body, assets } = json as { body?: unknown; assets?: unknown };
	if (typeof body !== "string") return null;
	const m = /^Version:\s*(\d+\.\d+\.\d+)\s*$/m.exec(body);
	if (!m) return null;
	let apkUrl: string | null = null;
	if (Array.isArray(assets)) {
		for (const a of assets) {
			const url = (a as { browser_download_url?: unknown })?.browser_download_url;
			if ((a as { name?: unknown })?.name === APK_NAME && typeof url === "string" && url.startsWith(DOWNLOAD_PREFIX)) apkUrl = url;
		}
	}
	return { version: m[1], apkUrl };
}

export async function fetchLatestRelease(fetchFn: typeof fetch = fetch, signal?: AbortSignal): Promise<ReleaseInfo> {
	const res = await fetchFn(RELEASE_API, { headers: { Accept: "application/vnd.github+json" }, signal });
	if (!res.ok) throw new Error(`GitHub ${res.status}`);
	const info = parseRelease(await res.json());
	if (!info) throw new Error("Unexpected release format");
	return info;
}
