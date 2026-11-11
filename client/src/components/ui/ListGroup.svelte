<script lang="ts">
	import type { Snippet } from "svelte";

	/**
	 * One block of a list dialog (skills, MCP servers, extension commands, helper roles): a small heading with a count and,
	 * optionally, the folder the entries come from, then the entries. Every list dialog uses it, so the four read the same.
	 *
	 *  title   the group's name ("전역", "프로젝트", an extension's name)
	 *  count   shown right after the title (`2`, `1/2`)
	 *  path    where the entries live; it shrinks with an ellipsis, the title never does
	 *  hint    one line under the heading that says what the group does
	 *  extra   inline after the count (a badge)
	 */
	let { title, count, path, hint, extra, children }: { title: string; count?: string; path?: string; hint?: string; extra?: Snippet; children: Snippet } = $props();
</script>

<section class="group" aria-label={title}>
	<div class="head">
		<span class="title">{title}</span>
		{#if count}<span class="count">{count}</span>{/if}
		{#if extra}{@render extra()}{/if}
		{#if path}<span class="path mono">{path}</span>{/if}
	</div>
	{#if hint}<p class="hint">{hint}</p>{/if}
	{@render children()}
</section>

<style>
	/* the space between two groups is the caller's (a flex column with `gap: var(--dlg-gap)`), this is only inside one */
	.group { display: flex; flex-direction: column; gap: 8px; }
	.head { display: flex; align-items: baseline; gap: 8px; min-width: 0; font-size: var(--fs-xs); line-height: 20px; }
	.title { flex: none; font-weight: 600; color: var(--text); }
	.count { flex: none; color: var(--text-faint); }
	.path { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--fs-2xs); color: var(--text-faint); }
	.hint { margin: 0; font-size: var(--fs-2xs); line-height: 16px; color: var(--text-faint); }
</style>
