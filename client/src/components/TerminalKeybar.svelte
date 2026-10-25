<script lang="ts">
	import { onDestroy } from "svelte";
	import { t } from "../lib/i18n";
	import Icon from "./Icon.svelte";
	import { applyMods, BAR_KEYS, keySequence, type BarKey, type Mods } from "../lib/terminal-keys";

	/**
	 * Helper keys above the soft keyboard (Esc, Tab, arrows, Ctrl/Alt, ...). The buttons never take focus, so the
	 * keyboard stays up while they are used. Ctrl/Alt are sticky: they apply to the next typed character.
	 */
	let {
		mods = $bindable(),
		appCursor,
		onsend,
		onfit,
		onbottom,
		onkeyboard,
		onpaste,
		scrolledUp,
	}: {
		mods: Mods;
		appCursor: () => boolean;
		onsend: (data: string) => void;
		onfit: () => void;
		onbottom: () => void;
		onkeyboard: () => void;
		onpaste: () => void;
		scrolledUp: boolean;
	} = $props();

	let timer: ReturnType<typeof setTimeout> | undefined;
	let iv: ReturnType<typeof setInterval> | undefined;
	function stop() {
		clearTimeout(timer);
		clearInterval(iv);
		timer = iv = undefined;
	}
	onDestroy(stop);

	const NO_MODS: Mods = { ctrl: false, alt: false, shift: false };
	function fire(k: BarKey) {
		if (k.send) onsend(keySequence(k.send, mods, appCursor()));
		else if (k.text) onsend(applyMods(k.text, mods).data);
		if (mods.ctrl || mods.alt || mods.shift) mods = NO_MODS;
		navigator.vibrate?.(8);
	}
	/**
	 * A key fires when the finger lifts, so swiping the bar sideways (the browser cancels the pointer then) never types
	 * the keys under it. Keys that repeat start after a short hold and then fire on every tick.
	 */
	let held = false;
	function down(e: PointerEvent, k: BarKey) {
		e.preventDefault(); // keep the terminal's focus (and the keyboard)
		stop();
		held = false;
		if (!k.repeat) return;
		timer = setTimeout(() => {
			held = true;
			fire(k);
			iv = setInterval(() => fire(k), 70);
		}, 350);
	}
	function up(k: BarKey) {
		const wasHeld = held;
		stop();
		held = false;
		if (!wasHeld) fire(k);
	}
	const noFocus = (e: Event) => e.preventDefault();
</script>

<div class="bar" role="toolbar" aria-label={t("터미널 보조 키")}>
	<div class="keys">
		{#if scrolledUp}
			<button class="k icon" aria-label={t("맨 아래로")} title={t("맨 아래로")} onpointerdown={noFocus} onclick={onbottom}><Icon name="chevron-down" /></button>
		{/if}
		{#each BAR_KEYS as k (k.id)}
			{#if k.mod}
				{@const on = mods[k.mod]}
				<button class="k mod" class:gap={k.gap} class:on aria-pressed={on} title={k.title} onpointerdown={noFocus} onclick={() => (mods = { ...mods, [k.mod!]: !on })}>{k.label}</button>
			{:else if k.action}
				<button class="k" class:gap={k.gap} title={k.title} aria-label={k.action === "paste" ? t("붙여넣기") : t("화면 맞춤")} onpointerdown={noFocus} onclick={k.action === "paste" ? onpaste : onfit}>{k.label}</button>
			{:else}
				<button class="k" class:gap={k.gap} title={k.title} aria-label={k.title} onpointerdown={(e) => down(e, k)} onpointerup={() => up(k)} onpointercancel={stop} onpointerleave={stop} onclick={noFocus}>{k.label}</button>
			{/if}
		{/each}
	</div>
	<button class="k kb" aria-label={t("키보드 접기/펴기")} title={t("키보드 접기/펴기")} onpointerdown={noFocus} onclick={onkeyboard}>⌨</button>
</div>

<style>
	.bar {
		display: flex;
		align-items: center;
		gap: 4px;
		padding: 4px 6px;
		border-top: 1px solid var(--border);
		background: var(--bg-elev);
		user-select: none;
		-webkit-user-select: none;
		touch-action: manipulation;
		flex: none;
	}
	.keys {
		display: flex;
		gap: 4px;
		flex: 1;
		min-width: 0;
		overflow-x: auto;
		scrollbar-width: none;
		overscroll-behavior-x: contain;
		touch-action: pan-x;
		/* fade at the right edge: more keys are one swipe away */
		mask-image: linear-gradient(to right, #000 calc(100% - 22px), transparent);
		-webkit-mask-image: linear-gradient(to right, #000 calc(100% - 22px), transparent);
		padding-right: 22px;
		margin-right: -8px;
	}
	.keys::-webkit-scrollbar {
		display: none;
	}
	.k {
		flex: none;
		min-width: 38px;
		height: 36px;
		padding: 0 10px;
		border-radius: var(--radius-sm);
		background: var(--bg-hover);
		color: var(--text);
		font: inherit;
		font-family: var(--mono);
		font-size: var(--fs-xs);
		display: inline-flex;
		align-items: center;
		justify-content: center;
		-webkit-tap-highlight-color: transparent;
	}
	.k.gap {
		margin-left: 8px;
	}
	.k:active {
		background: var(--border-strong);
	}
	.k.mod.on {
		background: var(--text);
		color: var(--bg);
	}
	.k.kb {
		flex: none;
		position: relative;
	}
	.k.icon :global(svg) {
		width: 16px;
		height: 16px;
	}
</style>
