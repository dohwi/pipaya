<script lang="ts">
	import { focusOnDesktop } from "../../lib/focus";
	import Button from "../ui/Button.svelte";
	import Badge from "../ui/Badge.svelte";
	import ConfirmButton from "../ui/ConfirmButton.svelte";
	import Icon from "../ui/Icon.svelte";
	import { t } from "../../lib/i18n";
	import { collapseIn, collapseOut } from "../../lib/motion";
	import type { CustomProvider } from "../../lib/types";

	/**
	 * One custom connection in the list: its name, address, state badge (usable, key needed, no models), a compact
	 * model count summary, and its actions (add/delete key, refresh models, edit, delete). Individual model toggles,
	 * tests and details live inside the Edit modal (`ConnectionForm`).
	 */
	let {
		p,
		busy,
		keying,
		keyValue = $bindable(),
		refreshing,
		anyRefreshing,
		ontogglekey,
		onsavekey,
		onremovekey,
		onrefresh,
		onedit,
		onremove,
	}: {
		p: CustomProvider;
		busy: boolean;
		keying: boolean;
		keyValue: string;
		refreshing: boolean;
		anyRefreshing: boolean;
		ontogglekey: () => void;
		onsavekey: () => void;
		onremovekey: () => void;
		onrefresh: () => void;
		onedit: () => void;
		onremove: () => void;
	} = $props();

	const activeCount = $derived(p.models.filter((m) => !m.disabled).length);
	const disabledCount = $derived(p.models.filter((m) => m.disabled).length);
	const unavailableCount = $derived(p.models.filter((m) => m.unavailable).length);
</script>

<div class="prov" class:off={!p.models.length} data-provider={p.id}>
	<div class="phead">
		<div class="pname">
			<span class="ptitle">{p.name}</span>
			<span class="pid mono url">{p.baseUrl}</span>
		</div>
		{#if !activeCount}<Badge>{t("모델 없음")}</Badge>{:else if p.configured}<Badge tone="ok">{t("사용 가능")}</Badge>{:else}<Badge tone="warn">{t("키 필요")}</Badge>{/if}
	</div>

	<div class="models">
		{#if !p.models.length}
			<div class="nomodels">
				<span>{t("모델이 없습니다. 모델을 추가해야 이 연결을 쓸 수 있습니다.")}</span>
				<Button size="sm" disabled={busy} onclick={onedit}><Icon name="plus" /> {t("모델 추가")}</Button>
			</div>
		{:else}
			<div class="msummary">
				<span>{t("모델 {n}개", { n: activeCount })}</span>
				{#if disabledCount}<span class="gone off">{t("꺼짐 {n}개", { n: disabledCount })}</span>{/if}
				{#if unavailableCount}<span class="gone">{t("사용 불가 {n}개", { n: unavailableCount })}</span>{/if}
			</div>
		{/if}
	</div>

	<div class="actions">
		{#if p.authRequired}
			{#if p.hasStoredKey}
				<ConfirmButton size="sm" danger confirmLabel={t("정말 삭제")} disabled={busy} onconfirm={onremovekey}><Icon name="key" /> {t("키 삭제")}</ConfirmButton>
			{:else}
				<Button size="sm" onclick={ontogglekey}><Icon name="key" /> {t("키 추가")}</Button>
			{/if}
		{/if}
		<Button size="sm" disabled={busy || anyRefreshing || !p.configured} onclick={onrefresh} title={p.configured ? t("업스트림의 모델 목록을 다시 불러옵니다") : t("키를 먼저 추가하세요")}>
			<span class="spinwrap" class:spin={refreshing}><Icon name="retry" /></span> {refreshing ? t("불러오는 중…") : t("모델 새로고침")}
		</Button>
		<Button size="sm" disabled={busy} onclick={onedit}><Icon name="pencil" /> {t("수정")}</Button>
		<ConfirmButton size="sm" danger confirmLabel={t("정말 삭제")} disabled={busy} onconfirm={onremove}>{t("삭제")}</ConfirmButton>
	</div>
	{#if keying}
		<form class="keyform" in:collapseIn out:collapseOut onsubmit={(e) => { e.preventDefault(); onsavekey(); }}>
			<input class="field" type="password" placeholder={t("API 키")} bind:value={keyValue} autocomplete="off" autocapitalize="off" spellcheck="false" use:focusOnDesktop />
			<Button variant="primary" type="submit" disabled={busy || !keyValue.trim()}>{t("저장")}</Button>
		</form>
	{/if}
</div>

<style>
	.nomodels {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		flex-wrap: wrap;
		font-size: var(--fs-xs);
		color: var(--text-dim);
	}
	.msummary {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
		font-size: var(--fs-xs);
		line-height: 18px;
		color: var(--text-dim);
	}
	.url {
		font-size: var(--fs-xs);
		color: var(--text-dim);
		overflow-wrap: anywhere;
	}
	.prov {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 12px;
		border-bottom: 1px solid var(--border);
		background: transparent;
	}
	.phead {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.pname {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
	}
	.pid {
		font-size: var(--fs-2xs);
		line-height: 16px;
		color: var(--text-faint);
	}
	.ptitle {
		font-weight: 550;
		font-size: var(--fs-md);
		line-height: 20px;
	}
	.prov.off .phead,
	.prov.off .nomodels > span {
		opacity: 0.55;
	}
	.gone {
		color: var(--text-faint);
	}
	.spinwrap {
		display: inline-flex;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}
	.keyform {
		display: flex;
		align-items: center;
		gap: 8px;
	}
</style>
