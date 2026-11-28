<script lang="ts">
	import { caretOnFirstVisualLine, caretOnLastVisualLine } from "../../lib/caret-line";
	import type { ComposerPart } from "../../lib/composer-text";
	import {
		domMatchesParts,
		getEditorSelection,
		moveEditorEdge,
		readEditorText,
		renderEditorDom,
		setEditorSelection,
		tokenBoundaryOffset,
		type WrapAffinity,
	} from "../../lib/composer/editor-dom";
	import { edgeNavKey } from "../../lib/composer/input-keys";
	import { isMac } from "../../lib/keys";

	const MODIFIER_KEYS = new Set(["Shift", "Control", "Meta", "Alt"]);

	let {
		text = $bindable(""),
		parts,
		readonly = false,
		placeholder = "",
		ariaLabel = "",
		ariaAttrs = {},
		oninput,
		onkeydown,
		onkeyup,
		onclick,
		onfocus,
		onpaste,
		oncompositionstart,
		oncompositionend,
	}: {
		text: string;
		parts: ComposerPart[];
		readonly?: boolean;
		placeholder?: string;
		ariaLabel?: string;
		ariaAttrs?: Record<string, string>;
		oninput?: () => void;
		onkeydown?: (e: KeyboardEvent) => void;
		onkeyup?: (e: KeyboardEvent) => void;
		onclick?: () => void;
		onfocus?: () => void;
		onpaste?: (e: ClipboardEvent) => void;
		oncompositionstart?: () => void;
		oncompositionend?: (e: CompositionEvent) => void;
	} = $props();

	let el: HTMLDivElement | undefined = $state();
	let composing = $state(false);
	let pendingSelection: { start: number; end: number } | null = null;
	let wrapAffinity: WrapAffinity | null = null;

	/** Reconcile token chips into the DOM whenever `parts` changes outside an active IME composition. */
	$effect(() => {
		const target = el;
		const nextParts = parts;
		if (!target || composing) return;
		const hadFocus = document.activeElement === target;
		const saved = pendingSelection ?? (hadFocus ? getEditorSelection(target) : null);
		if (!domMatchesParts(target, nextParts)) {
			renderEditorDom(target, nextParts);
			wrapAffinity = null;
			if (hadFocus && saved) setEditorSelection(target, saved.start, saved.end);
		} else if (hadFocus && pendingSelection) {
			wrapAffinity = null;
			setEditorSelection(target, pendingSelection.start, pendingSelection.end);
		}
		pendingSelection = null;
	});

	export function focus() {
		el?.focus();
	}

	export function isFocused(): boolean {
		return !!el && document.activeElement === el;
	}

	export function getSelection(): { start: number; end: number } {
		if (!el) return { start: text.length, end: text.length };
		if (pendingSelection) return { ...pendingSelection };
		return getEditorSelection(el) ?? { start: text.length, end: text.length };
	}

	export function setSelection(start: number, end = start) {
		const clampedStart = Math.max(0, Math.min(start, text.length));
		const clampedEnd = Math.max(0, Math.min(end, text.length));
		wrapAffinity = null;
		pendingSelection = { start: clampedStart, end: clampedEnd };
		if (el && !composing && domMatchesParts(el, parts)) {
			setEditorSelection(el, clampedStart, clampedEnd);
			pendingSelection = null;
		}
	}

	/** Replace the active selection (or append at the end) with plain text and place the caret after it. */
	export function insertTextAtSelection(str: string): { text: string; caret: number } {
		const sel = isFocused() ? getSelection() : { start: text.length, end: text.length };
		const nextText = text.slice(0, sel.start) + str + text.slice(sel.end);
		const nextCaret = sel.start + str.length;
		pendingSelection = { start: nextCaret, end: nextCaret };
		text = nextText;
		oninput?.();
		return { text: nextText, caret: nextCaret };
	}

	export function isOnFirstVisualLine(): boolean {
		return el ? caretOnFirstVisualLine(el) : true;
	}

	export function isOnLastVisualLine(): boolean {
		return el ? caretOnLastVisualLine(el) : true;
	}

	export function getElement(): HTMLDivElement | undefined {
		return el;
	}

	function handleInput() {
		if (!el) return;
		wrapAffinity = null;
		text = readEditorText(el);
		oninput?.();
	}

	function handleKeyDown(e: KeyboardEvent) {
		onkeydown?.(e);
		if (e.defaultPrevented) return;
		if (!readonly && el) {
			const edge = edgeNavKey(e, composing, isMac);
			if (edge) {
				const res = moveEditorEdge(el, edge.target, edge.extend, wrapAffinity);
				if (res.handled) {
					wrapAffinity = res.affinity;
					e.preventDefault();
					return;
				}
			}
		}
		if (!MODIFIER_KEYS.has(e.key)) wrapAffinity = null;
		// Normalise newline Enter (Shift+Enter on desktop, Enter on touch) to a clean "\n" instead of browser <div>/<br> quirks.
		if (e.key === "Enter" && !composing && !e.isComposing && !readonly) {
			e.preventDefault();
			insertTextAtSelection("\n");
		}
	}

	function handleCompositionStart() {
		composing = true;
		wrapAffinity = null;
		oncompositionstart?.();
	}

	function handleCompositionEnd(e: CompositionEvent) {
		composing = false;
		if (el) text = readEditorText(el);
		oncompositionend?.(e);
	}

	function handlePaste(e: ClipboardEvent) {
		onpaste?.(e);
		if (e.defaultPrevented || readonly) return;
		e.preventDefault();
		const plain = (e.clipboardData?.getData("text/plain") ?? "").replace(/\r\n?/g, "\n");
		if (plain) insertTextAtSelection(plain);
	}

	function handleCopy(e: ClipboardEvent) {
		if (!el) return;
		const sel = getEditorSelection(el);
		if (!sel || sel.start === sel.end) return;
		e.preventDefault();
		e.clipboardData?.setData("text/plain", text.slice(sel.start, sel.end));
	}

	function handleCut(e: ClipboardEvent) {
		if (!el || readonly) return;
		const sel = getEditorSelection(el);
		if (!sel || sel.start === sel.end) return;
		e.preventDefault();
		e.clipboardData?.setData("text/plain", text.slice(sel.start, sel.end));
		pendingSelection = { start: sel.start, end: sel.start };
		text = text.slice(0, sel.start) + text.slice(sel.end);
		oninput?.();
	}

	function handleMouseDown(e: MouseEvent) {
		if (!el || readonly) return;
		const chip = (e.target as HTMLElement | null)?.closest<HTMLElement>("[data-token]");
		if (!chip || !el.contains(chip)) {
			wrapAffinity = null;
			return;
		}
		e.preventDefault();
		el.focus();
		const rect = chip.getBoundingClientRect();
		const side = e.clientX < rect.left + rect.width / 2 ? "before" : "after";
		const pos = tokenBoundaryOffset(el, chip, side);
		setEditorSelection(el, pos, pos);
		wrapAffinity = { pos, side: side === "before" ? "start" : "end" };
		onclick?.();
	}
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions, a11y_no_noninteractive_tabindex -->
<div
	bind:this={el}
	class="editor"
	data-composer
	data-value={text}
	data-empty={text === "" ? "" : undefined}
	data-placeholder={placeholder}
	contenteditable={readonly ? "false" : "true"}
	role={ariaAttrs.role ?? "textbox"}
	aria-multiline="true"
	aria-readonly={readonly ? "true" : undefined}
	aria-label={ariaLabel}
	{...ariaAttrs}
	tabindex={readonly ? -1 : 0}
	onkeydown={handleKeyDown}
	oninput={handleInput}
	onkeyup={onkeyup}
	onclick={onclick}
	onmousedown={handleMouseDown}
	onfocus={onfocus}
	onpaste={handlePaste}
	oncopy={handleCopy}
	oncut={handleCut}
	oncompositionstart={handleCompositionStart}
	oncompositionend={handleCompositionEnd}
	enterkeyhint="enter"
	autocapitalize="sentences"
	spellcheck="false"
