<script lang="ts">
	import { t } from "../lib/i18n";
	import { fadeIn, fadeOut } from "../lib/motion";
	import { tick, untrack } from "svelte";
	import Icon from "./Icon.svelte";
	import Message from "./Message.svelte";
	import PipayaLogo from "./PipayaLogo.svelte";
	import WorkBox from "./WorkBox.svelte";
	import { faceFor } from "../lib/faces";
	import { app } from "../lib/store.svelte";
	import type { ChatState } from "../lib/chat.svelte";
	import type { AssistantItem, ChatItem, NoticeItem, UserItem } from "../lib/types";

	let { chat }: { chat: ChatState } = $props();

	let scroller: HTMLDivElement | undefined = $state();
	let stuck = $state(true);
	let showJump = $state(false);

	const NEAR = 80;
	const atBottom = () => !scroller || scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < NEAR;

	let lastTop = 0;
	let raf = 0;

	function onScroll() {
		if (!scroller) return;
		const top = scroller.scrollTop;
		// Any upward movement is the user leaving the bottom: release immediately instead of waiting for NEAR.
		if (top < lastTop - 1) stuck = false;
		else if (atBottom()) stuck = true;
		lastTop = top;
		showJump = !stuck;
	}

	/** User intent (wheel/touch/keys) unpins before the browser even moves, so we never fight their scroll. */
	function release() {
		if (stuck) {
			stuck = false;
			showJump = true;
		}
	}
	function onWheel(e: WheelEvent) {
		if (e.deltaY < 0) release();
	}
	let touchY = 0;
	function onTouchStart(e: TouchEvent) {
		touchY = e.touches[0]?.clientY ?? 0;
	}
	function onTouchMove(e: TouchEvent) {
		if ((e.touches[0]?.clientY ?? 0) > touchY) release(); // finger moving down = content going up
	}
	function onKey(e: KeyboardEvent) {
		if (["ArrowUp", "PageUp", "Home"].includes(e.key)) release();
	}

	export function toBottom(smooth = false) {
		if (!scroller) return;
		stuck = true;
		showJump = false;
		if (smooth) {
			scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
			return;
		}
		// Coalesce bursts (token + resize + effect) into one write per frame.
		if (raf) return;
		raf = requestAnimationFrame(() => {
			raf = 0;
			if (!scroller || !stuck) return;
			scroller.scrollTop = scroller.scrollHeight;
			lastTop = scroller.scrollTop;
		});
	}

	// Follow the stream while the user is parked at the bottom; stop the moment they scroll up.
	$effect(() => {
		chat.items.length;
		const last = chat.items[chat.items.length - 1];
		if (last?.kind === "assistant") {
			last.blocks.length;
			const b = last.blocks[last.blocks.length - 1];
			if (b && "text" in b) b.text;
		}
		Object.keys(chat.tools).length;
		if (stuck) void tick().then(() => toBottom());
	});

	// New conversation: jump to the end without animation.
	$effect(() => {
		chat.id;
		chat.ready;
		stuck = true;
		void tick().then(() => toBottom());
	});

	// The user just sent something (prompt / steer / queue): go to the bottom once, even if they had scrolled up.
	let seenRequest = untrack(() => chat.bottomRequest);
	$effect(() => {
		const n = chat.bottomRequest;
		if (n === seenRequest) return;
		seenRequest = n;
		stuck = true;
		void tick().then(() => toBottom());
		// The optimistic bubble / queued chip may lay out a frame later.
		requestAnimationFrame(() => toBottom());
	});

	// The answer is complete: settle at the bottom, unless the user is reading further up.
	let wasRunning = untrack(() => chat.running);
	$effect(() => {
		const r = chat.running;
		if (wasRunning && !r && untrack(() => stuck)) {
			void tick().then(() => {
				toBottom();
				requestAnimationFrame(() => toBottom()); // the final message re-renders (work box collapses etc.)
			});
		}
		wasRunning = r;
	});

	// Content can grow after layout (images, tool cards opening, fonts), and the viewport itself shrinks when the
	// input grows (queued chips, multi-line text); keep pinned in both cases.
	let content: HTMLDivElement | undefined = $state();
	$effect(() => {
		if (!content || !scroller) return;
		const ro = new ResizeObserver(() => {
			if (stuck) toBottom();
		});
		ro.observe(content);
		ro.observe(scroller);
		return () => ro.disconnect();
	});

	/** The run has started but the model has not produced anything yet: nothing to attach the status to, so show it here */
	const waitingFirst = $derived(chat.running && chat.ready && chat.items[chat.items.length - 1]?.kind === "user");

	type Unit = { kind: "user"; item: UserItem } | { kind: "notice"; item: NoticeItem } | { kind: "turn"; key: string; items: AssistantItem[] };
	/** One prompt gets one reply: consecutive assistant messages (one per LLM call) are drawn as a single turn. */
	const units = $derived.by<Unit[]>(() => {
		const out: Unit[] = [];
		for (const it of chat.items as ChatItem[]) {
			if (it.kind === "user") out.push({ kind: "user", item: it });
			else if (it.kind === "notice") out.push({ kind: "notice", item: it });
			else {
				const prev = out[out.length - 1];
				if (prev?.kind === "turn") prev.items.push(it);
				else out.push({ kind: "turn", key: it.key, items: [it] });
			}
		}
		return out;
	});

	// A compaction is shown as a "/compact" command to the agent, so its bubble gets the same working wave as a prompt.
	const lastUserKey = $derived.by(() => {
		if (chat.compacting && chat.compactKey) return chat.compactKey;
		if (!chat.running) return undefined;
		for (let i = chat.items.length - 1; i >= 0; i--) if (chat.items[i]!.kind === "user") return chat.items[i]!.key;
		return undefined;
	});

	/** The newest units may still be streaming or glowing; everything older can be skipped by the browser while off-screen. */
	const SETTLED_TAIL = 2;

