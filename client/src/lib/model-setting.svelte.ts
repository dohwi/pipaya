import { Api, type Connection, errorText } from "./api";

type Snapshot<T> = { settings: T; defaults: T };

/** Bind one settings section to its current server. Responses from an old binding never change the new one. */
export function modelSetting<T>(
	connection: () => Connection | undefined,
	read: (api: Api) => Promise<Snapshot<T>>,
	write: (api: Api, next: T) => Promise<Snapshot<T>>,
	failure: (detail: string) => string,
) {
	let settings = $state.raw<T | null>(null), defaults = $state.raw<T | null>(null);
	let busy = $state(false), error = $state("");
	let current: Api | null = null;
	$effect(() => {
		const conn = connection();
		const api = current = conn ? new Api({ baseUrl: conn.baseUrl, token: conn.token }) : null;
		settings = defaults = null;
		busy = false;
		error = "";
		if (api) void read(api).then((r) => {
			if (api === current) { settings = r.settings; defaults = r.defaults; }
		}).catch(() => { /* an older server may not support this setting */ });
		return () => { current = null; };
	});
	async function save(next: T) {
		const api = current, before = settings;
		if (!api || before === null || busy) return;
		settings = next;
		busy = true;
		error = "";
		try {
			const r = await write(api, next);
			if (api === current) { settings = r.settings; defaults = r.defaults; }
		} catch (e) {
			if (api === current) { settings = before; error = failure(errorText(e)); }
		} finally {
			if (api === current) busy = false;
		}
	}
	return { get settings() { return settings; }, get defaults() { return defaults; }, get busy() { return busy; }, get error() { return error; }, save };
}
