<script lang="ts">
	/**
	 * An on/off switch. A button with role="switch" rather than a checkbox: the state is only what the caller says it
	 * is, so when an action fails (an extension that cannot start) the switch simply stays where it was.
	 */
	let {
		checked,
		disabled = false,
		label,
		describedby,
		onchange,
	}: {
		checked: boolean;
		disabled?: boolean;
		label: string;
		describedby?: string;
		onchange: (on: boolean) => void;
	} = $props();
</script>

<button
	type="button"
	role="switch"
	class="sw hit"
	aria-checked={checked}
	aria-label={label}
	aria-describedby={describedby}
	{disabled}
	onclick={() => onchange(!checked)}
>
	<span class="knob"></span>
</button>

<style>
	.sw {
		flex: none;
		position: relative;
		width: 38px;
		height: 22px;
		padding: 0;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-pill);
		background: var(--bg-active);
		transition:
			background var(--motion-fast) var(--ease-std),
			border-color var(--motion-fast) var(--ease-std);
	}
	.knob {
		position: absolute;
		top: 2px;
		left: 2px;
		width: 16px;
		height: 16px;
		border-radius: 50%;
		background: var(--text-dim);
		transition:
			transform var(--motion-normal) var(--ease-spring),
			background-color var(--motion-fast) var(--ease-std);
	}
	.sw[aria-checked="true"] {
		background: var(--text);
		border-color: var(--text);
	}
	.sw[aria-checked="true"] .knob {
		transform: translateX(16px);
		background: var(--bg);
	}
	.sw:active:not(:disabled) .knob {
		scale: 1.12;
	}
	.sw:disabled {
		opacity: 0.45;
		cursor: default;
	}
	.sw:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
	@media (prefers-reduced-motion: reduce) {
		.sw,
		.knob {
			transition: none;
		}
	}
</style>