</script>

<div
	class="scroller"
	bind:this={scroller}
	onscroll={onScroll}
	onwheel={onWheel}
	ontouchstart={onTouchStart}
	ontouchmove={onTouchMove}
	onkeydown={onKey}
	role="presentation"
>
	<div class="inner" bind:this={content}>
		{#if !chat.ready && !chat.loadError}
			<div class="skeleton" aria-busy="true">
				<div class="sk skeleton-bar r"></div>
				<div class="sk skeleton-bar l"></div>
				<div class="sk skeleton-bar l short"></div>
			</div>
		{:else if chat.loadError}
			<div class="loaderr">
				<Icon name="alert" />
				<p>{chat.loadError}</p>
				<button class="btn" onclick={() => chat.load()}>{t("다시 시도")}</button>
			</div>
		{:else}
			{#each units as u, n (u.kind === "turn" ? u.key : u.item.key)}
				<div class="unit" class:settled={n < units.length - SETTLED_TAIL && !(u.kind === "user" && u.item.key === lastUserKey)}>
					{#if u.kind === "notice"}
						<div class="notice"><Icon name="alert" /> {u.item.text}</div>
					{:else if u.kind === "user"}
						<Message item={u.item} working={u.item.key === lastUserKey} />
					{:else}
						{@const end = n === units.length - 1}
						<Message item={u.items[u.items.length - 1]!} turn={u.items} last={end} live={end && chat.running} />
					{/if}
				</div>
			{/each}
			{#if waitingFirst}
				<div class="row wait">
					<div class="avatar"><PipayaLogo size={18} eyes face={faceFor(chat.id)} blink /></div>
					<div class="content"><WorkBox steps={[]} live /></div>
				</div>
			{/if}
		{/if}
	</div>
</div>

{#if showJump}
	<button class="jump" onclick={() => toBottom(true)} in:fadeIn out:fadeOut aria-label={t("최신 메시지로 이동")}>
		<Icon name="arrow-down" />
	</button>
{/if}

<style>
	/* Long sessions: off-screen turns skip layout and paint. `auto` remembers each turn's last real height. */
	.unit.settled {
		content-visibility: auto;
		contain-intrinsic-size: auto 160px;
	}
	.row.wait {
		display: flex;
		align-items: flex-start;
		gap: 12px;
		padding: 10px 0;
	}
	.avatar {
		flex: none;
		width: 30px;
		height: 30px;
		margin-top: 2px;
		display: grid;
		place-items: center;
		border-radius: 50%;
		border: 1px solid var(--border-strong);
		background: var(--bg-elev);
		color: var(--text);
	}
	.content {
		flex: none;
		min-width: 0;
		width: 100%;
	}
	.scroller {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		overflow-x: hidden;
		overscroll-behavior: contain;
		-webkit-overflow-scrolling: touch;
		scroll-padding-bottom: 24px;
	}
	.inner {
		max-width: calc(var(--content-w) + 32px);
		margin: 0 auto;
		padding: 16px 16px 28px;
	}
	.notice {
		display: flex;
		align-items: center;
		gap: 8px;
		margin: 10px 0;
		padding: 9px 12px;
		border-radius: var(--radius);
		background: var(--danger-soft);
		color: var(--danger);
		font-size: var(--fs-sm);
	}
	.notice :global(svg) {
		width: 17px;
		height: 17px;
		flex: none;
		stroke: currentColor;
		fill: none;
		stroke-width: 1.8;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	.jump {
		position: absolute;
		bottom: 8px;
		left: 50%;
		translate: -50% 0;
		width: 38px;
		height: 38px;
		display: grid;
		place-items: center;
		border-radius: var(--radius);
		background: var(--bg-elev);
		border: 1px solid var(--border-strong);
		box-shadow: var(--shadow);
		color: var(--text);
		z-index: 5;
	}
	.jump :global(svg) {
		width: 18px;
		height: 18px;
		stroke: currentColor;
		fill: none;
		stroke-width: 2;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	.skeleton {
		display: flex;
		flex-direction: column;
		gap: 14px;
		padding-top: 8px;
	}
	.sk {
		height: 46px;
	}
	.sk.r {
		width: 55%;
		align-self: flex-end;
	}
	.sk.l {
		width: 85%;
		height: 90px;
	}
	.sk.short {
		width: 60%;
		height: 46px;
	}
	.loaderr {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 10px;
		padding: 60px 0;
		color: var(--text-dim);
	}
	.loaderr :global(svg) {
		width: 28px;
		height: 28px;
		stroke: var(--danger);
		fill: none;
		stroke-width: 1.8;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
</style>
