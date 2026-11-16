<script lang="ts">
	import { t } from "../../lib/i18n";
	import Icon from "../ui/Icon.svelte";
	import { tilde } from "../../lib/format";
	import { app } from "../../lib/store.svelte";
	import { tailKeepLast } from "../../lib/fit-text";

	/** Pill above the composer showing the folder a new chat will work in; a press opens the folder picker. */
	let { path, onclick }: { path: string; onclick: () => void } = $props();
	/** The home folder reads as `~`, like the sidebar, so the part that matters survives a narrow screen. */
	const shown = $derived(tilde(path, app.workspace?.home));
</script>

<button class="where mono tap" {onclick} title={t("새 대화가 작업할 폴더 (눌러서 바꾸기)")} aria-label={t("작업 폴더: {path}", { path })}>
	<Icon name="folder" />
	<span class="p" title={path} use:tailKeepLast={shown || t("서버 기본 폴더")}></span>
	<span class="chg">{t("변경")}</span>
</button>

<style>
	.where {
		display: flex;
		align-items: center;
		gap: 8px;
		max-width: 100%;
		height: 28px;
		margin: 0 0 8px 0; /* aligned with the composer box's left edge */
		padding: 0 8px 0 8px;
		font-size: var(--fs-xs);
		line-height: 16px; /* whole-pixel label beside the folder glyph (rule 3) */
		color: var(--text-dim);
		background: var(--bg-elev);
		border: 1px solid var(--border);
		border-radius: var(--radius-pill);
		transition:
			border-color var(--motion-fast) var(--ease-std),
			color var(--motion-fast) var(--ease-std);
	}
	@media (hover: hover) {
		.where:hover {
			color: var(--text);
			border-color: var(--border-strong);
		}
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
