<script lang="ts">
	import ExtensionMount from "./extensions/ExtensionMount.svelte";
	import ExtensionPart from "./extensions/ExtensionPart.svelte";
	import { extensions } from "../lib/extensions/host.svelte";
	import { peerLabel } from "../lib/peers";
	import { t } from "../lib/i18n";
	import Icon from "./Icon.svelte";
	import AgentBadge from "./AgentBadge.svelte";
	import EmptyHero from "./EmptyHero.svelte";
	import Welcome from "./Welcome.svelte";
	import MessageList from "./MessageList.svelte";
	import FindBar from "./FindBar.svelte";
	import Composer from "./Composer.svelte";
	import DropLayer from "./DropLayer.svelte";
	import SessionToasts from "./SessionToasts.svelte";
	import { activityOf } from "../lib/activity";
	import { dragSource } from "../lib/dnd.svelte";
	import { closeContextMenu, openContextMenu, type MenuItem } from "../lib/context-menu";
	import type { Point } from "../lib/press-menu";
	import { marquee } from "../lib/fit-text";
	import { setPane } from "../lib/pane";
	import { app } from "../lib/store.svelte";
	import ExtensionSlot from "./extensions/ExtensionSlot.svelte";
	import Lazy from "./Lazy.svelte";
	import { isTerminalId, platformName } from "../lib/terminal";

	const loadTerminal = () => import("./TerminalView.svelte");

	/**
	 * One conversation with its own input. `id` null = a new chat that has no session yet.
	 * `grouped`: shown as one of several panes, so it gets a title bar (to drag it around) and can be focused by a click.
	 */
	let { id, grouped = false }: { id: string | null; grouped?: boolean } = $props();

	const focused = $derived(!grouped || id === app.activeId);
	setPane(() => ({ id, focused }));

	const group = $derived(grouped && id ? app.groupOf(id) : undefined);
	const full = $derived(app.isFull(group?.id));
	const zoomed = $derived(grouped && !!id && (full || app.zoomId === id));
	/** The button: full mode toggles back to the grid, otherwise the temporary zoom. */
	function toggleZoom() {
		if (!id) return;
		if (full && group) app.toggleFull(group.id);
		else app.zoomId = zoomed ? null : id;
	}
	const chat = $derived(app.chatOf(id));
	const session = $derived(app.session(id));
	/** A terminal pane: the server's shell instead of a conversation */
	const term = $derived(app.terminal(id));
	const isTerm = $derived(isTerminalId(id));
	const state = $derived(id && !isTerm ? activityOf(app, id) : "idle");
	/** A label an extension put on this session. */
	const tag = $derived(id ? (peerLabel(session) ?? extensions.labelOf(id)) : undefined);

	/** Right click / long press on the title bar: what its buttons do, with renaming and closing. */
	function paneMenu(pt: Point) {
		if (!id) return;
		const pane = id;
		const items: MenuItem[] = [
			{ icon: zoomed ? "shrink" : "expand", label: zoomed ? t("작게 보기") : t("크게 보기"), title: "", run: toggleZoom },
			{ icon: "unlink", label: t("그룹에서 빼기"), title: "", run: () => void app.leaveGroup(pane) },
			isTerm
				? { icon: "x", label: t("터미널 닫기"), title: t("셸을 종료합니다"), run: () => void app.closeTerminal(pane) }
				: { icon: "x", label: t("닫기"), title: t("닫기 (/resume 으로 다시 열기)"), run: () => void app.close(pane) },
		];
		openContextMenu(pt, `pane:${pane}`, items);
		return closeContextMenu;
	}

	function focus() {
		if (grouped && id && id !== app.activeId) void app.openSession(id);
	}
</script>

