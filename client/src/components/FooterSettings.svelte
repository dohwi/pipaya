<script lang="ts">
	import Button from "./Button.svelte";
	import Icon from "./Icon.svelte";
	import Segmented from "./Segmented.svelte";
	import SettingRow from "./SettingRow.svelte";
	import Switch from "./Switch.svelte";
	import { msg, t } from "../lib/i18n";
	import { app } from "../lib/store.svelte";
	import { DEFAULT_FOOTER, type FooterAlign, type FooterItemId, type FooterLayout } from "../lib/footer-prefs";

	/** Footer = the line of counts and figures under the input. Which items show, their order, and how a full line behaves; this device only. */
	const labels: Record<FooterItemId, { name: string; icon: string }> = {
		elapsed: { name: msg("경과 시간"), icon: "clock" },
		agents: { name: msg("AGENTS.md"), icon: "prompt" },
		skills: { name: msg("스킬"), icon: "skill" },
		mcp: { name: msg("MCP 서버"), icon: "plug" },
		roles: { name: msg("도우미 역할"), icon: "bot" },
		commands: { name: msg("확장 명령"), icon: "list" },
		context: { name: msg("컨텍스트 사용량"), icon: "bolt" },
		cache: { name: msg("캐시 적중률"), icon: "cache" },
		speed: { name: msg("출력 속도"), icon: "gauge" },
	};
	const layouts: { id: FooterLayout; label: string }[] = [
		{ id: "auto", label: msg("자동") },
		{ id: "wrap", label: msg("줄바꿈") },
		{ id: "scroll", label: msg("한 줄 스크롤") },
	];
	const aligns: { id: FooterAlign; label: string }[] = [
		{ id: "center", label: msg("가운데") },
		{ id: "start", label: msg("왼쪽") },
	];
	const f = $derived(app.prefs.footer);
	const changed = $derived(JSON.stringify(f) !== JSON.stringify(DEFAULT_FOOTER));
</script>

<div class="head">
	<div class="section-label">{t("푸터")}</div>
	<Button size="sm" disabled={!changed} onclick={() => app.prefs.resetFooter()}>{t("기본값으로")}</Button>
</div>
<span class="hint">{t("입력창 아래 줄에 띄울 항목과 순서입니다. 이 기기에만 적용됩니다")}</span>

<div class="list" role="list">
	{#each f.order as id, i (id)}
		{@const shown = !f.hidden.includes(id)}
		<div class="item" class:off={!shown} role="listitem">
			<Icon name={labels[id].icon as never} />
			<span class="name">{t(labels[id].name)}</span>
			<button class="mv tap" aria-label={t("위로")} disabled={i === 0} onclick={() => app.prefs.moveFooterItem(id, -1)}><Icon name="arrow-up" /></button>
			<button class="mv tap" aria-label={t("아래로")} disabled={i === f.order.length - 1} onclick={() => app.prefs.moveFooterItem(id, 1)}><Icon name="arrow-down" /></button>
			<Switch checked={shown} label={t(labels[id].name)} onchange={(on) => app.prefs.toggleFooterItem(id, on)} />
		</div>
	{/each}
</div>

<SettingRow label={t("항목이 많을 때")} hint={t("자동은 좁은 화면에서만 한 줄로 스크롤합니다. 줄바꿈은 입력창이 위아래로 움직일 수 있습니다")}>
	<Segmented size="sm" full={false} label={t("항목이 많을 때")} value={f.layout} options={layouts.map((o) => ({ id: o.id, label: t(o.label) }))} onchange={(layout) => app.prefs.setFooter({ layout })} />
</SettingRow>
<SettingRow label={t("정렬")}>
	<Segmented size="sm" full={false} label={t("푸터 정렬")} value={f.align} options={aligns.map((o) => ({ id: o.id, label: t(o.label) }))} onchange={(align) => app.prefs.setFooter({ align })} />
</SettingRow>

<style>
	.head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
	}
	.list {
		display: flex;
		flex-direction: column;
		gap: 1px; /* hairline between rows, like the other lists */
	}
	.item {
		display: flex;
		align-items: center;
		gap: 8px;
		height: 40px;
		font-size: var(--fs-md);
		color: var(--text);
	}
	.item.off .name,
	.item.off > :global(.ic) {
		color: var(--text-faint);
	}
	.name {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.mv {
		display: grid;
		place-items: center;
		width: 32px;
		height: 32px;
		border-radius: var(--radius-control);
		color: var(--text-dim);
	}
	.mv:hover:not(:disabled) {
		background: var(--bg-hover);
		color: var(--text);
	}
	.mv:disabled {
		opacity: 0.3;
	}
</style>
