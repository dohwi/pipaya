<script lang="ts">
	import { untrack } from "svelte";
	import Button from "../ui/Button.svelte";
	import Notice from "../ui/Notice.svelte";
	import RemoveExtensionConfirm from "./RemoveExtensionConfirm.svelte";
	import { app } from "../../lib/store.svelte";
	import { extensions } from "../../lib/extensions/host.svelte";
	import { extensionUpdates } from "../../lib/extension-updates.svelte";
	import { flagVariable, serverFields, serverProvides, serverText, serverTitle, srvKey, type ServerExt } from "../../lib/server-extension";
	import { t } from "../../lib/i18n";
	import ExtensionPage from "./ExtensionPage.svelte";
	import ExtensionMount from "./ExtensionMount.svelte";
	import ExtensionPart from "./ExtensionPart.svelte";
	import ExtensionSurface from "./ExtensionSurface.svelte";
	import SettingsForm from "./SettingsForm.svelte";
	import { serverPanelView } from "../../lib/server-panel";
	import { ownPageUis } from "../../lib/extensions/own-ui.svelte";
	import type { Api } from "../../lib/api";
	import type { UIEvent } from "../../lib/extensions/ui";

	/**
	 * The page of one extension that runs inside the server: read-only except its settings, which every device shares.
	 * It says so when the client half it needs is not installed on the server.
	 */
	let {
		ext,
		settings,
		page,
		api = null,
		onsavepartial,
		oncall,
		onpageevent,
		busy,
		upgrade,
		onback,
		onsave,
		serverId = null,
		oninstallclient,
		onopenclient,
		onenableclient,
		removing,
		onaskremove,
		oncancelremove,
		onremove,
	}: {
		/** The delete question is open */
		removing: boolean;
		onaskremove: (event: Event) => void;
		oncancelremove: () => void;
		onremove: (keepSettings: boolean) => void;
		ext: ServerExt;
		/** The server this extension runs on (the one picked in settings); the open one when unset */
		serverId?: string | null;
		/** Saved settings of this extension (`GET /extensions/settings`, by `settingsId`) */
		settings: Record<string, unknown> | undefined;
		/** The page the extension shows (`pi.ui.setPanel`) as the server holds it now; unset when it has none */
		page?: unknown;
		/** The connection of the server this page belongs to, to fetch the extension's own components from */
		api?: Api | null;
		/** `save(partial)` of the extension's own settings section: validated like the form, only those keys are written */
		onsavepartial: (partial: unknown) => Promise<void>;
		/** `call(method, params)` of that section: one of the extension's methods, on the server this page belongs to */
		oncall: (method: unknown, params: unknown) => Promise<unknown>;
		/** What the user did on the page (a button, a form), for the server to hand to the extension */
		onpageevent: (event: UIEvent) => Promise<unknown>;
		busy: boolean;
		/** A newer marketplace version of this extension, with what the button does */
		upgrade?: { version: string; disabled: boolean; onclick: () => void };
		onback: () => void;
		onsave: (settings: Record<string, unknown>) => void;
		/** Download the client half and open its install preview. */
		oninstallclient: (id: string) => void;
		/** Open the installed client half (id, name); absent when it lives in another section */
		onopenclient?: (id: string) => void;
		/** Turn the installed client half on */
		onenableclient?: (id: string) => void;
	} = $props();

	const form = $derived(serverFields(ext));
	const provides = $derived(serverProvides(ext));
	/** A server extension whose client half is not installed on this server runs only half. */
	const clients = $derived((void app.extensionStoreTick, app.clientExtensionsOf(serverId ?? app.serverId)));
	const client = $derived(ext.companion ? clients.find((e) => e.id === ext.companion) : undefined);
	const clientOff = $derived(!!client && !client.live);
	const missingClient = $derived(!!ext.companion && !client);

	/** The page, in the language in use and validated like a client extension's UI. */
	const shownPage = $derived(serverPanelView(page, ext.translations));
	const run = (event: UIEvent) => onpageevent(event).then(() => {});
	const surface = $derived(shownPage.view ? { owner: ext.name, id: "page", view: shownPage.view, run } : null);
	/**
	 * Who may draw this page with Svelte: the client extension this one names as its client half (`pipaya.companion`). Its
	 * components run in the open server's app, so another server's page, whose client half is not running here, gets the
	 * plain form. Nobody else can replace or add to the page.
	 */
	const owners = $derived(ext.companion && (!serverId || serverId === app.serverId) ? [ext.companion] : []);
	/** The extension's own Svelte (`pipaya.components`): runs only after this device agreed to exactly this code. */
	const uiServer = $derived(serverId ?? app.serverId ?? "");
	const ownKey = $derived(JSON.stringify(ext.ui ?? null) + (ext.version ?? ""));
	const own = $derived(ext.ui ? ownPageUis.stateOf(uiServer, ext.name) : ({ status: "off" } as const));
	$effect(() => {
		void ownKey; void extensions.safeMode;
		const server = uiServer, name = ext.name, id = ext.settingsId;
		if (ext.ui && api && server) untrack(() => { void ownPageUis.ensure(server, api, name, id); });
	});
	$effect(() => { const server = uiServer, name = ext.name, value = settings ?? {}; if (server) untrack(() => ownPageUis.setSettings(server, name, value)); });
	const ownReady = $derived(own.status === "ready" ? own.ui : null);
	const pageProps = $derived({
		id: ext.settingsId, extension: ext.name, serverId: serverId ?? app.serverId, settings: settings ?? {}, fields: form.fields ?? [],
		panel: shownPage.view, disabled: busy, save: onsavepartial, call: oncall,
	});
