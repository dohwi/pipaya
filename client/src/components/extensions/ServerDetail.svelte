<script lang="ts">
	import Notice from "../Notice.svelte";
	import { extensions } from "../../lib/extensions/host.svelte";
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
		onback,
		onsave,
		oninstallclient,
	}: {
		ext: ServerExt;
		/** Saved settings of this extension (`GET /extensions/settings`, by `settingsId`) */
		settings: Record<string, unknown> | undefined;
		busy: boolean;
		onback: () => void;
		onsave: (settings: Record<string, unknown>) => void;
		/** Download the client half and open its install preview. */
		oninstallclient: (id: string) => void;
	} = $props();

	const form = $derived(serverFields(ext));
	const provides = $derived(serverProvides(ext));
	/** A server extension that needs a client extension this device does not have runs only half. */
	const missingClient = $derived(!!ext.companion && !extensions.installed.some((e) => e.package.manifest.id === ext.companion));
</script>

<ExtensionPage id="extension-{srvKey(ext.name)}" name={ext.title ?? ext.name} sub={ext.name} {busy} {onback}>
	{#snippet meta()}
		{#if ext.version}<span class="meta">v{ext.version}</span>{/if}
		<span class="meta">{t("서버에서 실행")}</span>
	{/snippet}

	{#if serverText(ext)}<p class="description">{serverText(ext)}</p>{/if}
	{#if ext.error}<Notice tone="danger" size="sm" role="status">{ext.error}</Notice>{/if}
	{#if missingClient}
		<Notice tone="warn" size="sm" role="status" icon={false}>
			{t("클라이언트 확장 ‘{id}’도 설치해야 동작합니다.", { id: ext.companion ?? "" })}
			{#snippet action()}<button type="button" disabled={busy} onclick={() => oninstallclient(ext.companion ?? "")}>{t("설치")}</button>{/snippet}
		</Notice>
	{/if}

	<section class="block">
		<h3 class="label">{t("확장 설정")}</h3>
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
			<h3 class="label">{t("제공 기능")}</h3>
			{#if provides.length}<p class="brief">{provides.join(", ")}</p>{/if}
			{#each ext.flags as flag (flag.name)}
				<p class="hint"><code>{flagVariable(flag.name)}</code>{flag.description ? ` — ${flag.description}` : ""}{flag.value !== undefined ? ` (${t("현재 값")}: ${String(flag.value)})` : ""}</p>
			{/each}
		</section>
	{/if}
</ExtensionPage>

<style>
	.meta, .hint { font-size: var(--fs-xs); color: var(--text-faint); overflow-wrap: anywhere; }
	.meta { font-family: var(--mono); font-size: var(--fs-2xs); }
	p { margin: 0; }
	.description { white-space: pre-wrap; overflow-wrap: anywhere; color: var(--text-dim); }
	.brief { font-size: var(--fs-xs); color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	section { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
	.block { gap: 10px; padding-top: 14px; border-top: 1px solid var(--border); }
	h3.label { margin: 0; font-family: var(--mono); font-size: var(--fs-2xs); font-weight: 500; letter-spacing: 0.04em; color: var(--text-faint); }
</style>
