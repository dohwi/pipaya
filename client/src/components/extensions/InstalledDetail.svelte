<script lang="ts">
	import Button from "../Button.svelte";
	import Notice from "../Notice.svelte";
	import Switch from "../Switch.svelte";
	import { CONFIG_REQUIRED, extensions, type InstalledExtension } from "../../lib/extensions/host.svelte";
	import type { ExtensionTasks } from "../../lib/extension-tasks.svelte";
	import { t } from "../../lib/i18n";
	import ExtensionPage from "./ExtensionPage.svelte";
	import PermissionList from "./PermissionList.svelte";
	import RemoveConfirm from "./RemoveConfirm.svelte";
	import SettingsForm from "./SettingsForm.svelte";

	/**
	 * The page of one installed extension: on/off switch, its settings (a form when it declares fields, else raw JSON),
	 * what it may do, and reload / export / delete. Doing things is the caller's (`on…`); what is busy and which delete
	 * question is open lives in `tasks`.
	 */
	let {
		entry,
		tasks,
		drafts,
		bundledBy,
		onback,
		onenable,
		ondisable,
		onsave,
		onreload,
		onexport,
		onaskremove,
		oncancelremove,
		onremove,
	}: {
		entry: InstalledExtension;
		tasks: ExtensionTasks;
		/** Unsaved text of the raw JSON editor, by extension id */
		drafts: Record<string, string>;
		/** Name of the server extension that carries this one as its client half, if any */
		bundledBy?: string;
		onback: () => void;
		onenable: () => void;
		ondisable: () => void;
		onsave: (settings?: Record<string, unknown>) => void;
		onreload: () => void;
		onexport: () => void;
		onaskremove: (event: Event) => void;
		oncancelremove: () => void;
		onremove: (keepSettings: boolean) => void;
	} = $props();

	const id = $derived(entry.package.manifest.id);
	const fields = $derived(entry.package.manifest.settings);
	const gated = $derived(!!fields && extensions.configRequired(id));
	const on = $derived(entry.state === "active" || entry.state === "starting");
	const problem = $derived(on ? "" : gated ? t(CONFIG_REQUIRED) : extensions.settingsProblem(id));
	const saveLabel = $derived(entry.state === "active" ? t("설정 저장 및 다시 불러오기") : t("설정 저장"));
</script>

