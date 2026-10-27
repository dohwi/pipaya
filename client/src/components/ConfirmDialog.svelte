<script lang="ts">
	import type { Snippet } from "svelte";
	import Button from "./Button.svelte";
	import Icon, { type IconName } from "./Icon.svelte";
	import Modal from "./Modal.svelte";

	/**
	 * The one "are you sure?" sheet: a round mark, a title, one line of explanation, optional extra content, and the
	 * answers stacked full width (the most likely one first, the way out last). Every confirmation in the app goes through it,
	 * so they all look, focus and stack the same. Use `ConfirmButton` instead for a plain delete on a row.
	 *
	 *  tone     warn (default, amber), danger (red, for deleting) or neutral (grey, for a plain question)
	 *  actions  the `primary` one takes focus (so Enter does it, Esc cancels), or whichever has `focus`; at most one
	 *  busy     disables every answer and the scrim, for an action that is running
	 * `layer` is the nesting depth of the modal it opens over (see Modal).
	 */
	export type ConfirmAction = {
		label: string;
		onclick: () => void;
		variant?: "primary" | "danger" | "default" | "ghost";
		/** red text on a ghost button, for "close without saving" */
		destructive?: boolean;
		/** takes focus (Enter does it); defaults to the `primary` one. Give it to "cancel" when the other answers destroy something. */
		focus?: boolean;
	};
	let {
		title,
		description,
		icon = "alert",
		tone = "warn",
		actions,
		oncancel,
		busy = false,
		layer = 4,
		portal = true,
		sheet = true,
		id = "confirm",
		children,
	}: {
		title: string;
		description?: string;
		icon?: IconName;
		tone?: "warn" | "danger" | "neutral";
		actions: ConfirmAction[];
		oncancel: () => void;
		busy?: boolean;
		layer?: 1 | 2 | 3 | 4 | 5;
		portal?: boolean;
		/** false: stays a centred card on phones instead of a bottom sheet */
		sheet?: boolean;
		id?: string;
		children?: Snippet;
	} = $props();
</script>

<Modal onclose={() => !busy && oncancel()} dismissible={!busy} role="alertdialog" labelledby="{id}-title" describedby={description ? `${id}-desc` : undefined} width="s" {layer} {portal} {sheet}>
	<div class="cd">
		<span class="mark {tone}"><Icon name={icon} /></span>
		<h3 id="{id}-title">{title}</h3>
		{#if description}<p id="{id}-desc">{description}</p>{/if}
		{@render children?.()}
		<div class="btns">
			{#each actions as a (a.label)}
				<Button
					variant={a.variant === "default" ? undefined : a.variant}
					class={a.destructive ? "danger-text" : undefined}
					disabled={busy}
					focus={a.focus ?? a.variant === "primary"}
					onclick={a.onclick}
				>{a.label}</Button>
			{/each}
		</div>
	</div>
</Modal>

<style>
	.cd { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 24px 20px calc(16px + var(--sab)); text-align: center; }
	.mark { display: grid; place-items: center; width: 44px; height: 44px; margin-bottom: 6px; border-radius: 50%; }
	.mark :global(svg) { width: 22px; height: 22px; stroke-width: 1.8; }
	.warn { background: var(--warn-soft); color: var(--warn); }
	.danger { background: var(--danger-soft); color: var(--danger); }
	.neutral { background: var(--bg-elev); border: 1px solid var(--border); color: var(--text-dim); }
	h3 { margin: 0; font-size: var(--fs-lg); overflow-wrap: anywhere; }
	p { margin: 0; color: var(--text-dim); font-size: var(--fs-sm); line-height: 1.5; }
	.btns { display: flex; flex-direction: column; gap: 8px; align-self: stretch; margin-top: 16px; }
	.btns :global(.btn) { width: 100%; }
</style>
