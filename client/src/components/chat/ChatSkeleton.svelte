<script lang="ts">
	import { t } from "../../lib/i18n";

	/**
	 * A conversation's outline while its transcript loads: the question on the right, the start of the reply under it.
	 * Few blunt blocks on the conversation column, each where the real one lands, so the swap does not move anything.
	 * `fade`: fade in after a beat (a quick load never shows it); false when the reader already waited on the previous screen.
	 */
	let { fade = true }: { fade?: boolean } = $props();
</script>

<div class="skeleton" class:skeleton-in={fade} aria-busy="true" aria-label={t("불러오는 중…")}>
	<i class="skeleton-bar ask"></i>
	<i class="skeleton-bar line" style:--sk-i={1}></i>
	<i class="skeleton-bar line short" style:--sk-i={2}></i>
</div>

<style>
	.skeleton {
		display: flex;
		flex-direction: column;
		gap: 12px;
		padding-top: 32px; /* measured: the first bubble's top under the day heading (16px line + 8 + the unit's 8) */
	}
	/* the question: a short bubble, its corners and height (UserMessage .bubble: 8 + a 24px line + 8) */
	.ask {
		align-self: flex-end;
		width: min(70%, 240px);
		height: 40px;
		margin-bottom: 44px; /* measured: the reply's first line starts 56 under the bubble (its time row and the units' padding) */
		border-radius: var(--radius);
	}
	/* the reply: two thick bars, a full line and a short last one; corners a third of their height */
	.line {
		width: 100%;
		height: 24px;
		border-radius: var(--radius-sm);
	}
	.line.short {
		width: 60%;
	}
</style>
