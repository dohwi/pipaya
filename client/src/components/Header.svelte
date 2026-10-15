<script lang="ts">
	import { t } from "../lib/i18n";
	import { formatCombo } from "../lib/keys";
	import Icon from "./Icon.svelte";
	import NavbarUsage from "./extensions/NavbarUsage.svelte";
	import { app } from "../lib/store.svelte";
	import { panesOf } from "../lib/layout";
	import { viewport } from "../lib/viewport.svelte";
	const hint = $derived(app.prefs.bindings.toggleSidebar ? ` (${formatCombo(app.prefs.bindings.toggleSidebar)})` : "");

	const s = $derived(app.current);
	// Wide screens show the whole group at once, so the header names the group rather than one session.
	const group = $derived(viewport.narrow ? undefined : app.activeGroup);
</script>

<header>
	<div class="capsule">
		<button class="tool menu" onclick={() => (app.sidebar.open = true)} aria-label={t("사이드바 열기")} title={t("사이드바 열기") + hint}>
			<Icon name="sidebar" />
		</button>

		<div class="title">
			{#if group}
				<span class="t">{group.name}</span>
				<span class="sub mono">{t("대화 {n}개", { n: panesOf(group.layout).length })}</span>
			{:else}
				<span class="t">{s?.title ?? t("새 대화")}</span>
				{#if s}<span class="sub mono">{s.cwd.split("/").slice(-2).join("/")}</span>{/if}
			{/if}
		</div>

		<NavbarUsage />

	</div>
</header>


<style>
	header {
		flex: none;
		z-index: 10;
		padding: var(--sat) var(--sar) 0 var(--sal);
		border-bottom: 1px solid var(--border);
		background: var(--bg);
	}
	.capsule {
		display: flex;
		align-items: center;
		gap: 2px;
		height: 44px;
		/* Every visible edge sits 16px from the window, like the extension button below. The round menu button's circle is
		   only a hover state, so the drawn icon is what counts: the sidebar glyph's strokes start ~2.4px inside its 19px box,
		   so left = 3px + 10.5px around the icon + 2.4px of glyph inset (set below where the menu shows) or 6px + the title's own 10px; right = 13px + the 3px padding of the nav slot. */
		padding: 0 13px 0 6px;
	}
	.title {
		flex: 1 1 0;
		/* The title keeps priority over the extension slot: never squeezed to nothing. */
		min-width: min(96px, 40%);
		display: flex;
		flex-direction: column;
		justify-content: center;
		padding: 0 10px;
	}
	.t {
		font-weight: 600;
		font-size: var(--fs-md);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		line-height: 1.2;
	}
	.sub {
		font-size: var(--fs-2xs);
		color: var(--text-faint);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		line-height: 1.2;
	}
	.tool {
		display: grid;
		place-items: center;
		width: 40px;
		height: 40px;
		border-radius: 50%;
		color: var(--text-dim);
		transition:
			background var(--motion-fast) var(--ease-std),
			color var(--motion-fast) var(--ease-std);
	}
	.tool:hover {
		background: var(--bg-hover);
		color: var(--text);
	}
	.tool :global(svg) {
		width: 19px;
		height: 19px;
		stroke: currentColor;
		fill: none;
		stroke-width: 1.75;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	.menu {
		display: none;
	}
	@media (max-width: 600px) {
		/* the nav slot pads 2px here */
		.capsule { padding-right: 14px; }
		.title { padding: 0 4px; }
		.tool { width: 32px; }
	}
	@media (max-width: 860px) {
		.capsule { padding-left: 3px; }
		.menu {
			display: grid;
		}
	}
	@media (max-width: 600px) {
		/* declared after the 860px rule so it wins: the 32px button leaves 6.5px around the icon */
		.capsule { padding-left: 7px; }
	}
</style>
