<script lang="ts">
	import { collapseIn, collapseOut } from "../../../lib/motion";
	import { msg, t } from "../../../lib/i18n";
	import { app } from "../../../lib/store.svelte";
	import { ACTIVITY_LABEL, ACTIVITY_TONE, mostUrgent } from "../../../lib/activity";
	import { tabPanes } from "../../../lib/nav";
	import { unreachable } from "../../../lib/sidebar-model";
	import { getSidebarCtx, type SidebarNode } from "../../../lib/sidebar-ctx";
	import Icon from "../../ui/Icon.svelte";
	import DirBlockView from "./DirBlock.svelte";
	import ProjectBlock from "./ProjectBlock.svelte";
	import ListButton from "./ListButton.svelte";
	import NewButton from "./NewButton.svelte";
	import { skeletonGate } from "../../../lib/skeleton-gate.svelte";

	/**
	 * One server's band in the sidebar: its header (fold, status, name, the conversation list and "+") and the folders under it.
	 * The header can be dragged to reorder servers (`single`: there is nothing to reorder).
	 */
	let { n, single }: { n: SidebarNode; single: boolean } = $props();

	const sb = getSidebarCtx();
	const statusText = { online: "", offline: msg("연결 안 됨"), unauthorized: msg("토큰 거부됨"), incompatible: msg("앱 업데이트 필요"), checking: msg("확인 중") };
	/** Cannot be read: the header stays but is locked, folded and dimmed (the sidebar also lists it last) */
	const off = $derived(unreachable(n.state));
	const sfold = $derived(off || sb.isFolded(n.server.id));
	/** The most urgent state among the server's conversations: tints the count while folded */
	const sstate = $derived(sfold ? mostUrgent(n.dirs.flatMap((d) => d.tabs.flatMap((x) => tabPanes(x))).map((id) => sb.stateOfId(n, id))) : "idle");
	const srvMark = $derived(sb.marks.blockMark(`server:${n.server.id}`));
	/** The bones stay a moment once they were seen, so a list that lands just after they appeared does not flash them */
	const sk = skeletonGate(() => !n.loaded);
	/**
	 * Rows as they were at the last visit: per entry its header and the rows that were open under it (`shape`, capped).
	 * Folders start folded, so a device that never saw the server draws three folder rows.
	 */
	const BONE_W = [128, 88, 112, 72];
	const bones = $derived((app.links[n.server.id]?.shape ?? [1, 1, 1]).map((rows, d) => ({ dir: [96, 80, 112][d] ?? 96, tabs: BONE_W.slice(0, rows - 1) })));
