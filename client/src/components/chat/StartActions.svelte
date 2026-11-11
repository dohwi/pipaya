<script lang="ts">
	import Notice from "../ui/Notice.svelte";
	import Button from "../ui/Button.svelte";
	import FilterChip from "../ui/FilterChip.svelte";
	import { t } from "../../lib/i18n";
	import { app } from "../../lib/store.svelte";
	import { runCommand } from "../../lib/commands";
	import { recentDirs } from "../../lib/start-actions";

	/** What to do from an empty conversation: connect a model when there is none, else pick a folder, reopen a closed chat, and the `/` `@` hint. */
	const noModel = $derived(!app.models.some((m) => m.configured));
	const dirs = $derived(recentDirs(app.workspace, app.workdir));
</script>

<div class="start">
	{#if noModel && app.sessionsLoaded}
		<Notice tone="warn" icon="key">
			{t("사용할 수 있는 모델이 아직 없습니다.")}
			{#snippet action()}<button type="button" class="tap" onclick={() => app.openSettings("agent")}>{t("모델 연결")}</button>{/snippet}
		</Notice>
	{/if}
	{#if dirs.length > 1}
		<div class="row">
			<span class="label">{t("최근 작업 폴더")}</span>
			<div class="chips">
				{#each dirs as d (d.path)}
					<FilterChip size="sm" mono on={d.current} title={d.title} onclick={() => app.changeWorkdir(d.path)}>{d.label}</FilterChip>
				{/each}
			</div>
		</div>
	{/if}
	<div class="row">
		<Button size="sm" onclick={() => runCommand("cd")}>{t("폴더 바꾸기")}</Button>
		<Button size="sm" onclick={() => runCommand("resume")}>{t("닫은 대화 다시 열기")}</Button>
	</div>
	<p class="hint">{t("/ 로 명령, @ 로 파일을 불러옵니다")}</p>
</div>

<style>
	.start {
		container-type: inline-size;
		width: 100%;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 12px;
		margin-top: 16px;
		pointer-events: auto;
	}
	.start :global(.notice) {
		text-align: left;
		max-width: 100%;
	}
	.row {
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		align-items: center;
		gap: 8px;
		max-width: 100%;
	}
	.label {
		font-size: var(--fs-sm);
		color: var(--text-dim);
		line-height: 20px;
	}
	.chips {
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		gap: 4px;
		min-width: 0;
	}
	.hint {
		margin: 0;
		font-size: var(--fs-xs);
		color: var(--text-faint);
		line-height: 16px;
		word-break: keep-all;
		text-wrap: balance;
	}
	/* a narrow split pane: the label sits above its chips */
	@container (max-width: 320px) {
		.label {
			flex-basis: 100%;
			text-align: center;
		}
	}
</style>
