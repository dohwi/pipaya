<script lang="ts">
	import { focusOnDesktop } from "../../lib/focus";
	import Button from "../Button.svelte";
	import Badge from "../Badge.svelte";
	import Switch from "../Switch.svelte";
	import Accordion from "../Accordion.svelte";
	import ConfirmButton from "../ConfirmButton.svelte";
	import Icon from "../Icon.svelte";
	import ModelLogo from "../ModelLogo.svelte";
	import { t } from "../../lib/i18n";
	import { compact } from "../../lib/format";
	import { collapseIn, collapseOut } from "../../lib/motion";
	import type { ConnectionResult, CustomProvider } from "../../lib/types";
	import CapTags from "../CapTags.svelte";

	/**
	 * One custom connection in the list: its name and address with a state chip (usable, key needed, no models), its
	 * models (each with a test button and the result), and its actions: add / delete the key, refresh the model list,
	 * edit, delete. Doing things is the caller's (`on…`); what is running comes in as props.
	 *
	 *  tests         results of the model tests, by `provider\u0000model`
	 *  keying        the key field under the card is open; `keyValue` is its text
	 *  refreshing    this card's model list is being fetched; `anyRefreshing` any card's (one at a time)
	 */
	let {
		p,
		conn,
		busy,
		tests,
		keying,
		keyValue = $bindable(),
		refreshing,
		anyRefreshing,
		ontest,
		ontoggle,
		ontogglekey,
		onsavekey,
		onremovekey,
		onrefresh,
		onedit,
		onremove,
	}: {
		p: CustomProvider;
		conn: { baseUrl: string; token: string } | null;
		busy: boolean;
		tests: Record<string, ConnectionResult | "running">;
		keying: boolean;
		keyValue: string;
		refreshing: boolean;
		anyRefreshing: boolean;
		ontest: (model: string) => void;
		/** Turn one model on or off (an off model is hidden from every picker) */
		ontoggle: (model: string, on: boolean) => void;
		ontogglekey: () => void;
		onsavekey: () => void;
		onremovekey: () => void;
		onrefresh: () => void;
		onedit: () => void;
		onremove: () => void;
	} = $props();

</script>

<div class="prov" class:off={!p.models.length}>
	<div class="phead">
		<div class="pname">
			<span class="ptitle">{p.name}</span>
			<span class="pid mono url">{p.baseUrl}</span>
		</div>
		{#if !p.models.some((m) => !m.disabled)}<span class="chip">{t("모델 없음")}</span>{:else if p.configured}<span class="chip ok">{t("사용 가능")}</span>{:else}<span class="chip warn">{t("키 필요")}</span>{/if}
	</div>

	<div class="models">
	{#if !p.models.length}
		<div class="nomodels">
			<span>{t("모델이 없습니다. 모델을 추가해야 이 연결을 쓸 수 있습니다.")}</span>
			<Button size="sm" disabled={busy} onclick={onedit}><Icon name="plus" /> {t("모델 추가")}</Button>
		</div>
	{:else}
	<Accordion variant="text">
	{#snippet head()}{t("모델 {n}개", { n: p.models.filter((m) => !m.disabled).length })}{#if p.models.some((m) => m.disabled)}<span class="gone off">{t("꺼짐 {n}개", { n: p.models.filter((m) => m.disabled).length })}</span>{/if}{#if p.models.some((m) => m.unavailable)}<span class="gone">{t("사용 불가 {n}개", { n: p.models.filter((m) => m.unavailable).length })}</span>{/if}{/snippet}
	<ul class="mlist">
		{#each [...p.models.filter((x) => !x.disabled), ...p.models.filter((x) => x.disabled)] as m (m.id)}
			{@const probe = tests[`${p.id}\u0000${m.id}`]}
			<li class:unavail={m.unavailable} class:disabled={m.disabled}>
				<span class="mlogo"><ModelLogo {conn} icon={m.icon} provider={p.id} model={m.id} size={16} /></span>
				<span class="minfo">
					<span class="mid mono">{m.name ?? m.id}</span>
					{#if m.name && m.name !== m.id}<span class="msub mono">{m.id}</span>{/if}
				</span>
				<span class="mtags">
					{#if m.unavailable}<Badge tone="danger" size="sm"><Icon name="alert" />{t("불러오지 못함")}</Badge>{/if}
					<CapTags model={m} end ctx={m.imageGeneration ? undefined : compact(m.contextWindow)} />
				</span>
				<Button variant="ghost" size="sm" class={m.disabled ? "hidden" : ""} disabled={m.disabled || probe === "running" || !p.configured || m.unavailable} tabindex={m.disabled ? -1 : undefined} onclick={() => ontest(m.id)} title={t("실제 모델 요청을 1회 보냅니다 (요금이 발생할 수 있음)")}>
					{probe === "running" ? t("확인 중…") : t("테스트")}
				</Button>
				<Switch checked={!m.disabled} disabled={busy} label={t("{id} 사용", { id: m.name ?? m.id })} onchange={(on) => ontoggle(m.id, on)} />
				{#if !m.disabled && probe && probe !== "running"}
					<span class="res {probe.ok ? 'ok' : 'bad'}" role="status">{probe.ok ? `${t("성공")} ${probe.durationMs}ms${probe.text ? ` · “${probe.text.trim().slice(0, 40)}”` : ""}` : (probe.error ?? t("실패"))}</span>
				{/if}
			</li>
		{/each}
	</ul>
	</Accordion>
	{/if}
	</div>

	<div class="actions">
		{#if p.authRequired}
			{#if p.hasStoredKey}
				<Button variant="ghost" size="sm" disabled={busy} onclick={onremovekey}><Icon name="key" /> {t("키 삭제")}</Button>
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
		font-size: 0.85em;
		color: var(--muted, inherit);
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
		padding: 8px 12px 12px;
		border-bottom: 1px solid var(--border);
		background: var(--bg-elev);
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
		color: var(--text-faint);
	}
	.ptitle {
		font-weight: 550;
		font-size: var(--fs-md);
	}
	.mlist {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.prov.off .phead,
	.prov.off .nomodels {
		opacity: 0.55;
	}
	.mlogo {
		flex: none;
		display: grid;
		place-items: center;
		color: var(--text-dim);
	}
	.mlist li {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 4px 8px;
		padding: 4px 8px 4px 8px;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: var(--bg);
		font-size: var(--fs-sm);
	}
	.minfo {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
	}
	.mid {
		font-size: var(--fs-sm);
		font-weight: 550;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.msub {
		font-size: var(--fs-2xs);
		color: var(--text-faint);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.mtags {
		display: flex;
		align-items: center;
		gap: 8px;
		color: var(--text-faint);
	}
	.gone {
		margin-left: 8px;
		color: var(--danger);
	}
	/* an off model keeps the test button's slot (invisible) so the switches stay in one column */
	.mlist li :global(.btn.hidden) {
		visibility: hidden;
	}
	.gone.off {
		color: var(--text-faint);
	}
	.mlist li.disabled .minfo,
	.mlist li.disabled .mlogo,
	.mlist li.disabled .mtags {
		opacity: 0.45;
	}
	.mlist li.unavail .minfo {
		opacity: 0.6;
	}
	.spinwrap {
		display: inline-flex;
	}
	.res {
		flex-basis: 100%;
		font-size: var(--fs-xs);
		overflow-wrap: anywhere;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
	}
	.keyform {
		display: flex;
		gap: 8px;
	}
	.res.ok {
		color: var(--ok);
	}
	.res.bad {
		color: var(--danger);
	}
</style>
