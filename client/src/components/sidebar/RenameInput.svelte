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
	}: { value: string; oninput: (v: string) => void; oncommit: () => void; oncancel: () => void; maxlength?: number } = $props();

	function focusSelect(node: HTMLInputElement) {
		node.focus();
		node.select();
	}
</script>

<input
	class="rename"
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
</style>
