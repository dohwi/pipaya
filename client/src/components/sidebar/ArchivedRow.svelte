<script lang="ts">
	import { t } from "../../lib/i18n";
	import { app } from "../../lib/store.svelte";
	import { openContextMenu, closeContextMenu } from "../../lib/context-menu";
	import { pressMenu, type Point } from "../../lib/press-menu";
	import type { Session } from "../../lib/types";
	import Icon from "../Icon.svelte";
	import RowTitle from "./RowTitle.svelte";
	import { type SidebarNode } from "../../lib/sidebar-ctx";

	/**
	 * A conversation in a folder's archive: dimmed, nothing drags or groups it. Clicking brings it back and opens it; the
	 * button (and the context menu) restores it quietly, or deletes it for good.
	 */
	let { n, x }: { n: SidebarNode; x: Session } = $props();

	function menu(pt: Point) {
		openContextMenu(pt, `arch:${x.id}`, [
			{ icon: "undo", label: t("복원"), title: t("보관함에서 꺼내 목록으로 되돌립니다"), run: () => void app.unarchive(n.server.id, x.id) },
			{ icon: "trash", label: t("삭제"), title: t("대화를 영구 삭제합니다"), run: () => void app.deleteArchived(n.server.id, x.id) },
		]);
		return closeContextMenu;
	}
</script>

<div class="item nested archived" use:pressMenu={menu}>
	<button class="open wide" onclick={() => void app.unarchive(n.server.id, x.id, true)} title={t("{title} · 눌러서 복원하고 열기", { title: x.title })}>
		<span class="lead"><Icon name="archive" /></span>
		<RowTitle text={x.title} />
	</button>
	<div class="acts">
		<button class="more" onclick={() => void app.unarchive(n.server.id, x.id)} aria-label={t("복원")} title={t("복원")}><Icon name="undo" /></button>
	</div>
</div>

<style>
	.archived {
		opacity: 0.6;
	}
	.archived:hover {
		opacity: 1;
	}
</style>
