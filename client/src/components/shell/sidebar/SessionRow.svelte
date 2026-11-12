<script lang="ts">
	import { sessionTitle } from "../../../lib/session-title";
	import { extensions } from "../../../lib/extensions/host.svelte";
	import { ACTIVITY_LABEL } from "../../../lib/activity";
	import { t } from "../../../lib/i18n";
	import { peerLabel } from "../../../lib/peers";
	import type { DropOpts } from "../../../lib/dnd.svelte";
	import { getSidebarCtx, type SidebarNode } from "../../../lib/sidebar-ctx";
	import type { Session } from "../../../lib/types";
	import { app } from "../../../lib/store.svelte";
	import { whenShort } from "../../../lib/schedules";
	import Icon from "../../ui/Icon.svelte";
	import PinMark from "../../ui/PinMark.svelte";
	import AgentBadge from "../AgentBadge.svelte";
	import RowTitle from "./RowTitle.svelte";
	import TabRow from "./TabRow.svelte";

	/** A conversation: the model's logo (it takes the state colour and a dot while working, asking, done or failed), an extension's label, its title. */
	let { n, x, drop, member = false }: { n: SidebarNode; x: Session; drop: DropOpts; member?: boolean } = $props();

	const sb = getSidebarCtx();
	const st = $derived(sb.stateOf(n, x));
	const label = $derived(peerLabel(x) ?? extensions.labelOf(x.id));
	const tip = $derived([label?.title ?? "", sessionTitle(x.title), st !== "idle" ? ACTIVITY_LABEL[st] : "", x.parentId ? t("분기된 대화") : ""].filter(Boolean).join(" · "));
	/** Switched-on scheduled tasks of this conversation. Only the open server's list is kept current, so only its rows show it. */
	const sched = $derived(n.current ? app.schedules.of(n.server.id, x.id) : { count: 0, next: null });
	const schedTip = $derived(sched.next === null ? t("예약 {n}개", { n: sched.count }) : `${t("예약 {n}개", { n: sched.count })} · ${t("다음 실행 {when}", { when: whenShort(sched.next) })}`);
</script>

{#snippet body(pinned: boolean)}
	<span class="lead"><AgentBadge id={x.id} server={n.server.id} state={st} size={16} />{#if pinned}<PinMark />{/if}</span>
	{#if label}<span class="who mono {st}">{label.text}</span>{/if}
	<RowTitle text={sessionTitle(x.title)} />
	{#if sched.count}<span class="clock" role="img" aria-label={schedTip} title={schedTip}><Icon name="clock" /></span>{/if}
{/snippet}

<TabRow {n} {x} target={{ kind: "session", x }} {tip} {drop} {member} {body} />

<style>
	/* After the title, which gives way first (it is the one that shrinks and gets the ellipsis). A 20px box like the "+" / "⋯" buttons, pulled
	   8px into the open button's padding so its glyph centres on the action column (x 256); on hover the "⋯" takes that column and the clock steps to the list button's (x 236). */
	.clock {
		display: grid;
		place-items: center;
		flex: none;
		width: 20px;
		height: 20px;
		margin-right: -8px; /* the open button's right padding: the box ends where the "⋯" button ends */
		color: var(--text-faint);
	}
	.clock :global(svg) {
		width: 13px;
		height: 13px;
		stroke-width: 2;
	}
	/* label of a pane in a split tab: kept in view while the pane scrolls */
	.who {
		flex: none;
		font-size: var(--fs-2xs);
		font-weight: 600;
		color: var(--text-faint);
		line-height: 16px; /* whole-pixel line box centred by the row; the handle's ink centre lands on the row's centre line, level with the title */
	}
	.who.working { color: var(--info); }
	.who.asking { color: var(--warn); }
	.who.done { color: var(--ok); }
	.who.failed { color: var(--danger); }
</style>
