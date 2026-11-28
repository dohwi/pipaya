<script lang="ts">
	import { t } from "../../lib/i18n";
	import { hintOnce } from "../../lib/touch-hints";
	import { createSendHoldController } from "../../lib/send-hold";
	import { chipIn, chipOut, surfaceIn, surfaceOut } from "../../lib/motion";
	import Icon from "../ui/Icon.svelte";
	import Spinner from "../ui/Spinner.svelte";

	/**
	 * The right end of the composer bar. Idle: send. While the agent works: queue (after the run), steer (into it) and
	 * stop. While compacting: a status and cancel. Switching between them crossfades instead of jumping.
	 *
	 * `folded`: idle with nothing to send and a microphone beside it. The send circle then folds to nothing so the
	 * microphone sits in its place, and unfolds (pushing the microphone left) once there is text or an attachment.
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
		steerKey = "Enter",
		sendKey = "Enter",
		onsteer,
		onstop,
		folded = false,
		holdToQueue = false,
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
		/** The steer shortcut as shown to the user ("" = unbound). */
		steerKey?: string;
		/** The idle send shortcut as shown to the user ("" = hidden). */
		sendKey?: string;
		onsteer: () => void;
		onstop: () => void;
		folded?: boolean;
		/** Touch: hold the running send button to queue directly instead of opening the steer/queue chooser. */
		holdToQueue?: boolean;
	} = $props();

	const mode = $derived(compacting ? "compacting" : running ? "running" : "idle");
	const fold = $derived(folded && mode === "idle");

	// Touch: tap = steer, long-press = open steer/queue chooser (or queue directly when `holdToQueue` is on). The queue circle is hidden there (see CSS).
	let menu = $state(false);
	let menuEl = $state<HTMLDivElement | null>(null);
	let steerBtn = $state<HTMLButtonElement | null>(null);
	const coarse = () => typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
	const hold = createSendHoldController({
		canHold: () => coarse() && mode === "running" && hasInput && online && !sending,
		holdToQueue: () => holdToQueue,
		vibrate: () => navigator.vibrate?.(10),
		onOpenMenu: () => {
			menu = true;
		},
		onDirectQueue: () => {
			menu = false;
			onqueue();
		},
		onSteer: () => {
			onsteer();
			// touch: the queue choice hides behind a long press, which nothing on screen shows; say it once
			if (coarse()) {
				hintOnce(
					"steer-hold",
					holdToQueue
						? t("끼워 넣기 버튼을 길게 누르면 바로 대기열에 넣습니다")
						: t("끼워 넣기 버튼을 길게 누르면 대기열에 넣을 수도 있습니다"),
				);
			}
		},
	});

	function pressStart() {
		hold.start();
	}
	function pressEnd() {
		hold.cancel();
	}
	function steerClick(e: MouseEvent) {
		hold.handleClick(() => e.preventDefault());
	}
	function closeMenu(returnFocus = false) {
		menu = false;
		if (returnFocus) steerBtn?.focus();
	}
	function pick(fn: () => void) {
		menu = false;
		fn();
	}
	function menuKey(e: KeyboardEvent) {
		if (e.key === "Escape") {
			e.preventDefault();
			e.stopPropagation();
			closeMenu(true);
			return;
		}
		const items = [...(menuEl?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
		if (!items.length) return;
		const at = items.indexOf(document.activeElement as HTMLElement);
		const next =
			e.key === "ArrowDown" ? (at + 1) % items.length
			: e.key === "ArrowUp" ? (at - 1 + items.length) % items.length
			: e.key === "Home" ? 0
			: e.key === "End" ? items.length - 1
			: -1;
		if (next < 0) return;
		e.preventDefault();
		items[next]!.focus();
	}
	$effect(() => {
		if (!menu) return;
		const first = menuEl?.querySelector<HTMLElement>('[role="menuitem"]');
		if (first) first.focus();
		const close = () => closeMenu();
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				closeMenu(true);
			}
		};
		const id = setTimeout(() => addEventListener("pointerdown", close, { once: true }), 0);
		addEventListener("keydown", onKey, true);
		return () => {
			clearTimeout(id);
			removeEventListener("pointerdown", close);
			removeEventListener("keydown", onKey, true);
		};
	});
	$effect(() => {
		if (mode !== "running" || !hasInput || !online || sending) {
			hold.cancel();
			menu = false;
		} else if (holdToQueue) {
			menu = false;
		}
	});
	$effect(() => () => hold.reset());
</script>

