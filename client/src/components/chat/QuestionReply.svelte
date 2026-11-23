<script lang="ts">
	import Button from "../ui/Button.svelte";
	import { t } from "../../lib/i18n";
	import { app } from "../../lib/store.svelte";
	import Icon from "../ui/Icon.svelte";
	import Ladder from "../ui/Ladder.svelte";
	import { THINKING_LEVELS, type Question } from "../../lib/types";
	import { unique } from "../../lib/unique";

	let { id, paneId, question }: { id: string; paneId: string | null; question: Pick<Question, "question" | "options" | "recommended" | "scale" | "multiple" | "descriptions" | "allowFreeText" | "items"> } = $props();

	let typed = $state("");

	// Several questions: one tab each. Answers stay editable until the final submit.
	const items = $derived(question.items && question.items.length > 1 ? question.items : null);

	/** Up to this many questions get numbered circles; more would not fit a phone, so they page with arrows instead. */
	const MAX_CIRCLES = 4;
	const paged = $derived(!!items && items.length > MAX_CIRCLES);
	let tab = $state(0);
	/**
	 * One per question, by index. `undefined`: not answered yet. `null`: left to the agent ("알아서 정해 줘").
	 * A string: the answer; a multiple-choice one holds its picks one per line, as the server expects.
	 */
	let answers = $state<(string | null | undefined)[]>([]);
	const cur = $derived(items ? items[tab]! : question);
	/** A repeated option is one choice (and a repeated key would crash the list): the first one stays. */
	const options = $derived(unique(cur.options ?? []));
	/** An option's one-line description, when the agent gave one per option. */
	const descOf = (o: string) => (cur.descriptions?.length === cur.options?.length ? cur.descriptions?.[cur.options!.indexOf(o)]?.trim() : "") || "";
	const described = $derived(options.some((o) => descOf(o)));
	const answered = (i: number) => answers[i] !== undefined && answers[i] !== "";
	const left = (i: number) => answers[i] === null;

	/**
	 * Several picks: the options toggle, and a "선택 완료" button sends them (it shows how many). A typed answer is one
	 * more pick. Restored from the saved answer when the user comes back to a tab.
	 */
	let picks = $state<string[]>([]);
	const toggle = (o: string) => (picks = picks.includes(o) ? picks.filter((x) => x !== o) : [...picks, o]);
	/** The picks in the order of the options (the user's click order says nothing), a typed one last. */
	const ordered = (list: string[]) => [...options.filter((o) => list.includes(o)), ...list.filter((x) => !options.includes(x))];

	/**
	 * How the options are laid out, always in equal columns so every button is the same width whatever it says.
	 * Two or three short answers share one row; four short ones make a 2x2; anything long (or five and more) goes one per row.
	 */
	const SHORT = 8; // a cell is ~105px wide: eight Korean characters fit on a line, with the sparkle counted below
	const cols = $derived.by(() => {
		const o = options;
		// a description under each label needs the full width
		if (described) return 1;
		// the recommended answer carries a sparkle (about 2 characters wide)
		const width = (x: string) => [...x].length + (x === cur.recommended ? 2 : 0);
		if (o.length < 2 || o.length > 4 || !o.every((x) => width(x) <= SHORT)) return 1;
		return o.length === 3 ? 3 : 2;
	});

	/**
	 * Options the agent marked as one ordered scale (low → high) are drawn as the strength ladder, when they fit one:
	 * two to eight steps, each a short word (a name runs under its node, so a sentence would not fit). Reasoning
	 * strengths take their own colours. Anything else stays a button grid.
	 */
	const LADDER_LABEL = 10;
	const ladder = $derived(!!cur.scale && !cur.multiple && !described && options.length >= 2 && options.length <= 8 && options.every((o) => [...o].length <= LADDER_LABEL));
	const isLevel = (o: string) => (THINKING_LEVELS as readonly string[]).includes(o);

	// Show the saved answer of the tab being opened in the text field.
	function go(i: number) {
		tab = i;
		const saved = answers[i];
		const q = items?.[i] ?? question;
		const lines = typeof saved === "string" ? saved.split("\n") : [];
		picks = q.multiple ? lines.filter((x) => q.options?.includes(x)) : [];
		const free = lines.filter((x) => !q.options?.includes(x));
		typed = q.multiple ? free.join(", ") : typeof saved === "string" && !q.options?.includes(saved) ? saved : "";
	}

	/** Records the current question's answer (null = left to the agent) and moves on, or sends when nothing is missing. */
	function settle(a: string | null) {
		if (!items) {
			void app.answerQuestion(id, a, paneId ?? undefined);
			typed = "";
			picks = [];
			return;
		}
		answers[tab] = a;
		// Next unanswered question after this one, else the first unanswered one before it (answers can be given in any order)
		const next = items.findIndex((_, i) => i > tab && !answered(i) && !left(i));
		const gap = next >= 0 ? next : items.findIndex((_, i) => !answered(i) && !left(i));
		if (gap >= 0) go(gap);
		else {
			typed = "";
			// The last missing answer sends everything at once.
			void app.answerQuestion(id, items.map((_, i) => (left(i) ? null : (answers[i] as string).trim())), paneId ?? undefined);
		}
	}

	function reply(text: string) {
		const a = text.trim();
		if (a) settle(a);
	}

	/** Several picks: the chosen options and the typed text (comma-separated, one pick each), one per line. */
	const multiAnswer = $derived(ordered([...picks, ...typed.split(",").map((x) => x.trim()).filter(Boolean)]));
	function sendPicks() {
		if (multiAnswer.length) settle(multiAnswer.join("\n"));
	}
