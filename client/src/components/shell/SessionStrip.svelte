<script lang="ts">
	import { sessionTitle } from "../../lib/session-title";
	import { peerLabel } from "../../lib/peers";
	import { extensions } from "../../lib/extensions/host.svelte";
	import { RENAME_KEY } from "../../lib/keys";
	import { t } from "../../lib/i18n";
	import Handle from "../ui/Handle.svelte";
	import AgentBadge from "./AgentBadge.svelte";
	import Icon from "../ui/Icon.svelte";
	import InlineRenameField from "../ui/InlineRenameField.svelte";
	import { ACTIVITY_LABEL, activityOf } from "../../lib/activity";
	import type { Tab } from "../../lib/nav";
	import { panesOf } from "../../lib/layout";
	import { app } from "../../lib/store.svelte";
	import { closeContextMenu, openContextMenu } from "../../lib/context-menu";
	import type { Point } from "../../lib/press-menu";
	import { drag, dragSource } from "../../lib/dnd.svelte";
	import { memberMenu } from "../../lib/member-menu";
	import { InlineRename } from "../../lib/inline-rename.svelte";

	/** The chip being renamed in place (double click, or "이름 바꾸기" in its menu). */
	const rename = new InlineRename();
	function commitRename() {
		const done = rename.commit();
		if (!done) return;
		void (app.terminal(done.id) ? app.renameTerminal(done.id, done.name) : app.rename(done.id, done.name));
	}

	/** Long press / right click on a chip: the same entries as the sidebar's row for it, except the ones that dissolve the group. */
	function chipMenu(pt: Point, id: string, title: string) {
		openContextMenu(pt, `chip:${id}`, memberMenu(id, title, (tid, name) => rename.start(tid, name)));
		return closeContextMenu;
	}

	/** The sessions of a group as chips inside its box; a tap opens the group on that session. */
	let { tab }: { tab: Extract<Tab, { kind: "group" }> } = $props();
	const group = $derived(tab.group);
	/** only the open group marks one of its sessions as the current one */
	const open = $derived(app.activeTab?.tab.id === tab.id);
	const items = $derived(group ? panesOf(group.layout).map((id) => app.session(id) ?? app.terminal(id)).filter((s) => !!s) : []);
	/** The `@name` handle of a conversation (a terminal has none), as the sidebar row and the tab bar show it. */
	const whoOf = (id: string) => {
		const s = app.session(id);
		return s ? (peerLabel(s) ?? extensions.labelOf(id)) : undefined;
	};

</script>

