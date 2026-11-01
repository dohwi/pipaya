<script lang="ts">
	import type { DropOpts } from "../../lib/dnd.svelte";
	import type { SidebarNode } from "../../lib/sidebar-ctx";
	import type { TerminalInfo } from "../../lib/terminal";
	import { t } from "../../lib/i18n";
	import Icon from "../Icon.svelte";
	import RowTitle from "./RowTitle.svelte";
	import TabRow from "./TabRow.svelte";

	/** A terminal: the shell icon and its title; the tooltip says which shell and where. */
	let { n, x, drop, member = false }: { n: SidebarNode; x: TerminalInfo; drop: DropOpts; member?: boolean } = $props();
</script>

{#snippet body(pinned: boolean)}
	<span class="lead"><Icon name="terminal" />{#if pinned}<span class="tpin" title={t("고정됨")}><Icon name="pin" /></span>{/if}</span>
	<RowTitle text={x.title} />
{/snippet}

<TabRow {n} {x} target={{ kind: "terminal", x }} tip={`${x.shell}\n${x.cwd}`} {drop} {member} {body} />
