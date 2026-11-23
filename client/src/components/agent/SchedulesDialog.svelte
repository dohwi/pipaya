<script lang="ts">
	import DialogBody from "../ui/DialogBody.svelte";
	import Modal from "../ui/Modal.svelte";
	import SchedulesPane from "../settings/SchedulesPane.svelte";
	import { t } from "../../lib/i18n";
	import { app } from "../../lib/store.svelte";

	/** The scheduled tasks of one server in a window of their own (opened from the sidebar); the same list and form as in settings. */
	let { serverId, onclose }: { serverId: string; onclose: () => void } = $props();
	const server = $derived(app.servers.find((s) => s.id === serverId));
	/** `sub` = the server the tasks belong to, as in every list dialog (count and folder / server) */
	const sub = $derived(server ? app.serverLabel(server) : null);
</script>

<Modal {onclose} title={t("예약 작업")} {sub} width="xl" maxHeight="760px" safeArea>
	<DialogBody gap><SchedulesPane {serverId} /></DialogBody>
</Modal>
