<script lang="ts">
	import type { Snippet } from "svelte";
	import { collapseIn, collapseOut } from "../../lib/motion";
	import Icon, { type IconName } from "./Icon.svelte";
	import { t } from "../../lib/i18n";

	/**
	 * The one boxed message: an error, a warning, a success note, or a plain note.
	 *
	 *  tone     danger = something failed (announced as an alert), warn = take care, ok = it worked, info = FYI
	 *  size     "sm" is the tighter variant used inside dense settings panels
	 *  icon     leading icon: false hides it, a name replaces the default (alert for danger/warn, check for ok, none for info)
	 *  role     overrides the default (alert for danger, status for ok, note otherwise)
	 *  animated slide open/closed when it appears or goes away (for notices that come and go inside a form)
	 *  action   optional trailing control (a link-style button)
 *  onretry  shorthand for the common action: a "다시 시도" button that calls it (ignored when `action` is given)
	 *  raised   for a notice standing on a tinted settings group: a solid tone-tinted base, a 1px ring of its own colour and a
	 *           soft shadow, so it reads as a box lifted off the card instead of a stripe painted inside it
	 */
	let {
		tone = "info",
		size = "md",
		icon,
		role,
		id,
		animated = false,
		raised = false,
		children,
		action,
		onretry,
	}: {
		tone?: "danger" | "warn" | "ok" | "info";
		size?: "md" | "sm";
		icon?: boolean | IconName;
		role?: "alert" | "status" | "note";
		id?: string;
		animated?: boolean;
		raised?: boolean;
		children: Snippet;
		action?: Snippet;
		onretry?: () => void;
	} = $props();

	const iconName = $derived<IconName | null>(
		icon === false ? null : typeof icon === "string" ? icon : icon === true || tone !== "info" ? (tone === "ok" ? "check" : "alert") : null,
	);
	const noMotion = () => ({ duration: 0 });
	const enter = $derived(animated ? collapseIn : noMotion);
	const leave = $derived(animated ? collapseOut : noMotion);
</script>

<div
	class="notice {tone} {size}"
	class:raised
	{id}
	role={role ?? (tone === "danger" ? "alert" : tone === "ok" ? "status" : "note")}
	in:enter
	out:leave
>
	{#if iconName}<Icon name={iconName} />{/if}
	<div class="text">{@render children()}</div>
	{#if action}<span class="action">{@render action()}</span>{:else if onretry}<span class="action"><button type="button" onclick={onretry}>{t("다시 시도")}</button></span>{/if}
</div>

<style>
	.notice {
		display: flex;
		gap: 8px;
		align-items: flex-start;
		padding: 8px 12px;
		border-radius: var(--radius);
		background: var(--bg-elev);
		color: var(--text-dim);
		font-size: var(--fs-sm);
		line-height: 20px; /* whole-pixel line: 1.5 (19.5px) put the text's ink 1.4px off the 17px icon */
		overflow-wrap: anywhere;
	}
	.danger {
		background: var(--danger-soft);
		color: var(--danger);
		font-weight: 500;
	}
	.warn {
		background: var(--warn-soft);
		color: var(--warn);
		word-break: keep-all;
	}
	.ok {
		background: var(--ok-soft);
		color: var(--text);
	}
	.ok > :global(svg) {
		color: var(--ok);
	}
	.sm {
		padding: 4px 12px;
		border-radius: var(--radius-sm);
		font-size: var(--fs-xs);
		line-height: 16px;
	}
	.sm.danger {
		font-weight: 400;
	}
	/* Raised: standing on a tinted settings group, the notice gets an opaque tinted base (the flat --*-soft over --bg-set reads as
	   paint on the card), a 1px ring of its own colour and the app's soft shadow, so it lifts off the group. --bg-lift is one step
	   lighter than --bg-set in both themes, which is what makes the box read as "above" the card. The ring is a shadow, not a
	   border, so the text keeps the flat notice's 12px inset and the box its height. */
	.raised {
		background: color-mix(in srgb, var(--notice-tint) 14%, var(--bg-lift));
		box-shadow: 0 0 0 1px color-mix(in srgb, var(--notice-tint) 34%, transparent), var(--shadow-soft);
	}
	.raised.info {
		--notice-tint: var(--info);
	}
	.raised.ok {
		--notice-tint: var(--ok);
	}
	.raised.warn {
		--notice-tint: var(--warn);
	}
	.raised.danger {
		--notice-tint: var(--danger);
	}
	.notice > :global(svg) {
		width: 17px;
		height: 17px;
		/* 17px icon centred on the 20px first line: (20 - 17) / 2 = 1.5px */
		margin-top: 1.5px;
		flex: none;
		stroke-width: 1.8;
	}
	.sm > :global(svg) {
		width: 16px;
		height: 16px;
		margin-top: 0;
	}
	/* A Notice carrying a full Button (.btn, 34px tall, --radius-control 10px): centre the icon, text and button on one axis
	   instead of pinning single-line text to the top, keep 8px even padding around the button, and step the outer corner up to
	   --radius (12px) so a sm Notice never wraps a 10px button in an 8px corner. `:where(:has(...))` keeps specificity equal to
	   `.notice` so caller overrides (e.g. RetryNotice mobile wrap padding) win; placed after `.sm > svg` so `margin-top: 0` wins. */
	.notice:where(:has(> .action :global(.btn))) {
		align-items: center;
		padding: 8px 8px 8px 12px;
		border-radius: var(--radius);
	}
	.notice:where(:has(> .action :global(.btn))) > :global(svg) {
		margin-top: 0;
	}
	.text {
		flex: 1 1 auto;
		min-width: 0;
	}
	.action {
		flex: none;
		display: inline-flex;
		align-items: center;
		white-space: nowrap;
		font-weight: 600;
	}
	/* callers sometimes wrap an action button in {#if ...} inside the snippet: hide the empty span so it adds no trailing gap */
	.action:not(:has(*)) {
		display: none;
	}
	.action :global(button:not(.btn)) {
		color: inherit;
		text-decoration: underline;
		text-underline-offset: 3px;
		background: none;
		border: 0;
		padding: 0;
		font: inherit;
		cursor: pointer;
	}
	.action :global(button:not(.btn):disabled) {
		opacity: 0.5;
		cursor: default;
		text-decoration: none;
	}
</style>
