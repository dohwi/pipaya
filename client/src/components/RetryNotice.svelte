<script lang="ts">
	import { t } from "../lib/i18n";
	import { app } from "../lib/store.svelte";
	import { getPane } from "../lib/pane";
	import { secondsLeft, type RetryState } from "../lib/retry-state";
	import Notice from "./Notice.svelte";
	import Button from "./Button.svelte";

	/**
	 * Shown while the server waits to call the model again: which model does not answer, how many tries are left, a
	 * countdown to the next try, the short cause, and the two things the user can do (stop, or pick another model).
	 */
	let { retrying }: { retrying: RetryState } = $props();

	const pane = getPane();
	const eff = $derived(app.effectiveOf(pane.id));
	const who = $derived.by(() => {
		const model = app.effectiveModelOf(pane.id)?.name || eff.model || "";
		const provider = app.providers.find((p) => p.id === eff.provider)?.name || eff.provider || "";
		return provider && model ? `${provider} / ${model}` : model || provider;
	});

	let now = $state(Date.now());
	$effect(() => {
		void retrying.at;
		now = Date.now();
		const id = setInterval(() => (now = Date.now()), 250);
		return () => clearInterval(id);
	});
	const left = $derived(secondsLeft(retrying, now));
	const head = $derived(
		[
			who ? t("{who} 모델이 응답하지 않아 다시 시도 중", { who }) : t("모델이 응답하지 않아 다시 시도 중"),
			`${retrying.attempt}/${retrying.maxRetries}`,
			...(retrying.delayMs ? [left > 0 ? t("{n}초 뒤 다시 시도", { n: left }) : t("지금 다시 시도")] : []),
		].join(" · "),
	);
</script>

<div class="retry">
	<Notice tone="warn" role="status" size="sm">
		<div class="line">{head}</div>
		{#if retrying.reason}<div class="reason">{retrying.reason}</div>{/if}
		{#snippet action()}
			<span class="acts">
				<Button size="sm" onclick={() => app.abort(pane.id)}>{t("중지")}</Button>
				<Button size="sm" onclick={() => app.modelPickerTick++}>{t("모델 바꾸기")}</Button>
			</span>
		{/snippet}
	</Notice>
</div>

<style>
	.retry { margin-bottom: 8px; }
	.line { line-height: 20px; }
	.reason { line-height: 16px; font-size: var(--fs-xs); opacity: 0.85; word-break: break-all; }
	.acts { display: inline-flex; gap: 8px; }
	@media (max-width: 600px) {
		.retry :global(.notice) { flex-wrap: wrap; }
		.retry :global(.text) { flex: 1 1 0; } /* keeps the icon on the text line; only the buttons wrap */
		.retry :global(.action) { flex-basis: 100%; }
		.acts { width: 100%; }
		.acts :global(.btn) { flex: 1; }
	}
</style>
