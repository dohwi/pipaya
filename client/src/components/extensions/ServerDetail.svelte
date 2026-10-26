<script lang="ts">
	import Button from "../Button.svelte";
	import Notice from "../Notice.svelte";
	import RemoveConfirm from "./RemoveConfirm.svelte";
	import { extensions } from "../../lib/extensions/host.svelte";
	import { extensionUpdates } from "../../lib/extension-updates.svelte";
	import { flagVariable, serverFields, serverProvides, serverText, srvKey, type ServerExt } from "../../lib/server-extension";
	import { t } from "../../lib/i18n";
	import ExtensionPage from "./ExtensionPage.svelte";
	import SettingsForm from "./SettingsForm.svelte";

	/**
	 * The page of one extension that runs inside the server: read-only except its settings, which every device shares.
	 * It says so when the client half it needs is not installed here.
	 */
	let {
		ext,
		settings,
		busy,
		upgrade,
		onback,
		onsave,
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
		/** Saved settings of this extension (`GET /extensions/settings`, by `settingsId`) */
		settings: Record<string, unknown> | undefined;
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
	/** A server extension that needs a client extension this device does not have runs only half. */
	const client = $derived(ext.companion ? extensions.installed.find((e) => e.package.manifest.id === ext.companion) : undefined);
	const clientOff = $derived(!!client && client.state !== "active" && client.state !== "starting");
	const missingClient = $derived(!!ext.companion && !extensions.installed.some((e) => e.package.manifest.id === ext.companion));
</script>

<ExtensionPage id="extension-{srvKey(ext.name)}" name={ext.title ?? ext.name} sub={ext.name} {busy} {upgrade} {onback}>
	{#snippet meta()}
		{#if ext.version}<span class="meta">v{ext.version}</span>{/if}
		<span class="meta">{t("서버에서 실행")}</span>
	{/snippet}

	{#if serverText(ext)}<p class="description">{serverText(ext)}</p>{/if}
	{#if ext.error}<Notice tone="danger" size="sm" role="status">{ext.error}</Notice>{/if}
	{#if missingClient}
		<Notice tone="warn" size="sm" icon="clip" role="status">
			{t("클라이언트 확장 ‘{name}’도 설치해야 동작합니다.", { name: (ext.companion && extensionUpdates.clientName(ext.companion)) || ext.companion || "" })}
			{#snippet action()}<button type="button" disabled={busy} onclick={() => oninstallclient(ext.companion ?? "")}>{t("설치")}</button>{/snippet}
		</Notice>
	{/if}

	{#if client && clientOff}
		<Notice tone="warn" size="sm" icon="clip" role="status">
			{t("클라이언트 확장 ‘{name}’이 꺼져 있습니다. 켜야 제대로 동작합니다.", { name: client.package.manifest.name })}
			{#snippet action()}{#if onenableclient}<button type="button" disabled={busy || client.state === "error"} onclick={() => onenableclient(client.package.manifest.id)}>{t("켜기")}</button>{/if}{/snippet}
		</Notice>
	{:else if client && onopenclient}
		<Notice tone="info" size="sm" icon="clip" role="status">
			{t("클라이언트 확장 ‘{name}’과 함께 작동합니다.", { name: client.package.manifest.name })}
			{#snippet action()}<button type="button" onclick={() => onopenclient(client.package.manifest.id)}>{t("열기")}</button>{/snippet}
		</Notice>
	{/if}

	<section class="block">
		<h3 class="section-label">{t("확장 설정")}</h3>
		{#if form.fields}
			<SettingsForm id={ext.settingsId} fields={form.fields} value={settings ?? {}} disabled={busy} saveLabel={t("설정 저장")} {onsave} />
		{:else if form.problem}
			<Notice tone="warn" size="sm" role="status">{form.problem}</Notice>
		{:else}
			<p class="hint">{t("이 확장은 편집할 수 있는 설정이 없습니다.")}</p>
		{/if}
	</section>

	{#if ext.tools.length || ext.commands.length || ext.flags.length}
		<section class="block">
			<h3 class="section-label">{t("제공 기능")}</h3>
			{#if provides.length}<p class="brief">{provides.join(", ")}</p>{/if}
			{#each ext.flags as flag (flag.name)}
				<p class="hint"><code>{flagVariable(flag.name)}</code>{flag.description ? ` — ${flag.description}` : ""}{flag.value !== undefined ? ` (${t("현재 값")}: ${String(flag.value)})` : ""}</p>
			{/each}
		</section>
	{/if}

	<section class="block">
		<h3 class="section-label">{t("관리")}</h3>
		<div class="row">
			<Button variant="danger" size="sm" disabled={busy} aria-expanded={removing} onclick={onaskremove}>{t("삭제")}</Button>
		</div>
		{#if removing}
			<RemoveConfirm labelledby="extension-remove-{srvKey(ext.name)}" oncancel={oncancelremove}>
				<p id="extension-remove-{srvKey(ext.name)}">{t("이 확장을 삭제합니다. 설정값은 어떻게 할까요?")}</p>
				<div class="row">
					<Button size="sm" disabled={busy} onclick={() => onremove(true)}>{t("설정 유지하고 삭제")}</Button>
					<Button variant="danger" size="sm" disabled={busy} onclick={() => onremove(false)}>{t("설정까지 삭제")}</Button>
					<Button size="sm" data-cancel disabled={busy} onclick={oncancelremove}>{t("취소")}</Button>
				</div>
			</RemoveConfirm>
		{/if}
	</section>
</ExtensionPage>

<style>
	.meta, .hint { font-size: var(--fs-xs); color: var(--text-faint); overflow-wrap: anywhere; }
	.meta { font-family: var(--mono); font-size: var(--fs-2xs); }
	p { margin: 0; }
	.row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
	.description { white-space: pre-wrap; overflow-wrap: anywhere; color: var(--text-dim); }
	.brief { font-size: var(--fs-xs); color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	section { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
	.block { gap: 10px; padding-top: 14px; border-top: 1px solid var(--border); }
</style>
