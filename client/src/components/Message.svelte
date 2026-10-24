<script lang="ts">
	import { app } from "../lib/store.svelte";
	import { getPane } from "../lib/pane";
	import UserMessage from "./message/UserMessage.svelte";
	import AssistantMessage from "./message/AssistantMessage.svelte";
	import type { AssistantItem, UserItem } from "../lib/types";

	/**
	 * One row of the transcript. `turn`: for an assistant row, every consecutive assistant message answering one prompt
	 * (one LLM call each); they render as a single reply. `live`: the agent is still on this turn. `working`: this is the
	 * prompt it is busy answering. Replying hands the text to the composer as a badge, so the next prompt answers it.
	 */
	let {
		item,
		turn = [],
		last = false,
		live = false,
		working = false,
	}: { item: UserItem | AssistantItem; turn?: AssistantItem[]; last?: boolean; live?: boolean; working?: boolean } = $props();

	const pane = getPane();
	const session = $derived(app.session(pane.id));
	/** The thinking colour of the bubble while the agent works on it: only a model that reasons has one. */
	const level = $derived(app.effectiveModelOf(pane.id)?.reasoning ? app.effectiveOf(pane.id).thinkingLevel : undefined);
</script>

{#if item.kind === "user"}
	<UserMessage {item} {session} {working} {level} onreply={(text, who) => (app.replyTo = { text, who })} />
{:else}
	<AssistantMessage {item} {turn} {last} {live} {session} paneId={pane.id} onreply={(text) => (app.replyTo = { text })} />
{/if}
