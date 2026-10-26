<script lang="ts">
	import type { DropOpts } from "../../lib/dnd.svelte";
	import { browserLabel, type BrowserTabInfo } from "../../lib/browser";
	import { t } from "../../lib/i18n";
	import type { SidebarNode } from "../../lib/sidebar-ctx";
	import Icon from "../Icon.svelte";
	import RowTitle from "./RowTitle.svelte";
	import TabRow from "./TabRow.svelte";

	/** A browser tab: the globe icon and the page's title; the tooltip says which address. */
	let { n, x, drop, member = false }: { n: SidebarNode; x: BrowserTabInfo; drop: DropOpts; member?: boolean } = $props();
	const label = $derived(browserLabel(x, t("브라우저")));
</script>

{#snippet body()}
	<span class="lead"><Icon name="globe" /></span>
	<RowTitle text={label} />
{/snippet}

<TabRow {n} x={{ id: x.id, title: label }} target={{ kind: "browser", x: { id: x.id, title: label } }} tip={`${x.url}\n${x.cwd}`} {drop} {member} {body} />
