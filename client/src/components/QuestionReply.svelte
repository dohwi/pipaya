<script lang="ts">
	import Button from "./Button.svelte";
	import { t } from "../lib/i18n";
	import { app } from "../lib/store.svelte";
	import Icon from "./Icon.svelte";
	import type { Question } from "../lib/types";

	let { id, paneId, question }: { id: string; paneId: string | null; question: Pick<Question, "question" | "options" | "recommended" | "allowFreeText" | "items"> } = $props();

	let typed = $state("");

	// Several questions: one tab each. Answers stay editable until the final submit.
	const items = $derived(question.items && question.items.length > 1 ? question.items : null);
	let tab = $state(0);
	let answers = $state<string[]>([]);
	const cur = $derived(items ? items[tab]! : question);

	// Show the saved answer of the tab being opened in the text field.
	function go(i: number) {
		tab = i;
		typed = answers[i] && !items?.[i]?.options?.includes(answers[i]!) ? answers[i]! : "";
	}

	function reply(text: string) {
		const a = text.trim();
		if (!a) return;
		if (!items) {
			void app.answerQuestion(id, a, paneId ?? undefined);
			typed = "";
			return;
		}
		answers[tab] = a;
		const next = items.findIndex((_, i) => i > tab && !answers[i]?.trim());
		if (next >= 0) go(next);
		else {
			typed = "";
			// The last missing answer sends everything at once.
			void app.answerQuestion(id, items.map((_, i) => answers[i]!.trim()), paneId ?? undefined);
		}
	}
</script>

<div class="reply">
	{#if items}
		<div class="tabs" role="tablist">
			{#each items as it, i (i)}
				<button class="tab" class:on={i === tab} class:filled={!!answers[i]?.trim()} role="tab" aria-selected={i === tab} title={it.question} onclick={() => go(i)}>
					{#if answers[i]?.trim()}<Icon name="check" />{:else}<span class="n">{i + 1}</span>{/if}
					<span class="tt">{it.question}</span>
				</button>
			{/each}
		</div>
	{/if}
	<div class="q">{cur.question}</div>
	{#if cur.options?.length}
		<div class="opts">
			{#each cur.options as o, n (o)}
				<Button class={["opt", items && answers[tab] === o && "picked", cur.recommended === o && "rec"]} onclick={() => reply(o)}>
					<span class="num" class:rec={cur.recommended === o}>{n + 1}</span>
					<span class="txt">{o}</span>
					{#if cur.recommended === o}<span class="badge">{t("추천")}</span>{/if}
				</Button>
			{/each}
		</div>
	{/if}
	{#if cur.allowFreeText}
		<div class="free">
			<input
				class="field"
				placeholder={cur.options?.length ? t("직접 입력") : t("답변을 입력하세요")}
				bind:value={typed}
				onkeydown={(e) => e.key === "Enter" && !e.isComposing && reply(typed)}
			/>
			<Button variant="primary" disabled={!typed.trim()} onclick={() => reply(typed)}>
				{#if items}{t("저장")}{:else}<Icon name="send" /> {t("보내기")}{/if}
			</Button>
		</div>
	{/if}
	{#if items}
		{#if answers[tab]}<div class="saved">{t("답변")}: {answers[tab]}</div>{/if}
	{/if}
</div>

<style>
	/* The block under a card that waits for an answer. Every gap is on the 4/8/12/16 scale; the card's own warn tint carries "needs you". */
	.reply {
		display: flex;
		flex-direction: column;
		gap: 12px; /* question | options | free text: three groups, 12 apart */
		padding: 12px;
		border-top: 1px solid var(--border);
		background: var(--warn-soft);
	}
	/* a question with its tabs: the tabs and the question belong together (8), the rest is 12 */
	.reply > .tabs + .q {
		margin-top: -4px;
	}
	.q {
		font-size: var(--fs-sm);
		line-height: 20px; /* 13px text on a 20px line, like the tool name in the header */
		font-weight: 600;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	.opts {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}
	/* An answer can be a whole sentence: the option grows with its text instead of clipping it. */
	.opts :global(.btn.opt) {
		height: auto;
		min-height: var(--control-h);
		max-width: 100%;
		padding: 8px 12px;
		gap: 8px;
		align-items: flex-start; /* number and pill stand on the first line when an answer wraps (both boxes are 20px, like the line) */
		justify-content: flex-start;
		text-align: left;
		line-height: 20px;
		white-space: normal;
		overflow-wrap: anywhere;
	}
	/* the number sits in a small square so it reads as a key, not as part of the answer */
	.num {
		flex: none;
		display: grid;
		place-items: center;
		width: 20px;
		height: 20px;
		border-radius: var(--radius-xs);
		background: var(--bg-active);
		color: var(--text-dim);
		font-size: var(--fs-2xs);
		font-weight: 600;
		font-variant-numeric: tabular-nums;
	}
	.txt {
		min-width: 0;
	}
	/* the recommended answer: the same box as the others (no thicker border that would grow it), tinted, with a pill after the text */
	.opts :global(.btn.opt.rec) {
		border-color: var(--warn);
		background: var(--warn-soft);
		font-weight: 600;
	}
	.opts :global(.btn.opt.rec:hover:not(:disabled)) {
		background: color-mix(in srgb, var(--warn) 22%, transparent);
	}
	.num.rec {
		background: var(--warn);
		color: var(--bg);
	}
	.badge {
		flex: none;
		display: inline-flex;
		align-items: center;
		height: 20px;
		padding: 0 8px;
		border-radius: var(--radius-pill);
		background: var(--warn);
		color: var(--bg);
		font-size: var(--fs-2xs);
		font-weight: 600;
		line-height: 1;
	}
	/* the answer picked for this tab: a filled border, not an outline that the neighbours' 8px gap would swallow */
	.opts :global(.btn.opt.picked) {
		border-color: var(--text);
		box-shadow: inset 0 0 0 1px var(--text);
	}
	.free {
		display: flex;
		gap: 8px;
	}
	.field {
		flex: 1;
		min-width: 0;
		height: var(--control-h); /* the same 40 as the send button beside it */
	}
	.free :global(.btn) {
		flex: none;
		min-width: 100px; /* 보내기 with its arrow is 100 wide; 저장 takes the same, so the input does not change size between modes */
		justify-content: center;
	}
	.tabs {
		display: flex;
		gap: 8px;
		overflow-x: auto;
		scrollbar-width: none;
	}
	.tabs::-webkit-scrollbar {
		display: none;
	}
	.tab {
		display: flex;
		align-items: center;
		gap: 4px;
		box-sizing: border-box;
		max-width: 200px;
		flex: none;
		height: 36px;
		padding: 0 12px;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-pill);
		background: transparent;
		color: var(--text-dim);
		font-size: var(--fs-sm);
		cursor: pointer;
	}
	.tab :global(svg) {
		width: 14px;
		height: 14px;
		flex: none;
	}
	.tab .n {
		font-size: var(--fs-2xs);
		font-variant-numeric: tabular-nums;
	}
	.tab.on {
		border-color: var(--text);
		color: var(--text);
		font-weight: 600;
	}
	/* answered tabs wear the ok colour on their check, so what is left to do stands out */
	.tab.filled :global(svg) {
		color: var(--ok);
	}
	.tt {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.saved {
		font-size: var(--fs-sm);
		line-height: 20px;
		color: var(--text-dim);
		overflow-wrap: anywhere;
	}
</style>