></div>

<style>
	.editor {
		position: relative;
		display: block;
		width: 100%;
		min-width: 0;
		border: 0;
		outline: 0;
		background: transparent;
		padding: 12px 16px 4px;
		font-family: var(--font-input); /* Manrope with a shorter caret (app.css); shared with .prompt-hint */
		font-size: var(--fs-lg);
		line-height: 24px; /* whole-pixel line box matching UserMessage .txt so 20px .tok chips sit identically */
		min-height: 40px; /* 12px top + 24px line + 4px bottom */
		max-height: 220px;
		overflow-x: hidden;
		overflow-y: auto;
		white-space: pre-wrap;
		overflow-wrap: break-word;
		word-break: break-word;
	}
	.editor[data-empty]::before {
		content: attr(data-placeholder);
		position: absolute;
		top: 12px;
		left: 16px;
		right: 16px;
		color: var(--text-faint);
		pointer-events: none;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* Inline token chips: identical geometry, hues, icons, and 20px box height as TokenText.svelte */
	.editor :global(.tok) {
		--hue: var(--mark-file);
		display: inline-flex;
		align-items: center;
		gap: 4px;
		max-width: 100%;
		padding: 1px 0.4em; /* em sides scale with the text, like inline code */
		border-radius: var(--radius-xs);
		background: color-mix(in srgb, var(--hue) 12%, transparent);
		box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--hue) 22%, transparent);
		color: inherit;
		font: inherit;
		font-size: 0.88em; /* matches TokenText: 20px chip sits inside the 24px line box */
		line-height: 18px; /* whole-pixel 20px box (18 + 2 padding) */
		vertical-align: middle;
		position: relative;
		top: -1px; /* measured: lifts middle onto the 24px line and Hangul ink centre */
		user-select: all;
		cursor: default;
	}
	.editor :global(.tok .tlabel) {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.editor :global(.tok .path) {
		display: inline-flex;
		min-width: 0;
	}
	.editor :global(.tok .dir) {
		flex: 0 999999 auto;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		opacity: 0.68;
	}
	.editor :global(.tok .base) {
		flex: 0 1 auto;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.editor :global(.tok.mention) {
		--hue: var(--mark-mention);
		color: var(--hue);
		font-weight: 600;
	}
	.editor :global(.tok.image) {
		--hue: var(--mark-img);
	}
	.editor :global(.tok.skill) {
		--hue: var(--accent);
		font-weight: 600;
	}
	.editor :global(.tok svg.ic) {
		display: block;
		flex: none;
		width: 12px;
		height: 12px;
		opacity: 0.7;
		stroke: currentColor;
		fill: none;
		stroke-width: 1.9;
		stroke-linecap: round;
		stroke-linejoin: round;
	}

	@container (max-width: 420px) {
		.editor {
			padding: 8px 12px 4px;
			min-height: 36px; /* 8px top + 24px line + 4px bottom */
		}
		.editor[data-empty]::before {
			top: 8px;
			left: 12px;
			right: 12px;
		}
	}
	@container (max-width: 420px) {
		@media (pointer: fine) {
			.editor {
				font-size: var(--fs-md);
				line-height: 20px;
				min-height: 32px; /* 8px top + 20px line + 4px bottom */
			}
		}
	}
</style>