<!-- Only listens (capture) to move focus to this pane when something inside it is pressed or focused; it is not itself a control. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<section class="pane" data-part="pane" data-pane={id ?? undefined} class:grouped class:focused={grouped && focused} class:finished={grouped && state === "done"} onpointerdowncapture={focus} onfocusincapture={focus}>
	{#if grouped && id}
		<header
			class="bar"
			use:dragSource={{ id, menu: paneMenu }}
			title={t("끌어서 다른 칸으로 옮기기 · 더블 클릭으로 전체 화면 전환")}
			ondblclick={(e) => {
				if ((e.target as HTMLElement).closest("button")) return;
				if (group) app.toggleFull(group.id);
			}}
		>
			{#if isTerm}
				<span class="ticon"><Icon name="terminal" /></span>
			{:else}
				<AgentBadge {id} {state} size={16} />
			{/if}
			<span class="tt">
				{#if term}
				<span class="t">{term.title}{#if app.terminalSupport}<span class="os mono">{platformName(app.terminalSupport.platform)}</span>{/if}</span>
				<span class="cwd mono" title={term.cwd}>{term.cwd.split(/[\\/]/).slice(-2).join("/")}</span>
				{:else}
				{#snippet label()}{#if tag}<span class="who mono {state}" title={session?.name ? t("이 대화의 이름. 다른 대화에서 @{name}(으)로 부를 수 있습니다", { name: session.name }) : tag.title}>{tag.text}</span>{/if}{session?.title ?? t("대화")}{/snippet}
				<span class="t" use:marquee={`${tag?.text ?? ""}${session?.title ?? ""}`}><span class="track"><span class="mq">{@render label()}</span><span class="dup" aria-hidden="true">{@render label()}</span></span></span>
				{#if session}<span class="cwd mono" title={session.cwd}>{session.cwd.split(/[\\/]/).slice(-2).join("/")}</span>{/if}
				{/if}
			</span>
			<button class="x" onpointerdown={(e) => e.stopPropagation()} onclick={toggleZoom} aria-label={zoomed ? t("작게 보기") : t("크게 보기")} title={zoomed ? (full ? t("작게 보기") : t("작게 보기 (Esc)")) : t("크게 보기")}><Icon name={zoomed ? "shrink" : "expand"} /></button>
			<button class="x" onpointerdown={(e) => e.stopPropagation()} onclick={() => app.leaveGroup(id)} aria-label={t("그룹에서 빼기")} title={t("그룹에서 빼기")}><Icon name="unlink" /></button>
			{#if isTerm}<button class="x" onpointerdown={(e) => e.stopPropagation()} onclick={() => app.closeTerminal(id)} aria-label={t("터미널 닫기")} title={t("터미널 닫기 (셸 종료)")}><Icon name="x" /></button>{/if}
		</header>
	{/if}

	{#if isTerm}
	<div class="body">
		<SessionToasts id={id!} />
		{#if term}
			{#key term.id}<Lazy load={loadTerminal} terminal={term} {focused} />{/key}
		{:else}
			<div class="gone">{t("터미널이 닫혔습니다")}</div>
		{/if}
	</div>
	<DropLayer target={id!} />
	{:else}

	<ExtensionMount slot="pane.top" props={{ paneId: id }} />
	<div class="body">
		{#if id}<SessionToasts {id} />{/if}
		{#if id && chat && chat.ready && !chat.loadError && chat.items.length === 0}
			<!-- centred in the conversation area (everything above the input), for new and empty sessions alike -->
			<ExtensionPart part="pane.empty" props={{ paneId: id }}><EmptyHero /></ExtensionPart>
		{/if}
		{#if chat}
			{#key chat.id}
				<MessageList {chat} />
			{/key}
			<FindBar paneId={id} {focused} />
		{:else if !id}
			<div class="empty">
				<ExtensionPart part="pane.welcome"><Welcome /></ExtensionPart>
			</div>
		{/if}
	</div>

	<ExtensionSlot slot="footer" />
	<ExtensionMount slot="pane.bottom" props={{ paneId: id }} />
	<Composer />
	<!-- covers the input and the stats line too, so a drop zone reaches the bottom edge of the pane -->
	{#if id}<DropLayer target={id} />{/if}
	{/if}
</section>

<style>
	.pane {
		flex: 1;
		min-width: 0;
		min-height: 0;
		display: flex;
		flex-direction: column;
		position: relative;
		container-type: inline-size;
		background: var(--bg);
	}
	.pane.grouped {
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		overflow: hidden;
	}
	.pane.focused {
		border-color: var(--accent);
	}
	/* finished while the user was elsewhere: green frame + title bar until the pane is looked at */
	.pane.finished {
		border-color: var(--ok);
		box-shadow: 0 0 0 1px var(--ok);
	}
	.pane.finished .bar {
		background: var(--ok-soft);
		border-bottom-color: var(--ok);
	}
	.pane.finished .t {
		color: var(--ok);
	}
	.bar {
		flex: none;
		display: flex;
		align-items: center;
		gap: 7px;
		height: 38px;
		padding: 0 4px 0 9px;
		background: var(--bg-side);
		border-bottom: 1px solid var(--border);
		cursor: grab;
		user-select: none;
	}
	.bar:active {
		cursor: grabbing;
	}
	/* takes all the free width so the badge and the unlink button sit at the right edge */
	.tt {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: baseline;
		gap: 7px;
	}
	/* pushed to the right edge of the title area, next to the badge / unlink button */
	.ticon {
		display: grid;
		place-items: center;
		width: 16px;
		height: 16px;
		color: var(--text-dim);
	}
	.ticon :global(svg) {
		width: 15px;
		height: 15px;
		stroke-width: 1.9;
	}
	.os {
		margin-left: 7px;
		font-size: var(--fs-2xs);
		font-weight: 500;
		color: var(--text-faint);
	}
	.gone {
		flex: 1;
		display: grid;
		place-items: center;
		color: var(--text-faint);
		font-size: var(--fs-sm);
	}
	.cwd {
		flex: 0 1 auto;
		min-width: 0;
		margin-left: auto;
		font-size: var(--fs-2xs);
		color: var(--text-faint);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.t {
		flex: 0 1 auto;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: var(--fs-xs);
		font-weight: 600;
		color: var(--text-dim);
	}
	.who {
		margin-right: 6px;
		color: var(--text-dim);
		font-weight: 700;
	}
	.who.working { color: var(--info); }
	.who.asking { color: var(--warn); }
	.who.done { color: var(--ok); }
	.who.failed { color: var(--danger); }
	.focused .t {
		color: var(--text);
	}
	/* a title that does not fit flows by while the pane is focused, looping back to its start */
	.t .track {
		display: inline;
	}
	.t .dup {
		display: none;
	}
	@media (hover: hover) {
		.focused .t:global([data-over]) {
			text-overflow: clip;
			-webkit-mask-image: linear-gradient(90deg, #000 calc(100% - 14px), transparent);
			mask-image: linear-gradient(90deg, #000 calc(100% - 14px), transparent);
		}
		.focused .t:global([data-over]) .track {
			display: flex;
			width: max-content;
			animation: mq var(--mq-d, 8s) linear infinite;
		}
		.focused .t:global([data-over]) .mq,
		.focused .t:global([data-over]) .dup {
			display: block;
			flex: none;
			padding-right: 32px;
		}
	}
	@keyframes mq {
		from {
			translate: 0;
		}
		to {
			translate: -50%;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.t:global([data-over]) .track {
			animation: none !important;
		}
	}
	.ti {
		display: inline-block;
	}
	/* A title longer than the bar scrolls through while the pane is selected, so the whole text can be read. */
	@media (prefers-reduced-motion: no-preference) {
		.focused .t:global(.over) {
			text-overflow: clip;
		}
		.focused .t:global(.over) .ti {
			animation: title-scroll var(--dur, 8s) ease-in-out infinite;
		}
	}
	@keyframes title-scroll {
		0%, 15% { transform: translateX(0); }
		70%, 85% { transform: translateX(var(--shift)); }
		100% { transform: translateX(0); }
	}
	.x {
		flex: none;
		display: grid;
		place-items: center;
		width: 24px;
		height: 24px;
		border-radius: var(--radius-sm);
		color: var(--text-faint);
	}
	.x:hover {
		background: var(--bg-hover);
		color: var(--text);
	}
	.x :global(svg) {
		width: 14px;
		height: 14px;
		stroke-width: 1.9;
	}
	.body {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
		position: relative;
	}
	.empty {
		flex: 1;
		display: flex;
		overflow-y: auto;
		position: relative;
	}
	.empty > :global(.welcome) {
		position: relative;
	}
</style>
