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
	import PipayaLogo from "./PipayaLogo.svelte";
	import { faceFor } from "../lib/faces";
	import { activityOf } from "../lib/activity";
	import { dragSource } from "../lib/dnd.svelte";
	import { setPane } from "../lib/pane";
	import { app } from "../lib/store.svelte";

	/**
	 * One conversation with its own input. `id` null = a new chat that has no session yet.
	 * `grouped`: shown as one of several panes, so it gets a title bar (to drag it around) and can be focused by a click.
	 */
	let { id, grouped = false }: { id: string | null; grouped?: boolean } = $props();

	const focused = $derived(!grouped || id === app.activeId);
	setPane(() => ({ id, focused }));

	const zoomed = $derived(grouped && !!id && app.zoomId === id);
	const chat = $derived(app.chatOf(id));
	const session = $derived(app.session(id));
	const state = $derived(id ? activityOf(app, id) : "idle");

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
			title={t("끌어서 다른 칸으로 옮기기 · 더블 클릭으로 크게 보기")}
			ondblclick={(e) => {
				if ((e.target as HTMLElement).closest("button")) return;
				app.zoomId = zoomed ? null : id;
			}}
		>
			<AgentBadge {id} {state} size={16} />
			<span class="tt">
				<span class="t">{session?.title ?? t("대화")}</span>
				{#if session}<span class="cwd mono" title={session.cwd}>{session.cwd.split("/").slice(-2).join("/")}</span>{/if}
			</span>
			<button class="x" onpointerdown={(e) => e.stopPropagation()} onclick={() => (app.zoomId = zoomed ? null : id)} aria-label={zoomed ? t("작게 보기 (Esc)") : t("크게 보기")} title={zoomed ? t("작게 보기 (Esc)") : t("크게 보기")}><Icon name={zoomed ? "shrink" : "expand"} /></button>
			<button class="x" onpointerdown={(e) => e.stopPropagation()} onclick={() => app.leaveGroup(id)} aria-label={t("그룹에서 빼기")} title={t("그룹에서 빼기")}><Icon name="unlink" /></button>
		</header>
	{/if}

	<div class="body">
		{#if id}<SessionToasts {id} />{/if}
		{#if id && chat && chat.ready && !chat.loadError && chat.items.length === 0}
			<!-- centred in the conversation area (everything above the input), for new and empty sessions alike -->
			<div class="hello" aria-hidden="true">
				<PipayaLogo size={112} eyes face={faceFor(id)} blink />
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
	.focused .t {
		color: var(--text);
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
