<script lang="ts">
	import { t } from "../lib/i18n";
	import { slidingIndicator } from "../lib/sliding-indicator";
	import { dragScroll } from "../lib/drag-scroll";
	import AgentBadge from "./AgentBadge.svelte";
	import Icon from "./Icon.svelte";
	import { ACTIVITY_LABEL, activityOf } from "../lib/activity";
	import { panesOf } from "../lib/layout";
	import { app } from "../lib/store.svelte";
	import { viewport } from "../lib/viewport.svelte";
	import { closeContextMenu, openContextMenu } from "../lib/context-menu";
	import { pressMenu, recentTouch, type Point } from "../lib/press-menu";
	import { InlineRename } from "../lib/inline-rename.svelte";

	/** The chip being renamed in place (double click, or "이름 바꾸기" in its menu). */
	const rename = new InlineRename();
	function commitRename() {
		const done = rename.commit();
		if (!done) return;
		void (app.terminal(done.id) ? app.renameTerminal(done.id, done.name) : app.rename(done.id, done.name));
	}
	function focusSelect(node: HTMLInputElement) {
		node.focus();
		node.select();
	}

	/**
	 * A mouse right click on a chip renames it in place. A long press (touch) or the menu key opens the menu:
	 * rename, take it out of the group, or close it.
	 */
	function chipMenu(pt: Point, id: string, title: string) {
		if (!pt.key && !recentTouch()) {
			rename.start(id, title);
			return;
		}
		const term = !!app.terminal(id);
		openContextMenu(pt, `chip:${id}`, [
			{ icon: "pencil", label: t("이름 바꾸기"), title: "", run: () => rename.start(id, title) },
			{ icon: "unlink", label: t("그룹에서 빼기"), title: "", run: () => void app.leaveGroup(id) },
			term
				? { icon: "x", label: t("터미널 닫기"), title: t("셸을 종료합니다"), run: () => void app.closeTerminal(id) }
				: { icon: "x", label: t("닫기"), title: t("닫기 (/resume 으로 다시 열기)"), run: () => void app.close(id) },
		]);
		return closeContextMenu;
	}

	/** Phones: the sessions of the open group as a strip under the header; a tap switches to that session. */
	const group = $derived(app.activeGroup);
	const items = $derived(group ? panesOf(group.layout).map((id) => app.session(id) ?? app.terminal(id)).filter((s) => !!s) : []);

	let strip: HTMLElement | undefined = $state();
	// keep the focused chip in view when it changes (also when switched from elsewhere)
	$effect(() => {
		app.activeId;
		strip?.querySelector<HTMLElement>('[aria-current="true"]')?.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" });
	});
</script>

{#if group && items.length}
	<nav class="strip" bind:this={strip} aria-label={t("{name} 그룹의 대화", { name: group.name })} use:slidingIndicator={{ selector: ".chip.on", radius: "var(--radius-sm)" }} use:dragScroll>
		{#if viewport.narrow}
			<button class="back tap" onclick={() => (viewport.backedOut = group.id)} aria-label={t("탭 목록으로")} title={t("탭 목록으로")}><Icon name="chevron-left" /></button>
		{/if}
		<span class="name" title={group.name}>{group.name}</span>
		{#each items as x (x.id)}
			{@const st = app.terminal(x.id) ? "idle" : activityOf(app, x.id)}
			{#if rename.is(x.id)}
				<input
					class="rename"
					value={rename.draft}
					aria-label={t("이름 바꾸기")}
					use:focusSelect
					oninput={(e) => (rename.draft = e.currentTarget.value)}
					onblur={commitRename}
					onkeydown={(e) => {
						if (e.key === "Enter") commitRename();
						if (e.key === "Escape") rename.cancel();
					}}
				/>
			{:else}
				<button class="chip tap" class:on={x.id === app.activeId} aria-current={x.id === app.activeId ? "true" : undefined} onclick={() => app.openSession(x.id)} ondblclick={() => rename.start(x.id, x.title)} use:pressMenu={(pt) => chipMenu(pt, x.id, x.title)} title="{x.title} · {ACTIVITY_LABEL[st]}">
					{#if app.terminal(x.id)}<span class="tico"><Icon name="terminal" /></span>{:else}<AgentBadge id={x.id} state={st} size={16} />{/if}
					<span class="t">{x.title}</span>
				</button>
			{/if}
		{/each}
	</nav>
{/if}

<style>
	/* same shape as the tab bar above it: rounded rectangles, a soft fill for the selection */
	.strip {
		position: relative;
		flex: none;
		display: flex;
		align-items: center;
		gap: 4px;
		height: 38px;
		padding: 0 8px 0 max(8px, var(--sal));
		padding-right: max(8px, var(--sar));
		overflow-x: auto;
		overscroll-behavior-x: contain;
		scrollbar-width: none;
		border-bottom: 1px solid var(--border);
		background: var(--bg-group);
	}
	/* going into a group: the tab opens up into the group's sessions */
	.strip {
		animation: into-group var(--motion-fast) var(--ease-std);
	}
	@keyframes into-group {
		from {
			opacity: 0;
			transform: translateX(12px);
		}
	}
	.strip::-webkit-scrollbar {
		display: none;
	}
	.name {
		flex: none;
		max-width: 28vw;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		padding: 0 4px 0 4px;
		font-size: var(--fs-sm);
		font-weight: 700;
		color: var(--text);
	}
	.back {
		flex: none;
		display: grid;
		place-items: center;
		width: 28px;
		height: 28px;
		border-radius: var(--radius-sm);
		color: var(--text-dim);
	}
	.back:hover {
		background: var(--bg-hover);
		color: var(--text);
	}
	.back :global(svg) {
		width: 16px;
		height: 16px;
		stroke-width: 2;
	}
	.tico {
		display: inline-grid;
	}
	.tico :global(svg) {
		width: 14px;
		height: 14px;
		stroke-width: 1.9;
	}
	.chip {
		position: relative;
		z-index: 1;
		flex: none;
		display: inline-flex;
		align-items: center;
		gap: 4px;
		height: 28px;
		max-width: 46vw;
		padding: 0 8px;
		border-radius: var(--radius-sm);
		color: var(--text-dim);
		font-size: var(--fs-sm);
		white-space: nowrap;
		transition: background var(--motion-fast) var(--ease-std);
	}
	.chip:hover {
		background: var(--bg-hover);
		color: var(--text);
	}
	.chip.on {
		background: var(--bg-active);
		color: var(--text);
		font-weight: 600;
	}
	.strip:global([data-indicator-ready]) .chip.on {
		background: transparent;
	}
	.rename {
		flex: none;
		width: 160px;
		height: 28px;
		padding: 0 8px;
		border: 1px solid var(--accent);
		border-radius: var(--radius-sm);
		background: var(--bg);
		color: var(--text);
		font-size: var(--fs-sm);
		outline: 0;
	}
	.t {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
