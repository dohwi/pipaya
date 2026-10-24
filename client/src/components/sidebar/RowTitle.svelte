<script lang="ts">
	import { marquee } from "../../lib/fit-text";

	/** A row's name. One that does not fit flows by while the row is hovered or focused, looping back to its start. */
	let { text }: { text: string } = $props();
</script>

<span class="title" use:marquee={text}><span class="track"><span class="mq">{text}</span><span class="dup" aria-hidden="true">{text}</span></span></span>
