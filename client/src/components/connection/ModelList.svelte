<script lang="ts">
	import Button from "../Button.svelte";
	import Badge from "../Badge.svelte";
	import Icon from "../Icon.svelte";
	import IconButton from "../IconButton.svelte";
	import ConfirmButton from "../ConfirmButton.svelte";
	import ModelLogo from "../ModelLogo.svelte";
	import { t } from "../../lib/i18n";
	import { collapseIn, collapseOut } from "../../lib/motion";
	import type { Form, Row } from "../../lib/connection-form";
	import type { CatalogModel } from "../../lib/types";

	/**
	 * The models of the connection being edited, one line each (logo, name, limits, and a badge when something needs the
	 * user: not fetched, no id, not matched to the catalog), with the button that fetches the upstream's list and the one
	 * that adds a blank model. Opening a line is the caller's (`onopen`).
	 */
	let {
		form,
		connection,
		busy,
		discovering,
		note,
		catalogLoaded,
		matchedOf,
		onopen,
		onadd,
		ondiscover,
		onremove,
		onprune,
	}: {
		form: Form;
		connection: { baseUrl: string; token: string } | null | undefined;
		busy: boolean;
		discovering: boolean;
		note: string;
		catalogLoaded: boolean;
		matchedOf: (r: Row) => CatalogModel | null;
		onopen: (index: number) => void;
		onadd: () => void;
		ondiscover: () => void;
		onremove: (index: number) => void;
		/** drop every model the upstream no longer lists */
		onprune: () => void;
	} = $props();

	const gone = $derived(form.rows.filter((r) => r.unavailable).length);
</script>

<section class="fsec">
	<div class="mhead">
		<div class="section-label">{t("모델 ({n})", { n: form.rows.length })}</div>
		<div class="mact">
			<Button size="sm" disabled={discovering || busy} onclick={ondiscover}>
				<Icon name="download" /> {discovering ? t("불러오는 중…") : t("업스트림에서 불러오기")}
			</Button>
			{#if gone > 1}
				<ConfirmButton size="sm" danger confirmLabel={t("정말 삭제")} disabled={busy} onconfirm={onprune}>{t("불러오지 못한 {n}개 삭제", { n: gone })}</ConfirmButton>
			{/if}
		</div>
	</div>
	{#if note}<p class="hint note" role="status" in:collapseIn out:collapseOut>{note}</p>{/if}
	<div class="mpick">
		{#each form.rows as r, i (i)}
			<div class="mitem" class:off={r.disabled || r.unavailable}>
			<button type="button" class="mopen" onclick={() => onopen(i)}>
				<span class="mlogo"><ModelLogo conn={connection} icon={r.icon} provider={form.id} model={r.id} size={18} /></span>
				<span class="mname" title={r.name.trim() || r.id.trim()}>{r.name.trim() || r.id.trim() || t("새 모델")}{#if r.fromUpstream && !r.unavailable}<span class="lockic" title={t("업스트림 제공")}><Icon name="server" /></span>{/if}{#if matchedOf(r)}<span class="mchk" title={matchedOf(r)?.id}><Icon name="check" /></span>{/if}</span>
				{#if r.disabled}
					<Badge tone="neutral" size="sm">{t("꺼짐")}</Badge>
				{:else if r.unavailable}
					<Badge tone="neutral" size="sm"><Icon name="alert" />{t("불러오지 못함")}</Badge>
				{:else if !r.id.trim()}
					<Badge tone="danger" size="sm" mono><Icon name="alert" />{t("ID 필요")}</Badge>
				{:else if catalogLoaded && !matchedOf(r)}
					<Badge tone="neutral" size="sm"><Icon name="unlink" />{t("수동 입력")}</Badge>
				{/if}
				<Icon name="chevron-right" />
			</button>
			{#if r.unavailable}<IconButton icon="trash" label={t("{name} 삭제", { name: r.name.trim() || r.id.trim() })} tip size="sm" disabled={busy} onclick={() => onremove(i)} />{:else if gone}<span class="tspace" aria-hidden="true"></span>{/if}
			</div>
		{/each}
	</div>
	<Button variant="dashed" onclick={onadd}><Icon name="plus" /> {t("모델 추가")}</Button>
</section>

<style>
	.note {
		margin: 0;
	}
	.mhead {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
	}
	.mhead :global(svg) {
		width: 14px;
		height: 14px;
		stroke-width: 2;
	}
	.lockic {
		flex: none;
		display: inline-flex;
	}
	.mpick {
		display: flex;
		flex-direction: column;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		overflow: hidden;
	}
	.mact {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	/* keeps the chevron column straight when only some rows carry a delete button (32px = IconButton sm) */
	.tspace {
		flex: none;
		width: 32px;
	}
	.mopen {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: 8px;
		min-height: 46px;
		text-align: left;
	}
	.mitem {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 0 12px 0 12px;
		background: var(--bg-elev);
		border-bottom: 1px solid var(--border);
		transition: background var(--motion-fast) var(--ease-std);
	}
	.mitem:last-child {
		border-bottom: 0;
	}
	.mitem:hover {
		background: var(--bg-hover);
	}
	.mname {
		flex: 1;
		min-width: 0;
		font-size: var(--fs-md);
		font-weight: 550;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.mname :global(.lockic) {
		margin-left: 4px;
		vertical-align: -2px;
	}
	.mname :global(.lockic svg) {
		width: 13px;
		height: 13px;
		opacity: 0.7;
	}
	.mname :global(.mchk) {
		margin-left: 4px;
		vertical-align: -2px;
		display: inline-flex;
	}
	.mname :global(.mchk svg) {
		width: 13px;
		height: 13px;
		stroke: var(--ok);
		stroke-width: 2.4;
	}
	.mitem :global(svg:not(.model):not(.logo)) {
		flex: none;
		width: 16px;
		height: 16px;
		stroke: var(--text-faint);
		stroke-width: 1.9;
	}
	/* a badge's icon keeps the badge's own size and colour */
	/* same :not() chain as the generic icon rule above, or that rule (higher specificity) makes badge icons 16px */
	.mitem :global(.badge svg:not(.model):not(.logo)) {
		width: 11px;
		height: 11px;
		stroke: currentColor;
		stroke-width: 2.4;
	}
	.mitem.off .mname,
	.mitem.off .mlogo {
		opacity: 0.5;
	}
	.mlogo {
		flex: none;
		display: grid;
		place-items: center;
		color: var(--text-dim);
	}
	.mitem :global(svg.model) {
		stroke: none;
		fill: currentColor;
		width: 18px;
		height: 18px;
	}
	.fsec {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}
</style>
