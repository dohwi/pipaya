<script lang="ts">
	import { getContext } from "svelte";
	import { marquee } from "../../lib/fit-text";
	import RenameInput from "./RenameInput.svelte";
	import { ROW_RENAME, type RowRename } from "./row-rename";

	/**
	 * A row's name. One that does not fit flows by while the row is hovered or focused, looping back to its start.
	 * While its row is renamed in place this is the field: the icon and the row stay, only the name becomes editable.
	 */
	let { text }: { text: string } = $props();
	const rn = getContext<RowRename | undefined>(ROW_RENAME);
</script>

{#if rn?.active}
	<RenameInput inline value={rn.draft} oninput={rn.ondraft} oncommit={rn.oncommit} oncancel={rn.oncancel} maxlength={rn.maxlength} />
{:else}
	<span class="title" use:marquee={text}><span class="track"><span class="mq">{text}</span><span class="dup" aria-hidden="true">{text}</span></span></span>
{/if}