{#if items.length}
	<!-- the arrows walk the chips together with the tab bar's other tabs (TabBar's rovingKeys): one row, one Tab stop -->
	<nav class="strip" aria-label={t("{name} 그룹의 대화", { name: group.name })}>
		{#each items as x (x.id)}
			{@const st = app.terminal(x.id) ? "idle" : activityOf(app, x.id)}
			{@const who = whoOf(x.id)}
			{#if rename.is(x.id)}
				<InlineRenameField
					variant="bar"
					class="strip-rename"
					value={rename.draft}
					ariaLabel={t("이름 바꾸기")}
					oninput={(v) => (rename.draft = v)}
					oncommit={commitRename}
					oncancel={() => rename.cancel()}
				/>
			{:else}
				<span class="gitem">
				<button class="gchip tap" tabindex={open && x.id === app.activeId ? 0 : -1} class:on={open && x.id === app.activeId} aria-current={open && x.id === app.activeId ? "true" : undefined} onclick={() => app.openSession(x.id)} onkeydown={(e) => e.key === RENAME_KEY && (e.preventDefault(), rename.start(x.id, x.title))} class:carried={drag.id === x.id} use:dragSource={{ id: x.id, menu: (pt) => chipMenu(pt, x.id, x.title) }} title="{who ? `${who.title} · ` : ''}{sessionTitle(x.title)} · {ACTIVITY_LABEL[st]}">
					{#if app.terminal(x.id)}<span class="tico"><Icon name="terminal" /></span>{:else}<AgentBadge id={x.id} state={st} size={16} />{/if}
					{#if who}<Handle text={who.text} state={st} />{/if}<span class="t">{sessionTitle(x.title)}</span>
				</button>
				<!-- a pane steps out into a tab of its own, like the × of a pane's title bar (Pane.svelte). A sibling of the chip, not
				     inside it (no button in a button), laid over its right end like a tab's × (TabBar.svelte) -->
				<button class="leave tap" tabindex="-1" onpointerdown={(e) => e.stopPropagation()} onclick={() => void app.leaveGroup(x.id)} aria-label={t("그룹에서 빼기")} title={t("그룹에서 빼기")}><Icon name="unlink" /></button>
				</span>
			{/if}
		{/each}
	</nav>
{/if}

<style>
	/* the open group's sessions, laid out inside the group's box in the tab bar (TabBar's .gbox draws the tray and decides its
	   width; the tab bar's own sliding marker is the open chip's fill). Only a box wider than the bar itself scrolls its chips. */
	.strip {
		position: relative;
		flex: 0 1 auto;
		min-width: 0;
		height: 100%;
		display: flex;
		align-items: center;
		gap: 4px;
		overflow-x: auto;
		overflow-y: hidden;
		overscroll-behavior-x: contain;
		scrollbar-width: none;
	}
	.strip::-webkit-scrollbar {
		display: none;
	}
	.tico {
		display: inline-grid;
	}
	.tico :global(svg) {
		width: 14px;
		height: 14px;
		stroke-width: 1.9;
	}
	/* the chips sit edge to edge in a strip that clips: an outer ring lost its sides (scripts/ui-focus.py) */
	.gchip:focus-visible {
		outline-offset: -2px;
	}
	.gitem {
		position: relative;
		flex: none;
		display: flex;
		align-items: center;
		max-width: 220px;
	}
	.gchip {
		position: relative;
		z-index: 1;
		flex: none;
		display: inline-flex;
		align-items: center;
		gap: 4px;
		height: 22px;
		max-width: 100%; /* .gitem caps it at a tab's width */
		padding: 0 8px;
		border-radius: var(--radius-sm);
		color: var(--text-dim);
		font-size: var(--fs-sm);
		line-height: 20px; /* whole-pixel line box (rule 3), not the body's 1.55 (20.15px), so the title's centre lands on a whole pixel */
		white-space: nowrap;
		transition: background var(--motion-fast) var(--ease-std);
	}
	/* the whole item, so the chip stays lit while the pointer is on its "leave" button */
	@media (hover: hover) {
		.gitem:hover > .gchip {
			background: var(--bg-hover);
			color: var(--text);
		}
	}
	.gchip.carried {
		opacity: 0.45;
	}
	.gchip.on {
		background: var(--bg-active);
		color: var(--text);
		font-weight: 600;
	}
	/* "그룹에서 빼기" at the chip's right end, shown while the pointer is on the chip (or the button has focus): over the end
	   of the title, on a backing of the chip's own colour (--xbg, set by the tab bar) with a fade, so the chip keeps its
	   width and its title runs out under it, exactly like a tab's ×. Not on touch or the phone strip: the long-press menu
	   has the same entry. */
	.leave {
		position: absolute;
		right: 5px;
		top: 4px; /* centred on the 28px chip: (28 - 20) / 2 */
		z-index: 2;
		display: none;
		place-items: center;
		width: 20px;
		height: 20px;
		border-radius: var(--radius-pill);
		background-color: var(--xbg, var(--bg));
		color: var(--text-dim);
		opacity: 0;
		transition:
			opacity var(--motion-fast) var(--ease-std),
			color var(--motion-fast) var(--ease-std);
	}
	.leave::before {
		content: "";
		position: absolute;
		top: 0;
		bottom: 0;
		right: 100%;
		width: 24px;
		background: linear-gradient(to right, color-mix(in srgb, var(--xbg, var(--bg)) 0%, transparent), color-mix(in srgb, var(--xbg, var(--bg)) 60%, transparent) 50%, var(--xbg, var(--bg)));
		pointer-events: none;
	}
	.leave :global(svg) {
		width: 14px;
		height: 14px;
		stroke-width: 1.9;
	}
	@media (hover: hover) and (pointer: fine) and (min-width: 601px) {
		.leave {
			display: grid;
		}
		.gitem:hover > .leave,
		.leave:focus-visible {
			opacity: 1;
		}
		.leave:hover {
			background-image: linear-gradient(color-mix(in srgb, var(--text) 10%, transparent), color-mix(in srgb, var(--text) 10%, transparent));
			color: var(--text);
		}
	}
	.strip :global(.strip-rename) {
		flex: none;
		width: 160px;
	}
	.t {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
