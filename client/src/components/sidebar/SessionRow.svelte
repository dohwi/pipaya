<script lang="ts">
	import { extensions } from "../../lib/extensions/host.svelte";
	import { ACTIVITY_LABEL } from "../../lib/activity";
	import { t } from "../../lib/i18n";
	import { peerLabel } from "../../lib/peers";
	import type { DropOpts } from "../../lib/dnd.svelte";
	import { getSidebarCtx, type SidebarNode } from "../../lib/sidebar-ctx";
	import type { Session } from "../../lib/types";
	import AgentBadge from "../AgentBadge.svelte";
	import RowTitle from "./RowTitle.svelte";
	import TabRow from "./TabRow.svelte";

	/** A conversation: the model's logo (it takes the state colour and a dot while working, asking, done or failed), an extension's label, its title. */
	let { n, x, drop, member = false }: { n: SidebarNode; x: Session; drop: DropOpts; member?: boolean } = $props();

	const sb = getSidebarCtx();
	const st = $derived(sb.stateOf(n, x));
	const label = $derived(peerLabel(x) ?? extensions.labelOf(x.id));
	const tip = $derived([label?.title ?? "", x.title, st !== "idle" ? ACTIVITY_LABEL[st] : "", x.parentId ? t("분기된 대화") : ""].filter(Boolean).join(" · "));
</script>

{#snippet body()}
	<span class="lead"><AgentBadge id={x.id} server={n.server.id} state={st} size={16} /></span>
	<span class="who mono {st}" title={label?.text}>{label?.text ?? ""}</span>
	<RowTitle text={x.title} />
{/snippet}

<TabRow {n} {x} target={{ kind: "session", x }} {tip} {drop} {member} {body} />
