<script lang="ts" generics="T extends string | number">
	import { tick } from "svelte";
	import Icon from "./Icon.svelte";
	import { portal } from "../lib/dialog";
	import { surfaceIn, surfaceOut } from "../lib/motion";

	/**
	 * One dropdown for every setting, in place of the native <select> (whose popup looks different on each OS, cannot
	 * be animated and cannot sit in a themed card) and of <datalist> (no styling, no keyboard hint).
	 *
	 * Focus stays on the trigger the whole time: the list is a listbox the trigger points at with aria-activedescendant,
	 * so a modal's focus trap and Esc handling keep working. The list lives on <body> (a modal clips and scrolls) and
	 * opens downwards, or upwards when there is no room.
	 *
	 * `editable`: the trigger is a text field and the options are suggestions; whatever is typed is committed on Enter or
	 * blur (a font name that is not in the list). Otherwise only an option can be chosen.
	 */
	let {
		options,
		value,
		onchange,
		label,
		id,
		placeholder = "",
		disabled = false,
		editable = false,
		invalid = false,
		required = false,
		describedby,
		size = "md",
		width = "100%",
		mono = false,
	}: {
		options: { value: T; label: string; hint?: string; disabled?: boolean }[];
		value: T | string;
		onchange: (value: T) => void;
		/** accessible name when no <label for> points at the trigger */
		label?: string;
		id?: string;
		placeholder?: string;
		disabled?: boolean;
		editable?: boolean;
		invalid?: boolean;
		required?: boolean;
		describedby?: string;
		size?: "sm" | "md";
		/** any CSS width; the list is at least as wide as the trigger */
		width?: string;
		mono?: boolean;
	} = $props();

	const uid = $props.id();
	const listId = `${uid}-list`;
	const optId = (i: number) => `${uid}-o${i}`;

	let root = $state<HTMLElement | null>(null);
	let trigger = $state<HTMLElement | null>(null);
	let list = $state<HTMLElement | null>(null);
	let open = $state(false);
	let active = $state(-1);
	let pos = $state({ left: 0, top: 0, width: 0, maxHeight: 280, up: false });
	let draft = $state<string | null>(null);

	const selected = $derived(options.findIndex((o) => o.value === value));
	const shown = $derived(selected >= 0 ? options[selected]!.label : editable ? String(value ?? "") : "");

	function place() {
		if (!trigger) return;
		const r = trigger.getBoundingClientRect();
		const below = window.innerHeight - r.bottom - 12;
		const above = r.top - 12;
		const want = Math.min(280, options.length * 36 + 10);
		const up = below < want && above > below;
		const w = Math.max(r.width, 160);
		pos = {
			left: Math.max(8, Math.min(r.left, window.innerWidth - w - 8)),
			top: up ? r.top - 6 : r.bottom + 6,
			width: w,
			maxHeight: Math.max(120, Math.min(280, up ? above : below)),
			up,
		};
	}
	async function show() {
		if (disabled || open || !options.length) return;
		place();
		active = selected >= 0 ? selected : options.findIndex((o) => !o.disabled);
		open = true;
		await tick();
		reveal();
	}
	function hide() {
		open = false;
		active = -1;
	}
	function reveal() {
		list?.querySelector(`#${CSS.escape(optId(active))}`)?.scrollIntoView({ block: "nearest" });
	}
	function pick(i: number) {
		const o = options[i];
		if (!o || o.disabled) return;
		draft = null;
		hide();
		if (o.value !== value) onchange(o.value);
		(editable ? trigger?.querySelector("input") : trigger)?.focus();
	}
	function move(step: number, from = active) {
		const n = options.length;
		for (let k = 1; k <= n; k++) {
			const i = (((from + step * k) % n) + n) % n;
			if (!options[i]!.disabled) return (active = i), reveal();
		}
	}
	function edge(last: boolean) {
		const i = last ? options.map((o) => !o.disabled).lastIndexOf(true) : options.findIndex((o) => !o.disabled);
		if (i >= 0) (active = i), reveal();
	}

	let typed = "";
	let typedTimer: ReturnType<typeof setTimeout> | undefined;
	function typeahead(ch: string) {
		clearTimeout(typedTimer);
		typed += ch.toLowerCase();
		typedTimer = setTimeout(() => (typed = ""), 600);
		const from = typed.length === 1 ? active : active - 1;
		for (let k = 1; k <= options.length; k++) {
			const i = (from + k + options.length) % options.length;
			if (!options[i]!.disabled && options[i]!.label.toLowerCase().startsWith(typed)) {
				if (!open) void show();
				active = i;
				reveal();
				return;
			}
		}
	}

	function onkeydown(e: KeyboardEvent) {
		if (disabled || e.isComposing || e.altKey || e.ctrlKey || e.metaKey) return;
		const k = e.key;
		if (k === "ArrowDown" || k === "ArrowUp") {
			e.preventDefault();
			if (!open) void show();
			else move(k === "ArrowDown" ? 1 : -1);
		} else if (k === "Escape") {
			if (!open) return;
			e.preventDefault(); // the modal behind keeps its Esc for the next press
			draft = null;
			hide();
		} else if (k === "Enter" || (k === " " && !editable)) {
			if (open && active >= 0) (e.preventDefault(), pick(active));
			else if (!editable) (e.preventDefault(), void show());
			else commit();
		} else if (k === "Tab") {
			if (open) hide();
		} else if (!editable && (k === "Home" || k === "End") && open) {
			e.preventDefault();
			edge(k === "End");
		} else if (!editable && k.length === 1) {
			typeahead(k);
		}
	}

	function commit() {
		if (draft === null) return;
		const next = draft.trim();
		draft = null;
		if (next && next !== value) onchange(next as T);
	}
	function onblur() {
		if (editable) commit();
		hide();
	}

	/** A press outside both the trigger and the list closes it; a press inside the list must not steal focus. */
	function outside(e: PointerEvent) {
		if (!open) return;
		const n = e.target as Node | null;
		if (n && (root?.contains(n) || list?.contains(n))) return;
		hide();
	}
	function onscroll(e: Event) {
		if (open && !list?.contains(e.target as Node)) hide();
	}
