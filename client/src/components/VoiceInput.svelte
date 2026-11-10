<script lang="ts">
	import Icon from "./Icon.svelte";
	import { t } from "../lib/i18n";
	import { app } from "../lib/store.svelte";
	import { pressMic, voice } from "../lib/voice.svelte";

	/**
	 * The composer's microphone button. Shown whenever voice input is on (`voice.visible`), and disabled while it cannot
	 * record (`voice.ready` false): a setup that is incomplete or whose last test failed keeps the button in place with
	 * the reason as its tooltip and a tap that opens Settings > Voice. Hiding it left the user with no microphone and no
	 * way to learn why.
	 *
	 * While recording, the whole input becomes the recording surface (`VoiceRecording`); the button in another pane's composer stops it.
	 *
	 * Press: recording starts as the button goes down. A tap keeps it going until the next tap; a longer press records
	 * while held and stops when let go (the same "both" behaviour as the shortcut, `PressToTalk`). The lift is read on the
	 * window (`pressMic`), since the button is replaced by the recording row the moment recording starts.
	 */
	/** The composer this button belongs to; "" on the new-chat screen, where the transcript goes to the open pane. */
	let { paneId }: { paneId: string } = $props();

	function down(e: PointerEvent) {
		if (e.button !== 0 && e.pointerType === "mouse") return;
		// no focus ring, text selection or touch emulation from the press: the press is followed on the window
		e.preventDefault();
		pressMic(e, paneId);
	}

</script>

{#if voice.visible}
	<div class="voice">
		{#if voice.ready}
			<button
				class="mic tap"
				class:rec={voice.recording}
				disabled={voice.transcribing}
				aria-label={voice.recording ? t("녹음 정지") : t("음성으로 입력")}
				aria-pressed={voice.recording}
				title={t("음성으로 입력 (짧게 누르면 시작/정지, 길게 누르면 누르는 동안)")}
				onpointerdown={down}
				oncontextmenu={(e) => e.preventDefault()}
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
	/* a long press is push-to-talk: no callout, text selection or double-tap zoom on the way */
	.mic:not(.blocked) {
		-webkit-touch-callout: none;
		user-select: none;
		touch-action: manipulation;
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
</style>
