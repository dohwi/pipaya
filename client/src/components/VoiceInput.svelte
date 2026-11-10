<script lang="ts">
	import Icon from "./Icon.svelte";
	import { t } from "../lib/i18n";
	import { app } from "../lib/store.svelte";
	import { voice } from "../lib/voice.svelte";
	import { FAILURE_SUMMARY, FAILURE_TEXT, TAP_MS } from "../lib/voice";

	/**
	 * The composer's microphone button. Shown whenever voice input is on (`voice.visible`), and disabled while it cannot
	 * record (`voice.ready` false): a setup that is incomplete or whose last test failed keeps the button in place with
	 * the reason as its tooltip and a tap that opens Settings > Voice. Hiding it left the user with no microphone and no
	 * way to learn why.
	 *
	 * While recording, the whole input becomes the recording surface (`VoiceRecording`); this button then only stops it.
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
		{#if voice.ready}
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
		{:else}
			<!-- Configured but not usable: the button stays, disabled, and says what is missing. A tap (or Enter) opens the
			     settings that fix it, so the reason is never a dead end. A real <button disabled> would swallow the tap, so
			     this one is aria-disabled and handles the click itself. -->
			<button
				class="mic tap blocked"
				aria-disabled="true"
				aria-label={`${t("음성 입력을 사용할 수 없습니다")}. ${voice.blockedReason ?? ""} ${t("설정에서 고치기")}`}
				title={`${voice.blockedReason ?? t("음성 입력을 사용할 수 없습니다")} — ${t("설정에서 고치기")}`}
				onclick={() => app.openSettings("voice")}
			>
				<Icon name="mic" />
			</button>
		{/if}
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
	/* Configured but not usable: dimmed like a disabled control, yet still a target (its tap opens Settings). A dashed
	   ring says "not working" without the button reading as a different control. */
	.mic.blocked {
		color: var(--text-faint);
		opacity: 0.55;
		box-shadow: inset 0 0 0 1px var(--border);
	}
	.mic.blocked:hover {
		opacity: 0.85;
		color: var(--text-dim);
		background: var(--bg-hover);
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
