<script lang="ts">
	import TemplatesPanel from "../agent/TemplatesPanel.svelte";

	let { serverId }: { serverId: string } = $props();
</script>

<TemplatesPanel {serverId} />
