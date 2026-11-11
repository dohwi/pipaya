<script lang="ts" module>
	/** Where each session's reader left the list: px between the view's end and the content's end. Absent = parked at the bottom.
	 *  The list is re-mounted per session, so this lives outside the component. Memory only. */
	const leftAt = new Map<string, number>();
</script>

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
	/** The loading outline: widths of the question's lines (px), of the work box's label and each paragraph's lines (% of the column) */
	const SK_TURNS = [
		{ ask: [220, 140], work: 32, paras: [[96, 92, 88, 54], [90, 72]], foot: true },
		{ ask: [168], work: 0, paras: [[94, 86, 62]], foot: false },
	];
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
		// Remember the reader's place for when this session comes back. Before the first restore the map still holds it.
		if (!firstOpen) {
			if (stuck) leftAt.delete(chat.id);
			else leftAt.set(chat.id, scroller.scrollHeight - scroller.scrollTop);
		}
		// The older page (already fetched ahead) goes in front only while the view is at rest or has reached the top:
		// writing scrollTop in the middle of a fling cuts its momentum and makes the view jump. A fling that reaches the
		// top simply stops there, the page is put in front, and the reader stays on the same message.
		if (chat.hasEarlier && !chat.earlierFailed && scroller.scrollTop < EARLIER_ZONE()) {
			if (scroller.scrollTop <= 1) void loadEarlier();
			else {
				clearTimeout(restTimer);
				restTimer = setTimeout(() => { if (scroller && scroller.scrollTop < EARLIER_ZONE()) void loadEarlier(); }, 120);
			}
		}
	}
	/** About three screens from the top: the page is in place before a calm reader gets there. */
	const EARLIER_ZONE = () => Math.max(2400, (scroller?.clientHeight ?? 0) * 3);
	let restTimer: ReturnType<typeof setTimeout> | undefined;
	$effect(() => () => clearTimeout(restTimer));

	/** Put the next older page in front without moving what the reader is looking at (Safari has no scroll anchoring). */
	async function loadEarlier() {
		if (!scroller || !chat.hasEarlier || chat.loadingEarlier) return;
		let before = -1;
		await chat.loadEarlier(() => {
			// Browser anchoring and our correction must not both move the view: ours alone, by exactly the height added.
			if (!scroller) return;
			before = scroller.scrollHeight;
			scroller.style.overflowAnchor = "none";
		});
		await tick();
		if (!scroller) return;
		if (before >= 0) {
			scroller.scrollTop += scroller.scrollHeight - before;
			lastTop = scroller.scrollTop;
		}
		scroller.style.overflowAnchor = stuck ? "none" : "auto";
	}

	// A short transcript that does not fill the view has nothing to scroll: fetch the older page right away.
	$effect(() => {
		if (!chat.ready || !chat.hasEarlier || chat.loadingEarlier || chat.earlierFailed || !scroller) return; // after a failure the retry button waits for the reader
		void tick().then(() => {
			if (scroller && scroller.scrollHeight <= scroller.clientHeight + 40) void loadEarlier();
		});
	});

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
	// Keys that scroll the list upward unpin too (otherwise onScroll would pin the view back at once). Typing fields keep
	// their own arrows, so a key only counts when the focus is not in one.
	const onKeyDown = (e: KeyboardEvent) => {
		if (e.defaultPrevented || e.ctrlKey || e.altKey) return;
		const up = e.key === "PageUp" || e.key === "Home" || e.key === "ArrowUp" || (e.key === " " && e.shiftKey);
		if (!up || !scroller) return;
		const el = e.target as HTMLElement | null;
		if (el?.closest("input, textarea, select, [contenteditable], [role=textbox]")) return;
		// Only this list: focus inside it, or nowhere (body). Other panes stay put.
		if (el !== document.body && !scroller.contains(el)) return;
		release();
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

	/** Back to where the reader left off; the bottom if they were parked there. */
	function restore() {
		// The first call uses the value from before mount: scroll events during mount overwrite the map.
		const below = firstOpen ? initialBelow : (leftAt.get(chat.id) ?? null);
		firstOpen = false;
		return place(below);
	}
	let firstOpen = true;
	let initialBelow: number | null = untrack(() => leftAt.get(chat.id) ?? null);
	function place(below: number | null) {
		if (below == null) return toBottom();
		if (!scroller) return;
		setStuck(false);
		showJump = true;
		scroller.scrollTop = scroller.scrollHeight - below;
		lastTop = scroller.scrollTop;
		// off-screen turns settle their real height afterwards; hold the same distance from the end
		requestAnimationFrame(() => {
			if (!scroller || stuck) return;
			scroller.scrollTop = scroller.scrollHeight - below;
			lastTop = scroller.scrollTop;
			showJump = gap() >= NEAR;
		});
	}

	// A conversation was opened and loaded: back where it was left, or at its end.
	$effect(() => {
		chat.id;
		if (chat.ready) void tick().then(restore);
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
		// RO callbacks already run after layout; one pin per frame is enough
		let queued = false;
		const ro = new ResizeObserver(() => {
			if (!stuck || touching || queued) return;
			queued = true;
			queueMicrotask(() => {
				queued = false;
				if (stuck && !touching) pin();
			});
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

</script>

<svelte:window onpointerup={onPointerUp} onpointercancel={onPointerUp} onkeydown={onKeyDown} />

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
			<!-- a conversation's outline while it loads: a question, a reply with a work box, paragraphs and its foot, then the next turn -->
			<div class="skeleton skeleton-in" aria-busy="true" aria-label={t("불러오는 중…")}>
				{#each SK_TURNS as turn, ti (ti)}
					<div class="skuser">
						<div class="skbubble">
							{#each turn.ask as w, i (i)}<i class="skeleton-bar skline" style:width="{w}px" style:--sk-i={ti * 8 + i}></i>{/each}
						</div>
					</div>
					<div class="skreply">
						{#if turn.work}
							<div class="skwork">
								<i class="skeleton-bar skico" style:--sk-i={ti * 8 + 2}></i>
								<i class="skeleton-bar skline" style:width="{turn.work}%" style:--sk-i={ti * 8 + 2}></i>
							</div>
						{/if}
						{#each turn.paras as para, pi (pi)}
							<div class="skpara">
								{#each para as w, i (i)}<i class="skeleton-bar skline" style:width="{w}%" style:--sk-i={ti * 8 + 3 + pi + i}></i>{/each}
							</div>
						{/each}
						{#if turn.foot}
							<div class="skfoot">
								{#each [0, 1, 2] as i (i)}<i class="skeleton-bar skico" style:--sk-i={ti * 8 + 6}></i>{/each}
								<i class="skeleton-bar skline skstats" style:--sk-i={ti * 8 + 6}></i>
							</div>
						{/if}
					</div>
				{/each}
			</div>
		{:else if chat.loadError}
			<div class="loaderr">
				<Icon name="alert" />
				<p>{chat.loadError}</p>
				<Button onclick={() => chat.load()}>{t("다시 시도")}</Button>
			</div>
		{:else}
			{#if chat.hasEarlier && (chat.loadingEarlier || chat.earlierFailed)}
				<!-- older pages arrive by themselves while scrolling; only a loading hint, or a retry after a failure, is shown -->
				<div class="earlier">
					{#if chat.loadingEarlier}
						<span class="earlier-wait" role="status">{t("불러오는 중…")}</span>
					{:else}
						<Button onclick={loadEarlier}>{t("이전 대화 더 보기")}</Button>
					{/if}
				</div>
			{/if}
			{#each units as u, n (u.kind === "turn" ? u.key : u.item.key)}
				<div class="unit" class:live={chat.running && n === units.length - 1}>
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

{#if chat.ready && chat.items.length > 0}<div class="fade" aria-hidden="true"></div>{/if}

{#if showJump}
	<button class="jump" onclick={() => toBottom(true)} in:fadeIn out:fadeOut aria-label={t("최신 메시지로 이동")}>
		<Icon name="arrow-down" />
	</button>
{/if}

<style>
	/* The reply being written is rebuilt every frame and only grows at its end. As a scroll anchor it made a reader above the
	   bottom creep down with the stream (the browser kept "correcting" for nodes that were replaced), so it is left out. */
	.unit.live {
		overflow-anchor: none;
	}
	.earlier {
		display: flex;
		justify-content: center;
		padding: 8px 0;
	}
	.earlier-wait {
		line-height: 20px;
		color: var(--text-dim);
	}
	.row.wait {
		display: flex;
		flex-direction: column;
		align-items: stretch;
		gap: 8px;
		padding: 8px 0;
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
		/* Pinned at the bottom we scroll ourselves (overflow-anchor: none, set from script); scrolled up, anchoring is on.
		   No content-visibility on turns: its 160px estimate for off-screen turns was swapped for the real height mid-flick,
		   and that correction made a fast scroll up stutter. */
	}
	/* The content fades out over its last 24px instead of being cut in a straight line against the composer's rounded box.
	   A gradient of the pane colour on top, not mask-image: a mask forces the whole scrolling list through an offscreen
	   layer that is redrawn on every scroll and resize frame (stutter in WebKit). */
	.fade {
		position: absolute;
		left: 0;
		right: 0;
		bottom: 0;
		height: 24px;
		background: linear-gradient(to bottom, transparent, var(--bg));
		pointer-events: none;
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
		margin: 8px 0;
		padding: 8px 12px;
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
		bottom: 12px; /* sits inside the 24px fade, clear of the composer's edge */
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
		gap: 16px;
		padding-top: 8px;
		/* the outline trails off toward the composer instead of ending on a hard edge */
		mask-image: linear-gradient(to bottom, #000 55%, transparent);
	}
	.skline {
		display: block;
		height: 12px;
		max-width: 100%;
	}
	.skico {
		display: block;
		flex: none;
		width: 16px;
		height: 16px;
	}
	/* the question: a bubble on the right, drawn like the real one (UserMessage .bubble) */
	.skuser {
		display: flex;
		justify-content: flex-end;
	}
	.skbubble {
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 8px;
		max-width: min(85%, 560px);
		padding: 12px 16px;
		border-radius: var(--radius);
		background: var(--user-bg);
		border: 1px solid var(--border);
	}
	.skreply {
		display: flex;
		flex-direction: column;
		gap: 16px;
		padding-top: 4px; /* the reply card's own 4 (AssistantMessage .reply-card) */
	}
	/* the work box: a 44px card with an icon and a label, like WorkBox's folded group */
	.skwork {
		display: flex;
		align-items: center;
		gap: 8px;
		height: 44px;
		padding: 0 12px;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--bg-elev);
	}
	/* a paragraph: 12px bones on a 24px line rhythm */
	.skpara {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}
	/* the reply's foot: copy / reply / fork glyphs (16px in 32px boxes, so 16 apart) and the model line, as in AssistantMessage .foot */
	.skfoot {
		display: flex;
		align-items: center;
		gap: 16px;
		height: 32px;
	}
	.skstats {
		width: 120px;
		height: 8px;
		margin-left: 8px;
	}
	.loaderr {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 8px;
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
