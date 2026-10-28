<script lang="ts">
	import Button from "../Button.svelte";
	import Notice from "../Notice.svelte";
	import type { UnreadableExtension } from "../../lib/extensions/host.svelte";
	import type { ExtensionTasks } from "../../lib/extension-tasks.svelte";
	import { t } from "../../lib/i18n";
	import RemoveExtensionConfirm from "./RemoveExtensionConfirm.svelte";

	/**
	 * An entry this version cannot read. Its raw data is kept (a version that understands it can read it again), so the
	 * only things offered are exporting that data and deleting it; an entry with an id asks what to do with its settings.
	 */
	let {
		item,
		index,
		tasks,
		onexport,
		onaskremove,
		oncancelremove,
		onremove,
	}: {
		item: UnreadableExtension;
		index: number;
		tasks: ExtensionTasks;
		onexport: () => void;
		onaskremove: (event: Event) => void;
		oncancelremove: () => void;
		onremove: (keepSettings: boolean) => void;
	} = $props();

	const key = $derived(`unreadable:${index}`);
	const name = $derived(item.name || item.id || t("알 수 없는 확장"));
</script>

<article class="card" aria-label={name}>
	<div class="heading">
		<h4>{name}</h4>
		<span class="state chip danger">{t("읽을 수 없음")}</span>
	</div>
	{#if item.id}<p class="meta">{item.id}</p>{/if}
	<Notice tone="warn" size="sm">{t("이 버전에서 지원하지 않는 형식입니다:")} {item.reason}</Notice>
	<p class="hint">{t("원본 데이터는 그대로 보관되어, 지원하는 버전에서 다시 읽을 수 있습니다. 같은 ID의 패키지를 가져오면 이 항목을 대체합니다.")}</p>
	<div class="row">
		<Button size="sm" disabled={tasks.busy[key]} onclick={onexport}>{t("원본 내보내기")}</Button>
		<Button variant="danger" size="sm" class="end" disabled={tasks.busy[key]} aria-expanded={tasks.removing === key} onclick={onaskremove}>{t("삭제")}</Button>
	</div>
	{#if tasks.removing === key}
		<RemoveExtensionConfirm name={name} busy={tasks.busy[key]} keepable={!!item.id} onkeep={() => onremove(true)} onwipe={() => onremove(false)} oncancel={oncancelremove} />
	{/if}
</article>

<style>
	.card { display: flex; flex-direction: column; gap: 8px; min-width: 0; padding: 12px 12px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--bg-elev); }
	.heading, .row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
	.heading { justify-content: space-between; flex-wrap: nowrap; }
	h4 { margin: 0; font-size: var(--fs-base); font-weight: 600; overflow-wrap: anywhere; min-width: 0; }
	p { margin: 0; }
	.meta, .hint { font-size: var(--fs-xs); color: var(--text-faint); overflow-wrap: anywhere; }
	.meta { font-family: var(--mono); font-size: var(--fs-2xs); }
	.row :global(.btn.sm) { height: auto; min-height: 34px; padding: 4px 12px; white-space: normal; }
	.row :global(.btn.end) { margin-left: auto; }
	@media (max-width: 640px) {
		.card { padding: 12px 12px; }
		.row > :global(.btn) { flex: 1 1 auto; }
		.row :global(.btn.end) { margin-left: 0; }
	}
</style>
