<script lang="ts">
	import { onDestroy } from "svelte";
	import { t } from "../lib/i18n";
	import Icon from "./Icon.svelte";
	import { BAR_KEYS, keySequence, type Mods } from "../lib/terminal-keys";

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
		scrolledUp,
	}: {
		mods: Mods;
		appCursor: () => boolean;
		onsend: (data: string) => void;
		onfit: () => void;
		onbottom: () => void;
		onkeyboard: () => void;
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

	function fire(k: (typeof BAR_KEYS)[number]) {
		if (k.send) onsend(keySequence(k.send, mods, appCursor()));
		else if (k.text) onsend(k.text);
		if (k.send && (mods.ctrl || mods.alt)) mods = { ctrl: false, alt: false };
		navigator.vibrate?.(8);
	}
	function down(e: PointerEvent, k: (typeof BAR_KEYS)[number]) {
		e.preventDefault(); // keep the terminal's focus (and the keyboard)
		fire(k);
		if (!k.repeat) return;
		stop();
		timer = setTimeout(() => (iv = setInterval(() => fire(k), 70)), 350);
	}
	const noFocus = (e: Event) => e.preventDefault();
</script>

<div class="bar" role="toolbar" aria-label={t("터미널 보조 키")}>
	<div class="keys">
		<button class="k mod" class:on={mods.ctrl} aria-pressed={mods.ctrl} onpointerdown={noFocus} onclick={() => (mods = { ...mods, ctrl: !mods.ctrl })}>Ctrl</button>
		<button class="k mod" class:on={mods.alt} aria-pressed={mods.alt} onpointerdown={noFocus} onclick={() => (mods = { ...mods, alt: !mods.alt })}>Alt</button>
		{#each BAR_KEYS as k (k.id)}
			<button class="k" title={k.title} aria-label={k.title} onpointerdown={(e) => down(e, k)} onpointerup={stop} onpointercancel={stop} onpointerleave={stop} onclick={noFocus}>{k.label}</button>
		{/each}
		<button class="k" aria-label={t("화면 맞춤")} title={t("화면 맞춤")} onpointerdown={noFocus} onclick={onfit}>Fit</button>
	</div>
	<div class="fixed">
		{#if scrolledUp}
			<button class="k icon" aria-label={t("맨 아래로")} title={t("맨 아래로")} onpointerdown={noFocus} onclick={onbottom}><Icon name="chevron-down" /></button>
		{/if}
		<button class="k" aria-label={t("키보드 접기/펴기")} title={t("키보드 접기/펴기")} onpointerdown={noFocus} onclick={onkeyboard}>⌨</button>
	</div>
</div>

<style>
	.bar {
		display: flex;
		align-items: stretch;
		gap: 4px;
		padding: 4px 6px 4px;
		border-top: 1px solid var(--border);
		background: var(--bg-elev);
		user-select: none;
		-webkit-user-select: none;
		touch-action: manipulation;
		flex: none;
	}
	.fixed {
		display: flex;
		gap: 4px;
		flex: none;
		margin-left: -18px;
		position: relative;
	}
	.keys {
		display: flex;
		gap: 4px;
		flex: 1;
		min-width: 0;
		overflow-x: auto;
		scrollbar-width: none;
		overscroll-behavior-x: contain;
		/* fade at the right edge: more keys are one swipe away */
		mask-image: linear-gradient(to right, #000 calc(100% - 22px), transparent);
		padding-right: 22px;
	}
	.keys::-webkit-scrollbar {
		display: none;
	}
	.k {
		flex: none;
		min-width: 34px;
		height: 36px;
		padding: 0 8px;
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
	.k:active {
		background: var(--border-strong);
	}
	.k.mod.on {
		background: var(--accent);
		color: var(--accent-fg);
	}
	.k.icon :global(svg) {
		width: 16px;
		height: 16px;
	}
</style>
