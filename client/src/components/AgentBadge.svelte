<script lang="ts">
	import PipayaLogo from "./PipayaLogo.svelte";
	import { faceFor } from "../lib/faces";
	import { ACTIVITY_LABEL, type Activity } from "../lib/activity";

	/** A session's agent: its own pipaya expression (stable per session), tinted and badged by what it is doing. */
	let { id, state = "idle", size = 20 }: { id: string; state?: Activity; size?: number } = $props();
</script>

<span class="agent {state}" style="width:{size}px;height:{size}px" role="img" aria-label={ACTIVITY_LABEL[state]}>
	<PipayaLogo {size} eyes face={faceFor(id)} blink={state === "working"} />
	{#if state !== "idle"}<i class="badge"></i>{/if}
</span>

<style>
	.agent {
		position: relative;
		flex: none;
		display: inline-grid;
		place-items: center;
		color: var(--text-faint);
		transition: color var(--motion-fast) var(--ease-std);
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
