<script lang="ts">
	import Icon from "./Icon.svelte";
	import { t } from "../lib/i18n";

	/** The one way to show "this has a newer version": `v1.0.0 ↑ v2.0.0` (the new one in the update green). */
	let { from, to }: { from: string; to: string } = $props();
</script>

<span class="bump" title={t("새 버전 v{version}", { version: to })}>v{from} <Icon name="arrow-up" /> <b>v{to}</b></span>

<style>
	.bump { display: inline-flex; align-items: center; gap: 4px; font-family: var(--mono); font-size: var(--fs-2xs); color: var(--text-faint); white-space: nowrap; }
	.bump b { color: var(--ok); font-weight: 600; }
	.bump :global(svg) { width: 11px; height: 11px; stroke-width: 2.4; color: var(--ok); }
</style>
