<script lang="ts">
	import Icon from "./Icon.svelte";
	import { t } from "../lib/i18n";
	import { voice } from "../lib/voice.svelte";
	import { FAILURE_SUMMARY, FAILURE_TEXT, TAP_MS } from "../lib/voice";

	/**
	 * The composer's microphone button. Shown only when voice input is on and usable (`voice.visible`), so a broken
	 * setting never leaves a dead button behind.
	 *
	 * While recording, the whole input becomes the recording surface (`VoiceRecording`); this button then only stops it,
	 * and the pill that used to sit beside it is gone — the panel says the time and shows the wave.
	 *
	 * Press: a tap toggles recording, a longer press records while held (the same "both" behaviour as the shortcut).
	 */
	/** The composer this button belongs to; "" on the new-chat screen, where the transcript goes to the open pane. */
	let { paneId }: { paneId: string } = $props();

	let pressedAt = 0;
	let holding = false;
	/** The hold started recording, so letting go stops it (a tap keeps recording until the next tap). */
	let holdRecords = false;

	function down(e: PointerEvent) {
		if (e.button !== 0 && e.pointerType === "mouse") return;
		voice.clearFailure();
		pressedAt = performance.now();
		holding = true;
		holdRecords = false;
	}

	async function up() {
		if (!holding) return;
		holding = false;
		const held = performance.now() - pressedAt;
		if (voice.recording) {
			// already recording (a tap started it): a short press stops it, a held press was the hold's own stop
			if (!holdRecords) voice.stop();
			holdRecords = false;
			return;
		}
		if (held >= TAP_MS) {
			// a long press records only while held
			holdRecords = true;
			const failure = await voice.start(paneId);
			if (failure) holdRecords = false;
			return;
		}
		const failure = await voice.start(paneId);
		if (failure) return;
	}

</script>

{#if voice.visible || voice.failure}
	<div class="voice">
		{#if voice.failure}
			<!-- The toast carries the whole sentence: the chip is a short reminder, so it never crowds the composer. -->
			<button
				class="pill error"
				role="status"
				title={t(FAILURE_TEXT[voice.failure])}
				aria-label={`${t(FAILURE_SUMMARY[voice.failure])}. ${t(FAILURE_TEXT[voice.failure])}`}
				onclick={() => voice.clearFailure()}
			>
				<span>{t(FAILURE_SUMMARY[voice.failure])}</span>
			</button>
		{/if}
		{#if voice.visible}
		<button
			class="mic tap"
			class:rec={voice.recording}
			disabled={voice.transcribing}
			aria-label={voice.recording ? t("녹음 정지") : t("음성으로 입력")}
			aria-pressed={voice.recording}
			title={t("음성으로 입력 (짧게 누르면 시작/정지, 길게 누르면 누르는 동안)")}
			onpointerdown={down}
			onpointerup={up}
			onpointercancel={() => (holding = false)}
			onpointerleave={() => { if (voice.recording && !holdRecords) return; holding = false; }}
			onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); void (voice.recording ? voice.stop() : voice.start(paneId)); } }}
		>
			<Icon name={voice.recording ? "mic-rec" : "mic"} />
		</button>
		{/if}
	</div>
{/if}

<style>
	.voice {
		display: flex;
		align-items: center;
		gap: 4px;
		flex: none;
		min-width: 0;
	}
	.mic {
		display: grid;
		place-items: center;
		width: 38px;
		height: 38px;
		flex: none;
		border-radius: 50%;
		color: var(--text-dim);
		background: transparent;
	}
	.mic :global(svg) {
		width: 19px;
		height: 19px;
	}
	.mic:hover:not(:disabled) {
		background: var(--bg-hover);
		color: var(--text);
	}
	.mic.rec {
		color: var(--danger);
		background: color-mix(in srgb, var(--danger) 14%, transparent);
	}
	.mic:disabled {
		opacity: 0.4;
	}
	.pill {
		display: flex;
		align-items: center;
		gap: 8px;
		height: 32px;
		padding: 0 12px;
		border-radius: 999px;
		background: var(--bg-active);
		color: var(--danger);
		font-size: var(--fs-xs);
		white-space: nowrap;
		min-width: 0;
		max-width: 320px;
	}
	.pill.error span {
		overflow: hidden;
		text-overflow: ellipsis;
	}
	/* a narrow pane keeps the toolbar on one line: the error chip keeps its short word rather than emptying the pill */
	@container (max-width: 480px) {
		.pill.error {
			max-width: 152px;
		}
	}
</style>
