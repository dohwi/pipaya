<script lang="ts">
	import Button from "./Button.svelte";
	import { LocalizedError, t } from "../lib/i18n";
	import Icon from "./Icon.svelte";
	import Notice from "./Notice.svelte";
	import Accordion from "./Accordion.svelte";
	import Switch from "./Switch.svelte";
	import { download } from "../lib/download";
	import { tick } from "svelte";
	import { app } from "../lib/store.svelte";
		import { CONFIG_REQUIRED, extensions, type ExtensionScope, type InstalledExtension } from "../lib/extensions/host.svelte";
	import { parsePackage, MAX_PACKAGE_BYTES, type ExtensionPackage } from "../lib/extensions/schema";
	import { serverProvides, srvKey, type ServerExt } from "../lib/server-extension";
	import Marketplace from "./extensions/Marketplace.svelte";
	import { fetchCompanion } from "../lib/extensions/marketplace";
	import { compareVersions, fetchCatalog, fetchPackage, savedMarketplaceUrl, type MarketCatalog, type MarketEntry } from "../lib/extensions/marketplace";
	import ImportDialogs from "./extensions/ImportDialogs.svelte";
	import InstalledDetail from "./extensions/InstalledDetail.svelte";
	import ServerDetail from "./extensions/ServerDetail.svelte";
	import ExtensionRow from "./extensions/ExtensionRow.svelte";
	import UnreadableCard from "./extensions/UnreadableCard.svelte";
	import { ExtensionTasks } from "../lib/extension-tasks.svelte";

	/** "server": the open server's extensions (a server tab). "device": this device's (the common tab). */
	let { scope: view, selected = $bindable(null) }: { scope: ExtensionScope; selected?: string | null } = $props();
	let preview = $state<ExtensionPackage | null>(null);
	/** Where the package being imported will be installed: the scope of the tab it is imported from. */
	const target = $derived(view);
	const serverName = $derived(app.servers.find((s) => s.id === app.serverId)?.name ?? "");
	const list = $derived(extensions.installed.filter((e) => e.scope === view));
	const indexed = $derived(extensions.unreadable.map((item, index) => ({ item, index })));
	const unreadable = $derived(indexed.filter(({ item }) => (item.scope ?? "server") === view));
	let filename = $state("");
	let market = $state(false);
	/** Extensions that run inside the server (installed from the marketplace); read-only here. */
	let serverSide = $state<ServerExt[]>([]);
	/** Saved settings of the server extensions, by settings id (`GET /extensions/settings`). */
	let serverSettings = $state<Record<string, Record<string, unknown>>>({});
	const openServer = $derived(selected?.startsWith("srv:") ? serverSide.find((e) => srvKey(e.name) === selected) : undefined);
	/** A server extension that needs a client extension this device does not have runs only half: say so. */
	const missingClient = (companion?: string) => !!companion && !extensions.installed.some((e) => e.package.manifest.id === companion);
	async function loadServerSide() {
		const api = app.api;
		if (!api || view !== "server") { serverSide = []; return; }
		try { serverSide = (await api.serverExtensions()).extensions; } catch { serverSide = []; }
		try { serverSettings = (await api.extensionSettings()).settings; } catch { /* the forms start from their defaults */ }
	}
	function saveServerSettings(ext: ServerExt, settings: Record<string, unknown>) {
		void run(srvKey(ext.name), async () => {
			const api = app.api;
			if (!api) throw new LocalizedError(t("서버에 연결되어 있지 않습니다."));
			serverSettings[ext.settingsId] = (await api.saveExtensionSettings(ext.settingsId, settings)).settings;
			tasks.notice = t("설정을 저장했습니다.");
		});
	}
	$effect(() => { void app.api; void market; void loadServerSide(); });
	/** The catalog, read quietly in the background so updates can be offered without opening the marketplace. */
	let catalog = $state<MarketCatalog | null>(null);
	$effect(() => {
		const ctrl = new AbortController();
		void market;
		fetchCatalog(savedMarketplaceUrl(), ctrl.signal).then((c) => { catalog = c; }).catch(() => { /* offline: no update hints */ });
		return () => ctrl.abort();
	});
	/** Newer catalog entry of an installed extension of this tab, by id. */
	const newerEntry = (id: string, kind: "client" | "server", have?: string): MarketEntry | undefined => {
		const e = catalog?.extensions.find((x) => x.id === id && x.kind === kind);
		return e && have && compareVersions(e.version, have) > 0 ? e : undefined;
	};
	const clientUpdate = (entry: InstalledExtension) => newerEntry(entry.package.manifest.id, "client", entry.package.manifest.version);
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
			const api = app.api;
			if (!api || entry.source.type !== "git") throw new LocalizedError(t("서버에 연결되어 있지 않습니다."));
			const { repo, dir, ref, commit } = entry.source;
			await api.installServerExtension({ id: entry.id, repo, ...(dir ? { dir } : {}), ref, commit });
			await Promise.all([loadServerSide(), app.refreshServerExtensions()]);
			tasks.notice = t("{name}을(를) v{version}(으)로 업데이트했습니다.", { name: entry.name, version: entry.version });
		}, t("업데이트하지 못했습니다"));
	}
	/** A package picked in the marketplace goes through the same preview (permissions, scope) as an imported file. */
	function pickFromMarket(pkg: ExtensionPackage, entry: { id: string }) {
		market = false;
		preview = pkg;
		filename = `${entry.id}.json`;
	}
	/** The client half of a server extension: fetched from the catalog, then through the usual preview. */
	async function installCompanion(id: string) {
		await tasks.run("$import", async () => pickFromMarket(await fetchCompanion(id), { id }));
	}
	const tasks = new ExtensionTasks();
	let drafts = $state<Record<string, string>>({});
	/** The extension whose detail is open (chosen in the settings sidebar or from a row); null shows the list. */
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
		return id ? extensions.installed.find((entry) => entry.package.manifest.id === id) : undefined;
	});
	const willResume = $derived(preview ? extensions.canResume(preview) : false);
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
			const pkg = parsePackage(JSON.parse(await file.text()));
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
			const resume = extensions.canResume(pkg);
			extensions.install(pkg, replacement?.scope ?? target);
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
				await extensions.enable(id);
				tasks.result = { tone: "ok", title: t("확장을 교체하고 다시 실행했습니다"), detail: t("새 권한이 없어 다시 동의를 받지 않고 바로 실행했습니다."), pkg, running: true, replaced };
			} catch (cause) {
				const why = cause instanceof Error ? cause.message : String(cause);
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
			await extensions.enable(id);
		});
	}

	function disable(id: string) {
		void run(id, () => {
			extensions.disable(id);
		});
	}

	function reload(id: string) {
		void run(id, async () => {
			if (extensions.safeMode || extensions.find(id).state !== "active") throw new LocalizedError(t("활성 상태의 확장만 다시 불러올 수 있습니다."));
			await extensions.enable(id);
		});
	}

	function saveSettings(id: string, given?: Record<string, unknown>) {
		void run(id, async () => {
			const entry = extensions.find(id);
			const settings: unknown = given ?? JSON.parse(drafts[id] ?? JSON.stringify(entry.settings));
			// Local state and the cache update at once; the server copy follows in the background (see syncNotice).
			void extensions.setSettings(id, settings);
			drafts[id] = JSON.stringify(entry.settings, null, 2);
			if (entry.state === "active" && !extensions.safeMode) {
				await extensions.enable(id);
				tasks.notice = t("설정을 저장하고 확장을 다시 불러왔습니다.");
			} else {
				tasks.notice = t("설정을 저장했습니다. 다음 활성화 때 적용됩니다.");
			}
		});
	}

	function exportPackage(id: string) {
		void run(id, () => {
			const pkg = extensions.find(id).package;
			download(pkg, `${pkg.manifest.id}-${pkg.manifest.version}.json`);
		});
	}

	function exportRaw(index: number) {
		void run(`unreadable:${index}`, () => {
			const item = extensions.unreadable[index];
			if (item) download(item.raw, `${item.id ?? "extension"}-raw.json`);
		});
	}

	const askRemove = (key: string, event: Event) => tasks.askRemove(key, event);
	function cancelRemove() {
		tasks.cancelRemove((back) => void tick().then(() => { if (back?.isConnected) back.focus(); }));
	}

	function remove(id: string, keepSettings: boolean) {
		void run(id, () => {
			extensions.remove(id, { keepSettings });
			delete drafts[id];
			tasks.closeRemove();
			tasks.notice = keepSettings ? t("확장을 삭제했습니다. 설정값은 유지했습니다.") : t("확장과 설정값을 삭제했습니다.");
		});
	}

	function removeUnreadable(index: number, keepSettings: boolean) {
		void run(`unreadable:${index}`, () => {
			extensions.removeUnreadable(index, { keepSettings });
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

{#snippet updateLine(have: string, upd: MarketEntry, disabled: boolean)}
	<div class="updline">
		<Icon name="download" />
		<span class="to"><b>{t("새 버전이 있습니다")}</b> <span class="vers">v{have} → v{upd.version}</span></span>
		<Button variant="primary" size="sm" class="upd-btn" {disabled} aria-label={t("v{version}으로 업데이트", { version: upd.version })} onclick={() => update(upd)}>{t("업데이트")}</Button>
	</div>
{/snippet}

{#snippet companionLine(id: string, disabled: boolean)}
	<div class="updline warnline">
		<Icon name="alert" />
		<span class="to"><b>{t("클라이언트 확장 ‘{id}’ 필요", { id })}</b></span>
		<Button variant="primary" size="sm" class="upd-btn" {disabled} onclick={() => installCompanion(id)}>{t("설치")}</Button>
	</div>
{/snippet}

{#snippet installedRow(entry: InstalledExtension)}
	{@const id = entry.package.manifest.id}
	{@const fields = entry.package.manifest.settings}
	{@const gated = !!fields && extensions.configRequired(id)}
	{@const on = entry.state === "active" || entry.state === "starting"}
	{@const problem = on ? "" : gated ? t(CONFIG_REQUIRED) : extensions.settingsProblem(id)}
	{@const upd = clientUpdate(entry)}
	<ExtensionRow id="extension-{id}" name={entry.package.manifest.name} brief={entry.package.manifest.description} busy={tasks.busy[id] || entry.state === "starting"} onopen={() => (selected = id)}>
		{#snippet meta()}<span class="meta">v{entry.package.manifest.version}{#if entry.state === "starting"} · {t("시작 중")}{:else if entry.state === "error"} · {t("오류")}{/if}</span>{/snippet}
		{#snippet control()}
			<Switch
				checked={on}
				label={t("{name} 사용", { name: entry.package.manifest.name })}
				disabled={tasks.busy[id] || entry.state === "starting" || (!on && (extensions.safeMode || !!problem))}
				describedby={problem ? `extension-blocked-${id}` : undefined}
				onchange={(next) => (next ? enable(id) : disable(id))}
			/>
		{/snippet}
		{#snippet notices()}
			{#if upd}{@render updateLine(entry.package.manifest.version, upd, !!tasks.busy[id] || !!tasks.busy.$import)}{/if}
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
	{#if extensions.syncNotice}<Notice tone="warn" size="sm" animated role="status">{extensions.syncNotice}</Notice>{/if}
	{#if extensions.loadError}<Notice tone="danger" size="sm" animated role="status">{extensions.loadError}</Notice>{/if}

	{#if openEntry}
		{@const id = openEntry.package.manifest.id}
		<InstalledDetail
			entry={openEntry}
			{tasks}
			{drafts}
			onback={closeDetail}
			onenable={() => enable(id)}
			ondisable={() => disable(id)}
			onsave={(settings) => saveSettings(id, settings)}
			onreload={() => reload(id)}
			onexport={() => exportPackage(id)}
			onaskremove={(event) => askRemove(id, event)}
			oncancelremove={cancelRemove}
			onremove={(keepSettings) => remove(id, keepSettings)}
		/>
	{:else if openServer}
		<ServerDetail
			ext={openServer}
			settings={serverSettings[openServer.settingsId]}
			busy={!!tasks.busy[srvKey(openServer.name)]}
			onback={() => (selected = null)}
			onsave={(settings) => saveServerSettings(openServer, settings)}
			oninstallclient={installCompanion}
		/>
	{:else}
	<section aria-labelledby="extensions-installed">
		<div class="bar">
			<h3 id="extensions-installed" class="label bar-title">{t("설치된 확장 ({n})", { n: list.length + unreadable.length + (view === "server" ? serverSide.length : 0) })}</h3>
			<Button size="sm" class="add" disabled={tasks.busy.$import} onclick={() => (market = true)}><Icon name="search" /> {t("마켓플레이스")}</Button>
			<label class="btn sm add" class:disabled={tasks.busy.$import}>
				<input type="file" accept="application/json,.json" disabled={tasks.busy.$import} onchange={selectFile} />
				<Icon name="plus" /> {t("확장 추가")}
			</label>
		</div>
		{#if tasks.busy.$import}<p class="hint" role="status">{t("파일을 읽는 중…")}</p>{/if}
		{#if extensions.safeMode}
			<Notice tone="warn" size="sm" icon="shield" role="status">{t("안전 모드라서 모든 확장이 멈춰 있습니다. 아래 “고급”에서 해제할 수 있습니다.")}</Notice>
		{/if}
		{#if unreadable.length}
			<Notice tone="warn" size="sm" role="status">{t("이 버전에서 읽을 수 없는 확장 {n}개가 있습니다. 원본은 지우지 않고 그대로 보관합니다.", { n: unreadable.length })}</Notice>
		{/if}
		{#if view === "server"}
			<p class="hint">{t("{name}에 설치되어 이 서버에 접속한 모든 기기가 함께 씁니다. 켜고 끄는 상태도 서버에 저장되어 모든 기기가 따라갑니다.", { name: serverName })}</p>
		{:else}
			<p class="hint">{t("이 기기에만 설치되며 어느 서버에 연결해도 그대로 남습니다. 서버로 올라가지 않습니다.")}</p>
		{/if}
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
		{#if view === "server"}
			{#each serverSide as ext (ext.name)}
				{@const upd = serverUpdate(ext)}
				{@const half = missingClient(ext.companion)}
				<ExtensionRow name={ext.title ?? ext.name} brief={ext.error || serverProvides(ext).join(", ")} busy={!!tasks.busy[srvKey(ext.name)]} dim={half} onopen={() => (selected = srvKey(ext.name))}>
					{#snippet notices()}
						{#if half}{@render companionLine(ext.companion ?? "", !!tasks.busy.$import)}{/if}
						{#if upd}{@render updateLine(ext.version ?? "", upd, !!tasks.busy[srvKey(ext.name)])}{/if}
					{/snippet}
					{#snippet meta()}
						{#if ext.version}<span class="meta">v{ext.version}</span>{/if}
						<span class="meta">{t("서버에서 실행")}</span>
						{#if half}<span class="chip warn">{t("동작 안 함")}</span>{/if}
					{/snippet}
				</ExtensionRow>
			{/each}
		{/if}
		{#if !list.length && !unreadable.length && !(view === "server" && serverSide.length)}
			<p class="none">{view === "server" ? t("이 서버에 설치된 확장이 없습니다") : t("이 기기에 설치된 확장이 없습니다")}</p>
		{/if}
	</section>

	{#if view === "device"}
	<Accordion variant="line">
		{#snippet head()}{t("고급")}{/snippet}
		<div class="adv">
			<div class="adv-row">
				<span class="switch-text">
					<span class="switch-title"><Icon name="shield" /> {t("안전 모드: 모든 확장 실행 중지")}</span>
					<span class="hint">{t("풀어도 자동으로 켜지지 않습니다. 문제가 생기면 주소에")} <a href="?extensions=off">?extensions=off</a>{t("를 붙여 복구하세요.")}</span>
				</span>
				<Switch checked={extensions.safeMode} label={t("모든 확장 실행 중지")} disabled={tasks.busy.$safe} onchange={setSafeMode} />
			</div>
			{#if extensions.installed.length}<p class="hint">{t("내보내기에는 패키지만 포함되며, 개인 설정과 확장 저장 데이터는 포함되지 않습니다.")}</p>{/if}
		</div>
	</Accordion>
	{/if}
	{/if}
</div>

{#if market}
	<Marketplace scope={view} onclose={() => (market = false)} onpick={pickFromMarket} />
{/if}

<ImportDialogs {preview} result={tasks.result} {replacement} {willResume} {filename} {target} {serverName} busy={tasks.busy} oncancel={cancelPreview} onimport={importPackage} onclose={closeResult} onshow={showInstalled} />

<style>
	.extensions,
	section { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
	.extensions { gap: 22px; color: var(--text); font-size: var(--fs-md); line-height: 1.5; }
	.feedback { display: flex; flex-direction: column; gap: 8px; }
	/* The live region stays mounted, but while it holds no element (only Svelte's {#if} anchor comments, so :empty never matches) it must not take a flex gap */
	.feedback:not(:has(*)) { position: absolute; }
	h3,
	p { margin: 0; }
	h3.label { font-family: var(--mono); font-size: var(--fs-2xs); font-weight: 500; letter-spacing: 0.04em; color: var(--text-faint); }
	.meta, .hint { font-size: var(--fs-xs); color: var(--text-faint); overflow-wrap: anywhere; }
	.meta { font-family: var(--mono); font-size: var(--fs-2xs); }
	.chip { background: var(--bg-active); }
	.chip.warn { background: var(--warn-soft); }
	/* Update strip: a tinted band at the foot of the card, so it reads as "something to do" next to the plain cards */
	.updline { display: flex; align-items: center; gap: 10px; margin: 2px -14px -12px; padding: 9px 14px; border-top: 1px solid var(--border); border-radius: 0 0 var(--radius) var(--radius); background: var(--accent-soft); }
	.updline.warnline { background: var(--warn-soft); color: var(--warn); }
	.updline > :global(svg) { flex: none; width: 17px; height: 17px; stroke-width: 2; }
	.to { flex: 1; min-width: 0; display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 8px; font-size: var(--fs-xs); line-height: 1.4; }
	.to b { font-weight: 650; }
	.vers { font-family: var(--mono); font-size: var(--fs-2xs); color: var(--text-dim); }
	.extensions :global(.btn.sm.upd-btn) { flex: none; white-space: nowrap; min-height: 30px; padding: 4px 14px; }

	.switch-text { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
	.switch-title { display: inline-flex; align-items: center; gap: 6px; font-weight: 550; }
	.switch-title :global(svg) { width: 17px; height: 17px; stroke-width: 1.9; }
	.switch-title :global(svg) { color: var(--text-dim); }

	.extensions :global(.btn.sm) { height: auto; min-height: 34px; padding: 6px 12px; white-space: normal; }

	.bar { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
	.bar-title { margin-right: auto; }
	.extensions .bar > :global(.add) { position: relative; display: inline-flex; align-items: center; gap: 6px; cursor: pointer; }
	.extensions .bar > :global(.add.disabled) { opacity: 0.5; cursor: default; }
	.extensions .bar > :global(.add input) { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; cursor: inherit; }
	.extensions .bar > :global(.add svg) { width: 16px; height: 16px; }
	.adv { display: flex; flex-direction: column; gap: 10px; }
	.adv-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; }

	a { color: var(--text); text-decoration: underline; text-underline-offset: 3px; }
	.none {
		margin: 2px 0 6px;
		padding: 12px;
		border: 1px dashed var(--border);
		border-radius: var(--radius);
		color: var(--text-faint);
		font-size: var(--fs-sm);
		text-align: center;
	}

</style>
