<script lang="ts">
	import { t } from "../../lib/i18n";
	import { newKey } from "../../lib/sidebar-model";
	import { getSidebarCtx, type SidebarNode } from "../../lib/sidebar-ctx";
	import Icon from "../Icon.svelte";

	/**
	 * The "+" of a server or folder header: opens a menu to start a conversation or a terminal there. `key` identifies the
	 * place so the open menu keeps its button highlighted; `name` is what it says it is for.
	 */
	let { n, workdir, key, name, tip }: { n: SidebarNode; workdir: string; key: string; name: string; tip: string } = $props();

	const sb = getSidebarCtx();
</script>

<button class="dirnew" class:on={sb.menuId === newKey(key)} data-menu-button onpointerenter={(e) => sb.hoverNew(e, n, workdir, key)} onpointerleave={(e) => sb.leaveMenu(e)} onclick={(e) => sb.clickNew(e, n, workdir, key)} aria-label={t("{name}에서 새로 만들기", { name })} aria-haspopup="menu" title={tip}><Icon name="plus" /></button>
