<script lang="ts">
	import { untrack } from "svelte";
	import { t } from "../../lib/i18n";
	import { app } from "../../lib/store.svelte";
	import { sessionTitle } from "../../lib/session-title";
	import { activityOf, ACTIVITY_LABEL, ACTIVITY_TONE, URGENCY, type Activity } from "../../lib/activity";
	import { tabPanes, type Tab } from "../../lib/nav";
	import { agoText, gridNext, previewOfItems, previewOfStored, shortPath, type Preview } from "../../lib/tab-overview";
	import { reflow, rowOut } from "../../lib/motion";
	import Modal from "../ui/Modal.svelte";
	import IconButton from "../ui/IconButton.svelte";
	import Icon from "../ui/Icon.svelte";
	import Pin from "../ui/Pin.svelte";
	import StatusDot from "../ui/StatusDot.svelte";
	import AgentBadge from "./AgentBadge.svelte";

	/**
	 * The folder's tabs as a grid of cards, like a mobile browser's tab switcher: a full-screen sheet on a phone, a large
	 * dialog elsewhere. A card opens its tab (and closes this), its X closes the tab (a group has none, as on the strip).
	 */
	let { onclose }: { onclose: () => void } = $props();

	const dir = $derived(app.tabDir);
	const path = $derived(dir?.path ?? app.workdirAbs);
	const tabs = $derived(dir?.tabs ?? []);
	const activeTab = $derived(app.activeTab?.tab.id ?? null);
	const title = t("탭");
	const sub = $derived(shortPath(path));

	const titleOf = (x: Tab) => (x.kind === "group" ? x.group.name : x.kind === "session" ? sessionTitle(x.session.title) : x.terminal.title);
	function stateOf(x: Tab): Activity {
		const states = tabPanes(x)
			.filter((id) => !!app.session(id))
			.map((id) => activityOf(app, id));
		return URGENCY.find((a) => states.includes(a)) ?? "idle";
	}

	/* ---- previews: a loaded transcript as it is now, otherwise the newest few stored messages, read once per open ---- */
	let fetched = $state<Record<string, Preview | null>>({});
	const PREVIEW_TAIL = 6;
	// one controller for the overview's life: closing a tab re-runs the effect, which must not cancel the other cards' reads
	const ctrl = new AbortController();
	$effect(() => () => ctrl.abort());
	$effect(() => {
		const api = app.api;
		const ids = tabs.filter((x) => x.kind === "session").map((x) => x.id);
		if (!api) return;
		untrack(() => {
			for (const id of ids) {
				if (id in fetched || app.chatOf(id)?.ready) continue;
				fetched[id] = null; // asked: one request per card, even while it is in flight
				api.recentMessages(id, PREVIEW_TAIL, ctrl.signal)
					.then((m) => (fetched[id] = previewOfStored(m)))
					.catch(() => {
						/* no preview: the card keeps its facts line */
					});
			}
		});
	});
	const previewOf = (id: string): Preview | null => {
		const chat = app.chatOf(id);
		return chat?.ready ? previewOfItems(chat.items) : (fetched[id] ?? null);
	};

	let now = $state(Date.now());
	$effect(() => {
		const timer = setInterval(() => (now = Date.now()), 30_000);
		return () => clearInterval(timer);
	});

	function open(x: Tab) {
		app.openTab(x.id);
		onclose();
	}
	function close(x: Tab) {
		if (x.kind === "group") return;
		if (x.kind === "terminal") void app.closeTerminal(x.id);
		else void app.close(x.id);
	}
	const closeLabel = (x: Tab) => (x.kind === "terminal" ? t("터미널 닫기 (셸 종료)") : t("닫기 (/resume 으로 다시 열기)"));
	const workdir = $derived(path === app.workspace?.root ? "." : path);
	function newChat() {
		if (app.serverId) app.openIn(app.serverId, { workdir });
		onclose();
	}

	/* ---- keyboard: the cards are one Tab stop, arrows move across the grid by its real column count ---- */
	let grid: HTMLElement | undefined = $state();
	let focusId = $state<string | null>(untrack(() => activeTab));
	const current = $derived(tabs.some((x) => x.id === focusId) ? focusId : (tabs.find((x) => x.id === activeTab)?.id ?? tabs[0]?.id ?? null));
	function columns(): number {
		const cols = grid ? getComputedStyle(grid).gridTemplateColumns.split(" ").filter(Boolean).length : 1;
		return Math.max(1, cols);
	}
	function keys(e: KeyboardEvent) {
		if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
		const cards = Array.from(grid?.querySelectorAll<HTMLElement>(".card") ?? []);
		const i = cards.indexOf((e.target as HTMLElement).closest(".card") as HTMLElement);
		if (i < 0) return;
		if ((e.key === "Enter" || e.key === " ") && e.target === cards[i]) {
			e.preventDefault();
			cards[i]!.click();
			return;
		}
		if ((e.key === "Delete" || e.key === "Backspace") && e.target === cards[i]) {
			const x = tabs[i];
			if (x && x.kind !== "group") {
				e.preventDefault();
				// focus moves on to the card that takes its place
				focusId = tabs[i + 1]?.id ?? tabs[i - 1]?.id ?? null;
				close(x);
				queueMicrotask(() => grid?.querySelector<HTMLElement>(`[data-card="${CSS.escape(focusId ?? "")}"]`)?.focus());
			}
			return;
		}
		const next = gridNext(e.key, i, cards.length, columns());
		if (next == null) return;
		e.preventDefault();
		focusId = tabs[next]?.id ?? null;
		cards[next]?.focus();
	}
	/** The current tab's card takes focus as the overview opens, so arrows work at once and Enter goes back to it. */
	function focusCurrent(node: HTMLElement, on: boolean) {
		if (on) queueMicrotask(() => node.isConnected && node.focus({ preventScroll: false }));
	}
