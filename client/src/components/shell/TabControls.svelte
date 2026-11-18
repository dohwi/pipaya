<script lang="ts">
	import { t } from "../../lib/i18n";
	import { app } from "../../lib/store.svelte";
	import { platformName } from "../../lib/terminal";
	import { newMenuEntries } from "../../lib/sidebar-model";
	import Icon from "../ui/Icon.svelte";
	import RowMenu, { type RowMenuItem } from "../ui/RowMenu.svelte";
	import TabCountButton from "./TabCountButton.svelte";

	/**
	 * The tab controls as one cluster, a browser's corner: "+" (a new chat or terminal in this folder) and the tab count
	 * (opens the overview), 4px apart (none in the header, whose wider buttons already space them). `bar` sits pinned at the right end of the tab strip (wider screens), `header` at the
	 * right end of the phone header, where the strip folds away. Both behave the same; only the button sizes differ.
	 */
	let { place = "bar" }: { place?: "bar" | "header" } = $props();

	const dir = $derived(app.tabDir);
	const path = $derived(dir?.path ?? app.workdirAbs);
	const count = $derived(dir?.tabs.length ?? 0);
	const workdir = $derived(path === app.workspace?.root ? "." : path);

	let menu: ReturnType<typeof RowMenu> | undefined = $state();
	let menuId = $state<string | null>(null);
	const newItems = (): RowMenuItem[] =>
		newMenuEntries(platformName(app.terminalSupport?.platform), {
			chat: () => void (app.serverId && app.openIn(app.serverId, { workdir })),
			terminal: () => void (app.serverId && app.openIn(app.serverId, { workdir, terminal: true })),
		});
</script>

<div class="ctl {place}" data-part="tab-controls">
	<button
		class="add tap"
		class:on={menuId === "new"}
		onpointerenter={(e) => menu?.hover(e, "new", newItems())}
		onpointerleave={(e) => menu?.leave(e)}
		onclick={(e) => menu?.click(e, "new", newItems())}
		aria-label={t("새 대화 또는 터미널")}
		aria-haspopup="menu"
		title={t("이 폴더에서 새 대화 또는 터미널")}><Icon name="plus" /></button
	>
	{#if count}<TabCountButton {count} {place} />{/if}
</div>
<RowMenu bind:this={menu} bind:open={menuId} />

<style>
	.ctl {
		flex: none;
		display: flex;
		align-items: center;
		gap: 4px;
	}
	/* the header's 32px buttons already leave 6.5px around a 19px glyph: no gap on top, so the "+" ink and the count's square
	   stand 16px apart, the header's own step (the menu glyph to the title) instead of a loose 20 */
	.ctl.header {
		gap: 0;
	}
	.add {
		flex: none;
		display: grid;
		place-items: center;
		width: 28px;
		height: 28px;
		border-radius: var(--radius-sm);
		color: var(--text-dim);
		transition:
			background var(--motion-fast) var(--ease-std),
			color var(--motion-fast) var(--ease-std);
	}
	.add :global(svg) {
		width: 16px;
		height: 16px;
		stroke-width: 1.9;
	}
	/* the header's tool buttons: 32 wide, 40 tall, round, a 19px glyph (Header.svelte `.tool` on a phone) */
	.header .add {
		width: 32px;
		height: 40px;
		border-radius: 50%;
	}
	.header .add :global(svg) {
		width: 19px;
		height: 19px;
		stroke-width: 1.75;
	}
	.header .add:focus-visible {
		outline-offset: -2px; /* 40px in a 44px bar, like the header's other buttons */
	}
	.add.on {
		background: var(--bg-hover);
		color: var(--text);
	}
	@media (hover: hover) {
		.add:hover {
			background: var(--bg-hover);
			color: var(--text);
		}
	}
</style>
