<script lang="ts">
	import { t } from "../../lib/i18n";
	import { app } from "../../lib/store.svelte";
	import { workspaceViewer } from "../../lib/workspace-viewer.svelte";
	import { platformName } from "../../lib/terminal";
	import { newMenuEntries } from "../../lib/sidebar-model";
	import Icon from "../ui/Icon.svelte";
	import RowMenu, { type RowMenuItem } from "../ui/RowMenu.svelte";
	import TabCountButton from "./TabCountButton.svelte";

	/**
	 * The tab controls: "+" (a new chat or terminal in this folder) and the tab count (opens the overview). `header` puts
	 * both at the right end of the phone header as one pair, where the strip folds away. On wider screens the tab strip
	 * splits them like a browser: `part="add"` follows the last tab, `part="count"` stays pinned at the bar's right end.
	 * Both places behave the same; only the button sizes differ.
	 */
	let { place = "bar", part = "both" }: { place?: "bar" | "header"; part?: "both" | "add" | "count" } = $props();

	const dir = $derived(app.tabDir);
	const path = $derived(dir?.path ?? app.workdirAbs);
	/** as many as the strip lists: a whole project's when its name was clicked */
	const count = $derived(app.stripDirs.reduce((k, d) => k + d.tabs.length, 0));
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
	{#if part !== "count"}<button
		class="add tap"
		class:on={menuId === "new"}
		onpointerenter={(e) => menu?.hover(e, "new", newItems())}
		onpointerleave={(e) => menu?.leave(e)}
		onclick={(e) => menu?.click(e, "new", newItems())}
		aria-label={t("새 대화 또는 터미널")}
		aria-haspopup="menu"
		title={t("이 폴더에서 새 대화 또는 터미널")}><Icon name="plus" /></button
	>{/if}
	{#if count && part !== "add"}<TabCountButton {count} {place} />{/if}
	{#if part !== "add" && !app.graphOpen && workspaceViewer.sessionId}
		<button
			class="add files tap"
			class:on={app.filesOpen}
			onclick={() => app.toggleFiles()}
			aria-label={t("파일 뷰어")}
			aria-pressed={app.filesOpen}
			title={t("파일 뷰어 (현재 폴더 · 실시간 변경 확인)")}
		>
			<Icon name="folder" />
			{#if workspaceViewer.changes.length > 0}<span class="fdot" aria-hidden="true"></span>{/if}
		</button>
	{/if}
</div>
<RowMenu bind:this={menu} bind:open={menuId} />

<style>
	.ctl {
		flex: none;
		display: flex;
		align-items: center;
		gap: 4px;
	}
	/* the header's buttons already leave room around their glyphs: no gap, and both 28px wide (below and TabCountButton)
	   instead of 32, so the "+" ink and the count's square stand 12px apart and read as one pair rather than two loose icons */
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
	/* the header's tool buttons: 28 wide, 40 tall, round, a 19px glyph (Header.svelte `.tool` on a phone) */
	.header .add {
		width: 28px;
		height: 40px;
		border-radius: min(var(--radius-pill), 14px); /* a pill, 28 x 40: a circle would leave the 40px height unrounded; a theme's --radius-pill squares it */
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
	.files {
		position: relative;
	}
	.fdot {
		position: absolute;
		top: 4px;
		right: 4px;
		width: 6px; /* optical 6px indicator matching tab/tree change dots */
		height: 6px; /* optical 6px indicator matching tab/tree change dots */
		border-radius: var(--radius-pill);
		background: var(--warn);
		pointer-events: none;
	}
	.header .fdot {
		top: 10px;
		right: 4px;
	}
</style>
