<script lang="ts">
	import type { Snippet } from "svelte";
	import { onDestroy } from "svelte";

	/**
	 * A destructive button that asks by itself: the first press arms it (the label turns into `confirmLabel`, the
	 * button turns red and a thin bar shows the time left), a second press within `timeout` runs `onconfirm`.
	 * Leaving it alone, or moving focus away, disarms it. Used for removals that cannot be undone from where they are.
	 */
	let {
		confirmLabel,
		onconfirm,
		timeout = 4000,
		disabled = false,
		size,
		danger = false,
		class: cls = "",
		ariaLabel,
		children,
	}: {
		confirmLabel: string;
		onconfirm: () => void;
		timeout?: number;
		disabled?: boolean;
		size?: "sm";
		/** red even before it is armed */
		danger?: boolean;
		class?: string;
		ariaLabel?: string;
		children: Snippet;
	} = $props();

	let armed = $state(false);
	let timer: ReturnType<typeof setTimeout> | undefined;
	const disarm = () => {
		clearTimeout(timer);
		armed = false;
	};
	function press() {
		if (!armed) {
			armed = true;
			clearTimeout(timer);
			timer = setTimeout(() => (armed = false), timeout);
			return;
		}
		disarm();
		onconfirm();
	}
	onDestroy(() => clearTimeout(timer));
</script>

<button
	type="button"
	class="btn cbtn {cls}"
	class:sm={size === "sm"}
	class:danger={danger || armed}
	class:armed
	style:--cb-time="{timeout}ms"
	{disabled}
	aria-label={armed ? confirmLabel : ariaLabel}
	aria-live="polite"
	onclick={press}
	onblur={disarm}
	onkeydown={(e) => e.key === "Escape" && armed && (e.stopPropagation(), disarm())}
>
	{#if armed}{confirmLabel}{:else}{@render children()}{/if}
</button>

<style>
	.cbtn {
		position: relative;
		overflow: hidden;
		transition:
			color var(--motion-fast) var(--ease-std),
			border-color var(--motion-fast) var(--ease-std),
			background-color var(--motion-fast) var(--ease-std);
	}
	.cbtn.armed {
		border-color: var(--danger);
	}
	/* how long it stays armed, drawn as a bar that runs out */
	.cbtn.armed::after {
		content: "";
		position: absolute;
		left: 0;
		right: 0;
		bottom: 0;
		height: 2px;
		background: currentColor;
		opacity: 0.45;
		transform-origin: left;
		animation: cb-run var(--cb-time) linear forwards;
	}
	@keyframes cb-run {
		to {
			transform: scaleX(0);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.cbtn.armed::after {
			animation: none;
		}
	}
</style>
