<script lang="ts">
	import type { ClassValue } from "svelte/elements";

	/**
	 * The shared loading ring. Pass `label` when the spinner itself announces status (adds `role="status"` and
	 * `aria-label`); omit it when adjacent text or `aria-busy` already announces the state.
	 */
	let {
		size = 14,
		tone = "current",
		label,
		class: cls = "",
	}: {
		size?: 12 | 14 | 16;
		/** `current`: inherits text color; `muted`: subtle ring with a high-contrast leading arc */
		tone?: "current" | "muted";
		label?: string;
		class?: ClassValue;
	} = $props();
</script>

<span
	class={["spinner", tone === "muted" && "muted", cls]}
	style:--spin-size="{size}px"
	role={label ? "status" : undefined}
	aria-label={label}
	aria-hidden={label ? undefined : "true"}
></span>

<style>
	.spinner {
		box-sizing: border-box;
		display: inline-block;
		width: var(--spin-size, 14px);
		height: var(--spin-size, 14px);
		border-radius: 50%;
		border: 2px solid currentColor;
		border-right-color: transparent;
		animation: spin 0.7s linear infinite;
		flex: none;
	}
	.spinner.muted {
		border-color: var(--border-strong);
		border-top-color: var(--text);
		animation-duration: 0.8s;
	}
	@media (prefers-reduced-motion: reduce) {
		.spinner {
			animation: none;
		}
	}
</style>
