<script lang="ts">
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
	const done = $derived(items ? items.every((_, i) => !!answers[i]?.trim()) : false);

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
		else typed = "";
	}

	function submit() {
		if (!items || !done) return;
		void app.answerQuestion(id, items.map((_, i) => answers[i]!.trim()), paneId ?? undefined);
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
				<button class="btn opt" class:picked={items && answers[tab] === o} class:rec={cur.recommended === o} onclick={() => reply(o)}>
					<span class="num">{n + 1}.</span>
					<span>{o}</span>
					{#if cur.recommended === o}<span class="badge">({t("추천")})</span>{/if}
				</button>
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
			<button class="btn primary" disabled={!typed.trim()} onclick={() => reply(typed)}>
				{#if items}{t("저장")}{:else}<Icon name="send" /> {t("보내기")}{/if}
			</button>
		</div>
	{/if}
	{#if items}
		{#if answers[tab]}<div class="saved">{t("답변")}: {answers[tab]}</div>{/if}
		<button class="btn primary submit" disabled={!done} onclick={submit}><Icon name="send" /> {t("모두 보내기")}</button>
	{/if}
</div>

<style>
	.reply {
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding: 12px;
		border-top: 1px solid var(--border);
		background: var(--warn-soft);
	}
	.q {
		font-size: var(--fs-sm);
		line-height: 1.5;
		font-weight: 600;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	.opts {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}
	/* An answer can be a whole sentence. The shared pill is one fixed line high and clips what does not fit, so an option
	   grows with its text and uses a corner radius that a second line still sits inside. */
	.opt {
		height: auto;
		min-height: 38px;
		max-width: 100%;
		padding: 8px 16px;
		border-radius: var(--radius-pill);
		justify-content: flex-start;
		text-align: left;
		line-height: 1.45;
		white-space: normal;
		overflow-wrap: anywhere;
	}
	.opt.rec {
		border: 2px solid var(--warn);
		font-weight: 600;
	}
	.num {
		margin-right: 6px;
		opacity: 0.7;
		font-variant-numeric: tabular-nums;
	}
	.opt.picked {
		outline: 2px solid currentColor;
	}
	.free {
		display: flex;
		gap: 8px;
	}
	.field {
		flex: 1;
		min-width: 0;
		height: 38px;
	}
	.free .btn {
		flex: none;
		height: 38px;
	}
	.tabs {
		display: flex;
		gap: 6px;
		overflow-x: auto;
	}
	.tab {
		display: flex;
		align-items: center;
		gap: 6px;
		max-width: 180px;
		flex: none;
		padding: 6px 12px;
		border: 1px solid var(--border);
		border-radius: var(--radius-pill);
		background: transparent;
		color: inherit;
		font-size: var(--fs-sm);
		cursor: pointer;
	}
	.tab.on {
		border-color: currentColor;
		font-weight: 600;
	}
	.tab.filled:not(.on) {
		opacity: 0.75;
	}
	.tt {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.saved {
		font-size: var(--fs-sm);
		opacity: 0.8;
		overflow-wrap: anywhere;
	}
	.submit {
		align-self: flex-end;
		height: 38px;
	}
</style>
