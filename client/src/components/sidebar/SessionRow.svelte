<script lang="ts">
	import { sessionTitle } from "../../lib/session-title";
	import { extensions } from "../../lib/extensions/host.svelte";
	import { ACTIVITY_LABEL } from "../../lib/activity";
	import { t } from "../../lib/i18n";
	import { peerLabel } from "../../lib/peers";
	import type { DropOpts } from "../../lib/dnd.svelte";
	import { getSidebarCtx, type SidebarNode } from "../../lib/sidebar-ctx";
	import type { Session } from "../../lib/types";
	import Icon from "../Icon.svelte";
	import PinMark from "../PinMark.svelte";
	import AgentBadge from "../AgentBadge.svelte";
	import RowTitle from "./RowTitle.svelte";
	import TabRow from "./TabRow.svelte";

	/** A conversation: the model's logo (it takes the state colour and a dot while working, asking, done or failed), an extension's label, its title. */
	let { n, x, drop, member = false }: { n: SidebarNode; x: Session; drop: DropOpts; member?: boolean } = $props();

	const sb = getSidebarCtx();
	const st = $derived(sb.stateOf(n, x));
	const label = $derived(peerLabel(x) ?? extensions.labelOf(x.id));
	const tip = $derived([label?.title ?? "", sessionTitle(x.title), st !== "idle" ? ACTIVITY_LABEL[st] : "", x.parentId ? t("분기된 대화") : "", x.muted ? t("알림 꺼짐") : ""].filter(Boolean).join(" · "));
</script>

{#snippet body(pinned: boolean)}
	<span class="lead"><AgentBadge id={x.id} server={n.server.id} state={st} size={16} />{#if pinned}<PinMark />{/if}</span>
	{#if label}<span class="who mono {st}">{label.text}</span>{/if}
	<RowTitle text={sessionTitle(x.title)} />
{/snippet}

{#snippet trail()}
	{#if x.muted}<span class="mutemark" title={t("알림 꺼짐")}><Icon name="bell-off" /></span>{/if}
{/snippet}

<TabRow {n} {x} target={{ kind: "session", x }} {tip} {drop} {member} {body} {trail} />

<style>
	/* a 20px box like the "more" button beside it, so it centres on the list-button column (x 236); Sidebar.svelte keeps that button's box reserved */
	.mutemark {
		flex: none;
		display: grid;
		place-items: center;
		width: 20px;
		height: 20px;
		font-size: 16px;
		color: var(--text-faint);
	}
</style>