</script>

<svelte:window onpointerdown={outside} onresize={hide} />
<svelte:document onscrollcapture={onscroll} />

<div class="sel" class:sm={size === "sm"} class:open class:invalid class:disabled class:mono bind:this={root} style:width>
	{#if editable}
		<div class="trigger edit" bind:this={trigger}>
			<input
				{id}
				type="text"
				role="combobox"
				aria-expanded={open}
				aria-controls={listId}
				aria-autocomplete="list"
				aria-activedescendant={open && active >= 0 ? optId(active) : undefined}
				aria-label={label}
				aria-invalid={invalid ? "true" : undefined}
				aria-describedby={describedby}
				{placeholder}
				{disabled}
				spellcheck="false"
				autocomplete="off"
				value={draft ?? shown}
				oninput={(e) => (draft = e.currentTarget.value)}
				{onkeydown}
				onblur={onblur}
			/>
			<button type="button" class="chev" tabindex="-1" aria-hidden="true" {disabled} onpointerdown={(e) => e.preventDefault()} onclick={() => (open ? hide() : (void show(), trigger?.querySelector("input")?.focus()))}>
				<Icon name="chevron-down" />
			</button>
		</div>
	{:else}
		<button
			{id}
			type="button"
			class="trigger"
			role="combobox"
			aria-haspopup="listbox"
			aria-expanded={open}
			aria-controls={listId}
			aria-activedescendant={open && active >= 0 ? optId(active) : undefined}
			aria-label={label}
			aria-invalid={invalid ? "true" : undefined}
			aria-required={required ? "true" : undefined}
			aria-describedby={describedby}
			{disabled}
			bind:this={trigger}
			onclick={() => (open ? hide() : show())}
			{onkeydown}
			onblur={onblur}
		>
			<span class="text" class:ph={!shown}>{shown || placeholder}</span>
			<span class="chev"><Icon name="chevron-down" /></span>
		</button>
	{/if}
</div>

{#if open}
	<!-- Focus stays on the trigger and its keys drive this list (aria-activedescendant); the options are only clickable for a pointer. -->
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<div
		use:portal
		bind:this={list}
		id={listId}
		class="list"
		class:up={pos.up}
		class:mono
		role="listbox"
		tabindex="-1"
		aria-label={label}
		in:surfaceIn={{ y: pos.up ? 4 : -4 }}
		out:surfaceOut={{ y: pos.up ? 4 : -4 }}
		style:left="{pos.left}px"
		style:top={pos.up ? undefined : `${pos.top}px`}
		style:bottom={pos.up ? `${window.innerHeight - pos.top}px` : undefined}
		style:min-width="{pos.width}px"
		style:max-height="{pos.maxHeight}px"
		onpointerdown={(e) => e.preventDefault()}
	>
		{#each options as o, i (o.value)}
			<div
				id={optId(i)}
				class="opt"
				class:on={i === selected}
				class:act={i === active}
				role="option"
				tabindex="-1"
				aria-selected={i === selected}
				aria-disabled={o.disabled ? "true" : undefined}
				onpointermove={() => !o.disabled && (active = i)}
				onclick={() => pick(i)}
			>
				<span class="ol">{o.label}</span>
				{#if o.hint}<span class="oh">{o.hint}</span>{/if}
				<span class="ck">{#if i === selected}<Icon name="check" />{/if}</span>
			</div>
		{/each}
	</div>
{/if}

<style>
	.sel {
		position: relative;
		display: inline-block;
		min-width: 0;
		max-width: 100%;
	}
	.trigger {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		height: var(--control-h);
		padding: 0 8px 0 12px;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-control);
		background: var(--bg);
		color: var(--text);
		font-size: var(--fs-lg);
		text-align: left;
		transition:
			border-color var(--motion-fast) var(--ease-std),
			box-shadow var(--motion-fast) var(--ease-std),
			background-color var(--motion-fast) var(--ease-std);
	}
	.sm .trigger {
		height: var(--control-h-sm);
		padding: 0 8px 0 8px;
		font-size: var(--fs-md);
	}
	.mono .trigger {
		font-family: var(--mono);
		font-size: var(--fs-sm);
	}
	button.trigger:hover:not(:disabled) {
		background: var(--bg-hover);
	}
	.trigger:focus-visible,
	.trigger:focus-within,
	.open .trigger {
		outline: none;
		border-color: var(--accent);
		box-shadow: 0 0 0 3px var(--accent-soft);
	}
	.invalid .trigger {
		border-color: var(--danger);
	}
	.disabled .trigger {
		opacity: 0.55;
		cursor: not-allowed;
	}
	.text {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.text.ph {
		color: var(--text-faint);
	}
	.edit input {
		flex: 1;
		min-width: 0;
		height: 100%;
		padding: 0;
		border: 0;
		background: transparent;
		color: inherit;
		font: inherit;
		outline: none;
	}
	.chev {
		flex: none;
		display: grid;
		place-items: center;
		width: 20px;
		height: 20px;
		padding: 0;
		color: var(--text-faint);
		transition: transform var(--motion-normal) var(--ease-spring);
	}
	.open .chev {
		transform: rotate(180deg);
	}
	.chev :global(svg) {
		width: 16px;
		height: 16px;
		stroke-width: 2;
	}
	.list {
		position: fixed;
		z-index: 110; /* above every dialog the dropdown can sit in, below the lightbox */
		display: flex;
		flex-direction: column;
		gap: 1px;
		padding: 4px;
		overflow-y: auto;
		overscroll-behavior: contain;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius);
		background: var(--bg-elev);
		box-shadow: var(--shadow);
	}
	.list.mono {
		font-family: var(--mono);
	}
	.opt {
		display: flex;
		align-items: center;
		gap: 8px;
		min-height: 34px;
		padding: 0 8px 0 8px;
		border-radius: var(--radius-sm);
		font-size: var(--fs-md);
		color: var(--text);
		cursor: pointer;
		transition: background-color var(--motion-fast) var(--ease-std);
	}
	.opt.act {
		background: var(--bg-hover);
	}
	.opt.on {
		font-weight: 600;
	}
	.opt[aria-disabled="true"] {
		opacity: 0.45;
		cursor: not-allowed;
	}
	.ol {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.oh {
		flex: none;
		font-size: var(--fs-xs);
		color: var(--text-faint);
	}
	.ck {
		flex: none;
		width: 16px;
		height: 16px;
	}
	.ck :global(svg) {
		width: 16px;
		height: 16px;
		stroke: var(--text);
		stroke-width: 2.2;
	}
</style>
