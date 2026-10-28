<script lang="ts">
	import { reflow, surfaceIn, surfaceOut } from "../lib/motion";
	import { app } from "../lib/store.svelte";
	import CountdownClose from "./CountdownClose.svelte";
	import type { Toast } from "../lib/feedback.svelte";

	/**
	 * The toast strips themselves, shared by the global strip (Toasts: under the header, above dialogs) and a pane's own
	 * (SessionToasts: on top of that pane). Each one slides in, counts down on its close button, and the rest close the gap.
	 */
	let { toasts, compact = false }: { toasts: Toast[]; compact?: boolean } = $props();
</script>

{#each toasts as t (t.id)}
	<div class="strip {t.tone}" class:compact role={t.tone === "error" ? "alert" : "status"} in:surfaceIn={{ y: -10 }} out:surfaceOut={{ y: -10 }} animate:reflow>
		<span class="msg">{t.text}</span>
		<CountdownClose ms={t.ms} onclick={() => app.feedback.dismissToast(t.id)} />
	</div>
{/each}

<style>
	.strip {
		--tone: var(--text-faint);
		pointer-events: auto;
		display: flex;
		align-items: center;
		gap: 8px;
		min-height: 44px;
		padding: 4px 8px 4px 16px;
		/* tinted with the tone, like the "done" strips (neutral toasts get only a faint tint) */
		background: color-mix(in srgb, var(--tone) 16%, var(--bg-elev));
		border-bottom: 1px solid color-mix(in srgb, var(--tone) 25%, var(--border-strong));
		color: var(--text);
		font-size: var(--fs-sm);
		line-height: 1.4;
	}
	.strip.compact {
		min-height: 40px;
		padding: 4px 8px 4px 12px;
	}
	.strip.ok {
		--tone: var(--ok);
	}
	.strip.error {
		--tone: var(--danger);
	}
	.msg {
		flex: 1;
		min-width: 0;
		overflow-wrap: anywhere;
	}
</style>
