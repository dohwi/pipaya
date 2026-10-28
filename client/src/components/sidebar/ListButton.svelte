<script lang="ts">
	import { app } from "../../lib/store.svelte";
	import Icon from "../Icon.svelte";

	/**
	 * The conversation-list button of a server, folder or archive header: opens the list narrowed to `filter`. It is a
	 * `.dirnew` (same look and hover as the "+" beside it), shown on hover and hidden while its row is folded.
	 */
	let { serverId, filter = null, name, tip }: { serverId: string; filter?: { cwd?: string; archived?: boolean } | null; name: string; tip: string } = $props();
</script>

<button class="dirnew listbtn tap" onclick={() => app.openSessions(serverId, filter)} aria-label={name} title={tip}><Icon name="list" /></button>

<style>
	/* flush against the "+" beside it: 20px buttons, centres 20px apart (x 234 and 254), so it takes no margin of its own */
	:global(:where(.side) .dirnew.listbtn) {
		margin-right: 0;
	}
	:global(:where(.side) .srvhead.folded .listbtn),
	:global(:where(.side) .dir.folded .listbtn) {
		display: none;
	}
</style>