</script>

{#snippet stepper()}
	{#if paged}
		<!-- many questions: "3 / 8" between two arrows (a row of circles would not fit a phone) -->
		<div class="pager" role="group" aria-label={t("질문 {n}개", { n: items!.length })}>
			<button class="nav tap" disabled={tab === 0} aria-label={t("이전 질문")} onclick={() => go(tab - 1)}><Icon name="chevron-left" /></button>
			<span class="where mono" class:done={answered(tab) || left(tab)}>{tab + 1} / {items!.length}</span>
			<button class="nav tap" disabled={tab === items!.length - 1} aria-label={t("다음 질문")} onclick={() => go(tab + 1)}><Icon name="chevron-right" /></button>
		</div>
	{:else}
		<!-- a few questions: numbered circles joined by a line, centred. Answered = green check, here = filled, ahead = outline. -->
		<div class="stepper" role="tablist" aria-label={t("질문 {n}개", { n: items!.length })}>
			{#each items! as it, i (i)}
				{#if i > 0}<span class="link" class:done={answered(i - 1) || left(i - 1)} aria-hidden="true"></span>{/if}
				<button class="step tap" class:on={i === tab} class:filled={answered(i) || left(i)} role="tab" aria-selected={i === tab} aria-label={`${i + 1}. ${it.question}`} title={left(i) ? `${it.question} · ${t("에이전트에게 맡김")}` : it.question} onclick={() => go(i)}>
					{#if left(i)}<Icon name="sparkles" />{:else if answered(i)}<Icon name="check" />{:else}{i + 1}{/if}
				</button>
			{/each}
		</div>
	{/if}
{/snippet}

<div class="reply">
	{#if items}{@render stepper()}{/if}
	<div class="q">{cur.question}</div>
	{#if ladder}
		<Ladder
			label={cur.question}
			options={options.map((o) => ({ id: o, label: o, level: isLevel(o) ? o : undefined, marked: cur.recommended === o, title: cur.recommended === o ? t("추천") : undefined }))}
			value={items && typeof answers[tab] === "string" ? (answers[tab] as string) : null}
			onchange={reply}
		/>
	{:else if options.length}
		{#if cur.multiple}<p class="how">{t("여러 개를 고를 수 있습니다")}</p>{/if}
		<div class="opts" class:described style:--cols={cols} role={cur.multiple ? "group" : undefined} aria-label={cur.multiple ? cur.question : undefined}>
			{#each options as o (o)}
				{@const on = cur.multiple ? picks.includes(o) : !!items && answers[tab] === o}
				<Button class={["opt", on && "picked", cur.recommended === o && "rec"]} aria-pressed={cur.multiple ? on : undefined} onclick={() => (cur.multiple ? toggle(o) : reply(o))}>
					{#if cur.multiple}<span class="box" class:on aria-hidden="true">{#if on}<Icon name="check" />{/if}</span>{/if}
					<span class="txt">
						<span class="lab">{#if cur.recommended === o}<span class="rec-mark" title={t("추천")} role="img" aria-label={t("추천")}><Icon name="sparkles" /></span>{/if}{o}</span>
						{#if descOf(o)}<span class="desc">{descOf(o)}</span>{/if}
					</span>
					{#if !cur.multiple && on}<Icon name="check" />{/if}
				</Button>
			{/each}
		</div>
	{/if}
	{#if items && !cur.allowFreeText && items.some((it) => it.allowFreeText)}
		<!-- an answer-by-choice question among typed ones: hold the input's 40px so the card keeps one height on every tab -->
		<div class="free hold" aria-hidden="true"></div>
	{/if}
	{#if cur.allowFreeText}
		<!-- one input with the send arrow inside it (like the composer): no separate button to sit awkwardly beside it -->
		<div class="free">
			<input
				class="field"
				placeholder={cur.multiple ? t("직접 입력 (쉼표로 여러 개)") : cur.options?.length ? t("직접 입력") : t("답변을 입력하세요")}
				bind:value={typed}
				onkeydown={(e) => e.key === "Enter" && !e.isComposing && (cur.multiple ? sendPicks() : reply(typed))}
			/>
			{#if !cur.multiple}
				<button class="go" disabled={!typed.trim()} onclick={() => reply(typed)} aria-label={items ? t("저장") : t("보내기")} title={items ? t("저장") : t("보내기")}>
					<Icon name={items ? "check" : "send"} />
				</button>
			{/if}
		</div>
	{/if}
	<div class="foot">
		<!-- the agent decides (its recommendation when it gave one): an outlined button like the options, never a second primary -->
		<Button size="sm" class={["leave", left(tab) && "on"]} aria-pressed={items ? left(tab) : undefined} onclick={() => settle(null)} title={cur.recommended ? t("추천: {option}", { option: cur.recommended }) : undefined}>
			<Icon name="sparkles" />{t("알아서 정해 줘")}
		</Button>
		{#if cur.multiple}
			<Button variant="primary" size="sm" disabled={!multiAnswer.length} onclick={sendPicks}>
				{multiAnswer.length ? t("{n}개 선택 완료", { n: multiAnswer.length }) : t("선택 완료")}
			</Button>
		{/if}
	</div>
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
		border: 2px solid var(--border-strong); /* the ladder's ring weight (ui/Ladder.svelte) */
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
	/* the line between two circles: the ladder's rail (2px, --border-strong), green once the question before it is answered */
	.link {
		flex: none;
		width: 24px;
		height: 2px;
		border-radius: 1px;
		background: var(--border-strong);
		transition: background var(--motion-fast) var(--ease-std);
	}
	.link.done {
		background: var(--ok);
	}
	.step.filled {
		border-color: var(--ok);
		color: var(--ok);
	}
	/* where you are: filled with the card's own warn colour (the block is warn-tinted, so the current step belongs to it).
	   An answered question you came back to keeps this fill and shows its check inside. */
	.step.on,
	.step.on.filled {
		--fill: color-mix(in srgb, var(--warn) 85%, black); /* a touch deeper so the number reads (light theme: 3.99:1 -> over 4.5:1) */
		border-color: var(--fill);
		background: var(--fill);
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
		color: var(--disabled-fg);
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
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	/* a described option: label and its line read left to right, like a list row, not a centred button */
	.opts.described :global(.btn.opt) {
		justify-content: flex-start;
		text-align: left;
		padding: 8px 12px;
	}
	.desc {
		font-size: var(--fs-xs);
		line-height: 16px;
		font-weight: 400;
		color: var(--text-dim);
	}
	/* several picks: a small check box leads each option, filled when picked */
	.box {
		flex: none;
		display: grid;
		place-items: center;
		width: 16px;
		height: 16px;
		border: 2px solid var(--border-strong);
		border-radius: var(--radius-xs);
		transition:
			background var(--motion-fast) var(--ease-std),
			border-color var(--motion-fast) var(--ease-std);
	}
	.box.on {
		background: var(--text);
		border-color: var(--text);
		color: var(--bg);
	}
	.box :global(svg) {
		width: 12px;
		height: 12px;
		color: var(--bg);
		stroke-width: 3;
	}
	.how {
		margin: -4px 0 0; /* a note on the question above it: 8 under it, not the block's 12 */
		font-size: var(--fs-xs);
		line-height: 16px;
		color: var(--text-dim);
	}
	/* the last line: "leave it to the agent" on the left, the multiple-choice send button on the right */
	.foot {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
	}
	/* the sparkle in the card's warn colour: the same mark as a recommended option, so it reads "the agent's pick" */
	.foot :global(.btn.leave svg) {
		width: 14px;
		height: 14px;
		color: var(--warn);
	}
	/* chosen on a tab of several questions: the picked option's look (a clear border) */
	.foot :global(.btn.leave.on) {
		border-color: var(--text);
		box-shadow: inset 0 0 0 1px var(--text);
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
	.opts :global(.btn.opt > svg:last-child) {
		flex: none;
		width: 16px;
		height: 16px;
		color: var(--ok);
	}

	/* the free answer: the field with the send arrow inside its right end, as in the composer */
	.free {
		position: relative;
	}
	.free.hold {
		height: var(--control-h);
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
