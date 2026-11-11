<script lang="ts">
	import { RENAME_KEY } from "../../../lib/keys";
	import { setContext, type Snippet } from "svelte";
	import type { ClassValue } from "svelte/elements";
	import { t } from "../../../lib/i18n";
	import { drag, dragSource, dropTarget, type DropOpts } from "../../../lib/dnd.svelte";
	import { getSidebarCtx, type MenuTarget } from "../../../lib/sidebar-ctx";
	import Icon from "../../ui/Icon.svelte";
	import { ROW_RENAME, type RowRename } from "./row-rename";

	/**
	 * The frame every tab row shares, whether it is a conversation, a terminal or a split tab's header: drag source and
	 * drop target, the drop line before / after it, the "pulled onto" highlight, the in-place rename field, and the
	 * "more" button that appears on hover. What goes inside the row is the caller's (`children`).
	 *
	 *  id       the thing this row stands for (a session, terminal or group id)
	 *  current  its server is the open one: only then can it be dragged, renamed or have a menu
	 *  renaming this row is being renamed: the content is replaced by the field
	 *  draft / ondraft / oncommit / oncancel  the rename field's value and its handlers
	 *  target   what the "more" menu acts on
	 *  maxlength limit for the rename field
 *  member   a pane of a split tab (its menu offers taking it out)
 *  Right click or a long press opens the same menu where the pointer is (a long press that moves on drags the row).
	 *  class    the row's own marker classes (`active`, `cur`, `term`, `member`, `grprow`) for the caller's rules
	 */
	let {
		id,
		current,
		renaming,
		draft,
		ondraft,
		oncommit,
		oncancel,
		target,
		drop,
		maxlength,
		over = false,
		member = false,
		class: cls = "",
		children,
	}: {
		id: string;
		current: boolean;
		renaming: boolean;
		draft: string;
		ondraft: (v: string) => void;
		oncommit: () => void;
		oncancel: () => void;
		target: MenuTarget;
		drop: DropOpts;
		maxlength?: number;
		over?: boolean;
		/** a pane of a split tab: its menu can take it out */
		member?: boolean;
		class?: ClassValue;
		children: Snippet;
	} = $props();

	const sb = getSidebarCtx();
	/** The row keeps its icon and its place while renamed: only its `RowTitle` turns into the field (read there) */
	setContext<RowRename>(ROW_RENAME, {
		get active() { return current && renaming; },
		get draft() { return draft; },
		ondraft: (v) => ondraft(v),
		oncommit: () => oncommit(),
		oncancel: () => oncancel(),
		get maxlength() { return maxlength; },
	});
	/** F2 renames the focused row, as in a file manager. */
	function keys(e: KeyboardEvent) {
		if (e.key !== RENAME_KEY || !current || renaming || (e.target as Element).closest("input")) return;
		e.preventDefault();
		if (target.kind === "group") sb.startGroupRename(target.g);
		else sb.startRename(target.x.id, target.x.title);
	}
</script>

<!-- The row frame handles F2 (rename) for whatever inside it has focus and is a drag source; its buttons are the controls. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class={["item nested", cls]}
	class:over
	class:before={sb.marks.tabLine(id) === "before"}
	class:after={sb.marks.tabLine(id) === "after"}
	class:carried={drag.id === id}
	class:grabbable={current && !renaming}
	class:menuopen={sb.menuId === id}
	use:dragSource={{ id, disabled: !current || renaming, menu: current ? (pt) => sb.rowMenuAt(pt, target, member) : undefined }}
	use:dropTarget={drop}
	onkeydown={keys}
