<script lang="ts">
	import { t } from "../lib/i18n";
	import { chipIn, chipOut, surfaceIn, surfaceOut } from "../lib/motion";
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
				<span class="compacting" role="status"><span class="dots" aria-hidden="true"><i></i><i></i><i></i></span> {t("압축 중")}</span>
				<button class="send" class:on={canSend} onclick={onsend} disabled={!canSend} aria-label={t("보내기")}>
					{#if sending}<span class="spinner"></span>{:else}<Icon name="send" />{/if}
				</button>
				<button class="send stop" onclick={onstop} disabled={!online} aria-label={t("압축 취소")} title={t("컨텍스트 압축 취소")}><Icon name="stop" /></button>
			{:else if mode === "running"}
				<div class="stack">
					{#if hasInput}
					<button class="mode queue" onclick={onqueue} aria-label={t("대기열")} title={queueKey ? t("현재 작업이 모두 끝난 뒤 실행 ({key})", { key: queueKey }) : t("현재 작업이 모두 끝난 뒤 실행")}>
						<Icon name="list" />
					</button>
					{/if}
					{#if hasInput}
					<div class="steerwrap">
						{#if menu}
							<div class="menu" role="menu" in:surfaceIn={{ y: 8 }} out:surfaceOut={{ y: 8 }}>
								<button class="opt" role="menuitem" onpointerdown={(e) => e.stopPropagation()} onclick={() => pick(onsteer)}>
									<span class="ico bolt"><Icon name="bolt" /></span><span class="lbl">{t("끼워 넣기")}</span><span class="desc">{t("지금 답변 중에 전달")}</span>
								</button>
								<button class="opt" role="menuitem" onpointerdown={(e) => e.stopPropagation()} onclick={() => pick(onqueue)}>
									<span class="ico"><Icon name="list" /></span><span class="lbl">{t("대기열")}</span><span class="desc">{t("작업이 끝난 뒤 실행")}</span>
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
							aria-label={t("끼워 넣기")}
							title={t("진행 중인 작업에 바로 끼워 넣기: 실행 중인 도구가 끝나면 다음 모델 호출 전에 전달됩니다 (Enter)")}
						>
							<Icon name="bolt" />
						</button>
					</div>
					{/if}
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
		gap: 4px;
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
		stroke-width: 2.1;
	}
	.send.stop :global(svg) {
		fill: currentColor;
		stroke-width: 1;
	}
	.compacting {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		padding: 0 8px;
		font-size: var(--fs-xs);
		color: var(--text-dim);
	}
	/* same yellow as the composer's compaction glow */
	.compacting .dots {
		color: var(--warn);
	}
	/* icon-only controls: queue (neutral), steer (accent, a bolt: it goes straight into the run), stop (danger). No overlap, no dividers */
	.stack {
		display: flex;
		align-items: center;
		gap: 4px;
	}
	.stack .mode {
		width: 38px;
		height: 38px;
		border: 0;
	}
	.stack .mode.queue {
		background: var(--bg-active);
		color: var(--text);
	}
	.stack .mode.queue:hover:not(:disabled) {
		background: var(--border-strong);
	}
	.stack .mode.primary {
		background: var(--accent);
		color: var(--accent-fg);
	}
	.stack .mode.primary:hover:not(:disabled) {
		background: var(--accent-hover);
	}
	/* disabled: solid pre-mixed colours instead of opacity */
	.stack .mode:disabled {
		opacity: 1;
		background: var(--bg-active);
		color: var(--text-faint);
	}
	.stack .send.stop {
		width: 38px;
		height: 38px;
		background: var(--danger-soft);
		color: var(--danger);
		box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--danger) 40%, transparent);
	}
	.stack .send.stop:hover {
		background: color-mix(in srgb, var(--danger) 22%, transparent);
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
		width: 18px;
		height: 18px;
		stroke-width: 2;
	}
	/* the bolt bends more than an arrow, so the same stroke reads heavier: thin it a little */
	.stack .mode.primary :global(svg),
	.opt .ico.bolt :global(svg) {
		stroke-width: 1.5;
	}
	/* no positioned ancestor here on purpose: the menu anchors to the composer box, like the slash menu */
	.menu {
		position: absolute;
		left: 0;
		right: 0;
		bottom: calc(100% + 6px);
		background: var(--bg-elev);
		border: 1px solid var(--border-strong);
		border-radius: var(--radius);
		box-shadow: var(--shadow);
		padding: 4px 0;
		z-index: 20;
	}
	.opt {
		display: flex;
		align-items: center;
		gap: 12px;
		width: 100%;
		min-height: 40px;
		padding: 4px 12px;
		text-align: left;
	}
	.opt:hover,
	.opt:active {
		background: var(--bg-active);
	}
	.opt .ico {
		display: grid;
		place-items: center;
		flex: none;
		color: var(--text-dim);
	}
	.opt .ico :global(svg) {
		width: 18px;
		height: 18px;
		stroke-width: 2;
	}
	.opt .lbl {
		flex: none;
		font-size: var(--fs-sm);
		font-weight: 600;
		color: var(--text);
		white-space: nowrap;
	}
	.opt .desc {
		min-width: 0;
		font-size: var(--fs-xs);
		color: var(--text-dim);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	/* Touch: the queue circle folds into the long-press menu of the steer circle */
	@media (pointer: coarse) {
		.stack .mode.queue {
			display: none;
		}
	}
	@container (max-width: 340px) {
		.send {
			width: 32px;
			height: 32px;
		}
		.mode,
		.stack .mode {
			width: 32px;
			height: 32px;
		}
	}
</style>
