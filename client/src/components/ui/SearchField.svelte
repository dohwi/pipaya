<script lang="ts">
	import type { HTMLInputAttributes } from "svelte/elements";
	import Icon from "./Icon.svelte";

	/**
	 * The one search box: a magnifier inside a field, the same height, radius and focus ring everywhere
	 * (sidebar, settings, shortcuts, skills, commands, marketplace).
	 *
	 *  value        bound text
	 *  label        accessible name; also the placeholder unless `placeholder` is given
	 *  onescape     Escape on a non-empty box clears it (and stops there, so a dialog stays open); this runs after
	 *  Everything else (`onkeydown`, `data-*`, `autofocus`) goes straight to the <input>.
	 */
	let {
		value = $bindable(""),
		label,
		placeholder,
		class: cls = "",
		onkeydown,
		...rest
	}: {
		value?: string;
		label: string;
		placeholder?: string;
		class?: string;
	} & Omit<HTMLInputAttributes, "value" | "type" | "class" | "placeholder"> = $props();

	function keydown(e: KeyboardEvent & { currentTarget: EventTarget & HTMLInputElement }) {
		if (e.key === "Escape" && value) {
			e.stopPropagation();
			value = "";
			return;
		}
		onkeydown?.(e);
	}
</script>

<label class={["searchfield", cls]}>
	<Icon name="search" />
	<input type="search" placeholder={placeholder ?? label} aria-label={label} bind:value onkeydown={keydown} {...rest} />
</label>

<style>
	.searchfield {
		position: relative;
		display: flex;
		align-items: center;
		width: 100%;
		min-width: 0;
	}
	.searchfield :global(svg) {
		position: absolute;
		left: 12px; /* the field's own 12px side padding: the magnifier starts where text would */
		width: 16px;
		height: 16px;
		stroke: var(--text-faint);
		stroke-width: 2;
		pointer-events: none;
	}
	input {
		width: 100%;
		height: var(--control-h-sm);
		padding: 0 12px 0 36px; /* 12 + 16 icon + 8 gap */
		border: 1px solid var(--border);
		border-radius: var(--radius-control);
		background: var(--bg);
		color: var(--text);
		font: inherit;
		font-size: var(--fs-md);
		outline: none;
		transition:
			border-color var(--motion-fast) var(--ease-std),
			box-shadow var(--motion-fast) var(--ease-std);
	}
	input::placeholder {
		color: var(--text-faint);
	}
	input:focus {
		border-color: var(--accent);
		box-shadow: 0 0 0 3px var(--accent-soft);
	}
	/* the native clear "x" differs per engine; Escape clears instead */
	input::-webkit-search-cancel-button {
		display: none;
	}
	/* touch screens: 16px stops iOS zooming into the page on focus */
	@media (pointer: coarse) {
		input {
			font-size: var(--fs-lg);
		}
	}
</style>
