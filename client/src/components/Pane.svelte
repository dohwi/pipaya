<script lang="ts">
	import { t } from "../lib/i18n";
	import Icon from "./Icon.svelte";
	import AgentBadge from "./AgentBadge.svelte";
	import Backdrop from "./Backdrop.svelte";
	import Welcome from "./Welcome.svelte";
	import MessageList from "./MessageList.svelte";
	import Composer from "./Composer.svelte";
	import DropLayer from "./DropLayer.svelte";
	import SessionToasts from "./SessionToasts.svelte";
	import PipayaMark from "./PipayaMark.svelte";
	import { activityOf } from "../lib/activity";
	import { dragSource } from "../lib/dnd.svelte";
	import { setPane } from "../lib/pane";
	import { app } from "../lib/store.svelte";
	import ExtensionSlot from "./extensions/ExtensionSlot.svelte";

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
	const state = $derived(id ? activityOf(app, id) : "idle");
	/** The name other sessions call this one by; the other sessions address it as @name. */
	const memberName = $derived(session?.name);

	/**
	 * Marks a clipped title: sets `--shift` (how far the text overflows) and `.over` so CSS can scroll it into view.
	 * Re-measured when the text or the bar width changes.
	 */
	function overflow(node: HTMLElement, _text?: string) {
		const measure = () => {
			const inner = node.firstElementChild as HTMLElement | null;
			const d = inner ? inner.scrollWidth - node.clientWidth : 0;
			node.classList.toggle("over", d > 1);
			node.style.setProperty("--shift", `${-Math.max(d, 0)}px`);
			node.style.setProperty("--dur", `${Math.max(d / 40, 2) + 2}s`);
		};
		const ro = new ResizeObserver(measure);
		ro.observe(node);
		if (node.firstElementChild) ro.observe(node.firstElementChild);
		measure();
		return { update: measure, destroy: () => ro.disconnect() };
	}

	function focus() {
		if (grouped && id && id !== app.activeId) void app.openSession(id);
	}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<section class="pane" data-pane={id ?? undefined} class:grouped class:focused={grouped && focused} class:finished={grouped && state === "done"} onpointerdowncapture={focus} onfocusincapture={focus}>
	{#if grouped && id}
		<header
			class="bar"
			use:dragSource={{ id }}
			title={t("끌어서 다른 칸으로 옮기기 · 더블 클릭으로 전체 화면 전환")}
			ondblclick={(e) => {
				if ((e.target as HTMLElement).closest("button")) return;
				if (group) app.toggleFull(group.id);
			}}
		>
			<AgentBadge {id} {state} size={16} />
			<span class="tt">
				<span class="t">{#if memberName}<span class="who mono {state}" title={t("이 대화의 이름. 다른 대화에서 @{name}로 부를 수 있습니다", { name: memberName })}>@{memberName}</span>{/if}{session?.title ?? t("대화")}</span>
				{#if session}<span class="cwd mono" title={session.cwd}>{session.cwd.split("/").slice(-2).join("/")}</span>{/if}
			</span>
			<button class="x" onpointerdown={(e) => e.stopPropagation()} onclick={toggleZoom} aria-label={zoomed ? t("작게 보기") : t("크게 보기")} title={zoomed ? (full ? t("작게 보기") : t("작게 보기 (Esc)")) : t("크게 보기")}><Icon name={zoomed ? "shrink" : "expand"} /></button>
			<button class="x" onpointerdown={(e) => e.stopPropagation()} onclick={() => app.leaveGroup(id)} aria-label={t("그룹에서 빼기")} title={t("그룹에서 빼기")}><Icon name="unlink" /></button>
		</header>
	{/if}

	<div class="body">
		{#if id}<SessionToasts {id} />{/if}
		{#if id && chat && chat.ready && !chat.loadError && chat.items.length === 0}
			<!-- centred in the conversation area (everything above the input), for new and empty sessions alike -->
			<div class="hello" aria-hidden="true">
				<PipayaMark size={72} />
			</div>
		{/if}
		{#if chat}
			{#key chat.id}
				<MessageList {chat} />
			{/key}
		{:else if !id}
			<div class="empty">
				<Backdrop />
				<Welcome />
			</div>
		{/if}
	</div>

	<ExtensionSlot slot="footer" />
	<Composer />
	<!-- covers the input and the stats line too, so a drop zone reaches the bottom edge of the pane -->
	{#if id}<DropLayer target={id} />{/if}
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
		stroke: currentColor;
		fill: none;
		stroke-width: 1.9;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	.body {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
		position: relative;
	}
	.hello {
		position: absolute;
		inset: 0;
		display: grid;
		place-items: center;
		pointer-events: none;
		user-select: none;
		color: var(--text-faint);
		opacity: 0.35;
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
