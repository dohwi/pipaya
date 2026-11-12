<script lang="ts">
	import DialogBody from "../ui/DialogBody.svelte";
	import Modal from "../ui/Modal.svelte";
	import SchedulesPane from "../settings/SchedulesPane.svelte";
	import { t } from "../../lib/i18n";

	/** The scheduled tasks of one server in a window of their own (opened from the sidebar); the same list and form as in settings. */
	let { serverId, onclose }: { serverId: string; onclose: () => void } = $props();
</script>

<Modal {onclose} title={t("예약 작업")} width="xl" maxHeight="760px" safeArea>
	<DialogBody><SchedulesPane {serverId} /></DialogBody>
</Modal>
