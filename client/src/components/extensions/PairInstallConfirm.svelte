<script lang="ts">
	import Button from "../Button.svelte";
	import Icon from "../Icon.svelte";
	import Modal from "../Modal.svelte";
	import { t } from "../../lib/i18n";

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

<Modal onclose={oncancel} role="alertdialog" labelledby="pair-title" describedby="pair-desc" width="s" layer={4} portal>
	<div class="pc">
		<span class="mark"><Icon name="clip" /></span>
		<h3 id="pair-title">{t("함께 설치할까요?")}</h3>
		<p id="pair-desc">{t("이 두 확장은 짝으로 작동합니다. 한쪽만 있으면 동작하지 않습니다.")}</p>
		<ul class="rows">
			<li><span class="k">{kindLabel(picked.kind)}</span><strong>{picked.name}</strong></li>
			<li><span class="k">{kindLabel(other.kind)}</span><strong>{other.name}</strong></li>
		</ul>
		<div class="btns">
			<Button variant="primary" onclick={onboth} focus>{t("함께 설치")}</Button>
			<Button onclick={onsolo}>{t("{kind}만 설치", { kind: kindLabel(picked.kind) })}</Button>
			<Button variant="ghost" onclick={oncancel}>{t("취소")}</Button>
		</div>
	</div>
</Modal>

<style>
	.pc { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 24px 20px calc(16px + var(--sab)); text-align: center; }
	.mark { display: grid; place-items: center; width: 44px; height: 44px; margin-bottom: 6px; border-radius: 50%; background: var(--bg-elev); border: 1px solid var(--border); color: var(--text-dim); }
	.mark :global(svg) { width: 22px; height: 22px; stroke-width: 1.8; }
	h3 { margin: 0; font-size: var(--fs-lg); }
	p { margin: 0; color: var(--text-dim); font-size: var(--fs-sm); }
	.rows { list-style: none; margin: 12px 0 0; padding: 0; align-self: stretch; display: flex; flex-direction: column; gap: 6px; }
	.rows li { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 8px 12px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--bg-elev); font-size: var(--fs-sm); }
	.k { color: var(--text-faint); font-size: var(--fs-xs); }
	.btns { display: flex; flex-direction: column; gap: 8px; align-self: stretch; margin-top: 16px; }
	.btns :global(.btn) { width: 100%; }
</style>
