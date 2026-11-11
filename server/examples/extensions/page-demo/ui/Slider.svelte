<script>
	// Draws one settings field (`"component": "Slider"`): value + onchange; the form's button saves it.
	let { field, value, onchange, disabled, fallback } = $props();
</script>

<label class="row">
	<span class="name">{field.label}</span>
	<input type="range" min={field.min ?? 0} max={field.max ?? 100} value={value ?? field.default ?? 0} {disabled} oninput={(e) => onchange(e.currentTarget.valueAsNumber)} />
	<output>{value ?? field.default ?? 0}</output>
</label>

<style>
	.row { display: grid; grid-template-columns: 1fr auto; gap: 4px 12px; align-items: center; }
	.name { grid-column: 1 / -1; font-size: var(--fs-xs); font-weight: 550; }
	input { accent-color: var(--accent); width: 100%; }
	output { font-size: var(--fs-sm); color: var(--text-dim); min-width: 2ch; text-align: right; }
</style>