</script>

	<section class="srv band" data-block={`server:${n.server.id}`} data-server="" class:carried={srvMark.carried} class:before={srvMark.before} class:after={srvMark.after} class:cur={n.current} class:off class:stale={n.stale && !off}>
		<div class="srvhead grabbable" class:folded={sfold} use:sb.dirSource={{ kind: "server", serverId: "", path: n.server.id, paths: [], disabled: single || off || Boolean(n.server.local), menu: (pt) => sb.headMenuAt(pt, n, null, n.server.id) }}>
			<button class="srvtoggle" disabled={off} onclick={() => app.sidebar.toggleFolded(n.server.id)} aria-expanded={!sfold} title={(n.state === "online" ? "" : `${t(statusText[n.state])}\n`) + (n.root ? `${n.server.baseUrl}\n${n.root}` : n.server.baseUrl)}>
				<span class="chev" class:folded={sfold}><Icon name="chevron-down" /></span>
				<span class="sicon {n.state}"><Icon name="server" /></span>
				<span class="sname">{app.serverLabel(n.server)}</span>
				{#if off}<span class="sstat {n.state}">{t(statusText[n.state])}</span>{/if}
				{#if sfold && !off && (n.state === "online" || n.loaded)}<span class="cbadge tint {ACTIVITY_TONE[sstate]}" title={t("{n}개", { n: n.total }) + (sstate !== "idle" ? ` · ${ACTIVITY_LABEL[sstate]}` : "")}>{n.total}</span>{/if}
			</button>
			{#if !off}
				<ListButton serverId={n.server.id} name={t("대화 목록 관리")} tip={t("대화 목록 관리 (닫기·삭제)")} />
				<NewButton {n} workdir="." key={n.server.id} name={app.serverLabel(n.server)} tip={t("이 서버에서 새 대화 또는 터미널")} />
			{/if}
		</div>

		{#if !sfold}
		<div class="fold" class:skeleton-out={sk.revealed} in:collapseIn out:collapseOut>
			{#if sk.showing}
				<!-- folders and tabs as bones on the sidebar's columns (folder icon 48, titles from x 80), 32px rows like the real ones -->
				<div class="sklist skeleton-in" aria-busy="true" aria-label={t("불러오는 중…")}>
					{#each bones as b, d (d)}
						<div class="skrow skdir"><i class="skeleton-bar skbar" style:width="{b.dir + 20}px"></i></div>
						{#each b.tabs as w, i (i)}
							<div class="skrow sktab"><i class="skeleton-bar skbar" style:width="{w}px" style:--sk-i={d * 2 + i + 1}></i></div>
						{/each}
					{/each}
				</div>
			{:else if n.total === 0}
				{#if n.dirs.length === 0}
					<div class="nosess">{t("활성 대화 없음")}</div>
				{/if}
			{/if}

			{#if !sk.showing}
				{#each n.blocks as b (b.kind === "dir" ? b.dir.path : `project:${b.root}`)}
					{#if b.kind === "dir"}
						<DirBlockView {n} d={b.dir} />
					{:else}
						<ProjectBlock {n} root={b.root} dirs={b.dirs} />
					{/if}
				{/each}
			{/if}
		</div>
		{/if}
	</section>

<style>

	/* one full-bleed band per server: a tone step instead of a card, so no space is lost to a frame. The inner 8px keeps every row where it was */
	.srv {
		position: relative;
		padding: 0 12px 4px 8px; /* inside the card the first column starts 12 from its left edge (8 here + the toggle's 4) and the last ends 12 from its right edge (12 here), so both sides match */
	}
	/* where a carried server would land: a line in the gap beside its card */
	:global(:where(.side) .srv.before::before),
	:global(:where(.side) .srv.after::after) {
		left: 0;
		right: 0;
	}
	:global(:where(.side) .srv.before::before) {
		top: -5px;
	}
	:global(:where(.side) .srv.after::after) {
		bottom: -5px;
	}
	:global(:where(.side) .srv:has(> .fold)) {
		padding-bottom: 4px; /* a card ends 4px under its last row (the row's own 1px margin makes it 5): the same 4 as its top */
	}
	/* every server sits in a band, even when it is the only one */
	.srv.band {
		margin: 0 8px;
		background: var(--band);
		border: 1px solid color-mix(in srgb, var(--text) 8%, transparent);
		border-radius: var(--radius);
	}
	:global(:where(.side) .srv.band + .srv.band) {
		margin-top: 8px;
	}
	/* the rows are the copy kept from the last visit: drawn at once, a step quieter until the server confirms them */
	.srv.stale > .fold {
		color: var(--text-dim);
	}
	.srv > .fold {
		transition: opacity var(--motion-fast) var(--ease-std);
	}
	/* unreachable: the header steps its name down a colour and is locked. Fading the whole strip to 0.55 took the name to
	   2.6:1 and the red icon to 2.3:1 on the band, so it read as half gone rather than "down"; the icon's colour still says why */
	:global(:where(.side) .srv.off .sname) {
		font-weight: 500;
	}
	.srvtoggle:disabled {
		cursor: default;
	}
	/* several servers: the folders hang under their server: the folder icon sits under its status dot and the name under the server name; the right edge stays put, so every "+" keeps one column */
	:global(:where(.side) .srv > .fold) {
		padding-left: 0;
	}
	.srvhead {
		display: flex;
		align-items: center;
		margin: 0 -12px 4px -8px; /* header strip spanning the card: a darker tone marks everything below as belonging to this server */
		padding: 0 12px 0 8px;
		box-shadow: inset 0 -1px 0 color-mix(in srgb, var(--text) 8%, transparent); /* open: one hairline under the header instead of a darker strip (a shadow, so the row stays 32px) */
		border-radius: max(0px, var(--radius) - 1px) max(0px, var(--radius) - 1px) 0 0; /* the card's corners (--radius), minus its 1px border */
	}
	.srvhead:last-child {
		box-shadow: none;
		border-radius: max(0px, var(--radius) - 1px); /* the card's corners, minus its 1px border */
		margin-bottom: 0;
	}
	.srv:has(> .srvhead:last-child) {
		padding-bottom: 0; /* folded: the header is the whole card, no band strip under it */
	}
	@media (hover: hover) {
		.srvhead:global([data-hovered]) {
			background: color-mix(in srgb, var(--text) 6%, var(--bg-side));
		}
	}
	/* pressing the name or the "+" darkens the whole strip one more step; the global row tint (a lighter square inside the strip) is switched off here */
	.srvhead:has(.srvtoggle:active),
	:global(:where(.side) .srvhead:has(.dirnew:active)) {
		background: color-mix(in srgb, var(--text) 9%, var(--bg-side));
	}
	.srvhead .srvtoggle:active:not(:disabled) {
		background-color: transparent;
	}
	:global(:where(.side) .srvhead .dirnew.on) {
		background: color-mix(in srgb, var(--text) 15%, var(--bg-side));
	}
	@media (hover: hover) {
		:global(:where(.side) .srvhead .dirnew[data-hovered]) {
			background: color-mix(in srgb, var(--text) 15%, var(--bg-side));
		}
	}
	.srvtoggle {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: 6px; /* alignment, not spacing: the same column step as .dirtoggle (chevron 14 + 6 = 20) */
		height: 32px;
		padding: 0 4px 0 4px; /* chevron and icon sit in the folder rows' columns (same 4px as .dirtoggle) */
		text-align: left;
		color: var(--text-dim);
	}
	@media (pointer: coarse) {
		.srvtoggle {
			height: 40px; /* touch rows are 40px, like .dirtoggle */
		}
	}
	/* folded: the list button is hidden, so the toggle runs to the "+" and its count takes that column (x 256 on a mouse, where the
	   "+" leaves the flow; x 236 on touch, where the "+" keeps x 256) — measured, both on the grid */
	:global(:where(.side) .srvhead.folded .srvtoggle) {
		padding-right: 0;
	}
	:global(:where(.side) .srv.cur .srvtoggle) {
		color: var(--text);
	}
	/* after .cur: the open server can be the unreachable one */
	:global(:where(.side) .srv.off .srvtoggle) {
		color: var(--text-faint);
	}
	/* the icon takes the folder-icon column, so the name lines up with the directory names */
	.sicon {
		position: relative;
		display: grid;
		flex: none;
		width: 14px;
		height: 14px;
		color: var(--text-faint);
	}
	/* the status is the server icon's colour, and only a problem gets one: online stays faint (no news), red offline, amber needs
	   attention, blinking while checking. A problem also says itself in words after the name (.sstat), so colour is never the only cue */
	.sicon.online {
		color: var(--text-faint);
	}
	.sicon.offline {
		color: var(--danger);
	}
	.sicon.unauthorized,
	.sicon.incompatible {
		color: var(--warn);
	}
	.sicon.checking {
		animation: blink-cursor 1s ease-in-out infinite;
	}
	.sname {
		flex: 0 1 auto;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: var(--fs-md);
		font-weight: 600;
	}
	.sstat {
		flex: none;
		margin-left: 4px;
		font-size: var(--fs-2xs);
		font-weight: 600;
		line-height: 16px; /* whole-pixel line box, centred on the name like the handle (ui/Handle) */
		white-space: nowrap;
	}
	.sstat.offline {
		color: var(--danger);
	}
	.sstat.unauthorized,
	.sstat.incompatible {
		color: var(--warn);
	}
	.nosess {
		padding: 4px 8px 4px 48px;
		font-size: var(--fs-xs);
		line-height: 20px; /* whole-pixel row (the body's 1.55 gave 26.59 and a 68.59px server card) */
		color: var(--text-faint);
	}
	.skrow {
		display: flex;
		align-items: center;
		height: 32px;
		margin: 1px 0; /* rows sit 1px apart, like .item */
	}
	.skdir {
		margin-top: 4px; /* folded folders sit 4 apart, like .dir */
		padding-left: 24px; /* the bone starts where the folder glyph does (.dirtoggle's 4 + the chevron's 14 + 6) and covers its name too */
	}
	.skdir:first-child {
		margin-top: 4px; /* the folder sits 4 under the header, like .dirblock:first-child > .dir */
	}
	@media (pointer: coarse) {
		.skrow {
			height: 40px; /* touch rows are 40px, like .dirtoggle and .item */
		}
	}
	.sktab {
		padding-left: 63px; /* the bone starts where a row's text does, after its icon (x 80: .item 4 + .open 39 + the 16px lead + its 4 gap, measured) */
	}
	/* one blunt block per row (a folder's glyph and name are a single bone), thick enough to read as a row, not a hairline */
	.skbar {
		height: 16px;
		max-width: 100%;
	}
	.sicon :global(svg) {
		width: 14px;
		height: 14px;
		stroke-width: 1.9;
	}
	/* a block being dragged fades */
	.srv.carried {
		opacity: 0.45;
	}
	.srvhead.grabbable {
		cursor: grab;
		-webkit-user-select: none;
		user-select: none;
		-webkit-touch-callout: none;
	}
	@media (hover: hover) {
	.srvhead.folded {
		position: relative;
	}
	:global(:where(.side) .srvhead.folded .dirnew) {
		position: absolute;
		top: 50%;
		translate: 0 -50%;
	}
	:global(:where(.side) .srvhead.folded .dirnew) {
		right: 12px; /* the strip's right padding: the same centre (x 256) */
	}
	.srvhead.folded .cbadge {
		transition: opacity var(--motion-fast) var(--ease-std);
	}
	.srvhead.folded:global([data-hovered]) .cbadge,
	.srvhead.folded:has(:global(.dirnew.on)) .cbadge {
		opacity: 0;
	}
	}
</style>
