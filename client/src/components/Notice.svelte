<script lang="ts">
	import type { Snippet } from "svelte";
	import { collapseIn, collapseOut } from "../lib/motion";
	import Icon, { type IconName } from "./Icon.svelte";

	/**
	 * The one boxed message: an error, a warning, a success note, or a plain note.
	 *
	 *  tone     danger = something failed (announced as an alert), warn = take care, ok = it worked, info = FYI
	 *  size     "sm" is the tighter variant used inside dense settings panels
	 *  icon     leading icon: false hides it, a name replaces the default (alert for danger/warn, check for ok, none for info)
	 *  role     overrides the default (alert for danger, status for ok, note otherwise)
	 *  animated slide open/closed when it appears or goes away (for notices that come and go inside a form)
	 *  action   optional trailing control, e.g. a "retry" button
	 */
	let {
		tone = "info",
		size = "md",
		icon,
		role,
		id,
		animated = false,
		children,
		action,
	}: {
		tone?: "danger" | "warn" | "ok" | "info";
		size?: "md" | "sm";
		icon?: boolean | IconName;
		role?: "alert" | "status" | "note";
		id?: string;
		animated?: boolean;
		children: Snippet;
		action?: Snippet;
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
	{id}
	role={role ?? (tone === "danger" ? "alert" : tone === "ok" ? "status" : "note")}
	in:enter
	out:leave
>
	{#if iconName}<Icon name={iconName} />{/if}
	<div class="text">{@render children()}</div>
	{#if action}<span class="action">{@render action()}</span>{/if}
</div>

<style>
	.notice {
		display: flex;
		gap: 8px;
		align-items: flex-start;
		padding: 10px 12px;
		border-radius: var(--radius);
		background: var(--bg-elev);
		color: var(--text-dim);
		font-size: var(--fs-sm);
		line-height: 1.5;
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
	.ok :global(svg) {
		color: var(--ok);
	}
	.sm {
		padding: 9px 12px;
		border-radius: var(--radius-sm);
		font-size: var(--fs-xs);
	}
	.sm.danger {
		font-weight: 400;
	}
	.notice :global(svg) {

		width: 17px;

		height: 17px;

		flex: none;

		margin-top: 1px;

		stroke-width: 1.8;

	}
	.sm :global(svg) {
		width: 16px;
		height: 16px;
		margin-top: 2px;
	}
	.text {
		flex: 1 1 auto;
		min-width: 0;
	}
	.action {
		flex: none;
	}
	.action :global(button) {
		color: inherit;
		text-decoration: underline;
		background: none;
		border: 0;
		padding: 0;
		font: inherit;
		cursor: pointer;
	}
</style>
