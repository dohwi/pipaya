<script lang="ts">
	import { t, tc } from "../lib/i18n";
	import { ACTIONS, formatCombo } from "../lib/keys";
	import type { ConfigurationPlan } from "../lib/extensions/configuration";
	import Badge from "./Badge.svelte";
	import Icon from "./Icon.svelte";
	import Notice from "./Notice.svelte";

	/**
	 * What importing a settings file would change, group by group, and what it promises; the person decides here.
	 * The plan is computed by the caller (`extensions.planImport`); a blocked plan cannot be applied.
	 */
	let { filename, plan, oncancel, onapply }: { filename: string; plan: ConfigurationPlan; oncancel: () => void; onapply: () => void } = $props();
</script>

<div class="review">
	<div class="rhead">
		<Icon name="file" />
		<span class="rname">{filename}</span>
		<button type="button" class="link" onclick={oncancel}>{t("다른 파일")}</button>
	</div>

	{#if plan.empty}
		<Notice tone="ok" size="sm">{t("이 파일의 내용은 지금 설정과 같습니다. 바꿀 것이 없습니다.")}</Notice>
	{:else}
		<div class="changes">
			{#if plan.servers.add.length || plan.servers.rename.length}
				<div class="group">
					<h4>{t("서버")}</h4>
					{#each plan.servers.add as s (s.baseUrl)}
						<div class="chg"><Badge tone="ok" size="sm" minWidth={34}>{t("추가")}</Badge><span class="cn">{s.name}</span><span class="cm mono">{s.baseUrl}</span></div>
					{/each}
					{#each plan.servers.rename as s (s.baseUrl)}
						<div class="chg"><Badge tone="warn" size="sm" minWidth={34}>{tc("rename", "이름")}</Badge><span class="cn">{s.from} → {s.to}</span><span class="cm mono">{s.baseUrl}</span></div>
					{/each}
				</div>
			{/if}
			{#if plan.extensions.install.length || plan.extensions.replace.length}
				<div class="group">
					<h4>{t("확장")}</h4>
					{#each plan.extensions.install as e (e.id)}
						<div class="chg"><Badge tone="ok" size="sm" minWidth={34}>{t("설치")}</Badge><span class="cn">{e.name}</span><span class="cm">v{e.version}</span></div>
					{/each}
					{#each plan.extensions.replace as e (e.id)}
						<div class="chg"><Badge tone="warn" size="sm" minWidth={34}>{t("교체")}</Badge><span class="cn">{e.name}</span><span class="cm">v{e.from} → v{e.to}</span></div>
					{/each}
				</div>
			{/if}
			{#if plan.preferences.length}
				<div class="group">
					<h4>{t("앱 설정")}</h4>
					{#each plan.preferences as p (p)}
						<div class="chg"><Badge tone="warn" size="sm" minWidth={34}>{t("변경")}</Badge><span class="cn">{p}</span></div>
					{/each}
				</div>
			{/if}
			{#if plan.keybindings.length}
				<div class="group">
					<h4>{t("단축키")}</h4>
					{#each plan.keybindings as k (k.id)}
						<div class="chg"><Badge tone="warn" size="sm" minWidth={34}>{t("변경")}</Badge><span class="cn">{t(ACTIONS.find((a) => a.id === k.id)?.label ?? k.id)}</span><span class="cm">{k.from ? formatCombo(k.from) : t("없음")} → {k.to ? formatCombo(k.to) : t("없음")}</span></div>
					{/each}
				</div>
			{/if}
		</div>

		<ul class="assure">
			<li>{t("이미 있는 서버는 주소로 찾아 이름만 맞추고, 토큰은 그대로 둡니다.")}</li>
			{#if plan.extensions.install.length || plan.extensions.replace.length}
				<li>{t("확장은 이 기기의 확장으로, 모두 꺼진 상태로 들어옵니다. 권한을 확인한 뒤 직접 켜세요.")}</li>
			{/if}
			<li>{t("적용하기 직전의 상태를 이 기기에 백업해 두어, 아래에서 되돌릴 수 있습니다.")}</li>
		</ul>
	{/if}

	{#if plan.blocked}<Notice tone="danger" size="sm" role="alert">{plan.blocked}</Notice>{/if}

	<div class="actions">
		<button type="button" class="btn" onclick={oncancel}>{t("취소")}</button>
		{#if !plan.empty}
			<button type="button" class="btn primary" disabled={!!plan.blocked} onclick={onapply}>{t("적용하기")}</button>
		{/if}
	</div>
</div>

<style>

	.review {
		display: flex;
		flex-direction: column;
		gap: 14px;
		padding: 14px;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--bg-elev);
	}
	.rhead {
		display: flex;
		align-items: center;
		gap: 8px;
		color: var(--text-dim);
	}
	.rname {
		flex: 1;
		min-width: 0;
		font-size: var(--fs-sm);
		color: var(--text);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.link {
		padding: 0;
		font-size: inherit;
		color: var(--text);
		text-decoration: underline;
		text-underline-offset: 3px;
	}
	.rhead .link {
		font-size: var(--fs-xs);
		color: var(--text-dim);
	}
	.changes {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}
	.group {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.group h4 {
		margin: 0 0 2px;
		font-size: var(--fs-xs);
		font-weight: 600;
		color: var(--text-dim);
	}
	.chg {
		display: flex;
		align-items: baseline;
		gap: 8px;
		min-width: 0;
		font-size: var(--fs-sm);
	}
	.cn {
		overflow-wrap: anywhere;
	}
	.cm {
		margin-left: auto;
		padding-left: 8px;
		font-size: var(--fs-xs);
		color: var(--text-faint);
		overflow-wrap: anywhere;
		text-align: right;
	}
	.assure {
		margin: 0;
		padding: 0 0 0 18px;
		display: flex;
		flex-direction: column;
		gap: 4px;
		font-size: var(--fs-xs);
		line-height: 1.5;
		color: var(--text-dim);
	}
	.rhead :global(svg) {
		flex: none;
		stroke: currentColor;
		fill: none;
		stroke-width: 1.9;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
</style>
