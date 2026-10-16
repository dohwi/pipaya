<script lang="ts">
	import { t } from "../lib/i18n";
	import { chipIn, chipOut } from "../lib/motion";
	import Icon from "./Icon.svelte";

	/**
	 * The right end of the composer bar. Idle: send. While the agent works: queue (after the run), steer (into it) and
	 * stop. While compacting: a status and cancel. Switching between them crossfades instead of jumping.
	 */
	let {
		compacting,
		running,
		canSend,
		hasInput,
		sending,
		online,
		onsend,
		onqueue,
		queueKey = "",
		onsteer,
		onstop,
	}: {
		compacting: boolean;
		running: boolean;
		canSend: boolean;
		hasInput: boolean;
		sending: boolean;
		online: boolean;
		onsend: () => void;
		onqueue: () => void;
		/** The queue shortcut as shown to the user ("" = unbound). */
		queueKey?: string;
		onsteer: () => void;
		onstop: () => void;
	} = $props();

	const mode = $derived(compacting ? "compacting" : running ? "running" : "idle");
</script>

<div class="sc">
	{#key mode}
		<div class="set" in:chipIn out:chipOut>
			{#if mode === "compacting"}
				<span class="compacting" role="status"><span class="spinner"></span> {t("압축 중")}</span>
				<button class="send" class:on={canSend} onclick={onsend} disabled={!canSend} aria-label={t("보내기")}>
					{#if sending}<span class="spinner"></span>{:else}<Icon name="send" />{/if}
				</button>
				<button class="send stop" onclick={onstop} disabled={!online} aria-label={t("압축 취소")} title={t("컨텍스트 압축 취소")}><Icon name="stop" /></button>
			{:else if mode === "running"}
				<button class="mode" onclick={onqueue} disabled={!hasInput} title={queueKey ? t("현재 작업이 모두 끝난 뒤 실행 ({key})", { key: queueKey }) : t("현재 작업이 모두 끝난 뒤 실행")}>
					<Icon name="list" /><span>{t("대기열")}</span>{#if queueKey}<kbd>{queueKey}</kbd>{/if}
				</button>
				<button class="mode primary" onclick={onsteer} disabled={!hasInput} title={t("진행 중인 작업에 바로 끼워 넣기: 실행 중인 도구가 끝나면 다음 모델 호출 전에 전달됩니다 (Enter)")}>
					<Icon name="bolt" /><span>{t("끼워 넣기")}</span><kbd>↵</kbd>
				</button>
				<button class="send stop" onclick={onstop} aria-label={t("중지")} title={t("작업 중지")}><Icon name="stop" /></button>
			{:else}
				<button class="send" class:on={canSend} onclick={onsend} disabled={!canSend} aria-label={t("보내기")}>
					{#if sending}<span class="spinner"></span>{:else}<Icon name="send" />{/if}
				</button>
			{/if}
		</div>
	{/key}
</div>

<style>
	/* the outgoing set and the incoming one share the cell, so the bar does not jump while they crossfade */
	.sc {
		display: grid;
		justify-items: end;
		align-items: center;
		flex: none;
	}
	.set {
		grid-area: 1 / 1;
		display: flex;
		align-items: center;
	}
	.send {
		display: grid;
		place-items: center;
		width: 38px;
		height: 38px;
		border-radius: 50%;
		background: var(--bg-active);
		color: var(--text-faint);
		transition:
			background var(--motion-fast) var(--ease-std),
			color var(--motion-fast) var(--ease-std),
			transform var(--motion-fast) var(--ease);
		flex: none;
	}
	.send.on {
		background: var(--accent);
		color: var(--accent-fg);
	}
	.send:active:not(:disabled) {
		transform: scale(0.9);
	}
	.send.stop {
		background: var(--text);
		color: var(--bg);
	}
	.send :global(svg) {
		width: 19px;
		height: 19px;
		stroke: currentColor;
		fill: none;
		stroke-width: 2.1;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	.send.stop :global(svg) {
		fill: currentColor;
		stroke-width: 1;
	}
	.compacting {
		display: inline-flex;
		align-items: center;
		gap: 7px;
		padding: 0 8px;
		font-size: var(--fs-xs);
		color: var(--text-dim);
	}
	.mode {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		height: 34px;
		padding: 0 10px;
		margin-right: 4px;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-pill);
		color: var(--text-dim);
		font-size: var(--fs-sm);
		font-weight: 500;
		white-space: nowrap;
		flex: none;
		transition:
			background var(--motion-fast) var(--ease-std),
			color var(--motion-fast) var(--ease-std),
			opacity var(--motion-fast) var(--ease-std);
	}
	.mode:hover:not(:disabled) {
		background: var(--bg-active);
		color: var(--text);
	}
	.mode:disabled {
		opacity: 0.4;
	}
	.mode.primary {
		background: var(--accent);
		border-color: var(--accent);
		color: var(--accent-fg);
	}
	.mode.primary:hover:not(:disabled) {
		background: var(--accent-hover);
		color: var(--accent-fg);
	}
	.mode :global(svg) {
		width: 14px;
		height: 14px;
		stroke: currentColor;
		fill: none;
		stroke-width: 2;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	kbd {
		font-family: var(--mono);
		font-size: var(--fs-2xs);
		opacity: 0.6;
	}
	/* Sized by the pane, not the window: a pane in a split group is narrow on a wide screen. */
	@media (pointer: coarse) {
		kbd {
			display: none;
		}
	}
	@container (max-width: 480px) {
		kbd {
			display: none;
		}
		/* One row cannot hold the model picker, two labelled buttons and stop: keep the buttons icon-only so none is squashed */
		.mode {
			width: 34px;
			height: 34px;
			padding: 0;
			margin-right: 0;
			justify-content: center;
			border-radius: 50%;
		}
		.mode span {
			display: none;
		}
		.mode :global(svg) {
			width: 16px;
			height: 16px;
		}
	}
	@container (max-width: 340px) {
		.send {
			width: 32px;
			height: 32px;
		}
		.mode {
			width: 30px;
			height: 30px;
		}
	}
	@media (pointer: coarse) {
		.mode {
			width: 36px;
			height: 36px;
			padding: 0;
			margin-right: 0;
			justify-content: center;
			border-radius: 50%;
		}
		.mode span {
			display: none;
		}
		.mode :global(svg) {
			width: 17px;
			height: 17px;
		}
	}
</style>
