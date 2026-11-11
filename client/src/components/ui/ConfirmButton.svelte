<script lang="ts">
	import type { Snippet } from "svelte";
	import { onDestroy } from "svelte";

	/**
	 * A destructive button that asks by itself: the first press arms it (the label turns into `confirmLabel`, the
	 * button turns red and its border runs out like a timer), a second press within `timeout` runs `onconfirm`.
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
	/* the time left is the border itself: a red ring that unwinds clockwise from the top */
	@property --cb-a {
		syntax: "<angle>";
		inherits: false;
		initial-value: 360deg;
	}
	.cbtn {
		position: relative;
		transition:
			color var(--motion-fast) var(--ease-std),
			border-color var(--motion-fast) var(--ease-std),
			background-color var(--motion-fast) var(--ease-std);
	}
	.cbtn.armed {
		border-color: color-mix(in srgb, var(--danger) 30%, transparent);
	}
	.cbtn.armed::after {
		content: "";
		position: absolute;
		inset: -1px; /* covers the 1px border and 1px inside it, so the ring reads as 2px */
		padding: 2px;
		border-radius: inherit;
		background: conic-gradient(var(--danger) var(--cb-a), transparent 0);
		/* keep only the 1px ring: the padding box minus the content box */
		mask:
			linear-gradient(#000 0 0) content-box,
			linear-gradient(#000 0 0);
		mask-composite: exclude;
		-webkit-mask-composite: xor;
		pointer-events: none;
		animation: cb-run var(--cb-time) linear forwards;
	}
	@keyframes cb-run {
		to {
			--cb-a: 0deg;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.cbtn.armed::after {
			animation: none;
		}
	}
</style>
