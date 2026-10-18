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

	// Touch: tap = steer, long-press = choose steer / queue. The queue circle is hidden there (see CSS).
	let menu = $state(false);
	let timer: ReturnType<typeof setTimeout> | undefined;
	let longPressed = false;
	const coarse = () => typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;

	function pressStart() {
		longPressed = false;
		if (!coarse() || !hasInput) return;
		clearTimeout(timer);
		timer = setTimeout(() => {
			longPressed = true;
			menu = true;
			navigator.vibrate?.(10);
		}, 380);
	}
	function pressEnd() {
		clearTimeout(timer);
	}
	function steerClick(e: MouseEvent) {
		if (longPressed) {
			longPressed = false;
			e.preventDefault();
			return;
		}
		onsteer();
	}
	function pick(fn: () => void) {
		menu = false;
		fn();
	}
	$effect(() => {
		if (!menu) return;
		const close = () => (menu = false);
		const id = setTimeout(() => addEventListener("pointerdown", close, { once: true }), 0);
		return () => {
			clearTimeout(id);
			removeEventListener("pointerdown", close);
		};
	});
	$effect(() => {
		if (mode !== "running" || !hasInput) menu = false;
	});
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
				<div class="stack">
					<button class="mode queue" onclick={onqueue} disabled={!hasInput} aria-label={t("대기열")} title={queueKey ? t("현재 작업이 모두 끝난 뒤 실행 ({key})", { key: queueKey }) : t("현재 작업이 모두 끝난 뒤 실행")}>
						<Icon name="list" />
					</button>
					<div class="steerwrap">
						{#if menu}
							<div class="menu" role="menu">
								<button class="opt" role="menuitem" onpointerdown={(e) => e.stopPropagation()} onclick={() => pick(onsteer)}>
									<span class="lbl">{t("끼워 넣기")}</span><span class="mode primary"><Icon name="bolt" /></span>
								</button>
								<button class="opt" role="menuitem" onpointerdown={(e) => e.stopPropagation()} onclick={() => pick(onqueue)}>
									<span class="lbl">{t("대기열")}</span><span class="mode"><Icon name="list" /></span>
								</button>
							</div>
						{/if}
						<button
							class="mode primary"
							onpointerdown={pressStart}
							onpointerup={pressEnd}
							onpointerleave={pressEnd}
							onpointercancel={pressEnd}
							oncontextmenu={(e) => coarse() && e.preventDefault()}
							onclick={steerClick}
							disabled={!hasInput}
							aria-label={t("끼워 넣기")}
							title={t("진행 중인 작업에 바로 끼워 넣기: 실행 중인 도구가 끝나면 다음 모델 호출 전에 전달됩니다 (Enter)")}
						>
							<Icon name="bolt" />
						</button>
					</div>
					<button class="send stop" onclick={onstop} aria-label={t("중지")} title={t("작업 중지")}><Icon name="stop" /></button>
				</div>
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
	/* three round buttons, each overlapping the previous one; a ring in the bar colour separates them */
	.stack {
		display: flex;
		align-items: center;
	}
	.stack > :global(* + *),
	.stack > .steerwrap + .send {
		margin-left: -8px;
	}
	.stack > :global(*) {
		position: relative;
	}
	.stack .send,
	.stack .mode {
		box-shadow: 0 0 0 2px var(--bg);
	}
	.mode {
		display: grid;
		place-items: center;
		width: 36px;
		height: 36px;
		padding: 0;
		border: 1px solid var(--border-strong);
		border-radius: 50%;
		background: var(--bg);
		color: var(--text-dim);
		flex: none;
		-webkit-touch-callout: none;
		user-select: none;
		touch-action: manipulation;
		transition:
			background var(--motion-fast) var(--ease-std),
			color var(--motion-fast) var(--ease-std),
			opacity var(--motion-fast) var(--ease-std),
			transform var(--motion-fast) var(--ease);
	}
	.mode:hover:not(:disabled) {
		background: var(--bg-active);
		color: var(--text);
	}
	.mode:active:not(:disabled) {
		transform: scale(0.92);
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
		width: 16px;
		height: 16px;
		stroke: currentColor;
		fill: none;
		stroke-width: 2;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	.steerwrap {
		position: relative;
	}
	.menu {
		position: absolute;
		right: 0;
		bottom: calc(100% + 10px);
		display: flex;
		flex-direction: column;
		gap: 8px;
		align-items: flex-end;
		z-index: 5;
	}
	.opt {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		animation: pop var(--motion-fast) var(--ease) both;
	}
	.opt .lbl {
		padding: 4px 10px;
		border-radius: var(--radius-pill);
		background: var(--bg);
		border: 1px solid var(--border-strong);
		color: var(--text);
		font-size: var(--fs-sm);
		white-space: nowrap;
	}
	@keyframes pop {
		from {
			opacity: 0;
			transform: translateY(6px) scale(0.9);
		}
	}
	/* Touch: the queue circle folds into the long-press menu of the steer circle */
	@media (pointer: coarse) {
		.mode.queue {
			display: none;
		}
		.stack > .steerwrap {
			margin-left: 0;
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
</style>
