<script lang="ts">
	import ModelLogo from "./ModelLogo.svelte";
	import { app } from "../lib/store.svelte";
	import { syncAnim } from "../lib/syncAnim";
	import { ACTIVITY_LABEL, type Activity } from "../lib/activity";

	/** A session's agent: the (monochrome) logo of the model that did its last work; the logo itself takes the state colour and animation. */
	let { id, state = "idle", size = 20 }: { id: string; state?: Activity; size?: number } = $props();

	/** The model that wrote the last reply; a session with no reply yet (or not loaded) uses its current model. */
	const logoModel = $derived.by(() => {
		const items = app.chatOf(id)?.items;
		if (items) {
			for (let i = items.length - 1; i >= 0; i--) {
				const it = items[i]!;
				if (it.kind === "assistant" && it.model) return { provider: it.provider, model: it.model };
			}
		}
		const e = app.effectiveOf(id);
		return { provider: e.provider, model: e.model };
	});
	const icon = $derived(app.models.find((m) => m.provider === logoModel.provider && m.id === logoModel.model)?.icon);
</script>

<span class="agent {state}" style="width:{size}px;height:{size}px" role="img" aria-label={ACTIVITY_LABEL[state]}>
	<span class="logo" use:syncAnim={state}><ModelLogo {id} provider={logoModel.provider} model={logoModel.model} {icon} {size} /></span>
</span>

<style>
	.agent {
		position: relative;
		flex: none;
		display: inline-grid;
		place-items: center;
		color: var(--text-faint);
	}
	.logo {
		display: inline-grid;
		color: var(--text-dim);
		transition: color var(--motion-fast) var(--ease-std);
	}
	/* the logo takes the state colour too, not just the dot */
	.working .logo,
	.asking .logo,
	.done .logo,
	.failed .logo {
		color: inherit;
	}
	.working {
		color: var(--info);
	}
	.asking {
		color: var(--warn);
	}
	.done {
		color: var(--ok);
	}
	.failed {
		color: var(--danger);
	}
	.working .logo {
		animation: pulse 1.2s ease-in-out infinite;
	}
	.asking .logo {
		animation: nudge 1.2s ease-in-out infinite;
	}
	@keyframes pulse {
		50% {
			opacity: 0.35;
		}
	}
	/* asking: the logo swells and a glow in its own shape radiates out, then fades */
	@keyframes nudge {
		0% {
			transform: scale(1);
			filter: drop-shadow(0 0 0 currentColor);
		}
		50% {
			transform: scale(1.18);
			filter: drop-shadow(0 0 5px currentColor);
		}
		100% {
			transform: scale(1);
			filter: drop-shadow(0 0 0 currentColor);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.logo {
			animation: none !important;
		}
	}
</style>
