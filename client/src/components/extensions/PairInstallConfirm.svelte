<script lang="ts">
	import { t } from "../../lib/i18n";
	import ConfirmDialog from "../ConfirmDialog.svelte";

	/**
	 * "Install the other half too?" for a server + client pair. Both rows say which half is which; the answer is
	 * both, only the one that was picked, or nothing. Neutral on purpose: orange stays for "a half is missing".
	 */
	let { picked, other, onboth, onsolo, oncancel }: {
		picked: { name: string; kind: "server" | "client" };
		other: { name: string; kind: "server" | "client" };
		onboth: () => void;
		onsolo: () => void;
		oncancel: () => void;
	} = $props();

	const kindLabel = (k: "server" | "client") => (k === "server" ? t("서버 확장") : t("클라이언트 확장"));
</script>

<ConfirmDialog
	id="pair"
	icon="clip"
	tone="neutral"
	title={t("함께 설치할까요?")}
	description={t("이 두 확장은 짝으로 작동합니다. 한쪽만 있으면 동작하지 않습니다.")}
	{oncancel}
	actions={[
		{ label: t("함께 설치"), variant: "primary", onclick: onboth },
		{ label: t("{kind}만 설치", { kind: kindLabel(picked.kind) }), onclick: onsolo },
		{ label: t("취소"), variant: "ghost", onclick: oncancel },
	]}
>
	<ul class="rows">
		<li><span class="k">{kindLabel(picked.kind)}</span><strong>{picked.name}</strong></li>
		<li><span class="k">{kindLabel(other.kind)}</span><strong>{other.name}</strong></li>
	</ul>
</ConfirmDialog>

<style>
	.rows { list-style: none; margin: 12px 0 0; padding: 0; align-self: stretch; display: flex; flex-direction: column; gap: 6px; }
	.rows li { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 8px 12px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--bg-elev); font-size: var(--fs-sm); }
	.k { color: var(--text-faint); font-size: var(--fs-xs); }
</style>
