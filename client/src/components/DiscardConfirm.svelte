<script lang="ts">
	import { t } from "../lib/i18n";
	import Icon from "./Icon.svelte";
	import Modal from "./Modal.svelte";

	/**
	 * "Close without saving?" sheet for a dialog with unsaved edits: save, keep editing, or discard.
	 * Saving is the default answer and gets focus (Modal keeps a child's own focus).
	 */
	let { onsave, oncancel, ondiscard }: { onsave: () => void; oncancel: () => void; ondiscard: () => void } = $props();

	const focusMe = (node: HTMLElement) => node.focus();
</script>

<Modal onclose={oncancel} role="alertdialog" labelledby="unsaved-title" describedby="unsaved-desc" width="s" layer={5} portal>
	<div class="uc">
		<span class="ucmark"><Icon name="alert" /></span>
		<h3 id="unsaved-title">{t("저장하지 않고 닫을까요?")}</h3>
		<p id="unsaved-desc">{t("저장되지 않은 변경이 있습니다.")}</p>
		<div class="ucbtns">
			<button type="button" class="btn primary" onclick={onsave} use:focusMe>{t("저장")}</button>
			<button type="button" class="btn" onclick={oncancel}>{t("계속 편집")}</button>
			<button type="button" class="btn ghost danger-text" onclick={ondiscard}>{t("저장하지 않고 닫기")}</button>
		</div>
	</div>
</Modal>

<style>
	.uc {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 6px;
		padding: 24px 20px calc(16px + var(--sab));
		text-align: center;
	}
	.ucmark {
		display: grid;
		place-items: center;
		width: 44px;
		height: 44px;
		margin-bottom: 6px;
		border-radius: 50%;
		background: var(--warn-soft);
		color: var(--warn);
	}
	.ucmark :global(svg) {

		width: 22px;

		height: 22px;

		stroke-width: 1.8;

	}
	h3 {
		margin: 0;
		font-size: var(--fs-lg);
	}
	p {
		margin: 0;
		color: var(--text-dim);
		font-size: var(--fs-sm);
	}
	.ucbtns {
		display: flex;
		flex-direction: column;
		gap: 8px;
		align-self: stretch;
		margin-top: 16px;
	}
	.ucbtns .btn {
		width: 100%;
	}
</style>
