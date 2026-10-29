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

	/**
	 * How the options are laid out, always in equal columns so every button is the same width whatever it says.
	 * Two or three short answers share one row; four short ones make a 2x2; anything long (or five and more) goes one per row.
	 */
	const SHORT = 10;
	const cols = $derived.by(() => {
		const o = cur.options ?? [];
		if (o.length < 2 || o.length > 4 || !o.every((x) => [...x].length <= SHORT)) return 1;
		return o.length === 3 ? 3 : 2;
	});

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
		<!-- where you are in several questions: "2 / 3" and one thin segment per question (filled once answered) -->
		<div class="steps" role="tablist" aria-label={t("질문 {n}개", { n: items.length })}>
			<span class="count mono">{tab + 1} / {items.length}</span>
			<span class="segs">
				{#each items as it, i (i)}
					<button class="seg" class:on={i === tab} class:filled={!!answers[i]?.trim()} role="tab" aria-selected={i === tab} aria-label={`${i + 1}. ${it.question}`} title={it.question} onclick={() => go(i)}></button>
				{/each}
			</span>
		</div>
	{/if}
	<div class="q">{cur.question}</div>
	{#if cur.options?.length}
		<div class="opts" style:--cols={cols}>
			{#each cur.options as o (o)}
				<Button class={["opt", items && answers[tab] === o && "picked", cur.recommended === o && "rec"]} onclick={() => reply(o)}>
					<span class="txt">{o}</span>
					{#if cur.recommended === o}<span class="rectag" title={t("추천")} role="img" aria-label={t("추천")}></span>{/if}
					{#if items && answers[tab] === o}<Icon name="check" />{/if}
				</Button>
			{/each}
		</div>
	{/if}
	{#if cur.allowFreeText}
		<!-- one input with the send arrow inside it (like the composer): no separate button to sit awkwardly beside it -->
		<div class="free">
			<input
				class="field"
				placeholder={cur.options?.length ? t("직접 입력") : t("답변을 입력하세요")}
				bind:value={typed}
				onkeydown={(e) => e.key === "Enter" && !e.isComposing && reply(typed)}
			/>
			<button class="go" disabled={!typed.trim()} onclick={() => reply(typed)} aria-label={items ? t("저장") : t("보내기")} title={items ? t("저장") : t("보내기")}>
				<Icon name={items ? "check" : "send"} />
			</button>
		</div>
	{/if}
</div>

<style>
	/* The block under a card that waits for an answer. Every gap is on the 4/8/12/16 scale; the card's own warn tint carries "needs you". */
	.reply {
		display: flex;
		flex-direction: column;
		gap: 12px; /* progress | question | options | free text: groups 12 apart */
		padding: 12px;
		border-top: 1px solid var(--border);
		background: var(--warn-soft);
	}
	.q {
		font-size: var(--fs-sm);
		line-height: 20px; /* 13px text on a 20px line, like the tool name in the header */
		font-weight: 600;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	/* progress: "2 / 3" and a segment per question. Quiet: no pills, no names (the question below says what it is). */
	.steps {
		display: flex;
		align-items: center;
		gap: 8px;
		height: 20px; /* the same line as the question text, so 6px of a current segment never moves the rows below */
		margin-bottom: -4px; /* the progress belongs to the question under it: 8 instead of 12 */
	}
	.count {
		flex: none;
		font-size: var(--fs-2xs);
		color: var(--text-faint);
		font-variant-numeric: tabular-nums;
	}
	.segs {
		flex: 1;
		display: flex;
		gap: 4px;
	}
	.seg {
		position: relative;
		flex: 1;
		height: 4px;
		padding: 0;
		border-radius: var(--radius-pill);
		background: color-mix(in srgb, var(--text) 16%, transparent);
		transition: background var(--motion-fast) var(--ease-std);
	}
	/* the 4px bar is the picture; the tap target is the full 20px row around it */
	.seg::after {
		content: "";
		position: absolute;
		inset: -8px 0;
	}
	.seg.filled {
		background: var(--ok);
	}
	.seg.on {
		background: var(--text);
	}
	/* where you are: taller by 2px (not a halo), so it reads the same whether the question was answered or not */
	.seg.on {
		height: 6px;
	}
	.seg.on.filled {
		background: var(--ok);
	}

	/* options: plain buttons, the text is all there is. A long answer wraps inside the button. */
	/* equal columns (or one per row): the buttons are all the same width, so the block reads as one even grid */
	.opts {
		display: grid;
		grid-template-columns: repeat(var(--cols, 1), minmax(0, 1fr));
		gap: 8px;
	}
	.opts :global(.btn.opt) {
		height: auto;
		min-height: var(--control-h);
		min-width: 0;
		padding: 8px 12px;
		gap: 8px;
		justify-content: center;
		text-align: center;
		line-height: 20px;
		white-space: normal;
		overflow-wrap: anywhere;
	}
	.txt {
		min-width: 0;
	}
	/* the recommended answer: tinted and outlined in warn, with one small word after it (no pill, no number) */
	.opts :global(.btn.opt.rec) {
		border-color: var(--warn);
		background: var(--warn-soft);
	}
	.opts :global(.btn.opt.rec:hover:not(:disabled)) {
		background: color-mix(in srgb, var(--warn) 22%, transparent);
	}
	/* the recommended mark is a small dot in the button's top-right corner: no text, so it never takes width from the answer
	   (the tint and border say "recommended" too; the word stays as the tooltip and for screen readers) */
	.opts :global(.btn.opt) {
		position: relative;
	}
	.rectag {
		position: absolute;
		top: 4px;
		right: 4px;
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--warn);
		font-size: 0; /* the word is hidden, not removed */
	}

	/* the answer chosen for this question: a clear border and a check */
	.opts :global(.btn.opt.picked) {
		border-color: var(--text);
		box-shadow: inset 0 0 0 1px var(--text);
	}
	.opts :global(.btn.opt svg) {
		flex: none;
		width: 16px;
		height: 16px;
		color: var(--ok);
	}

	/* the free answer: the field with the send arrow inside its right end, as in the composer */
	.free {
		position: relative;
	}
	.field {
		padding-right: 48px; /* room for the 32px arrow + its 4px inset + 12px text gap */
	}
	.go {
		position: absolute;
		top: 4px;
		right: 4px; /* 40px field, 32px button: 4 all round */
		display: grid;
		place-items: center;
		width: 32px;
		height: 32px;
		border-radius: var(--radius-sm);
		background: var(--accent);
		color: var(--accent-fg);
		transition:
			opacity var(--motion-fast) var(--ease-std),
			transform var(--motion-fast) var(--ease);
	}
	.go:disabled {
		opacity: 0;
		pointer-events: none; /* nothing to send yet: the arrow appears once there is text */
	}
	.go:active:not(:disabled) {
		transform: scale(0.94);
	}
	.go :global(svg) {
		width: 16px;
		height: 16px;
	}
</style>
