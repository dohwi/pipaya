<script lang="ts">
	import type { Snippet } from "svelte";
	import type { ClassValue } from "svelte/elements";
	import type { HTMLButtonAttributes } from "svelte/elements";

	/**
	 * The one text button. The look is the global `.btn` (app.css); this only names its variants so a call site reads
	 * `<Button variant="primary" size="sm">` instead of a class string, and passes everything else (`onclick`,
	 * `disabled`, `aria-*`, `data-*`, `use:` actions, `bind:this`) straight to the <button>.
	 *
	 *  variant  default | primary (the one main action) | danger (red text) | ghost (no fill) | dashed (a full-width "add" slot)
	 *  size     md (38px) | sm (34px, dense rows and dialogs)
	 *  type     "button" unless it submits a form (a bare <button> inside a <form> submits, so the default is explicit)
	 *  class    extra classes for the caller's own layout rules
	 *  focus    take focus when it appears (the default answer of a confirm sheet; Modal keeps a child's own focus)
	 */
	let {
		variant = "default",
		size = "md",
		type = "button",
		class: cls = "",
		focus = false,
		children,
		...rest
	}: {
		variant?: "default" | "primary" | "danger" | "ghost" | "dashed";
		size?: "md" | "sm";
		type?: "button" | "submit";
		class?: ClassValue;
		focus?: boolean;
		children: Snippet;
	} & Omit<HTMLButtonAttributes, "type" | "class" | "children"> = $props();
</script>

<script lang="ts" module>
	/** Focus the element as it mounts. */
	const focusOnMount = (node: HTMLElement, on: boolean) => {
		if (on) node.focus();
	};
</script>

<button {type} class={["btn", variant !== "default" && variant, size === "sm" && "sm", cls]} use:focusOnMount={focus} {...rest}>{@render children()}</button>