</script>

<Modal {onclose} {title} {sub} subMono label={t("탭 {n}개 모두 보기", { n: tabs.length })} width="1040px" maxHeight="760px" full {titleExtra} {headerActions}>
	<div class="body">
		{#if tabs.length}
			<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
			<ul class="grid" bind:this={grid} role="list" onkeydown={keys}>
				{#each tabs as x (x.id)}
					{@const on = x.id === activeTab}
					{@const st = stateOf(x)}
					{@const p = x.kind === "session" ? previewOf(x.id) : null}
					<li class="cell" animate:reflow out:rowOut>
						<!-- Enter / Space / Delete and the arrows are handled once for the whole grid (`keys` on the list) -->
						<!-- svelte-ignore a11y_click_events_have_key_events -->
						<div
							class="card"
							class:on
							data-card={x.id}
							role="button"
							tabindex={x.id === current ? 0 : -1}
							aria-current={on ? "page" : undefined}
							aria-keyshortcuts={x.kind !== "group" ? "Delete" : undefined}
							aria-label="{titleOf(x)}{st !== 'idle' ? ` · ${ACTIVITY_LABEL[st]}` : ''}"
							use:focusCurrent={x.id === current}
							onclick={() => open(x)}
							onfocus={() => (focusId = x.id)}
						>
							<div class="top">
								{#if x.kind === "group"}
									<span class="ico"><Icon name="columns" />{#if st !== "idle"}<Pin tone={ACTIVITY_TONE[st] === "neutral" ? "danger" : ACTIVITY_TONE[st]} pulse={st === "working"} ping={st === "asking"} />{/if}</span>
								{:else if x.kind === "terminal"}
									<span class="ico"><Icon name="terminal" /></span>
								{:else}
									<span class="ico"><AgentBadge id={x.id} state={st} size={16} /></span>
								{/if}
								<span class="t">{titleOf(x)}</span>
								{#if x.kind !== "group"}
									<button class="x tap" tabindex="-1" onclick={(e) => (e.stopPropagation(), close(x))} aria-label={closeLabel(x)} title={closeLabel(x)}><Icon name="x" /></button>
								{/if}
							</div>
							<!-- the sheet under the title band: what the tab holds, then its facts -->
							<div class="sheet">
								<div class="prev">
									{#if x.kind === "session"}
										{#if p}
											<p class="text"><span class="who">{p.who === "user" ? t("나") : t("에이전트")}</span>&nbsp;{p.text}</p>
										{:else}
											<p class="text none">{t("아직 메시지가 없습니다")}</p>
										{/if}
									{:else if x.kind === "terminal"}
										<p class="term mono"><span class="prompt">$</span> {x.terminal.shell.split(/[\\/]/).pop()}</p>
									{:else}
										<ul class="members">
											{#each x.members.slice(0, 3) as m (m.id)}
												<li>{"shell" in m ? m.title : sessionTitle(m.title)}</li>
											{/each}
										</ul>
									{/if}
								</div>
								<div class="meta">
									{#if st !== "idle"}<span class="state {st}"><StatusDot tone={ACTIVITY_TONE[st]} pulse={st === "working"} size={7} />{ACTIVITY_LABEL[st]}</span>{/if}
									<span class="info">
										{#if x.kind === "group"}{t("대화 {n}개", { n: x.members.length })}
										{:else if x.kind === "terminal"}{t("터미널")} · <span class="mono">{shortPath(x.terminal.cwd)}</span>
										{:else}{agoText(x.session.updatedAt, now)}{/if}
									</span>
								</div>
							</div>
						</div>
					</li>
				{/each}
			</ul>
		{:else}
			<p class="empty">{t("이 폴더에 열린 탭이 없습니다")}</p>
		{/if}
	</div>
</Modal>

{#snippet titleExtra()}<span class="n">{tabs.length}</span>{/snippet}
<!-- beside the close button, as a browser's tab switcher keeps its "+" by the corner -->
{#snippet headerActions()}<IconButton icon="plus" label={t("새 대화")} tip onclick={newChat} />{/snippet}

<style>
	.body {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		overscroll-behavior: contain;
		padding: 8px var(--dlg-px) var(--dlg-body-b); /* top: the scroll box clips, and a focused current card's ring reaches 6px out (2px frame + 4px offset); 4 lost its top */
	}
	@media (max-width: 640px) {
		.body {
			padding-bottom: calc(var(--dlg-body-b) + var(--sab));
		}
	}
	.n {
		margin-left: 8px;
		font-size: var(--fs-xs);
		font-weight: 500;
		color: var(--text-faint);
		font-variant-numeric: tabular-nums;
	}
	/* 2 columns on a phone, 3 on a tablet, 4 in a wide dialog: the card is never narrower than ~150px */
	.grid {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: 12px;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	@media (max-width: 960px) {
		.grid {
			grid-template-columns: repeat(3, minmax(0, 1fr));
		}
	}
	@media (max-width: 640px) {
		.grid {
			grid-template-columns: repeat(2, minmax(0, 1fr));
			gap: 8px;
		}
	}
	.cell {
		min-width: 0;
	}
	/* A browser's tab card: a title band in the tab strip's tone over a sheet in the page's, a hairline between them. Both
	   are 12px inside the card's border on every side (DESIGN rule 4): band 12 + 20 + 12, sheet 12 + preview 54 + 8 + facts
	   16 + 12, so every card is 2 + 44 + 1 + 102 = 149px and a row of them lines up. */
	.card {
		position: relative;
		display: flex;
		flex-direction: column;
		height: 100%;
		overflow: hidden; /* the band's corners follow the card's */
		background: var(--bg);
		border: 1px solid var(--border-strong);
		border-radius: var(--radius);
		cursor: pointer;
		user-select: none;
		-webkit-user-select: none;
		transition:
			border-color var(--motion-fast) var(--ease-std),
			box-shadow var(--motion-fast) var(--ease-std);
	}
	@media (hover: hover) {
		.card:hover {
			border-color: var(--text-faint);
		}
	}
	/* the tab in front: a 3px accent frame (the border plus a 2px ring outside it), so the box does not grow */
	.card.on {
		border-color: var(--accent);
		box-shadow: 0 0 0 2px var(--accent);
	}
	.card:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 4px; /* clear of the current card's 2px ring */
	}
	/* the title band is the title's own 20px line with 12px of air above and below; the 28px close box overhangs the line
	   by 4px above and below instead of pushing the title down */
	.top {
		flex: none;
		display: flex;
		align-items: center;
		gap: 8px;
		height: 45px; /* 12 + the 20px title line + 12, and the 1px hairline below */
		padding: 12px;
		border-bottom: 1px solid var(--border);
		background: var(--bg-tabbar);
	}
	.sheet {
		flex: 1;
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 12px;
	}
	.ico {
		position: relative; /* hosts the group's status dot (Pin) */
		display: grid;
		flex: none;
		color: var(--text-dim);
	}
	.ico > :global(svg) {
		width: 16px;
		height: 16px;
		stroke-width: 1.9;
	}
	.t {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: var(--fs-sm);
		font-weight: 600;
		line-height: 20px;
	}
	/* the close glyph ends on the card's right line: the 28px box holds a 14px glyph 7px in */
	.x {
		display: grid;
		place-items: center;
		flex: none;
		width: 28px;
		height: 28px;
		margin-right: -7px; /* the glyph's inset in its 28px box (DESIGN rule 5) */
		margin-block: -4px; /* overhangs the 20px title row: the box keeps its 28px target, the row its title height */
		border-radius: var(--radius-sm);
		color: var(--text-faint);
	}
	.x :global(svg) {
		width: 14px;
		height: 14px;
		stroke-width: 1.9;
	}
	@media (hover: hover) {
		.x:hover {
			background: var(--bg-active);
			color: var(--text);
		}
	}
	.prev {
		flex: 1;
		min-height: 54px; /* three 18px lines, so every card in a row starts its facts line on the same height */
	}
	.prev p {
		margin: 0;
	}
	.text {
		font-size: var(--fs-xs);
		line-height: 18px;
		color: var(--text-dim);
		display: -webkit-box;
		-webkit-line-clamp: 3;
		line-clamp: 3;
		-webkit-box-orient: vertical;
		overflow: hidden;
		overflow-wrap: anywhere;
	}
	.text.none {
		color: var(--text-faint);
	}
	.who {
		font-weight: 600;
		color: var(--text);
	}
	.term {
		font-size: var(--fs-2xs);
		line-height: 16px;
		color: var(--text-dim);
		padding: 8px;
		background: var(--bg-active);
		border-radius: var(--radius-sm);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.prompt {
		color: var(--ok);
	}
	.members {
		margin: 0;
		padding: 0;
		list-style: none;
		font-size: var(--fs-xs);
		line-height: 18px;
		color: var(--text-dim);
	}
	.members li {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.meta {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
		font-size: var(--fs-2xs);
		line-height: 16px;
		color: var(--text-faint);
	}
	.state {
		flex: none;
		display: inline-flex;
		align-items: center;
		gap: 4px;
		font-weight: 600;
	}
	.state.working {
		color: var(--info);
	}
	.state.asking {
		color: var(--warn);
	}
	.state.done {
		color: var(--ok);
	}
	.state.failed {
		color: var(--danger);
	}
	/* "2분 전", "대화 2개": body type like the state beside it (the global `.facts` is mono and spread the Korean out) */
	.info {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.empty {
		margin: 0;
		padding: 24px 12px;
		text-align: center;
		color: var(--text-faint);
		font-size: var(--fs-sm);
		line-height: 20px;
	}
</style>
