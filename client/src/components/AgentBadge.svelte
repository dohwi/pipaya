<script lang="ts">
	import ModelLogo from "./ModelLogo.svelte";
	import { app } from "../lib/store.svelte";
	import { ACTIVITY_LABEL, type Activity } from "../lib/activity";

	/** A session's agent: the (monochrome) logo of the model that did its last work; the dot shows what it is doing. */
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
</script>

<span class="agent {state}" style="width:{size}px;height:{size}px" role="img" aria-label={ACTIVITY_LABEL[state]}>
	<span class="logo"><ModelLogo {id} provider={logoModel.provider} model={logoModel.model} {size} /></span>
	{#if state !== "idle"}<i class="badge" style="animation-delay:{-(Date.now() % 1200)}ms"></i>{/if}
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
	.badge {
		position: absolute;
		right: -3px;
		bottom: -3px;
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: currentColor;
		box-shadow: 0 0 0 2px var(--bg-side);
	}
	.working .badge {
		animation: pulse 1.2s ease-in-out infinite;
	}
	.asking .badge {
		animation: ping 1.2s ease-in-out infinite;
	}
	@keyframes pulse {
		50% {
			opacity: 0.3;
		}
	}
	@keyframes ping {
		0% {
			box-shadow: 0 0 0 2px var(--bg-side), 0 0 0 2px currentColor;
		}
		70%,
		100% {
			box-shadow: 0 0 0 2px var(--bg-side), 0 0 0 7px transparent;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.badge {
			animation: none !important;
		}
	}
</style>
