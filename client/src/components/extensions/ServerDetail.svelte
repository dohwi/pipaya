<script lang="ts">
	import Button from "../ui/Button.svelte";
	import Notice from "../ui/Notice.svelte";
	import RemoveExtensionConfirm from "./RemoveExtensionConfirm.svelte";
	import { app } from "../../lib/store.svelte";
	import { extensionUpdates } from "../../lib/extension-updates.svelte";
	import { flagVariable, serverFields, serverProvides, serverText, serverTitle, srvKey, type ServerExt } from "../../lib/server-extension";
	import { t } from "../../lib/i18n";
	import ExtensionPage from "./ExtensionPage.svelte";
	import ExtensionMount from "./ExtensionMount.svelte";
	import ExtensionPart from "./ExtensionPart.svelte";
	import ExtensionSurface from "./ExtensionSurface.svelte";
	import SettingsForm from "./SettingsForm.svelte";
	import { serverPanelView } from "../../lib/server-panel";
	import type { UIEvent } from "../../lib/extensions/ui";

	/**
	 * The page of one extension that runs inside the server: read-only except its settings, which every device shares.
	 * It says so when the client half it needs is not installed on the server.
	 */
	let {
		ext,
		settings,
		page,
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
	const pageProps = $derived({
		id: ext.settingsId, extension: ext.name, serverId: serverId ?? app.serverId, settings: settings ?? {}, fields: form.fields ?? [],
		panel: shownPage.view, disabled: busy, save: onsavepartial, call: oncall,
	});
</script>

<!-- A snippet, because `slot=` directly inside another component reads as a named-slot assignment -->
{#snippet top()}<ExtensionMount slot="extension.page.top" {owners} props={pageProps} />{/snippet}

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

	{@render top()}

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
		<ExtensionPart part="extension.settings" {owners} props={pageProps}>
			{#if form.fields}
				<SettingsForm id={ext.settingsId} fields={form.fields} value={settings ?? {}} disabled={busy} saveLabel={t("설정 저장")} {onsave} componentOwners={owners} />
			{:else if form.problem}
				<Notice tone="warn" size="sm" role="status">{form.problem}</Notice>
			{:else}
				<p class="hint">{t("이 확장은 편집할 수 있는 설정이 없습니다.")}</p>
			{/if}
		</ExtensionPart>
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
