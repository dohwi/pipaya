<script lang="ts">
	import { t } from "../lib/i18n";
	import Icon from "./Icon.svelte";

	/** Pill above the composer showing the folder a new chat will work in; a press opens the folder picker. */
	let { path, onclick }: { path: string; onclick: () => void } = $props();
</script>

<button class="where mono" {onclick} title={t("새 대화가 작업할 디렉터리 (눌러서 바꾸기)")} aria-label={t("작업 디렉터리: {path}", { path })}>
	<Icon name="folder" />
	<span class="p">{path || t("서버 기본 디렉터리")}</span>
	<span class="chg">{t("변경")}</span>
</button>

<style>
	.where {
		display: flex;
		align-items: center;
		gap: 7px;
		max-width: 100%;
		height: 28px;
		margin: 0 0 8px 2px;
		padding: 0 10px 0 8px;
		font-size: var(--fs-xs);
		color: var(--text-dim);
		background: var(--bg-elev);
		border: 1px solid var(--border);
		border-radius: var(--radius-pill);
		transition:
			border-color var(--motion-fast) var(--ease-std),
			color var(--motion-fast) var(--ease-std);
	}
	.where:hover {
		color: var(--text);
		border-color: var(--border-strong);
	}
	.where :global(svg) {
		width: 14px;
		height: 14px;
		flex: none;
		stroke-width: 1.8;
	}
	.p {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		text-align: left;
	}
	.chg {
		flex: none;
		color: var(--text-faint);
	}
</style>
