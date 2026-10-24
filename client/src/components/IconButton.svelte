<script lang="ts">
	import type { ClassValue, HTMLButtonAttributes } from "svelte/elements";
	import Icon, { type IconName } from "./Icon.svelte";

	/**
	 * The round icon-only button. The look is the global `.iconbtn` (app.css); this gives it a name for the icon and
	 * makes the accessible name required, since there is no text to fall back on.
	 *
	 *  icon   the glyph
	 *  label  the accessible name (always set as aria-label); shown as a tooltip too when `tip` is true
	 *  tip    also set `title` to the label (most buttons that sit alone do; ones inside a dense row do not)
	 *  title  a tooltip that says more than the label (e.g. adds the shortcut); wins over `tip`
	 *  size   md (38px) | sm (32px, rows of message actions)
	 *  class  extra classes for the caller's own layout rules
	 *  Everything else (`onclick`, `disabled`, `aria-pressed`, `tabindex`, `data-*`) goes straight to the <button>.
	 */
	let {
		icon,
		label,
		tip = false,
		title,
		size = "md",
		type = "button",
		class: cls = "",
		...rest
	}: {
		icon: IconName;
		label: string;
		tip?: boolean;
		title?: string;
		size?: "md" | "sm";
		type?: "button" | "submit";
		class?: ClassValue;
	} & Omit<HTMLButtonAttributes, "type" | "class" | "children" | "aria-label" | "title"> = $props();
</script>

<button {type} class={["iconbtn", size === "sm" && "sm", cls]} aria-label={label} title={title ?? (tip ? label : undefined)} {...rest}><Icon name={icon} /></button>
