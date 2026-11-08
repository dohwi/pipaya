<script lang="ts">
	/**
	 * The text field a row turns into while it is renamed in place: it takes focus with everything selected, Enter
	 * and leaving the field save, Escape cancels.
	 */
	let {
		value,
		oninput,
		oncommit,
		oncancel,
		maxlength,
		inline = false,
	}: { inline?: boolean; value: string; oninput: (v: string) => void; oncommit: () => void; oncancel: () => void; maxlength?: number } = $props();

	function focusSelect(node: HTMLInputElement) {
		node.focus();
		node.select();
	}
</script>

<input
	class="rename"
	class:inline
	{value}
	oninput={(e) => oninput(e.currentTarget.value)}
	use:focusSelect
	{maxlength}
	onblur={oncommit}
	onkeydown={(e) => {
		if (e.key === "Enter") oncommit();
		if (e.key === "Escape") oncancel();
	}}
/>

<style>
	.rename {
		flex: 1;
		margin: 4px;
		height: 34px;
		padding: 0 8px;
		border-radius: var(--radius-sm);
		border: 1px solid var(--accent);
		background: var(--bg);
		outline: 0;
		font-size: var(--fs-lg);
		min-width: 0;
	}
	/* in a row, in the title's place: same text size, a 24px field in the 32px row (4px above and below), so nothing moves */
	.rename.inline {
		margin: 0;
		border-radius: var(--radius-xs); /* 8px on a 24px field reads as a pill; a row's name field is a quiet text box */
		border-color: color-mix(in srgb, var(--accent) 45%, transparent); /* softer than the full accent: it is the only field on screen, focus is obvious */
		height: 24px;
		padding: 0 4px;
		font-size: var(--fs-sm);
		line-height: 20px;
	}
</style>
