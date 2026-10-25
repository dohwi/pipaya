<script lang="ts">
	import type { Snippet } from "svelte";
	import type { ClassValue } from "svelte/elements";
	import { t } from "../../lib/i18n";
	import { dragSource, dropTarget, type DropOpts } from "../../lib/dnd.svelte";
	import { getSidebarCtx, type MenuTarget } from "../../lib/sidebar-ctx";
	import Icon from "../Icon.svelte";
	import RenameInput from "./RenameInput.svelte";

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
	/** F2 renames the focused row, as in a file manager. */
	function keys(e: KeyboardEvent) {
		if (e.key !== "F2" || !current || renaming || (e.target as Element).closest("input")) return;
		e.preventDefault();
		if (target.kind === "group") sb.startGroupRename(target.g);
		else sb.startRename(target.x.id, target.x.title);
	}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class={["item nested", cls]}
	class:over
	class:before={sb.marks.tabLine(id) === "before"}
	class:after={sb.marks.tabLine(id) === "after"}
	class:grabbable={current && !renaming}
	class:menuopen={sb.menuId === id}
	use:dragSource={{ id, disabled: !current || renaming, menu: current ? (pt) => sb.rowMenuAt(pt, target, member) : undefined }}
	use:dropTarget={drop}
	onkeydown={keys}
>
	{#if current && renaming}
		<RenameInput value={draft} oninput={ondraft} {oncommit} {oncancel} {maxlength} />
	{:else}
		{@render children()}
		<div class="acts">
			{#if current}
				<button class="more" class:on={sb.menuId === id} onpointerenter={(e) => sb.hoverMenu(e, target)} onpointerleave={(e) => sb.leaveMenu(e)} onclick={(e) => sb.clickMenu(e, target, member)} aria-label={t("더 보기")} aria-haspopup="menu" aria-expanded={sb.menuId === id}><Icon name="more" /></button>
			{/if}
		</div>
	{/if}
</div>
