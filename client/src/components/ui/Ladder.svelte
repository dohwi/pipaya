<script lang="ts" generics="T extends string">
	import { rovingKeys } from "../../lib/roving";

	/**
	 * A row of ordered steps on one quiet rail: off → max, auto → fast. Every node is a button; its name sits under it.
	 *  - one choice (`value` + `onchange`): the chosen node is filled, arrow keys move it (one Tab stop, like `Segmented`);
	 *  - several (`selected` + `ontoggle`): each node is its own toggle, filled when on.
	 * Colour: `level` sets `data-level` (the reasoning colours in app.css), `color` any other CSS colour; neither = the text colour.
	 * The rail is never coloured between nodes, so the row reads as a set of steps to press, not a range to drag.
	 */
	/** `marked`: a step to point at without choosing it (the agent's recommendation): a warn-coloured ring and name until it is chosen. */
	type Option = { id: T; label: string; level?: string; color?: string; disabled?: boolean; title?: string; marked?: boolean };
	let {
		options,
		label,
		value,
		onchange,
		selected,
		ontoggle,
		disabled = false,
	}: {
		options: Option[];
		label: string;
		value?: T | null;
		onchange?: (id: T) => void;
		selected?: readonly T[];
		ontoggle?: (id: T) => void;
		/** the whole row: shown, not pressable (nothing to apply it to yet) */
		disabled?: boolean;
	} = $props();

	const multi = $derived(!!ontoggle);
	const on = (id: T) => (multi ? !!selected?.includes(id) : value === id);
	/** One Tab stop for a single choice: the chosen node, or the first one when nothing is chosen. */
	const stop = $derived(multi ? null : options.some((o) => o.id === value && !o.disabled) ? value : options.find((o) => !o.disabled)?.id);
</script>

<!-- arrows move a single choice; in a set of toggles they would toggle as they pass, so there each node is its own Tab stop -->
<div class="ladder" class:off={disabled} class:dense={options.length > 7} role="group" aria-label={label} aria-disabled={disabled || undefined} style:--n={options.length} use:rovingKeys={{ item: "button[data-roving]" }}>
	<span class="rail" aria-hidden="true"></span>
	{#each options as o (o.id)}
		<button
			type="button"
			class="step tap"
			class:marked={o.marked}
			data-level={o.level}
			data-roving={multi ? undefined : ""}
			style:--lv={o.color ?? (o.level ? undefined : "var(--text)")}
			aria-pressed={on(o.id)}
			tabindex={multi || stop === o.id ? 0 : -1}
			disabled={disabled || o.disabled}
			title={o.title}
			onclick={() => (multi ? ontoggle?.(o.id) : value !== o.id && onchange?.(o.id))}
		>
			<span class="node" aria-hidden="true"></span>
			<span class="name">{o.label}</span>
		</button>
	{/each}
</div>

<style>
	/* Equal columns on every width (390px phone, seven steps: 46px each, "minimal" in 12px fits), so nothing wraps or scrolls. */
	.ladder {
		position: relative;
		display: grid;
		grid-template-columns: repeat(var(--n), minmax(0, 1fr));
		padding: 12px 4px 8px;
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		transition: opacity var(--motion-fast) var(--ease-std);
	}
	.ladder.off {
		background: var(--disabled-bg);
		border-color: var(--disabled-border);
		color: var(--disabled-fg);
	}
	/* from the first node's centre to the last one's: half a column in from each side of the 4px padding */
	.rail {
		position: absolute;
		left: calc(4px + (100% - 8px) / (2 * var(--n)));
		right: calc(4px + (100% - 8px) / (2 * var(--n)));
		top: 23px; /* 12 padding + 4 node inset + 8 (half the 16px node) - 1 (half the 2px rail) */
		height: 2px;
		border-radius: 1px;
		background: var(--border-strong);
	}
	.step {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 4px;
		min-width: 0;
		padding: 4px 0;
		background: none;
		border: 0;
		border-radius: var(--radius-control);
		color: var(--text-faint);
	}
	.node {
		position: relative; /* above the rail */
		width: 16px;
		height: 16px;
		box-sizing: border-box;
		border-radius: 50%;
		border: 2px solid var(--border-strong);
		background: var(--bg);
		transition: background var(--motion-fast) var(--ease-std), border-color var(--motion-fast) var(--ease-std), transform var(--motion-fast) var(--ease-std);
	}
	/* the name may run a few px past its column (a 360px phone: "medium" 44px in a 41.7px column); its neighbours'
	   names are short enough that they never meet, so it is never cut */
	.name {
		white-space: nowrap;
		line-height: 20px;
		font-size: var(--fs-sm);
		font-weight: 500;
		transition: color var(--motion-fast) var(--ease-std);
	}
	@media (hover: hover) {
		.step:hover:not(:disabled) {
			color: var(--text);
		}
		.step:hover:not(:disabled) .node {
			transform: scale(1.15);
		}
		.step[aria-pressed="false"]:hover:not(:disabled) .node {
			border-color: var(--lv);
		}
	}
	.step[aria-pressed="true"] {
		color: var(--lv);
	}
	.step.marked[aria-pressed="false"] {
		color: var(--warn);
	}
	.step.marked[aria-pressed="false"] .node {
		border-color: var(--warn);
	}
	.step[aria-pressed="true"] .name {
		font-weight: 650;
	}
	.step[aria-pressed="true"] .node {
		background: var(--lv);
		border-color: var(--lv);
	}
	/* a step that cannot change (the last one a model offers, a speed it no longer lists) stays as drawn, not greyed */
	.step:disabled {
		cursor: default;
	}
	@media (max-width: 640px) {
		.name {
			font-size: var(--fs-xs);
		}
		/* eight steps ("자동" before seven strengths): 11px keeps "minimal" and "medium" apart on a 390px phone */
		.dense .name {
			font-size: var(--fs-2xs);
		}
	}
	/* a 360px phone gives each of seven columns 40px: "minimal" and "medium" in 12px crowded their neighbours. 11px and no
	   side padding (columns 41.7px) keep a gap between every pair of names; the rail's ends follow the padding. */
	@media (max-width: 380px) {
		.ladder {
			padding-inline: 0;
		}
		.rail {
			left: calc(100% / (2 * var(--n)));
			right: calc(100% / (2 * var(--n)));
		}
		.name {
			font-size: var(--fs-2xs);
		}
	}
</style>
