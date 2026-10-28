<script lang="ts">
	import type { Snippet } from "svelte";
	import { t } from "../lib/i18n";

	/**
	 * The one "nothing here" / "loading" line inside a list or panel, so every empty list reads and sits the same.
	 *
	 *  loading  shows "불러오는 중…" (announced politely) instead of the children
	 *  tone     card = a tinted box (inside a dialog body), plain = bare centred text (inside a menu or a list that has its own frame),
	 *           dashed = an outlined slot (the page itself is empty)
	 * A page-level empty state with an icon and a call to action is `Welcome`/`EmptyHero`, not this.
	 */
	let {
		loading = false,
		tone = "card",
		as = "div",
		children,
	}: {
		loading?: boolean;
		tone?: "card" | "plain" | "dashed";
		as?: "div" | "p" | "li";
		children?: Snippet;
	} = $props();
</script>

<svelte:element this={as} class="es {tone}" role={loading ? "status" : undefined}>
	{#if loading}{t("불러오는 중…")}{:else}{@render children?.()}{/if}
</svelte:element>

<style>
	.es { margin: 0; color: var(--text-faint); font-size: var(--fs-sm); line-height: 1.6; overflow-wrap: anywhere; }
	.card { padding: 16px 12px; background: var(--bg); border-radius: var(--radius); }
	.plain { padding: 24px 12px; text-align: center; }
	.dashed { padding: 16px; border: 1px dashed var(--border); border-radius: var(--radius); text-align: center; }
	li.es { list-style: none; }
</style>