<ExtensionPage id="extension-{id}" name={entry.package.manifest.name} sub={id} busy={tasks.busy[id] || entry.state === "starting"} {onback}>
	{#snippet meta()}<span class="meta">v{entry.package.manifest.version}{#if entry.state === "starting"} · {t("시작 중")}{:else if entry.state === "error"} · {t("오류")}{/if}</span>{/snippet}
	{#snippet control()}
		<Switch
			checked={on}
			label={t("{name} 사용", { name: entry.package.manifest.name })}
			disabled={tasks.busy[id] || entry.state === "starting" || (!on && (extensions.safeMode || !!problem))}
			describedby={problem ? `extension-blocked-${id}` : undefined}
			onchange={(next) => (next ? onenable() : ondisable())}
		/>
	{/snippet}

	{#if entry.package.manifest.description}<p class="description">{entry.package.manifest.description}</p>{/if}
	{#if bundledBy}<Notice tone="info" size="sm" icon="server" role="status">{t("서버 확장 ‘{name}’에 동봉된 클라이언트 확장입니다. 그 서버 확장과 함께 설치되어 작동합니다.", { name: bundledBy })}</Notice>{/if}
	{#if entry.error}<Notice tone="danger" size="sm" role="status">{entry.error}</Notice>{/if}
	{#if problem}<Notice tone="warn" size="sm" id="extension-blocked-{id}">{t("켤 수 없습니다.")} {problem}</Notice>{/if}

	<section class="block">
		<h3 class="section-label">{t("확장 설정")}</h3>
		{#if fields}
			{#if gated}<p class="hint">{t("새로 설치한 확장입니다. 기본값을 확인하고 설정을 저장하면 켤 수 있습니다.")}</p>{/if}
			<SettingsForm {id} {fields} value={entry.settings} disabled={tasks.busy[id] || entry.state === "starting"} {saveLabel} {onsave} />
		{:else}
			<label class="settings-label" for="extension-settings-{id}">{t("설정 JSON 객체")}</label>
			<textarea id="extension-settings-{id}" rows="6" spellcheck="false" value={drafts[id] ?? JSON.stringify(entry.settings, null, 2)} disabled={tasks.busy[id]} oninput={(event) => { drafts[id] = event.currentTarget.value; }}></textarea>
			<p class="hint">{t("JSON 객체만 저장할 수 있습니다 (최대 16KB). 켜져 있는 확장은 다시 불러와 적용하고, 꺼져 있으면 다음에 켤 때 적용합니다.")}</p>
			<div class="row">
				<Button size="sm" disabled={tasks.busy[id] || entry.state === "starting"} onclick={() => onsave()}>{saveLabel}</Button>
			</div>
		{/if}
	</section>

	<section class="block">
		<h3 class="section-label">{t("권한과 실행 안내")}</h3>
		<PermissionList pkg={entry.package} />
	</section>

	<section class="block">
		<h3 class="section-label">{t("관리")}</h3>
		<div class="row">
			<Button size="sm" disabled={extensions.safeMode || tasks.busy[id] || entry.state !== "active"} onclick={onreload}>{t("다시 불러오기")}</Button>
			<Button size="sm" disabled={tasks.busy[id]} onclick={onexport}>{t("내보내기")}</Button>
			<Button variant="danger" size="sm" class="end" disabled={tasks.busy[id]} aria-expanded={tasks.removing === id} onclick={onaskremove}>{t("삭제")}</Button>
		</div>
		{#if tasks.removing === id}
			<RemoveConfirm labelledby="extension-remove-{id}" oncancel={oncancelremove}>
				<p id="extension-remove-{id}">{t("이 확장을 삭제합니다. 설정값은 어떻게 할까요?")}</p>
				<div class="row">
					<Button size="sm" disabled={tasks.busy[id]} onclick={() => onremove(true)}>{t("설정 유지하고 삭제")}</Button>
					<Button variant="danger" size="sm" disabled={tasks.busy[id]} onclick={() => onremove(false)}>{t("설정까지 삭제")}</Button>
					<Button size="sm" data-cancel disabled={tasks.busy[id]} onclick={oncancelremove}>{t("취소")}</Button>
				</div>
			</RemoveConfirm>
		{/if}
	</section>
</ExtensionPage>

<style>
	.meta, .hint { font-size: var(--fs-xs); color: var(--text-faint); overflow-wrap: anywhere; }
	.meta { font-family: var(--mono); font-size: var(--fs-2xs); }
	p { margin: 0; }
	.description { white-space: pre-wrap; overflow-wrap: anywhere; color: var(--text-dim); }
	section { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
	.block { gap: 10px; padding-top: 14px; border-top: 1px solid var(--border); }
	.row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
	.settings-label { font-size: var(--fs-xs); font-weight: 550; }
	textarea { display: block; width: 100%; box-sizing: border-box; min-height: 110px; resize: vertical; padding: 10px 12px; border: 1px solid var(--border-strong); border-radius: var(--radius-sm); background: var(--bg-code); color: var(--text); font-family: var(--mono); font-size: var(--fs-xs); line-height: 1.5; transition: border-color var(--motion-fast) var(--ease-std), box-shadow var(--motion-fast) var(--ease-std); }
	textarea:focus-visible { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
	.row :global(.btn.sm) { height: auto; min-height: 34px; padding: 6px 12px; white-space: normal; }
	.row :global(.btn.end) { margin-left: auto; }
	@media (max-width: 640px) {
		.row > :global(.btn) { flex: 1 1 auto; }
		.row :global(.btn.end) { margin-left: 0; }
	}
</style>