</script>

<!-- A snippet, because `slot=` directly inside another component reads as a named-slot assignment -->
{#snippet top()}<ExtensionMount slot="extension.page.top" {owners} props={pageProps} />{/snippet}

{#snippet ownTop()}
	{#if ownReady}
		{#each ownReady.mounts as m (m.key)}
			<svelte:boundary onerror={(cause) => extensions.log(ext.name, `${m.key}: ${cause instanceof Error ? cause.message : String(cause)}`)}>
				<m.component {...pageProps} />
				{#snippet failed()}{/snippet}
			</svelte:boundary>
		{/each}
	{/if}
{/snippet}

{#snippet settingsSection()}
	<ExtensionPart part="extension.settings" {owners} props={pageProps}>
		{#if form.fields}
			<SettingsForm id={ext.settingsId} fields={form.fields} value={settings ?? {}} disabled={busy} saveLabel={t("설정 저장")} {onsave} componentOwners={owners} ownComponents={ownReady?.components} />
		{:else if form.problem}
			<Notice tone="warn" size="sm" role="status">{form.problem}</Notice>
		{:else}
			<p class="hint">{t("이 확장은 편집할 수 있는 설정이 없습니다.")}</p>
		{/if}
	</ExtensionPart>
{/snippet}

<ExtensionPage id="extension-{srvKey(ext.name)}" name={serverTitle(ext)} sub={ext.name} {busy} {upgrade} {onback}>
	{#snippet meta()}
		{#if ext.version}<span class="facts">v{ext.version}</span>{/if}
	{/snippet}
	{#snippet control()}
		<Button variant="danger" size="sm" disabled={busy} aria-expanded={removing} onclick={onaskremove}>{t("삭제")}</Button>
	{/snippet}

	{#if removing}
		<RemoveExtensionConfirm name={ext.name} busy={busy} onkeep={() => onremove(true)} onwipe={() => onremove(false)} oncancel={oncancelremove} />
	{/if}
	{#if serverText(ext)}<p class="description">{serverText(ext)}</p>{/if}
	{#if ext.error}<Notice tone="danger" size="sm" role="status">{ext.error}</Notice>{/if}
	{#if missingClient}
		<Notice tone="warn" size="sm" icon="clip" role="status">
			{t("‘{name}’ 확장도 설치해야 동작합니다.", { name: (ext.companion && extensionUpdates.clientName(ext.companion)) || ext.companion || "" })}
			{#snippet action()}<button type="button" disabled={busy} onclick={() => oninstallclient(ext.companion ?? "")}>{t("설치")}</button>{/snippet}
		</Notice>
	{/if}

	{#if client && clientOff}
		<Notice tone="warn" size="sm" icon="clip" role="status">
			{t("함께 쓰는 ‘{name}’ 확장이 꺼져 있습니다. 켜야 제대로 동작합니다.", { name: client.name })}
			{#snippet action()}{#if onenableclient}<button type="button" disabled={busy} onclick={() => onenableclient(client.id)}>{t("켜기")}</button>{/if}{/snippet}
		</Notice>
	{:else if client && onopenclient}
		<Notice tone="info" size="sm" icon="clip" role="status">
			{t("‘{name}’ 확장과 함께 작동합니다.", { name: client.name })}
			{#snippet action()}<button type="button" onclick={() => onopenclient(client.id)}>{t("열기")}</button>{/snippet}
		</Notice>
	{/if}

	{#if own.status === "ask" || own.status === "changed"}
		<Notice tone="danger" size="sm" icon="shield" role="status">
			<span>
				{own.status === "changed" ? t("이 확장이 화면 코드를 바꿨습니다.") : t("이 확장은 자기 설정 화면을 직접 그리는 코드를 가지고 있습니다.")}
				{t("격리 없이 앱 안에서 직접 실행되어 대화와 서버 토큰을 포함한 모든 데이터에 접근합니다. 신뢰하는 확장만 허용하세요.")}
				<code>{own.names.join(", ")}</code>
			</span>
			{#snippet action()}<button type="button" disabled={busy} onclick={() => ownPageUis.allow(uiServer, ext.name, ext.settingsId)}>{t("이 기기에서 허용")}</button>{/snippet}
		</Notice>
	{:else if own.status === "ready"}
		<Notice tone="info" size="sm" icon="shield" role="status">
			{t("이 기기에서 이 확장의 화면 코드를 실행 중입니다.")}
			{#snippet action()}<button type="button" onclick={() => ownPageUis.revoke(uiServer, ext.name)}>{t("허용 취소")}</button>{/snippet}
		</Notice>
	{:else if own.status === "error"}
		<Notice tone="warn" size="sm" role="status">{t("확장의 화면 코드를 실행하지 못했습니다: {message}", { message: own.message })}</Notice>
	{/if}
	{@render top()}
	{@render ownTop()}

	{#if surface}
		<section class="block set-group">
			<h3 class="section-label">{t("현재 상태")}</h3>
			<ExtensionSurface panel={surface} />
		</section>
	{:else if shownPage.problem}
		<Notice tone="warn" size="sm" role="status">{t("확장이 보낸 화면을 표시하지 못했습니다.")}</Notice>
	{/if}

	{#if ext.tools.length || ext.commands.length || ext.flags.length}
		<section class="block set-group">
			<h3 class="section-label">{t("제공 기능")}</h3>
			{#if provides.length}<p class="brief">{provides.join(", ")}</p>{/if}
			{#each ext.flags as flag (flag.name)}
				<p class="hint"><code>{flagVariable(flag.name)}</code>{flag.description ? ` — ${flag.description}` : ""}{flag.value !== undefined ? ` (${t("현재 값")}: ${String(flag.value)})` : ""}</p>
			{/each}
		</section>
	{/if}

	<section class="block set-group">
		<h3 class="section-label">{t("확장 설정")}</h3>
		{#if ownReady?.settings}
			{@const Section = ownReady.settings}
			<svelte:boundary onerror={(cause) => extensions.log(ext.name, `settings: ${cause instanceof Error ? cause.message : String(cause)}`)}>
				<Section {...pageProps} fallback={settingsSection} />
				{#snippet failed()}{@render settingsSection()}{/snippet}
			</svelte:boundary>
		{:else}
			{@render settingsSection()}
		{/if}
	</section>
</ExtensionPage>

<style>
	.hint { overflow-wrap: anywhere; }
	p { margin: 0; }
	.description { white-space: pre-wrap; overflow-wrap: anywhere; color: var(--text-dim); }
	.brief { font-size: var(--fs-xs); color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	section { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
	.block { gap: 8px; }
</style>
