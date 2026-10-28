<script lang="ts">
	import type { Snippet } from "svelte";
	import { t } from "../../lib/i18n";
	import Icon from "../Icon.svelte";
	import Notice from "../Notice.svelte";
	import Button from "../Button.svelte";

	/**
	 * The frame of one extension's detail page, for an installed one and for one running on the server: the way back
	 * (shown only where the settings sidebar does not already list the extensions), the heading with its state line and
	 * the control at the right (the on/off switch, or a spinner), then the sections.
	 *
	 *  id        the page's DOM id, so the list can bring focus back to it
	 *  name      heading
	 *  meta      the small line next to the name (version, "runs on the server")
	 *  sub       the line under it (the extension's id)
	 *  busy      a task is running on this extension
	 *  control   what sits at the right of the heading
 *  upgrade   a newer catalog version: a notice under the heading with the update action, like the other "needs" notices
	 */
	let {
		id,
		name,
		meta,
		sub,
		busy = false,
		onback,
		control,
		upgrade,
		children,
	}: {
		id: string;
		name: string;
		meta?: Snippet;
		sub: string;
		busy?: boolean;
		onback: () => void;
		control?: Snippet;
		upgrade?: { version: string; disabled: boolean; onclick: () => void };
		children: Snippet;
	} = $props();
</script>

<div class="page" {id} tabindex="-1">
	<button type="button" class="back" onclick={onback}><span class="chev flip"><Icon name="chevron-right" /></span>{t("목록")}</button>
	<div class="line">
		<div class="who">
			<span class="top">
				<h4 class="ename">{name}</h4>
				{#if meta}{@render meta()}{/if}
			</span>
			<span class="meta">{sub}</span>
		</div>
		<div class="actions">
			{#if busy}<span class="spinner" role="status" aria-label={t("처리 중")}></span>{/if}
			{#if control}{@render control()}{/if}
		</div>
	</div>
	{#if upgrade}
		<Notice tone="ok" size="sm" icon="arrow-up" role="status">
			{t("새 버전 v{version}을 사용할 수 있습니다.", { version: upgrade.version })}
			{#snippet action()}<Button size="sm" variant="update" disabled={upgrade.disabled} aria-label={t("v{version}으로 업데이트", { version: upgrade.version })} onclick={upgrade.onclick}>{t("업데이트")}</Button>{/snippet}
		</Notice>
	{/if}
	{@render children()}
</div>

<style>
	.page { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
	.page:focus { outline: none; }
	.line { display: flex; align-items: center; gap: 12px; }
	/* spinner and switch share one row, vertically centred on the name block like the list rows */
	.actions { flex: none; display: flex; align-items: center; gap: 8px; }
	.who { display: flex; flex-direction: column; min-width: 0; line-height: 1.35; flex: 1; gap: 4px; }
	.top { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 8px; min-width: 0; }
	h4 { margin: 0; font-size: var(--fs-lg); font-weight: 600; overflow-wrap: anywhere; }
	.meta { font-size: var(--fs-2xs); color: var(--text-faint); overflow-wrap: anywhere; font-family: var(--mono); }
	.back { align-self: flex-start; display: inline-flex; align-items: center; gap: 4px; padding: 4px 8px 4px 4px; border-radius: var(--radius-sm); color: var(--text-dim); font-size: var(--fs-sm); }
	.back:hover { color: var(--text); }
	/* on a wide window the settings sidebar lists the extensions, so there is nothing to go back to */
	@media (min-width: 761px) { .back { display: none; } }
	@media (max-width: 760px) {
		.page { gap: 12px; }
		.back { padding: 4px 12px 4px 4px; border: 1px solid var(--border); border-radius: 999px; background: var(--bg-elev); }
		.line { padding: 12px; border: 1px solid var(--border); border-radius: var(--radius-lg, 14px); background: var(--bg-elev); }
	}
	.back:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
	.chev { flex: none; display: inline-flex; color: var(--text-faint); transition: transform var(--motion-fast) var(--ease-exit); }
	.chev.flip { transform: rotate(180deg); }
	.chev :global(svg) { width: 16px; height: 16px; stroke-width: 2; }
</style>
