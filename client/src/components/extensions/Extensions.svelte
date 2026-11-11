<script lang="ts">
	import { errorText } from "../../lib/api";
	import Button from "../ui/Button.svelte";
	import { LocalizedError, t } from "../../lib/i18n";
	import Icon from "../ui/Icon.svelte";
	import Notice from "../ui/Notice.svelte";
	import VersionBump from "./VersionBump.svelte";
	import SettingRow from "../ui/SettingRow.svelte";
	import Switch from "../ui/Switch.svelte";
	import { download } from "../../lib/download";
	import { tick } from "svelte";
	import { app } from "../../lib/store.svelte";
	import { CONFIG_REQUIRED, extensions } from "../../lib/extensions/host.svelte";
	import { hostSource, storeSource, type ExtensionRow as Installed } from "../../lib/extensions/source";
	import { parsePackage, PackageError, MAX_PACKAGE_BYTES, type ExtensionPackage } from "../../lib/extensions/schema";
	import type { StoredExtensionSettings } from "../../lib/extensions/settings-store";
	import { serverProvides, serverText, serverTitle, srvKey, type ServerExt } from "../../lib/server-extension";
	import Marketplace from "./Marketplace.svelte";
	import { fetchCompanion } from "../../lib/extensions/marketplace";
	import { compareVersions, fetchCatalog, fetchPackage, DEFAULT_MARKETPLACE_URL, type MarketCatalog, type MarketEntry } from "../../lib/extensions/marketplace";
	import { extensionUpdates } from "../../lib/extension-updates.svelte";
	import ImportDialogs from "./ImportDialogs.svelte";
	import InstalledDetail from "./InstalledDetail.svelte";
	import ServerDetail from "./ServerDetail.svelte";
	import ExtensionRow from "./ExtensionRow.svelte";
	import UnreadableCard from "./UnreadableCard.svelte";
	import { ExtensionTasks } from "../../lib/extension-tasks.svelte";
	import { manifestDescription, manifestName } from "../../lib/extensions/translations";

	/** Every extension of one server, whichever kind it is underneath (a package this app runs, or code inside the server): one list, one "확장". */
	let { selected = $bindable(null), marketFor = $bindable(null), installFor = $bindable(null), serverId = null }: { /** The server whose extensions this lists (the one picked in the settings window); the open server when unset */ serverId?: string | null; selected?: string | null; /** A server extension to look up in the marketplace as soon as the tab opens */ marketFor?: string | null; /** A client extension to fetch and preview for install as soon as the tab opens */ installFor?: string | null } = $props();
	let marketQuery = $state("");
	$effect(() => { if (installFor) { const id = installFor; installFor = null; void installCompanion(id); } });
	$effect(() => { if (marketFor) { marketQuery = marketFor; market = true; marketFor = null; } });
	let preview = $state<ExtensionPackage | null>(null);
	/** The connection of the server being listed: the one picked in the settings window, else the open one. */
	const srvApi = $derived((serverId ? app.links[serverId]?.api : null) ?? app.api);
	const serverName = $derived(app.servers.find((s) => s.id === (serverId ?? app.serverId))?.name ?? "");
	/**
	 * Where this pane reads and writes. The open server is the extension host. Any other saved server is its own idle
	 * editor: its list, its connection, its sync, so nothing here can touch the open server.
	 */
	const store = $derived(app.extensionStoreOf(serverId));
	const src = $derived(store ? storeSource(store) : hostSource(extensions));
	/** A server other than the open one whose editor is not ready yet (its list is still being read) */
	const pendingStore = $derived(!!serverId && serverId !== app.serverId && !store);
	// Re-run when the open server changes: the one just left now needs its own editor, the one just opened has the host.
	$effect(() => { void app.serverId; if (serverId) void app.attachExtensionStore(serverId); });
	const rows = $derived((void app.extensionStoreTick, src.list()));
	const list = $derived(rows);
	const unreadable = $derived((void app.extensionStoreTick, src.unreadable()).map((item) => ({ item, index: item.index })));
	let filename = $state("");
	let market = $state(false);
	/** Extensions that run inside the server (installed from the marketplace); read-only here. */
	let serverSide = $state<ServerExt[]>([]);
	/** Saved settings of the server extensions, by settings id (`GET /extensions/settings`). */
	let serverSettings = $state<Record<string, StoredExtensionSettings>>({});
	const openServer = $derived(selected?.startsWith("srv:") ? serverSide.find((e) => srvKey(e.name) === selected) : undefined);
	/** A server extension whose client half is not installed on this server runs only half: say so. */
	const missingClient = (companion?: string) => !!companion && !app.clientExtensionsOf(serverId ?? app.serverId).some((e) => e.id === companion);
	async function loadServerSide() {
		const api = srvApi;
		if (!api) { serverSide = []; return; }
		try { serverSide = (await api.serverExtensions()).extensions; } catch { serverSide = []; }
		try { serverSettings = (await api.extensionSettings()).settings; } catch { /* the forms start from their defaults */ }
	}
	/** Read this server's extensions again; the open server's commands and tools follow only when it is the one listed. */
	const reloadServer = () => Promise.all([loadServerSide(), app.refreshServerExtensions(serverId ?? undefined)]);
	function saveServerSettings(ext: ServerExt, settings: Record<string, unknown>) {
		void run(srvKey(ext.name), async () => {
			const api = srvApi;
			if (!api) throw new LocalizedError(t("서버에 연결되어 있지 않습니다."));
			const saved = await api.saveExtensionSettings(ext.settingsId, settings);
			serverSettings[ext.settingsId] = { value: saved.value, updatedAt: saved.updatedAt };
			tasks.notice = t("설정을 저장했습니다.");
		});
	}
	$effect(() => { void srvApi; void market; void loadServerSide(); });
	/** The catalog, read quietly in the background so updates can be offered without opening the marketplace. */
	let catalog = $state<MarketCatalog | null>(null);
	$effect(() => {
		const ctrl = new AbortController();
		void market;
		fetchCatalog(DEFAULT_MARKETPLACE_URL, ctrl.signal).then((c) => { catalog = c; }).catch(() => { /* offline: no update hints */ });
		return () => ctrl.abort();
	});
	/** Newer catalog entry of an installed extension of this tab, by id. */
	const newerEntry = (id: string, kind: "client" | "server", have?: string): MarketEntry | undefined => {
		const e = catalog?.extensions.find((x) => x.id === id && x.kind === kind);
		return e && have && compareVersions(e.version, have) > 0 ? e : undefined;
	};
	const clientUpdate = (entry: Installed) => newerEntry(entry.package.manifest.id, "client", entry.package.manifest.version);
	const serverUpdate = (ext: ServerExt) => { const e = newerEntry(ext.name, "server", ext.version); return e?.source.type === "git" ? e : undefined; };
	/** Client: download, then the usual preview (permissions) before replacing. Server: reinstall at the catalog's commit. */
	function update(entry: MarketEntry) {
		void run(entry.kind === "server" ? srvKey(entry.id) : entry.id, async () => {
			if (entry.kind === "client") {
				const pkg = await fetchPackage(entry);
				preview = pkg;
				filename = `${entry.id}.json`;
				return;
			}
			const api = srvApi;
			if (!api || entry.source.type !== "git") throw new LocalizedError(t("서버에 연결되어 있지 않습니다."));
			const { repo, dir, ref, commit } = entry.source;
			await api.installServerExtension({ id: entry.id, repo, ...(dir ? { dir } : {}), ref, commit });
			await reloadServer();
			tasks.notice = t("{name}을(를) v{version}(으)로 업데이트했습니다.", { name: entry.name, version: entry.version });
		}, t("업데이트하지 못했습니다"));
	}
	/** Every extension of this tab that has a newer catalog entry. */
	const pending = $derived<MarketEntry[]>([
		...list.map(clientUpdate),
		...serverSide.map(serverUpdate),
	].filter((e): e is MarketEntry => !!e));
	/**
	 * Update everything at once. A client extension whose new version asks for no permission it did not already have is
	 * replaced in place (and restarted if it was running); one that asks for more is left for its own preview, where the
	 * user consents to the new permissions.
	 */
	function updateAll() {
		void run("$all", async () => {
			let done = 0, needsConsent = 0, failed = 0;
			for (const entry of pending) {
				try {
					if (entry.kind === "client") {
						const old = src.find(entry.id);
						const pkg = await fetchPackage(entry);
						if (!old || !pkg.manifest.permissions.every((p) => old.package.manifest.permissions.includes(p))) { needsConsent++; continue; }
						const resume = src.canResume(pkg);
						src.install(pkg);
						if (resume) await src.enable(entry.id);
					} else {
						const api = srvApi;
						if (!api || entry.source.type !== "git") throw new LocalizedError(t("서버에 연결되어 있지 않습니다."));
						const { repo, dir, ref, commit } = entry.source;
						await api.installServerExtension({ id: entry.id, repo, ...(dir ? { dir } : {}), ref, commit });
					}
					done++;
				} catch { failed++; }
			}
			await reloadServer();
			tasks.notice = [
				t("{n}개를 업데이트했습니다.", { n: done }),
				needsConsent ? t("새 권한이 필요한 {n}개는 각각 확인해 주세요.", { n: needsConsent }) : "",
				failed ? t("{n}개는 실패했습니다.", { n: failed }) : "",
			].filter(Boolean).join(" ");
		}, t("업데이트하지 못했습니다"));
	}
	/** A package picked in the marketplace goes through the same preview (permissions) as an imported file. */
	function pickFromMarket(pkg: ExtensionPackage, entry: { id: string }) {
		market = false;
		preview = pkg;
		filename = `${entry.id}.json`;
	}
	/** The client half of a server extension: fetched from the catalog, then through the usual preview. */
	async function installCompanion(id: string) {
		await tasks.run("$import", async () => pickFromMarket(await companionPackage(id), { id }));
	}
	/**
	 * The client half: the copy the server extension carries in its own folder when it has one (same version as the
	 * server half, works without the marketplace), else the catalog's.
	 */
	async function companionPackage(id: string): Promise<ExtensionPackage> {
		const owner = serverSide.find((e) => e.companion === id && e.clientPackage);
		if (owner && srvApi) {
			try { return parsePackage(await srvApi.serverExtensionClient(owner.name)); } catch { /* fall back to the catalog */ }
		}
		return fetchCompanion(id);
	}
	const tasks = new ExtensionTasks();
	let drafts = $state<Record<string, string>>({});
	/** The extension whose detail is open (chosen in the settings sidebar or from a row); null shows the list. */
	/** The server extension that carries the open client extension as its client half. */
	const bundleOwner = $derived(selected ? serverSide.find((e) => e.companion === selected && e.clientPackage) : undefined);
	/** The server extension on the open server that pairs with the open client extension */
	const pairedServer = $derived(selected ? serverSide.find((e) => e.companion === selected) : undefined);
	const openEntry = $derived(selected ? list.find((e) => e.package.manifest.id === selected) : undefined);
	$effect(() => { if (selected && !openEntry && !(selected.startsWith("srv:") && (!serverSide.length || openServer))) selected = null; });
	function closeDetail() {
		const id = selected;
		selected = null;
		tasks.removing = null;
		void tick().then(() => document.getElementById(`extension-${id}`)?.querySelector<HTMLElement>(".expand")?.focus({ preventScroll: false }));
	}
	const replacement = $derived.by(() => {
		const id = preview?.manifest.id;
		return id ? src.find(id) : undefined;
	});
	const willResume = $derived(preview ? src.canResume(preview) : false);
	const run = (key: string, task: () => unknown | Promise<unknown>, failTitle?: string) => tasks.run(key, task, failTitle);

	function selectFile(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		input.value = "";
		if (!file) return;
		void run("$import", async () => {
			preview = null;
			filename = "";
			if (file.size > MAX_PACKAGE_BYTES) throw new LocalizedError(t("패키지는 최대 {n}KB까지 가져올 수 있습니다.", { n: MAX_PACKAGE_BYTES / 1024 }));
			let json: unknown;
			try { json = JSON.parse(await file.text()); } catch { throw new LocalizedError(t("JSON 형식이 아닌 파일입니다.")); }
			let pkg: ExtensionPackage;
			try { pkg = parsePackage(json); } catch (cause) {
				// the validator speaks to the package's author in English: say what is wrong in our words, keep its text as the detail
				if (cause instanceof PackageError) throw new LocalizedError(`${t("확장 패키지 형식이 올바르지 않습니다.")} (${cause.message})`);
				throw cause;
			}
			preview = pkg;
			filename = file.name;
		}, t("파일을 불러오지 못했습니다"));
	}

	function importPackage() {
		void run("$import", async () => {
			if (!preview) throw new LocalizedError(t("먼저 확장 파일을 선택하세요."));
			const pkg = preview;
			const id = pkg.manifest.id;
			if (tasks.busy[id]) throw new LocalizedError(t("이 확장의 작업이 끝난 뒤 가져오세요."));
			const replaced = !!replacement;
			// Same id, was running, and no new permission: swap in place and start it again without a second consent.
			const resume = src.canResume(pkg);
			src.install(pkg);
			delete drafts[id];
			if (tasks.removing === id) tasks.closeRemove();
			preview = null;
			filename = "";
			if (!resume) {
				tasks.result = {
					tone: "ok",
					title: replaced ? t("확장을 교체했습니다") : t("확장을 가져왔습니다"),
					detail: t("아직 실행되지 않았습니다. 설치된 확장 목록에서 권한을 확인한 뒤 활성화하세요."),
					pkg,
					running: false,
					replaced,
				};
				return;
			}
			try {
				await src.enable(id);
				tasks.result = { tone: "ok", title: t("확장을 교체하고 다시 실행했습니다"), detail: t("새 권한이 없어 다시 동의를 받지 않고 바로 실행했습니다."), pkg, running: true, replaced };
			} catch (cause) {
				const why = errorText(cause);
				tasks.result = { tone: "warn", title: t("교체했지만 실행하지 못했습니다"), detail: `${t("비활성 상태로 남아 있습니다.")} ${why}`, pkg, running: false, replaced };
			}
		}, t("확장을 가져오지 못했습니다"));
	}

	function closeResult() {
		tasks.result = null;
	}

	function cancelPreview() {
		if (tasks.busy.$import) return;
		preview = null;
		filename = "";
	}

	/** Close the dialog and bring the imported extension's card into view. */
	function showInstalled() {
		const id = tasks.result?.pkg?.manifest.id;
		tasks.result = null;
		if (!id) return;
		selected = id;
		void tick().then(() => document.getElementById(`extension-${id}`)?.focus({ preventScroll: true }));
	}

	function enable(id: string) {
		void run(id, async () => {
			if (extensions.safeMode) throw new LocalizedError(t("안전 모드를 먼저 해제하세요."));
			await src.enable(id);
		});
	}

	function disable(id: string) {
		void run(id, () => {
			src.disable(id);
		});
	}

	function reload(id: string) {
		void run(id, async () => {
			if (extensions.safeMode || src.find(id)?.state !== "active") throw new LocalizedError(t("활성 상태의 확장만 다시 불러올 수 있습니다."));
			await src.enable(id);
		});
	}

	function saveSettings(id: string, given?: Record<string, unknown>) {
		void run(id, async () => {
			const entry = src.find(id);
			if (!entry) throw new LocalizedError(t("확장을 찾을 수 없습니다"));
			const settings: unknown = given ?? JSON.parse(drafts[id] ?? JSON.stringify(entry.settings));
			if (src.runs) {
				// Local state and the cache update at once; the server copy follows in the background (see syncNotice).
				void src.setSettings(id, settings as Record<string, unknown>);
			} else {
				// Another server: it must take them first, or the next read from it would silently undo the edit.
				await src.setSettings(id, settings as Record<string, unknown>);
			}
			drafts[id] = JSON.stringify(src.find(id)?.settings ?? entry.settings, null, 2);
			if (entry.state === "active" && !extensions.safeMode) {
				await src.enable(id);
				tasks.notice = t("설정을 저장하고 확장을 다시 불러왔습니다.");
			} else {
				tasks.notice = t("설정을 저장했습니다. 다음 활성화 때 적용됩니다.");
			}
		});
	}

	function exportPackage(id: string) {
		void run(id, () => {
			const pkg = src.find(id)?.package;
			if (!pkg) throw new LocalizedError(t("확장을 찾을 수 없습니다"));
			download(pkg, `${pkg.manifest.id}-${pkg.manifest.version}.json`);
		});
	}

	function exportRaw(index: number) {
		void run(`unreadable:${index}`, () => {
			const item = src.unreadable().find((u) => u.index === index);
			if (item) download(item.raw, `${item.id ?? "extension"}-raw.json`);
		});
	}

	const askRemove = (key: string, event: Event) => tasks.askRemove(key, event);
	function cancelRemove() {
		tasks.cancelRemove((back) => void tick().then(() => { if (back?.isConnected) back.focus(); }));
	}

	function remove(id: string, keepSettings: boolean) {
		void run(id, async () => {
			await src.remove(id, { keepSettings });
			delete drafts[id];
			tasks.closeRemove();
			tasks.notice = keepSettings ? t("확장을 삭제했습니다. 설정값은 유지했습니다.") : t("확장과 설정값을 삭제했습니다.");
		});
	}

	function removeServer(ext: ServerExt, keepSettings: boolean) {
		void run(srvKey(ext.name), async () => {
			const api = srvApi;
			if (!api) throw new LocalizedError(t("서버에 연결되어 있지 않습니다."));
			await api.removeServerExtension(ext.name, keepSettings);
			tasks.closeRemove();
			selected = null;
			await reloadServer();
			tasks.notice = keepSettings ? t("확장을 삭제했습니다. 설정값은 유지했습니다.") : t("확장과 설정값을 삭제했습니다.");
		}, t("삭제하지 못했습니다"));
	}

	function removeUnreadable(index: number, keepSettings: boolean) {
		void run(`unreadable:${index}`, async () => {
			await src.removeUnreadable(index, { keepSettings });
			tasks.closeRemove();
			tasks.notice = keepSettings ? t("확장을 삭제했습니다. 설정값은 유지했습니다.") : t("확장과 설정값을 삭제했습니다.");
		});
	}

	function setSafeMode(on: boolean) {
		void run("$safe", () => {
			extensions.setSafeMode(on);
			tasks.notice = on ? t("모든 확장의 실행을 중지했습니다.") : t("안전 모드를 해제했습니다. 각 확장을 직접 활성화하세요.");
		});
	}