<div class="sc" class:folded={fold}>
	{#key mode}
		<div class="set" in:chipIn out:chipOut>
			{#if mode === "compacting"}
				<span class="compacting" role="status"><span class="dots" aria-hidden="true"><i></i><i></i><i></i></span> {t("압축 중")}</span>
				<button class="send tap" class:on={canSend} onclick={onsend} disabled={!canSend} aria-label={t("보내기")}>
					{#if sending}<Spinner />{:else}<Icon name="send" />{/if}
				</button>
				<button class="send stop tap" onclick={onstop} disabled={!online} aria-label={t("압축 취소")} title={t("컨텍스트 압축 취소")}><Icon name="stop" /></button>
			{:else if mode === "running"}
				<div class="stack">
					{#if hasInput}
					<button class="mode queue" onclick={onqueue} disabled={!online || sending} aria-label={t("대기열")} title={queueKey ? t("현재 작업이 모두 끝난 뒤 실행 ({key})", { key: queueKey }) : t("현재 작업이 모두 끝난 뒤 실행")}>
						<Icon name="list" />
					</button>
					{/if}
					{#if hasInput}
					<div class="steerwrap">
						{#if menu}
							<!-- The menu container only routes arrow/Esc keys to its menuitem buttons. -->
							<!-- svelte-ignore a11y_no_static_element_interactions -->
							<div class="menu" role="menu" tabindex="-1" bind:this={menuEl} onkeydown={menuKey} in:surfaceIn={{ y: 8 }} out:surfaceOut={{ y: 8 }}>
								<button class="opt" role="menuitem" onpointerdown={(e) => e.stopPropagation()} onclick={() => pick(onsteer)}>
									<span class="ico bolt"><Icon name="bolt" /></span><span class="lbl">{t("끼워 넣기")}</span><span class="desc">{t("지금 답변 중에 전달")}</span>
								</button>
								<button class="opt" role="menuitem" onpointerdown={(e) => e.stopPropagation()} onclick={() => pick(onqueue)}>
									<span class="ico"><Icon name="list" /></span><span class="lbl">{t("대기열")}</span><span class="desc">{t("작업이 끝난 뒤 실행")}</span>
								</button>
							</div>
						{/if}
						<button
							bind:this={steerBtn}
							class="mode primary tap"
							disabled={!online || sending}
							aria-haspopup={holdToQueue ? undefined : "menu"}
							aria-expanded={holdToQueue ? undefined : menu}
							onpointerdown={pressStart}
							onpointerup={pressEnd}
							onpointerleave={pressEnd}
							onpointercancel={pressEnd}
							oncontextmenu={(e) => coarse() && e.preventDefault()}
							onclick={steerClick}
							aria-label={t("끼워 넣기")}
							title={steerKey ? t("진행 중인 작업에 바로 끼워 넣기: 실행 중인 도구가 끝나면 다음 모델 호출 전에 전달됩니다 ({key})", { key: steerKey }) : t("진행 중인 작업에 바로 끼워 넣기: 실행 중인 도구가 끝나면 다음 모델 호출 전에 전달됩니다")}
						>
							<Icon name="bolt" />
						</button>
					</div>
					{/if}
					<button class="send stop tap" onclick={onstop} aria-label={t("중지")} title={t("작업 중지")}><Icon name="stop" /></button>
				</div>
			{:else}
				<div class="slot" class:folded={fold} inert={fold}>
					<button class="send tap" class:on={canSend} onclick={onsend} disabled={!canSend} aria-label={t("보내기")} title={sendKey ? t("보내기 ({key})", { key: sendKey }) : undefined}>
						{#if sending}<Spinner />{:else}<Icon name="send" />{/if}
					</button>
				</div>
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
	/* Idle send circle in a box that folds to zero width (see `folded`); the circle keeps its size and only fades.
	   The 4px padding, cancelled by the margin, keeps the clip off the focus ring (2px outline + 2px offset). */
	.slot {
		--slot-w: 38px; /* the send circle */
		display: flex;
		justify-content: flex-end;
		box-sizing: content-box;
		width: var(--slot-w);
		padding: 4px;
		margin: -4px; /* cancels the ring padding above: the box takes exactly the circle's place */
		overflow: hidden;
		transition:
			width var(--motion-fast) var(--ease-std),
			padding var(--motion-fast) var(--ease-std),
			margin var(--motion-fast) var(--ease-std),
			opacity var(--motion-fast) var(--ease-std);
	}
	.slot.folded {
		width: 0;
		padding-inline: 0;
		margin-inline: 0;
		opacity: 0;
	}
	/* folded, the cell is 0 wide; pulling it over the bar's 4px gap lands the microphone exactly where the circle was */
	.sc {
		transition: margin var(--motion-fast) var(--ease-std);
	}
	.sc.folded {
		margin-left: -4px; /* the bar's gap */
	}
	@media (prefers-reduced-motion: reduce) {
		.slot,
		.sc {
			transition: none;
		}
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
		line-height: 16px;
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
	@media (hover: hover) {
		.stack .mode.queue:hover:not(:disabled) {
			background: var(--border-strong);
		}
	}
	.stack .mode.primary {
		background: var(--accent);
		color: var(--accent-fg);
	}
	@media (hover: hover) {
		.stack .mode.primary:hover:not(:disabled) {
			background: var(--accent-hover);
		}
	}
	/* disabled: solid pre-mixed colours instead of opacity */
	.stack .mode:disabled {
		color: var(--disabled-fg);
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
	@media (hover: hover) {
		.stack .send.stop:hover {
			background: color-mix(in srgb, var(--danger) 22%, transparent);
		}
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
	@media (hover: hover) {
		.mode:hover:not(:disabled) {
			background: var(--bg-active);
			color: var(--text);
		}
	}
	.mode:active:not(:disabled) {
		transform: scale(0.92);
	}
	.mode:disabled {
		color: var(--disabled-fg);
	}
	.mode.primary {
		background: var(--accent);
		border-color: var(--accent);
		color: var(--accent-fg);
	}
	@media (hover: hover) {
		.mode.primary:hover:not(:disabled) {
			background: var(--accent-hover);
			color: var(--accent-fg);
		}
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
		box-shadow: var(--shadow-overlay);
		padding: 4px 0;
		z-index: var(--z-popover);
	}
	.opt {
		display: flex;
		align-items: center;
		gap: 12px;
		width: 100%;
		min-height: 40px;
		padding: 4px 12px;
		line-height: 20px;
		text-align: left;
	}
	.opt:active {
		background: var(--bg-active);
	}
	@media (hover: hover) {
		.opt:hover {
			background: var(--bg-active);
		}
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
		.slot {
			--slot-w: 32px; /* the narrow send circle below */
		}
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
