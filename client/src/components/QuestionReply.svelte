<script lang="ts">
	import { t } from "../lib/i18n";
	import { app } from "../lib/store.svelte";
	import Icon from "./Icon.svelte";
	import type { Question } from "../lib/types";

	let { id, paneId, question }: { id: string; paneId: string | null; question: Pick<Question, "question" | "options" | "allowFreeText"> } = $props();

	let typed = $state("");

	function reply(text: string) {
		const a = text.trim();
		if (!a) return;
		void app.answerQuestion(id, a, paneId ?? undefined);
		typed = "";
	}
</script>

<div class="reply">
	<div class="q">{question.question}</div>
	{#if question.options?.length}
		<div class="opts">
			{#each question.options as o (o)}
				<button class="btn opt" onclick={() => reply(o)}>{o}</button>
			{/each}
		</div>
	{/if}
	{#if question.allowFreeText}
		<div class="free">
			<input
				class="field"
				placeholder={question.options?.length ? t("직접 입력") : t("답변을 입력하세요")}
				bind:value={typed}
				onkeydown={(e) => e.key === "Enter" && !e.isComposing && reply(typed)}
			/>
			<button class="btn primary" disabled={!typed.trim()} onclick={() => reply(typed)}><Icon name="send" /> {t("보내기")}</button>
		</div>
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
</style>
