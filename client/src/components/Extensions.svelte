<script lang="ts">
	import { LocalizedError, getLang, t } from "../lib/i18n";
	import Icon from "./Icon.svelte";
	import Notice from "./Notice.svelte";
	import Accordion from "./Accordion.svelte";
	import Switch from "./Switch.svelte";
	import { download } from "../lib/download";
	import SettingsForm from "./extensions/SettingsForm.svelte";
	import { tick } from "svelte";
	import { collapseIn, collapseOut } from "../lib/motion";
	import { app } from "../lib/store.svelte";
		import { CONFIG_REQUIRED, extensions, type ExtensionScope, type InstalledExtension, type UnreadableExtension } from "../lib/extensions/host.svelte";
	import { parsePackage, parseSettingFields, MAX_PACKAGE_BYTES, type ExtensionPackage, type SettingField } from "../lib/extensions/schema";
	import Marketplace from "./extensions/Marketplace.svelte";
	import PermissionList from "./extensions/PermissionList.svelte";
	import ImportDialogs, { type ImportResult } from "./extensions/ImportDialogs.svelte";

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
	type ServerExt = Awaited<ReturnType<NonNullable<typeof app.api>["serverExtensions"]>>["extensions"][number];
	let serverSide = $state<ServerExt[]>([]);
	/** Saved settings of the server extensions, by settings id (`GET /extensions/settings`). */
	let serverSettings = $state<Record<string, Record<string, unknown>>>({});
	const srvKey = (name: string) => `srv:${name}`;
	const openServer = $derived(selected?.startsWith("srv:") ? serverSide.find((e) => srvKey(e.name) === selected) : undefined);
	/** The declared form of a server extension, or why it cannot be shown. */
	function serverFields(ext: ServerExt): { fields?: SettingField[]; problem?: string } {
		if (!ext.settings) return {};
		try { return { fields: parseSettingFields(ext.settings) }; } catch (cause) { return { problem: cause instanceof Error ? cause.message : String(cause) }; }
	}
	const serverText = (ext: ServerExt) => ext.descriptions?.[getLang()] ?? ext.description ?? "";
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
			notice = t("설정을 저장했습니다.");
		});
	}
	$effect(() => { void app.api; void market; void loadServerSide(); });
	/** A package picked in the marketplace goes through the same preview (permissions, scope) as an imported file. */
	function pickFromMarket(pkg: ExtensionPackage, entry: { id: string }) {
		market = false;
		preview = pkg;
		filename = `${entry.id}.json`;
	}
	let error = $state("");
	let notice = $state("");
	let busy = $state<Record<string, boolean>>({});
	let drafts = $state<Record<string, string>>({});
	/** The extension whose detail is open (chosen in the settings sidebar or from a row); null shows the list. */
	const openEntry = $derived(selected ? list.find((e) => e.package.manifest.id === selected) : undefined);
	$effect(() => { if (selected && !openEntry && !(selected.startsWith("srv:") && (!serverSide.length || openServer))) selected = null; });
	function closeDetail() {
		const id = selected;
		selected = null;
		removing = null;
		void tick().then(() => document.getElementById(`extension-${id}`)?.querySelector<HTMLElement>(".expand")?.focus({ preventScroll: false }));
	}
	/** Which card asks about removal: the extension id, or `unreadable:<index>` for an unreadable entry. */
	let removing = $state<string | null>(null);
	let trigger: HTMLElement | null = null;
	/** What came of the last import, shown in a dialog of its own: the inline notice was easy to miss. */
	let result = $state<ImportResult | null>(null);
	const replacement = $derived.by(() => {
		const id = preview?.manifest.id;
		return id ? extensions.installed.find((entry) => entry.package.manifest.id === id) : undefined;
	});
	const willResume = $derived(preview ? extensions.canResume(preview) : false);
	/** With `failTitle`, a failure is reported in the result dialog instead of the inline error. */
	async function run(key: string, task: () => unknown | Promise<unknown>, failTitle?: string) {
		if (busy[key]) return;
		busy[key] = true;
		error = "";
		notice = "";
		try {
			await task();
		} catch (cause) {
			const message = cause instanceof Error ? cause.message : String(cause);
			if (failTitle) result = { tone: "danger", title: failTitle, detail: message };
			else error = message;
		} finally {
			busy[key] = false;
		}
	}

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
			if (busy[id]) throw new LocalizedError(t("이 확장의 작업이 끝난 뒤 가져오세요."));
			const replaced = !!replacement;
			// Same id, was running, and no new permission: swap in place and start it again without a second consent.
			const resume = extensions.canResume(pkg);
			extensions.install(pkg, replacement?.scope ?? target);
			delete drafts[id];
			if (removing === id) removing = null;
			preview = null;
			filename = "";
			if (!resume) {
				result = {
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
				result = { tone: "ok", title: t("확장을 교체하고 다시 실행했습니다"), detail: t("새 권한이 없어 다시 동의를 받지 않고 바로 실행했습니다."), pkg, running: true, replaced };
			} catch (cause) {
				const why = cause instanceof Error ? cause.message : String(cause);
				result = { tone: "warn", title: t("교체했지만 실행하지 못했습니다"), detail: `${t("비활성 상태로 남아 있습니다.")} ${why}`, pkg, running: false, replaced };
			}
		}, t("확장을 가져오지 못했습니다"));
	}

	function closeResult() {
		result = null;
	}

	function cancelPreview() {
		if (busy.$import) return;
		preview = null;
		filename = "";
	}

	/** Close the dialog and bring the imported extension's card into view. */
	function showInstalled() {
		const id = result?.pkg?.manifest.id;
		result = null;
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
				notice = t("설정을 저장하고 확장을 다시 불러왔습니다.");
			} else {
				notice = t("설정을 저장했습니다. 다음 활성화 때 적용됩니다.");
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

	function askRemove(key: string, event: Event) {
		trigger = event.currentTarget as HTMLElement;
		removing = key;
	}

	function cancelRemove() {
		const back = trigger;
		removing = null;
		trigger = null;
		void tick().then(() => { if (back?.isConnected) back.focus(); });
	}

	/** Move focus into the confirmation (on the safe choice) as soon as it appears; Esc cancels. */
	function focusConfirm(node: HTMLElement) {
		node.querySelector<HTMLElement>("[data-cancel]")?.focus();
		node.addEventListener("keydown", confirmKeydown);
		return { destroy: () => node.removeEventListener("keydown", confirmKeydown) };
	}

	function confirmKeydown(event: KeyboardEvent) {
		if (event.key !== "Escape") return;
		event.preventDefault();
		event.stopPropagation();
		cancelRemove();
	}

	function remove(id: string, keepSettings: boolean) {
		void run(id, () => {
			extensions.remove(id, { keepSettings });
			delete drafts[id];
			removing = null;
			trigger = null;
			notice = keepSettings ? t("확장을 삭제했습니다. 설정값은 유지했습니다.") : t("확장과 설정값을 삭제했습니다.");
		});
	}

	function removeUnreadable(index: number, keepSettings: boolean) {
		void run(`unreadable:${index}`, () => {
			extensions.removeUnreadable(index, { keepSettings });
			removing = null;
			trigger = null;
			notice = keepSettings ? t("확장을 삭제했습니다. 설정값은 유지했습니다.") : t("확장과 설정값을 삭제했습니다.");
		});
	}

	function setSafeMode(on: boolean) {
		void run("$safe", () => {
			extensions.setSafeMode(on);
			notice = on ? t("모든 확장의 실행을 중지했습니다.") : t("안전 모드를 해제했습니다. 각 확장을 직접 활성화하세요.");
		});
	}
</script>

{#snippet installedRow(entry: InstalledExtension)}
	{@const id = entry.package.manifest.id}
	{@const fields = entry.package.manifest.settings}
	{@const gated = !!fields && extensions.configRequired(id)}
	{@const problem = entry.state === "active" || entry.state === "starting" ? "" : gated ? t(CONFIG_REQUIRED) : extensions.settingsProblem(id)}
	{@const on = entry.state === "active" || entry.state === "starting"}
	<article class="card" id="extension-{id}" tabindex="-1" aria-label={entry.package.manifest.name}>
		<div class="line">
			<button type="button" class="expand" onclick={() => (selected = id)}>
				<span class="who">
					<span class="top">
						<span class="ename">{entry.package.manifest.name}</span>
						<span class="meta">v{entry.package.manifest.version}{#if entry.state === "starting"} · {t("시작 중")}{:else if entry.state === "error"} · {t("오류")}{/if}</span>
					</span>
					{#if entry.package.manifest.description}<span class="brief">{entry.package.manifest.description}</span>{/if}
				</span>
				<span class="chev"><Icon name="chevron-right" /></span>
			</button>
			{#if busy[id] || entry.state === "starting"}<span class="spinner" role="status" aria-label={t("처리 중")}></span>{/if}
			<Switch
				checked={on}
				label={t("{name} 사용", { name: entry.package.manifest.name })}
				disabled={busy[id] || entry.state === "starting" || (!on && (extensions.safeMode || !!problem))}
				describedby={problem ? `extension-blocked-${id}` : undefined}
				onchange={(next) => (next ? enable(id) : disable(id))}
			/>
		</div>
		{#if entry.error}<Notice tone="danger" size="sm" animated role="status">{entry.error}</Notice>{/if}
		{#if problem}<Notice tone="warn" size="sm" animated id="extension-blocked-{id}">{t("켤 수 없습니다.")} {problem}</Notice>{/if}
	</article>
{/snippet}

{#snippet installedDetail(entry: InstalledExtension)}
	{@const id = entry.package.manifest.id}
	{@const fields = entry.package.manifest.settings}
	{@const gated = !!fields && extensions.configRequired(id)}
	{@const problem = entry.state === "active" || entry.state === "starting" ? "" : gated ? t(CONFIG_REQUIRED) : extensions.settingsProblem(id)}
	{@const on = entry.state === "active" || entry.state === "starting"}
	<div class="page" id="extension-{id}" tabindex="-1">
		<button type="button" class="back" onclick={closeDetail}><span class="chev flip"><Icon name="chevron-right" /></span>{t("목록")}</button>
		<div class="line">
			<div class="who">
				<span class="top">
					<h4 class="ename">{entry.package.manifest.name}</h4>
					<span class="meta">v{entry.package.manifest.version}{#if entry.state === "starting"} · {t("시작 중")}{:else if entry.state === "error"} · {t("오류")}{/if}</span>
				</span>
				<span class="meta">{id}</span>
			</div>
			{#if busy[id] || entry.state === "starting"}<span class="spinner" role="status" aria-label={t("처리 중")}></span>{/if}
			<Switch
				checked={on}
				label={t("{name} 사용", { name: entry.package.manifest.name })}
				disabled={busy[id] || entry.state === "starting" || (!on && (extensions.safeMode || !!problem))}
				describedby={problem ? `extension-blocked-${id}` : undefined}
				onchange={(next) => (next ? enable(id) : disable(id))}
			/>
		</div>
		{#if entry.package.manifest.description}<p class="description">{entry.package.manifest.description}</p>{/if}
		{#if entry.error}<Notice tone="danger" size="sm" role="status">{entry.error}</Notice>{/if}
		{#if problem}<Notice tone="warn" size="sm" id="extension-blocked-{id}">{t("켤 수 없습니다.")} {problem}</Notice>{/if}

		<section class="block">
			<h3 class="label">{t("확장 설정")}</h3>
			{#if fields}
				{#if gated}<p class="hint">{t("새로 설치한 확장입니다. 기본값을 확인하고 설정을 저장하면 켤 수 있습니다.")}</p>{/if}
				<SettingsForm {id} {fields} value={entry.settings} disabled={busy[id] || entry.state === "starting"} saveLabel={entry.state === "active" ? t("설정 저장 및 다시 불러오기") : t("설정 저장")} onsave={(settings) => saveSettings(id, settings)} />
			{:else}
				<label class="settings-label" for="extension-settings-{id}">{t("설정 JSON 객체")}</label>
				<textarea id="extension-settings-{id}" rows="6" spellcheck="false" value={drafts[id] ?? JSON.stringify(entry.settings, null, 2)} disabled={busy[id]} oninput={(event) => { drafts[id] = event.currentTarget.value; }}></textarea>
				<p class="hint">{t("JSON 객체만 저장할 수 있습니다 (최대 16KB). 켜져 있는 확장은 다시 불러와 적용하고, 꺼져 있으면 다음에 켤 때 적용합니다.")}</p>
				<div class="row">
					<button type="button" class="btn sm" disabled={busy[id] || entry.state === "starting"} onclick={() => saveSettings(id)}>{entry.state === "active" ? t("설정 저장 및 다시 불러오기") : t("설정 저장")}</button>
				</div>
			{/if}
		</section>

		<section class="block">
			<h3 class="label">{t("권한과 실행 안내")}</h3>
			<PermissionList pkg={entry.package} />
		</section>

		<section class="block">
			<h3 class="label">{t("관리")}</h3>
			<div class="row">
				<button type="button" class="btn sm" disabled={extensions.safeMode || busy[id] || entry.state !== "active"} onclick={() => reload(id)}>{t("다시 불러오기")}</button>
				<button type="button" class="btn sm" disabled={busy[id]} onclick={() => exportPackage(id)}>{t("내보내기")}</button>
				<button type="button" class="btn danger sm end" disabled={busy[id]} aria-expanded={removing === id} onclick={(event) => askRemove(id, event)}>{t("삭제")}</button>
			</div>
			{#if removing === id}
				<div class="confirm" in:collapseIn out:collapseOut role="group" aria-labelledby="extension-remove-{id}" tabindex="-1" use:focusConfirm>
					<p id="extension-remove-{id}">{t("이 확장을 삭제합니다. 설정값은 어떻게 할까요?")}</p>
					<div class="row">
						<button type="button" class="btn sm" disabled={busy[id]} onclick={() => remove(id, true)}>{t("설정 유지하고 삭제")}</button>
						<button type="button" class="btn danger sm" disabled={busy[id]} onclick={() => remove(id, false)}>{t("설정까지 삭제")}</button>
						<button type="button" class="btn sm" data-cancel disabled={busy[id]} onclick={cancelRemove}>{t("취소")}</button>
					</div>
				</div>
			{/if}
		</section>
	</div>
{/snippet}

{#snippet serverDetail(ext: ServerExt)}
	{@const form = serverFields(ext)}
	{@const key = srvKey(ext.name)}
	<div class="page" id="extension-{key}" tabindex="-1">
		<button type="button" class="back" onclick={() => (selected = null)}><span class="chev flip"><Icon name="chevron-right" /></span>{t("목록")}</button>
		<div class="line">
			<div class="who">
				<span class="top">
					<h4 class="ename">{ext.title ?? ext.name}</h4>
					{#if ext.version}<span class="meta">v{ext.version}</span>{/if}
					<span class="meta">{t("서버에서 실행")}</span>
				</span>
				<span class="meta">{ext.name}</span>
			</div>
			{#if busy[key]}<span class="spinner" role="status" aria-label={t("처리 중")}></span>{/if}
		</div>
		{#if serverText(ext)}<p class="description">{serverText(ext)}</p>{/if}
		{#if ext.error}<Notice tone="danger" size="sm" role="status">{ext.error}</Notice>{/if}
		{#if missingClient(ext.companion)}<Notice tone="warn" size="sm" role="status">{t("이 확장은 클라이언트 확장 ‘{id}’도 설치되어 있어야 동작합니다.", { id: ext.companion ?? "" })}</Notice>{/if}

		<section class="block">
			<h3 class="label">{t("확장 설정")}</h3>
			{#if form.fields}
				<SettingsForm id={ext.settingsId} fields={form.fields} value={serverSettings[ext.settingsId] ?? {}} disabled={busy[key]} saveLabel={t("설정 저장")} onsave={(settings) => saveServerSettings(ext, settings)} />
			{:else if form.problem}
				<Notice tone="warn" size="sm" role="status">{form.problem}</Notice>
			{:else}
				<p class="hint">{t("이 확장은 편집할 수 있는 설정이 없습니다.")}</p>
			{/if}
		</section>

		{#if ext.tools.length || ext.commands.length || ext.flags.length}
			<section class="block">
				<h3 class="label">{t("제공 기능")}</h3>
				{#if ext.commands.length || ext.tools.length}<p class="brief">{[...ext.commands.map((c) => `/${c.name}`), ...ext.tools].join(", ")}</p>{/if}
				{#each ext.flags as flag (flag.name)}
					<p class="hint"><code>PIPAYA_FLAG_{flag.name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}</code>{flag.description ? ` — ${flag.description}` : ""}{flag.value !== undefined ? ` (${t("현재 값")}: ${String(flag.value)})` : ""}</p>
				{/each}
			</section>
		{/if}
	</div>
{/snippet}

{#snippet unreadableCard(item: UnreadableExtension, index: number)}
	{@const key = `unreadable:${index}`}
	<article class="card" aria-label={item.name || item.id || t("알 수 없는 확장")}>
		<div class="heading">
			<h4>{item.name || item.id || t("알 수 없는 확장")}</h4>
			<span class="state chip danger">{t("읽을 수 없음")}</span>
		</div>
		{#if item.id}<p class="meta">{item.id}</p>{/if}
		<Notice tone="warn" size="sm">{t("이 버전에서 지원하지 않는 형식입니다:")} {item.reason}</Notice>
		<p class="hint">{t("원본 데이터는 그대로 보관되어, 지원하는 버전에서 다시 읽을 수 있습니다. 같은 ID의 패키지를 가져오면 이 항목을 대체합니다.")}</p>
		<div class="row">
			<button type="button" class="btn sm" disabled={busy[key]} onclick={() => exportRaw(index)}>{t("원본 내보내기")}</button>
			<button type="button" class="btn danger sm end" disabled={busy[key]} aria-expanded={removing === key} onclick={(event) => askRemove(key, event)}>{t("삭제")}</button>
		</div>
		{#if removing === key}
			<div class="confirm" in:collapseIn out:collapseOut role="group" aria-labelledby="extension-remove-{key}" tabindex="-1" use:focusConfirm>
				{#if item.id}
					<p id="extension-remove-{key}">{t("이 확장을 삭제합니다. 설정값은 어떻게 할까요?")}</p>
					<div class="row">
						<button type="button" class="btn sm" disabled={busy[key]} onclick={() => removeUnreadable(index, true)}>{t("설정 유지하고 삭제")}</button>
						<button type="button" class="btn danger sm" disabled={busy[key]} onclick={() => removeUnreadable(index, false)}>{t("설정까지 삭제")}</button>
						<button type="button" class="btn sm" data-cancel disabled={busy[key]} onclick={cancelRemove}>{t("취소")}</button>
					</div>
				{:else}
					<p id="extension-remove-{key}">{t("이 항목을 삭제합니다. 되돌릴 수 없습니다.")}</p>
					<div class="row">
						<button type="button" class="btn danger sm" disabled={busy[key]} onclick={() => removeUnreadable(index, false)}>{t("삭제")}</button>
						<button type="button" class="btn sm" data-cancel disabled={busy[key]} onclick={cancelRemove}>{t("취소")}</button>
					</div>
				{/if}
			</div>
		{/if}
	</article>
{/snippet}

<div class="extensions">
	<div class="feedback" aria-live="polite" aria-atomic="true">
		{#if error}<Notice tone="danger" size="sm" animated>{error}</Notice>{/if}
		{#if notice}<Notice tone="ok" size="sm" animated>{notice}</Notice>{/if}
	</div>
	{#if extensions.syncNotice}<Notice tone="warn" size="sm" animated role="status">{extensions.syncNotice}</Notice>{/if}
	{#if extensions.loadError}<Notice tone="danger" size="sm" animated role="status">{extensions.loadError}</Notice>{/if}

	{#if openEntry}
		{@render installedDetail(openEntry)}
	{:else if openServer}
		{@render serverDetail(openServer)}
	{:else}
	<section aria-labelledby="extensions-installed">
		<div class="bar">
			<h3 id="extensions-installed" class="label bar-title">{t("설치된 확장 ({n})", { n: list.length + unreadable.length + (view === "server" ? serverSide.length : 0) })}</h3>
			<button type="button" class="btn sm add" disabled={busy.$import} onclick={() => (market = true)}><Icon name="search" /> {t("마켓플레이스")}</button>
			<label class="btn sm add" class:disabled={busy.$import}>
				<input type="file" accept="application/json,.json" disabled={busy.$import} onchange={selectFile} />
				<Icon name="plus" /> {t("확장 추가")}
			</label>
		</div>
		{#if busy.$import}<p class="hint" role="status">{t("파일을 읽는 중…")}</p>{/if}
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
		{#each list as entry (entry.package.manifest.id)}{@render installedRow(entry)}{/each}
		{#each unreadable as { item, index } (index)}{@render unreadableCard(item, index)}{/each}
		{#if view === "server"}
			{#each serverSide as ext (ext.name)}
				<article class="card" aria-label={ext.title ?? ext.name}>
					<div class="line">
						<button type="button" class="expand" onclick={() => (selected = srvKey(ext.name))}>
							<span class="who">
								<span class="top"><span class="ename">{ext.title ?? ext.name}</span>{#if ext.version}<span class="meta">v{ext.version}</span>{/if}<span class="meta">{t("서버에서 실행")}</span>{#if missingClient(ext.companion)}<span class="chip warn" title={t("이 확장은 클라이언트 확장 ‘{id}’도 설치되어 있어야 동작합니다.", { id: ext.companion ?? "" })}>{t("클라이언트 미설치 · 동작 안 함")}</span>{/if}</span>
								{#if ext.error}<span class="brief">{ext.error}</span>
								{:else if ext.tools.length || ext.commands.length}<span class="brief">{[...ext.commands.map((c) => `/${c.name}`), ...ext.tools].join(", ")}</span>{/if}
							</span>
							<span class="chev"><Icon name="chevron-right" /></span>
						</button>
					</div>
				</article>
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
				<Switch checked={extensions.safeMode} label={t("모든 확장 실행 중지")} disabled={busy.$safe} onchange={setSafeMode} />
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

<ImportDialogs {preview} {result} {replacement} {willResume} {filename} {target} {serverName} busy={busy} oncancel={cancelPreview} onimport={importPackage} onclose={closeResult} onshow={showInstalled} />

<style>
	.extensions, section, .card { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
	.extensions { gap: 22px; color: var(--text); font-size: var(--fs-md); line-height: 1.5; }
	.feedback { display: flex; flex-direction: column; gap: 8px; }
	.feedback:empty { display: none; }
	h3, h4, p { margin: 0; }
	h3.label { font-family: var(--mono); font-size: var(--fs-2xs); font-weight: 500; letter-spacing: 0.04em; color: var(--text-faint); }
	h4 { font-size: var(--fs-base); font-weight: 600; overflow-wrap: anywhere; }

	.card { padding: 12px 14px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--bg-elev); gap: 10px; }
	.heading, .row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
	.heading { justify-content: space-between; flex-wrap: nowrap; }
	.heading h4 { min-width: 0; }
	.heading .chip { flex: none; }
	.meta, .hint { font-size: var(--fs-xs); color: var(--text-faint); overflow-wrap: anywhere; }
	.meta { font-family: var(--mono); font-size: var(--fs-2xs); }
	.description { white-space: pre-wrap; overflow-wrap: anywhere; }
	.description { color: var(--text-dim); }
	.chip { background: var(--bg-active); }
	.chip.warn { background: var(--warn-soft); }
	.chip.danger { background: var(--danger-soft); }


	.switch-text { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
	.switch-title { display: inline-flex; align-items: center; gap: 6px; font-weight: 550; }
	.switch-title :global(svg) { width: 17px; height: 17px; stroke: currentColor; fill: none; stroke-width: 1.9; stroke-linecap: round; stroke-linejoin: round; }
	.switch-title :global(svg) { color: var(--text-dim); }



	.btn.sm { height: auto; min-height: 34px; padding: 6px 12px; white-space: normal; }
	.btn.end { margin-left: auto; }
	.confirm { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; border-radius: var(--radius-sm); background: var(--danger-soft); font-size: var(--fs-sm); }

	.settings-label { font-size: var(--fs-xs); font-weight: 550; }
	textarea { display: block; width: 100%; box-sizing: border-box; min-height: 110px; resize: vertical; padding: 10px 12px; border: 1px solid var(--border-strong); border-radius: var(--radius-sm); background: var(--bg-code); color: var(--text); font-family: var(--mono); font-size: var(--fs-xs); line-height: 1.5; transition: border-color var(--motion-fast) var(--ease-std), box-shadow var(--motion-fast) var(--ease-std); }
	textarea:focus-visible { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }


	.bar { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
	.bar-title { margin-right: auto; }
	.add { position: relative; display: inline-flex; align-items: center; gap: 6px; cursor: pointer; }
	.add.disabled { opacity: 0.5; cursor: default; }
	.add input { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; cursor: inherit; }
	.add :global(svg) { width: 16px; height: 16px; }
	.line { display: flex; align-items: center; gap: 10px; }
	.expand .who { flex: 1; }
	.expand { flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; padding: 4px 2px; border-radius: var(--radius-sm); text-align: left; color: var(--text); }
	.expand:hover .ename { text-decoration: underline; text-underline-offset: 3px; }
	.expand:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
	.chev { flex: none; display: inline-flex; color: var(--text-faint); transition: transform var(--motion-fast) var(--ease-exit); }
	.chev :global(svg) { width: 16px; height: 16px; stroke: currentColor; fill: none; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
	.who { display: flex; flex-direction: column; min-width: 0; line-height: 1.35; }
	.top { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 8px; min-width: 0; }
	.brief { font-size: var(--fs-xs); color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.ename { font-size: var(--fs-md); font-weight: 600; overflow-wrap: anywhere; }
	.page { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
	.page:focus { outline: none; }
	.page .line { align-items: flex-start; }
	.page .who { flex: 1; min-width: 0; gap: 2px; }
	.page h4.ename { font-size: var(--fs-lg); }
	.back { align-self: flex-start; display: inline-flex; align-items: center; gap: 4px; padding: 4px 8px 4px 2px; border-radius: var(--radius-sm); color: var(--text-dim); font-size: var(--fs-sm); }
	.back:hover { color: var(--text); }
	/* on a wide window the settings sidebar lists the extensions, so there is nothing to go back to */
	@media (min-width: 761px) { .back { display: none; } }
	.back:focus-visible, .page :global(.expand:focus-visible) { outline: 2px solid var(--accent); outline-offset: 2px; }
	.chev.flip { transform: rotate(180deg); }
	.block { gap: 10px; padding-top: 14px; border-top: 1px solid var(--border); }
	.adv { display: flex; flex-direction: column; gap: 10px; }
	.adv-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; }

	a { color: var(--text); text-decoration: underline; text-underline-offset: 3px; }
	@media (max-width: 640px) {
		.card { padding: 12px 14px; }
		.row > .btn { flex: 1 1 auto; }
		.btn.end { margin-left: 0; }
	}
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
