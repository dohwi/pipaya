<script lang="ts">
	import Button from "./Button.svelte";
	import { t } from "../lib/i18n";
	import { fadeIn, fadeOut } from "../lib/motion";
	import { tick, untrack } from "svelte";
	import Icon from "./Icon.svelte";
	import Message from "./Message.svelte";
	import WorkBox from "./WorkBox.svelte";
	import type { ChatState } from "../lib/chat.svelte";
	import type { AssistantItem, ChatItem, EntryItem, NoticeItem, UserItem } from "../lib/types";
	import EntryCard from "./extensions/EntryCard.svelte";
	import { extensions } from "../lib/extensions/host.svelte";

	let { chat }: { chat: ChatState } = $props();

	let scroller: HTMLDivElement | undefined = $state();
	let showJump = $state(false);

	/** Show the jump button once the view is further than this from the bottom. */
	const NEAR = 80;

	/** Pinned = parked at the bottom: follow the stream. Only real user intent (wheel/touch/keys/scrollbar drag) unpins. */
	let stuck = true;
	/** Browser scroll anchoring only while the user is reading above the bottom (see .scroller); pinned, we place the scroll ourselves. */
	function setStuck(v: boolean) {
		stuck = v;
		if (scroller) scroller.style.overflowAnchor = v ? "none" : "auto";
	}
	let lastTop = 0;
	let dragging = false;
	/** A smooth scroll to the bottom (jump button) is in flight. */
	let smoothing = false;

	const gap = () => (scroller ? scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight : 0);

	/** Synchronous write: lands before paint, so the stream never shows a frame that is off the bottom. */
	function pin() {
		if (!scroller) return;
		scroller.scrollTop = scroller.scrollHeight;
		lastTop = scroller.scrollTop;
	}

	function onScroll() {
		if (!scroller) return;
		if (smoothing) {
			if (gap() < 2) smoothing = false;
		} else if (stuck) {
			if (scroller.scrollTop < lastTop - 0.5 && performance.now() - lastWheelUp < 150) {
				// A gentle upward wheel that moved the view: the user is leaving the bottom.
				setStuck(false);
			} else if (gap() > 1) {
				// Not the user (they unpin first): the browser settled layout or clamped scrollTop. Stay at the bottom.
				pin();
			}
		} else if (gap() < 2 && scroller.scrollTop > lastTop) {
			// The user came back down to the end. Strictly greater: the scroll event of our own pin() arrives a frame late,
			// and if a wheel-up unpinned in between, that stale event (same position) must not pin again and undo the wheel.
			setStuck(true);
		}
		lastTop = scroller.scrollTop;
		showJump = gap() >= NEAR;
	}

	function release() {
		smoothing = false;
		setStuck(false);
	}
	let touchY = 0;
	// Only a clearly upward, mostly vertical wheel unpins: trackpad sideways swipes, pinch (ctrlKey) and inertia jitter must not.
	// A slower upward wheel (|deltaY| < 2, a gentle trackpad nudge) only notes the time: if the view then really moves up,
	// onScroll unpins. Otherwise onScroll would pin the view back to the bottom on every such event (a flicker).
	let lastWheelUp = 0;
	const onWheel = (e: WheelEvent) => {
		if (e.ctrlKey || e.deltaY >= 0 || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
		if (e.deltaY > -2) lastWheelUp = performance.now();
		else release();
	};
	let touching = false;
	const onTouchStart = (e: TouchEvent) => { touching = true; touchY = e.touches[0]?.clientY ?? 0; };
	const onTouchMove = (e: TouchEvent) => {
		const y = e.touches[0]?.clientY ?? 0;
		if (y > touchY + 4) release();
		touchY = y;
	};
	const onTouchEnd = () => {
		touching = false;
		if (stuck && gap() > 1) pin();
	};
	const onPointerDown = (e: PointerEvent) => { if (e.target === scroller) dragging = true; };
	const onPointerUp = () => { dragging = false; };
	// Dragging the scrollbar upward also unpins.
	function onDragScroll() {
		if (dragging && scroller && scroller.scrollTop < lastTop - 1) release();
	}

	// The in-chat search scrolls away from the end: stop following the stream so the view stays on the match.
	$effect(() => {
		const el = scroller;
		if (!el) return;
		el.addEventListener("unpin", release);
		return () => el.removeEventListener("unpin", release);
	});

	export function toBottom(smooth = false) {
		if (!scroller) return;
		setStuck(true);
		if (smooth) {
			smoothing = true;
			scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
			return;
		}
		smoothing = false;
		showJump = false;
		pin();
	}

	// A conversation was opened and loaded: start at its end.
	$effect(() => {
		chat.id;
		if (chat.ready) void tick().then(() => toBottom());
	});

	// The user just sent something (prompt / steer / queue): go to the bottom once, even if they had scrolled up.
	let seenRequest = untrack(() => chat.bottomRequest);
	$effect(() => {
		const n = chat.bottomRequest;
		if (n === seenRequest) return;
		seenRequest = n;
		setStuck(true);
		void tick().then(() => {
			toBottom();
			// off-screen turns settle their real height afterwards; land exactly on the input again
			requestAnimationFrame(() => stuck && pin());
		});
	});

	// Follow growth (streaming text, tool cards, images, input box resizing the viewport) while pinned.
	let content: HTMLDivElement | undefined = $state();
	$effect(() => {
		if (!content || !scroller) return;
		const ro = new ResizeObserver(() => {
			if (stuck && !touching) pin();
		});
		ro.observe(content);
		ro.observe(scroller);
		return () => ro.disconnect();
	});

	/** The run has started but the model has not produced anything yet: nothing to attach the status to, so show it here */
	const waitingFirst = $derived(chat.running && chat.ready && chat.items[chat.items.length - 1]?.kind === "user");

	type Unit = { kind: "user"; item: UserItem } | { kind: "notice"; item: NoticeItem } | { kind: "entry"; item: EntryItem } | { kind: "turn"; key: string; items: AssistantItem[] };
	/** One prompt gets one reply: consecutive assistant messages (one per LLM call) are drawn as a single turn. */
	const units = $derived.by<Unit[]>(() => {
		const out: Unit[] = [];
		for (const it of chat.items as ChatItem[]) {
			if (it.kind === "user") out.push({ kind: "user", item: it });
			else if (it.kind === "notice") out.push({ kind: "notice", item: it });
			else if (it.kind === "entry") {
				// Only entries an active extension knows how to draw take a place; the rest stay invisible.
				if (extensions.messageRendererFor(it.entryType)) out.push({ kind: "entry", item: it });
			}
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

<svelte:window onpointerup={onPointerUp} onpointercancel={onPointerUp} />

<div
	class="scroller"
	data-part="messages"
	bind:this={scroller}
	onscroll={() => { onDragScroll(); onScroll(); }}
	onwheel={onWheel}
	ontouchstart={onTouchStart}
	ontouchmove={onTouchMove}
	ontouchend={onTouchEnd}
	ontouchcancel={onTouchEnd}
	onpointerdown={onPointerDown}
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
				<Button onclick={() => chat.load()}>{t("다시 시도")}</Button>
			</div>
		{:else}
			{#each units as u, n (u.kind === "turn" ? u.key : u.item.key)}
				<div class="unit" class:settled={n < units.length - SETTLED_TAIL && !(u.kind === "user" && u.item.key === lastUserKey)} class:live={chat.running && n === units.length - 1}>
					{#if u.kind === "notice"}
						<div class="notice"><Icon name="alert" /> {u.item.text}</div>
					{:else if u.kind === "entry"}
						<EntryCard item={u.item} />
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
	/* Long sessions: off-screen turns skip layout and paint. `auto` remembers each turn's last real height.
	   Only where scroll anchoring exists: a turn swaps its 160px estimate for its real height as it scrolls into view, and
	   WebKit (macOS Safari / Tauri) cannot anchor that shift, so scrolling up flickered there. */
	@supports (overflow-anchor: auto) {
		.unit.settled {
			content-visibility: auto;
			contain-intrinsic-size: auto 160px;
		}
	}
	/* The reply being written is rebuilt every frame and only grows at its end. As a scroll anchor it made a reader above the
	   bottom creep down with the stream (the browser kept "correcting" for nodes that were replaced), so it is left out. */
	.unit.live {
		overflow-anchor: none;
	}
	.row.wait {
		display: flex;
		flex-direction: column;
		align-items: stretch;
		gap: 8px;
		padding: 10px 0;
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
		overflow-anchor: none;
		/* Pinned at the bottom we scroll ourselves (overflow-anchor: none, set from script). Scrolled up, anchoring must stay on:
		   off-screen turns (content-visibility) swap their 160px estimate for the real height as they come into view, and without
		   anchoring that shifts everything under the reader's eyes, so the list seemed to wobble up and down. */
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
		stroke-width: 1.8;
	}
	.jump {
		position: absolute;
		bottom: 8px;
		left: 50%;
		translate: -50% 0;
		width: 36px;
		height: 36px;
		display: grid;
		place-items: center;
		border-radius: 50%;
		background: var(--bg);
		border: 1px solid var(--border-strong);
		box-shadow: var(--shadow-soft);
		color: var(--text-dim);
		z-index: 5;
		transition:
			background var(--motion-fast) var(--ease-std),
			color var(--motion-fast) var(--ease-std),
			scale var(--motion-fast) var(--ease);
	}
	.jump:hover {
		background: var(--bg-hover);
		color: var(--text);
	}
	.jump:active {
		scale: 0.9;
	}
	.jump :global(svg) {
		width: 18px;
		height: 18px;
		stroke-width: 2;
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
		stroke-width: 1.8;
	}
</style>