</script>

{#snippet updateMeta(have: string, upd: MarketEntry)}
	<VersionBump from={have} to={upd.version} />
{/snippet}

{#snippet updateButton(upd: MarketEntry, disabled: boolean)}
	<Button size="sm" variant="update" {disabled} aria-label={t("v{version}으로 업데이트", { version: upd.version })} onclick={() => update(upd)}>{t("업데이트")}</Button>
{/snippet}

{#snippet needLine(text: string, disabled: boolean, onclick: () => void)}
	<div class="needline">
		<Icon name="alert" />
		<span class="need-text">{text}</span>
		<Button size="sm" {disabled} {onclick}>{t("설치")}</Button>
	</div>
{/snippet}

{#snippet companionLine(id: string, disabled: boolean)}
	{@render needLine(t("‘{name}’ 확장 필요", { name: extensionUpdates.clientName(id) ?? id }), disabled, () => installCompanion(id))}
{/snippet}

{#snippet installedRow(entry: Installed)}
	{@const id = entry.package.manifest.id}
	{@const fields = entry.package.manifest.settings}
	{@const gated = !!fields && src.configRequired(id)}
	{@const on = src.runs ? entry.state === "active" || entry.state === "starting" : entry.enabled}
	{@const problem = on ? "" : gated ? t(CONFIG_REQUIRED) : src.settingsProblem(id)}
	{@const upd = clientUpdate(entry)}
	{@const needServer = extensionUpdates.missingServerFor(id, serverId ?? app.serverId)}
	<ExtensionRow id="extension-{id}" name={manifestName(entry.package.manifest)} brief={manifestDescription(entry.package.manifest)} busy={tasks.busy[id] || entry.state === "starting"} dim={!!needServer} onopen={() => (selected = id)}>
		{#snippet meta()}{#if upd}{@render updateMeta(entry.package.manifest.version, upd)}{/if}<span class="facts">{#if !upd}v{entry.package.manifest.version}{/if}{#if entry.state === "starting"} · {t("시작 중")}{:else if entry.state === "error"} · {t("오류")}{/if}</span>{#if needServer}<span class="chip warn">{t("동작 안 함")}</span>{/if}{/snippet}
		{#snippet control()}
			{#if upd}{@render updateButton(upd, !!tasks.busy[id] || !!tasks.busy.$import || !!tasks.busy.$all)}{/if}
			<Switch
				checked={on}
				label={t("{name} 사용", { name: manifestName(entry.package.manifest) })}
				disabled={tasks.busy[id] || entry.state === "starting" || (!on && (extensions.safeMode || !!problem))}
				describedby={problem ? `extension-blocked-${id}` : undefined}
				onchange={(next) => (next ? enable(id) : disable(id))}
			/>
		{/snippet}
		{#snippet notices()}
			{#if entry.error}<Notice tone="danger" size="sm" animated role="status">{entry.error}</Notice>{/if}
			{#if problem}<Notice tone="warn" size="sm" animated id="extension-blocked-{id}">{t("켤 수 없습니다.")} {problem}</Notice>{/if}
		{/snippet}
	</ExtensionRow>
{/snippet}

<div class="extensions">
	<div class="feedback" aria-live="polite" aria-atomic="true">
		{#if tasks.error}<Notice tone="danger" size="sm" animated>{tasks.error}</Notice>{/if}
		{#if tasks.notice}<Notice tone="ok" size="sm" animated>{tasks.notice}</Notice>{/if}
	</div>
	{#if src.runs && extensions.syncNotice}<Notice tone="warn" size="sm" animated role="status">{extensions.syncNotice}</Notice>{/if}
	{#if src.loadError()}<Notice tone="danger" size="sm" animated role="status">{src.loadError()}</Notice>{/if}
	{#if pendingStore}<p class="hint" role="status">{t("목록을 불러오는 중…")}</p>{/if}

	{#if openEntry}
		{@const id = openEntry.package.manifest.id}
		<InstalledDetail
			entry={openEntry}
			{src}
			{tasks}
			{drafts}
			upgrade={(() => { const u = clientUpdate(openEntry); return u ? { version: u.version, disabled: !!tasks.busy[id] || !!tasks.busy.$import || !!tasks.busy.$all, onclick: () => update(u) } : undefined; })()}
			pairedServer={pairedServer ? serverTitle(pairedServer) : undefined}
			bundledBy={bundleOwner ? serverTitle(bundleOwner) : undefined}
			needsServer={extensionUpdates.missingServerFor(id, serverId ?? app.serverId)}
			onopenserver={pairedServer ? () => (selected = srvKey(pairedServer.name)) : undefined}
			onback={closeDetail}
			onenable={() => enable(id)}
			ondisable={() => disable(id)}
			onsave={(settings) => saveSettings(id, settings)}
			onreload={() => reload(id)}
			onexport={() => exportPackage(id)}
			onaskremove={(event) => askRemove(id, event)}
			oncancelremove={cancelRemove}
			onremove={(keepSettings) => remove(id, keepSettings)}
			onsettingslocal={(local) => src.setSettingsLocal(id, local)}
		/>
	{:else if openServer}
		<ServerDetail
			ext={openServer}
			{serverId}
			settings={serverSettings[openServer.settingsId]?.value}
			busy={!!tasks.busy[srvKey(openServer.name)]}
			upgrade={(() => { const u = serverUpdate(openServer); return u ? { version: u.version, disabled: !!tasks.busy[srvKey(openServer.name)] || !!tasks.busy.$all, onclick: () => update(u) } : undefined; })()}
			onback={() => (selected = null)}
			onsave={(settings) => saveServerSettings(openServer, settings)}
			oninstallclient={installCompanion}
			onopenclient={(id) => (selected = id)}
			onenableclient={enable}
			removing={tasks.removing === srvKey(openServer.name)}
			onaskremove={(event) => askRemove(srvKey(openServer.name), event)}
			oncancelremove={cancelRemove}
			onremove={(keepSettings) => removeServer(openServer, keepSettings)}
		/>
	{:else}
	<section aria-labelledby="extensions-installed">
		<div class="bar">
			<h3 id="extensions-installed" class="section-label bar-title">{t("설치된 확장 ({n})", { n: list.length + unreadable.length + serverSide.length })}</h3>
			<Button size="sm" class="add" disabled={tasks.busy.$import} onclick={() => (market = true)}><Icon name="search" /> {t("마켓플레이스")}</Button>
			<label class="btn sm add" class:disabled={tasks.busy.$import}>
				<input type="file" accept="application/json,.json" disabled={tasks.busy.$import} onchange={selectFile} />
				<Icon name="plus" /> {t("확장 추가")}
			</label>
			{#if pending.length > 1}<Button size="sm" variant="update" class="add" disabled={!!tasks.busy.$all || tasks.busy.$import} onclick={updateAll}><Icon name="download" /> {tasks.busy.$all ? t("업데이트하는 중…") : t("모두 업데이트 ({n})", { n: pending.length })}</Button>{/if}
		</div>
		{#if tasks.busy.$import}<p class="hint" role="status">{t("파일을 읽는 중…")}</p>{/if}
		{#if extensions.safeMode}
			<Notice tone="warn" size="sm" icon="shield" role="status">{t("안전 모드라서 모든 확장이 멈춰 있습니다. 아래 “문제 해결”에서 해제할 수 있습니다.")}</Notice>
		{/if}
		{#if unreadable.length}
			<Notice tone="warn" size="sm" role="status">{t("이 버전에서 읽을 수 없는 확장 {n}개가 있습니다. 원본은 지우지 않고 그대로 보관합니다.", { n: unreadable.length })}</Notice>
		{/if}
		<p class="hint">{t("{name}에 설치되어 접속한 모든 기기가 함께 씁니다.", { name: serverName })}</p>
		{#each list as entry (entry.package.manifest.id)}
			{@render installedRow(entry)}
		{/each}
		{#each unreadable as { item, index } (index)}
			<UnreadableCard
				{item}
				{index}
				{tasks}
				onexport={() => exportRaw(index)}
				onaskremove={(event) => askRemove(`unreadable:${index}`, event)}
				oncancelremove={cancelRemove}
				onremove={(keepSettings) => removeUnreadable(index, keepSettings)}
			/>
		{/each}
		{#each serverSide as ext (ext.name)}
				{@const upd = serverUpdate(ext)}
				{@const half = missingClient(ext.companion)}
				<ExtensionRow name={serverTitle(ext)} brief={ext.error || serverText(ext) || serverProvides(ext).join(", ")} busy={!!tasks.busy[srvKey(ext.name)]} dim={half} onopen={() => (selected = srvKey(ext.name))}>
					{#snippet notices()}
						{#if half}{@render companionLine(ext.companion ?? "", !!tasks.busy.$import)}{/if}
					{/snippet}
					{#snippet control()}{#if upd}{@render updateButton(upd, !!tasks.busy[srvKey(ext.name)] || !!tasks.busy.$all)}{/if}{/snippet}
					{#snippet meta()}
						{#if upd && ext.version}{@render updateMeta(ext.version, upd)}{:else if ext.version}<span class="facts">v{ext.version}</span>{/if}
						{#if half}<span class="chip warn">{t("동작 안 함")}</span>{/if}
					{/snippet}
				</ExtensionRow>
		{/each}
		{#if !list.length && !unreadable.length && !serverSide.length}
			<p class="none">{t("이 서버에 설치된 확장이 없습니다")}</p>
		{/if}
	</section>

	<!-- The same settings group as the other panes: a heading, a SettingRow and a hint line. Not folded: the switch is the way back when an extension misbehaves. -->
	<section class="set-group trouble" aria-labelledby="extensions-trouble">
		<h3 id="extensions-trouble" class="section-label">{t("문제 해결")}</h3>
		<SettingRow label={t("안전 모드")} hint={t("모든 확장의 실행을 멈춥니다. 꺼도 확장이 저절로 다시 켜지지 않습니다.")}>
			<Switch checked={extensions.safeMode} label={t("안전 모드")} disabled={tasks.busy.$safe} onchange={setSafeMode} />
		</SettingRow>
		<p class="hint">{t("이 화면까지 오지 못하면 주소 끝에")} <code>?extensions=off</code>{t("를 붙여 여세요.")}</p>
	</section>
	{/if}
</div>

{#if market}
	<Marketplace api={srvApi} {serverId} {src} onchanged={async () => { await reloadServer(); }} initialQuery={marketQuery} onclose={() => (market = false)} onpick={pickFromMarket} />
{/if}

<ImportDialogs {preview} result={tasks.result} {replacement} {willResume} {filename} {serverName} busy={tasks.busy} oncancel={cancelPreview} onimport={importPackage} onclose={closeResult} onshow={showInstalled} />

<style>
	.extensions,
	section { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
	.extensions { gap: 24px; color: var(--text); font-size: var(--fs-md); line-height: 1.5; }
	.feedback { display: flex; flex-direction: column; gap: 8px; }
	/* The live region stays mounted, but while it holds no element (only Svelte's {#if} anchor comments, so :empty never matches) it must not take a flex gap */
	.feedback:not(:has(*)) { position: absolute; }
	h3,
	p { margin: 0; }
	.hint { overflow-wrap: anywhere; }
	/* Same pattern as the app and server update rows: amber status chip, then the primary action on the right */
	.extensions :global(.btn.update) { flex: none; }
	/* a missing half: the same amber bar as the notices above, with the action on the right */
	.needline { display: flex; align-items: center; gap: 8px; padding: 8px 8px 8px 12px; border-radius: var(--radius-sm); background: var(--warn-soft); color: var(--warn); font-size: var(--fs-xs); line-height: 1.5; }
	.needline :global(svg) { flex: none; width: 16px; height: 16px; stroke-width: 1.8; }
	.need-text { flex: 1; min-width: 0; overflow-wrap: anywhere; word-break: keep-all; }
	.needline :global(.btn) { flex: none; }


	.extensions :global(.btn.sm) { height: auto; min-height: var(--control-h-sm); padding: 4px 12px; white-space: normal; }

	.bar { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
	.bar-title { margin-right: auto; }
	.extensions .bar > :global(.add) { position: relative; display: inline-flex; align-items: center; gap: 4px; cursor: pointer; }
	.extensions .bar > :global(.add.disabled) { opacity: 0.5; cursor: default; }
	.extensions .bar > :global(.add input) { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; cursor: inherit; }
	.extensions .bar > :global(.add svg) { width: 16px; height: 16px; }
	.trouble { display: flex; flex-direction: column; gap: 8px; }
	/* the recovery query is typed by hand: mono, on one line, never split at "?" */
	.trouble code { font-family: var(--mono); font-size: var(--fs-xs); color: var(--text-dim); white-space: nowrap; }

	.none {
		margin: 4px 0 4px;
		padding: 12px;
		border: 1px dashed var(--border);
		border-radius: var(--radius);
		color: var(--text-faint);
		font-size: var(--fs-sm);
		text-align: center;
	}

</style>
