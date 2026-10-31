<script lang="ts">
	import { RENAME_KEY } from "../lib/keys";
	import { t } from "../lib/i18n";
	import { slidingIndicator } from "../lib/sliding-indicator";
	import { dragScroll } from "../lib/drag-scroll";
	import AgentBadge from "./AgentBadge.svelte";
	import Icon from "./Icon.svelte";
	import { ACTIVITY_LABEL, activityOf } from "../lib/activity";
	import { panesOf } from "../lib/layout";
	import { app } from "../lib/store.svelte";
	import { closeContextMenu, openContextMenu } from "../lib/context-menu";
	import { pressMenu, type Point } from "../lib/press-menu";
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

	/** Long press / right click on a chip: take it out of the group, or close it. */
	function chipMenu(pt: Point, id: string, title: string) {
		const term = !!app.terminal(id);
		openContextMenu(pt, `chip:${id}`, [
			{ icon: "pencil", label: t("이름 바꾸기"), title: "", run: () => rename.start(id, title) },
			{ icon: "unlink", label: t("그룹에서 빼기"), title: "", run: () => void app.leaveGroup(id) },
			// the enlarged group's own tab (with its unlink button) is hidden on wide screens, so the whole group is dissolved from here
			...(group ? [{ icon: "unlink" as const, label: t("그룹 해제 (대화는 그대로 남습니다)"), title: "", run: () => void app.deleteGroup(group.id) }] : []),
			term
				? { icon: "x", label: t("터미널 닫기"), title: t("셸을 종료합니다"), run: () => void app.closeTerminal(id) }
				: { icon: "x", label: t("닫기"), title: t("닫기 (/resume 으로 다시 열기)"), run: () => void app.close(id) },
		]);
		return closeContextMenu;
	}

	/** The sessions of the open group as chips after its tab; a tap switches to that session. */
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
				<button class="chip tap" class:on={x.id === app.activeId} aria-current={x.id === app.activeId ? "true" : undefined} onclick={() => app.openSession(x.id)} ondblclick={() => rename.start(x.id, x.title)} onkeydown={(e) => e.key === RENAME_KEY && (e.preventDefault(), rename.start(x.id, x.title))} use:pressMenu={(pt) => chipMenu(pt, x.id, x.title)} title="{x.title} · {ACTIVITY_LABEL[st]}">
					{#if app.terminal(x.id)}<span class="tico"><Icon name="terminal" /></span>{:else}<AgentBadge id={x.id} state={st} size={16} />{/if}
					<span class="t">{x.title}</span>
				</button>
			{/if}
		{/each}
	</nav>
{/if}

<style>
	/* the open group's sessions as one bordered unit hanging off the group's tab in the tab bar: it gives way before the
	   tabs do, so with many sessions the chips scroll inside their box instead of pushing the other tabs off the screen */
	/* the sessions of the open group, the scrolling part of the group's box in the tab bar (TabBar's .gbox draws the border) */
	.strip {
		position: relative;
		flex: 1 1 auto;
		min-width: 96px;
		height: 100%;
		display: flex;
		align-items: center;
		gap: 4px;
		overflow-x: auto;
		overscroll-behavior-x: contain;
		scrollbar-width: none;
	}
	.strip::-webkit-scrollbar {
		display: none;
	}
	/* phones: no room for a second scroller, so the box keeps its natural width and the whole tab bar scrolls (same breakpoint as lib/viewport) */
	@media (max-width: 860px) {
		.strip {
			flex: none;
			min-width: 0;
			overflow: visible;
		}
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
		height: 22px;
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