>
	{@render children()}
	{#if !(current && renaming)}
		<div class="acts">
			{#if current}
				<button class="more" class:on={sb.menuId === id} onpointerenter={(e) => sb.hoverMenu(e, target, member)} onpointerleave={(e) => sb.leaveMenu(e)} onclick={(e) => sb.clickMenu(e, target, member)} aria-label={t("더 보기")} aria-haspopup="menu" aria-expanded={sb.menuId === id}><Icon name="more" /></button>
			{/if}
		</div>
	{/if}
</div>

<style>
	.item {
		position: relative;
		display: flex;
		align-items: center;
		border-radius: var(--radius-control);
		margin: 1px -8px 1px 4px; /* the row's highlight runs 8px past its content (the padding below gives it back), so the "⋯" and pin keep their column (x 256) yet are not glued to the highlight's edge */
		padding-right: 8px;
		transition: background var(--motion-fast) var(--ease-std);
	}
	.item:hover {
		background: var(--bg-hover);
	}
	.item.active {
		background: var(--bg-active);
	}
	.item.active:hover {
		background: transparent;
	}
	.acts {
		display: none;
	}
	.item:hover .acts,
	.item:has(:focus-visible) .acts,
	.item.menuopen .acts {
		display: flex;
	}
	@media (pointer: coarse) {
		.acts {
			display: flex;
		}
		.item:not(.active):not(.cur):not(.menuopen) .acts {
			display: none;
		}
	}
	/* the three dots: same box and right edge as the + on the directory row above */
	.more {
		display: grid;
		place-items: center;
		flex: none;
		width: 20px;
		height: 20px;
		margin-right: 0; /* tab rows end where folder rows do (no right margin), so this centres on x 256 like the "+" above */
		border-radius: 50%; /* a round hit area: a square tint on a row of rounded corners looked off */
		color: var(--text-faint);
		transition: background-color var(--motion-fast) var(--ease-std), color var(--motion-fast) var(--ease-std);
	}
	.more:hover,
	.more.on,
	.more:focus-visible {
		background: color-mix(in srgb, var(--text) 14%, transparent); /* over the row's own tint, so it also shows on the open row */
		color: var(--text);
	}
	.more :global(svg) {
		width: 15px;
		height: 15px;
		stroke-width: 2.6;
	}
	/* touch: the row's other buttons get a 20 x 40 hit box (Sidebar.svelte, .dirnew.tap); the "⋯" was left at its 20px
	   circle, a quarter of what a finger needs. Same box here, drawn nowhere. */
	@media (pointer: coarse) {
		.more {
			position: relative;
		}
		.more::after {
			content: "";
			position: absolute;
			left: 0;
			top: 50%;
			width: 100%;
			height: 40px;
			translate: 0 -50%;
		}
	}
	/* Where a carried session would land among its siblings: the neighbours step aside (the row grows a 24px gap on that
	   side, animated) and the line sits in the middle of it. The pseudo-element fills the whole gap and takes the pointer,
	   so the row under the pointer stays the same one while it moves (otherwise the gap would push the row away and the
	   hover would flicker); its line is a 2px gradient. */
	.item {
		transition:
			background var(--motion-fast) var(--ease-std),
			margin var(--motion-fast) var(--ease-std);
	}
	.item.before {
		margin-top: 25px; /* 24 gap + the usual 1px between rows */
	}
	.item.after {
		margin-bottom: 25px; /* 24 gap + the usual 1px between rows */
	}
	.item.before::before,
	.item.after::after {
		left: 8px;
		right: 16px; /* 8 from where the content ends (the row's highlight runs 8px past it) */
		height: 24px;
		border-radius: 0;
		background: linear-gradient(var(--accent), var(--accent)) center / 100% 2px no-repeat;
		pointer-events: auto;
	}
	.item.before::before {
		top: -24px;
	}
	.item.after::after {
		bottom: -24px;
	}
	/* the row in the air: it keeps its place, faded (dropping it on itself does nothing) */
	.item.carried {
		opacity: 0.45;
	}
	/* the row being pulled onto: pairs up with whatever is dropped */
	.item.over {
		background: var(--accent-soft);
		box-shadow: inset 0 0 0 1.5px var(--accent);
	}
	.item.grabbable {
		cursor: grab;
		-webkit-tap-highlight-color: transparent;
	}
</style>
