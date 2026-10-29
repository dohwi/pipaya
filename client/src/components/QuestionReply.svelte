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

	/** Up to this many questions get numbered circles; more would not fit a phone, so they page with arrows instead. */
	const MAX_CIRCLES = 4;
	const paged = $derived(!!items && items.length > MAX_CIRCLES);
	let tab = $state(0);
	let answers = $state<string[]>([]);
	const cur = $derived(items ? items[tab]! : question);

	/**
	 * How the options are laid out, always in equal columns so every button is the same width whatever it says.
	 * Two or three short answers share one row; four short ones make a 2x2; anything long (or five and more) goes one per row.
	 */
	const SHORT = 8; // a cell is ~105px wide: eight Korean characters fit on a line, with the sparkle counted below
	const cols = $derived.by(() => {
		const o = cur.options ?? [];
		// the recommended answer carries a sparkle (about 2 characters wide)
		const width = (x: string) => [...x].length + (x === cur.recommended ? 2 : 0);
		if (o.length < 2 || o.length > 4 || !o.every((x) => width(x) <= SHORT)) return 1;
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

{#snippet stepper()}
	{#if paged}
		<!-- many questions: "3 / 8" between two arrows (a row of circles would not fit a phone) -->
		<div class="pager" role="group" aria-label={t("질문 {n}개", { n: items!.length })}>
			<button class="nav tap" disabled={tab === 0} aria-label={t("이전 질문")} onclick={() => go(tab - 1)}><Icon name="chevron-left" /></button>
			<span class="where mono" class:done={!!answers[tab]?.trim()}>{tab + 1} / {items!.length}</span>
			<button class="nav tap" disabled={tab === items!.length - 1} aria-label={t("다음 질문")} onclick={() => go(tab + 1)}><Icon name="chevron-right" /></button>
		</div>
	{:else}
		<!-- a few questions: numbered circles joined by a line, centred. Answered = green check, here = filled, ahead = outline. -->
		<div class="stepper" role="tablist" aria-label={t("질문 {n}개", { n: items!.length })}>
			{#each items! as it, i (i)}
				{#if i > 0}<span class="link" class:done={!!answers[i - 1]?.trim()} aria-hidden="true"></span>{/if}
				<button class="step tap" class:on={i === tab} class:filled={!!answers[i]?.trim()} role="tab" aria-selected={i === tab} aria-label={`${i + 1}. ${it.question}`} title={it.question} onclick={() => go(i)}>
					{#if answers[i]?.trim()}<Icon name="check" />{:else}{i + 1}{/if}
				</button>
			{/each}
		</div>
	{/if}
{/snippet}

<div class="reply">
	{#if items}{@render stepper()}{/if}
	<div class="q">{cur.question}</div>
	{#if cur.options?.length}
		<div class="opts" style:--cols={cols}>
			{#each cur.options as o (o)}
				<Button class={["opt", items && answers[tab] === o && "picked", cur.recommended === o && "rec"]} onclick={() => reply(o)}>
					<span class="txt">{#if cur.recommended === o}<span class="rec-mark" title={t("추천")} role="img" aria-label={t("추천")}><Icon name="sparkles" /></span>{/if}{o}</span>
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

	/* step indicator: circles joined by a line, centred. Each circle is the tap target (28px, wider with .tap on touch). */
	.stepper {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0;
		height: 28px;
	}
	.step {
		position: relative;
		flex: none;
		display: grid;
		place-items: center;
		width: 28px;
		height: 28px;
		border: 1px solid var(--border-strong);
		border-radius: 50%;
		background: transparent;
		color: var(--text-dim);
		font-family: var(--mono);
		font-size: var(--fs-2xs);
		font-weight: 600;
		font-variant-numeric: tabular-nums;
		transition:
			background var(--motion-fast) var(--ease-std),
			border-color var(--motion-fast) var(--ease-std),
			color var(--motion-fast) var(--ease-std);
	}
	/* the line between two circles: 16px long, green once the question before it is answered */
	.link {
		flex: none;
		width: 16px;
		height: 2px;
		margin: 0 4px;
		border-radius: var(--radius-pill);
		background: color-mix(in srgb, var(--text) 16%, transparent);
		transition: background var(--motion-fast) var(--ease-std);
	}
	.link.done {
		background: var(--ok);
	}
	.step.filled {
		border-color: var(--ok);
		color: var(--ok);
	}
	.step.on {
		border-color: var(--text);
		background: var(--text);
		color: var(--bg);
	}
	.step.on.filled {
		border-color: var(--ok);
		background: var(--ok);
		color: var(--bg);
	}
	.step :global(svg) {
		width: 14px;
		height: 14px;
	}

	/* many questions: the same 28px row as the circles, "3 / 8" between two arrows */
	.pager {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		height: 28px;
	}
	.nav {
		position: relative;
		flex: none;
		display: grid;
		place-items: center;
		width: 28px;
		height: 28px;
		border-radius: var(--radius-sm);
		color: var(--text-dim);
	}
	.nav :global(svg) {
		width: 16px;
		height: 16px;
	}
	.nav:disabled {
		opacity: 0.3;
	}
	.where {
		min-width: 48px;
		text-align: center;
		font-size: var(--fs-xs);
		font-variant-numeric: tabular-nums;
		color: var(--text);
	}
	.where.done {
		color: var(--ok);
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
	/* the recommended answer looks like every other button (so it never reads as "already chosen"); only a small sparkle
	   leads its text. The sparkle is part of the text, so a long answer wraps around it and nothing is covered. */
	.rec-mark {
		display: inline-block;
		width: 14px;
		height: 14px;
		margin-right: 4px;
		vertical-align: -2px;
		color: var(--warn);
	}
	.rec-mark :global(svg) {
		width: 14px;
		height: 14px;
	}
	.rec-mark :global(svg path) {
		fill: currentColor;
		stroke: none;
	}

	/* the answer chosen for this question: a clear border and a check */
	.opts :global(.btn.opt.picked) {
		border-color: var(--text);
		box-shadow: inset 0 0 0 1px var(--text);
	}
	.opts :global(.btn.opt > svg) {
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
