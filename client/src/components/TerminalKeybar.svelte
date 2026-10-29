<script lang="ts">
	import { onDestroy } from "svelte";
	import { t } from "../lib/i18n";
	import Icon, { type IconName } from "./Icon.svelte";
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
		onpaste,
		scrolledUp,
	}: {
		mods: Mods;
		appCursor: () => boolean;
		onsend: (data: string) => void;
		onfit: () => void;
		onbottom: () => void;
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

	// Edge fades only where more keys are hidden, so the bar shows that it scrolls
	let strip: HTMLDivElement | undefined = $state();
	let more = $state({ left: false, right: false });
	function measure() {
		if (!strip) return;
		more = { left: strip.scrollLeft > 4, right: strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 4 };
	}
	$effect(() => {
		if (!strip) return;
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(strip);
		return () => ro.disconnect();
	});
</script>

<div class="bar" role="toolbar" aria-label={t("터미널 보조 키")}>
	<div class="strip" class:fade-l={more.left} class:fade-r={more.right}>
		<div class="keys" bind:this={strip} onscroll={measure}>
			{#if scrolledUp}
				<button class="k icon accent" aria-label={t("맨 아래로")} title={t("맨 아래로")} onpointerdown={noFocus} onclick={onbottom}><Icon name="arrow-down" /></button>
			{/if}
			{#each BAR_KEYS as k (k.id)}
				{#if k.gap}<span class="sep" aria-hidden="true"></span>{/if}
				{#if k.mod}
					{@const on = mods[k.mod]}
					<button class="k mod" class:on aria-pressed={on} title={k.title} onpointerdown={noFocus} onclick={() => (mods = { ...mods, [k.mod!]: !on })}>{k.label}</button>
				{:else if k.action}
					{@const label = k.action === "paste" ? t("붙여넣기") : t("화면 맞춤")}
					<button class="k" class:icon={k.icon} title={label} aria-label={label} onpointerdown={noFocus} onclick={k.action === "paste" ? onpaste : onfit}>
						{#if k.icon}<Icon name={k.icon as IconName} />{:else}{k.label}{/if}
					</button>
				{:else}
					<button class="k" class:icon={k.icon} title={k.title} aria-label={k.title} onpointerdown={(e) => down(e, k)} onpointerup={() => up(k)} onpointercancel={stop} onpointerleave={stop} onclick={noFocus}>
						{#if k.icon}<Icon name={k.icon as IconName} />{:else}{k.label}{/if}
					</button>
				{/if}
			{/each}
		</div>
	</div>
</div>

<style>
	/* Same surface as the composer's footer: the app's tokens only, no colours of its own */
	.bar {
		display: flex;
		align-items: center;
		gap: 4px;
		padding: 4px 16px calc(4px + var(--sab)); /* first key on the 16px line, like the composer above a conversation */
		border-top: 1px solid var(--border);
		background: var(--bg-elev);
		user-select: none;
		-webkit-user-select: none;
		touch-action: manipulation;
		flex: none;
	}
	.strip {
		flex: 1;
		min-width: 0;
		position: relative;
	}
	/* Edge fades that only appear on the side where keys are hidden */
	.strip::before,
	.strip::after {
		content: "";
		position: absolute;
		top: 0;
		bottom: 0;
		width: 22px;
		z-index: 1;
		pointer-events: none;
		opacity: 0;
		transition: opacity var(--motion-fast) var(--ease-std);
	}
	.strip::before {
		left: 0;
		background: linear-gradient(to right, var(--bg-elev), transparent);
	}
	.strip::after {
		right: 0;
		background: linear-gradient(to left, var(--bg-elev), transparent);
	}
	.strip.fade-l::before,
	.strip.fade-r::after {
		opacity: 1;
	}
	.keys {
		display: flex;
		align-items: center;
		gap: 4px;
		overflow-x: auto;
		scrollbar-width: none;
		overscroll-behavior-x: contain;
		touch-action: pan-x;
		-webkit-overflow-scrolling: touch;
	}
	.keys::-webkit-scrollbar {
		display: none;
	}
	.sep {
		flex: none;
		width: 1px;
		height: 18px;
		margin: 0 4px;
		background: var(--border-strong);
	}
	.k {
		flex: none;
		min-width: 40px;
		height: var(--control-h-sm);
		padding: 0 12px;
		border-radius: var(--radius-control);
		border: 1px solid var(--border);
		background: var(--bg-hover);
		color: var(--text);
		font-family: var(--mono);
		font-size: var(--fs-sm);
		font-weight: 500;
		line-height: 1;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		-webkit-tap-highlight-color: transparent;
		transition:
			background-color var(--motion-fast) var(--ease-std),
			color var(--motion-fast) var(--ease-std),
			border-color var(--motion-fast) var(--ease-std);
	}
	.k.icon {
		padding: 0;
		min-width: 40px;
		color: var(--text-dim);
	}
	.k.icon :global(svg) {
		width: 17px;
		height: 17px;
	}
	/* Pressed: a tint, like the app's list rows (no scale: the bar is a row of tightly packed keys) */
	.k:active {
		scale: 1;
		background: var(--bg-active);
		border-color: var(--border-strong);
		color: var(--text);
	}
	/* Sticky modifier switched on: the app's accent (inverted by contrast), also exposed as aria-pressed */
	.k.mod.on {
		background: var(--accent);
		border-color: var(--accent);
		color: var(--accent-fg);
		font-weight: 700;
	}
	.k.accent {
		background: var(--accent-soft);
		border-color: transparent;
		color: var(--text);
	}
	.k:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: -2px;
	}
</style>
