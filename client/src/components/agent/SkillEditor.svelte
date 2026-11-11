<script lang="ts">
	import Button from "../ui/Button.svelte";
	import DialogBody from "../ui/DialogBody.svelte";
	import FormField from "../ui/FormField.svelte";
	import Modal from "../ui/Modal.svelte";
	import Notice from "../ui/Notice.svelte";
	import Switch from "../ui/Switch.svelte";
	import { errorText, type Api } from "../../lib/api";
	import { t } from "../../lib/i18n";
	import type { SkillList, SkillSource } from "../../lib/types";

	/**
	 * Edits one skill's SKILL.md: the description the model reads to decide when to use it, whether it is manual-only
	 * (`disable-model-invocation`) and the instructions. The name and the other frontmatter keys are left as they are.
	 */
	let { source, cwd, api, onsaved, onclose }: { source: SkillSource; cwd: string; api: Api; onsaved: (list: SkillList) => void; onclose: () => void } = $props();

	// svelte-ignore state_referenced_locally
	let description = $state(source.description);
	// svelte-ignore state_referenced_locally
	let manualOnly = $state(source.manualOnly);
	// svelte-ignore state_referenced_locally
	let body = $state(source.body);
	let busy = $state(false);
	let error = $state("");

	async function submit(e: Event) {
		e.preventDefault();
		if (busy) return;
		busy = true;
		error = "";
		try {
			onsaved(await api.saveSkill(source.name, { description, manualOnly, body, cwd }));
			onclose();
		} catch (e) {
			error = errorText(e);
		} finally {
			busy = false;
		}
	}
	const home = (p: string) => p.replace(/^\/home\/[^/]+/, "~");
</script>

<Modal {onclose} title={source.name} sub={home(source.path)} width="xl" maxHeight="760px" safeArea layer={2}>
	<DialogBody>
		<form class="form" onsubmit={submit}>
			{#if error}<Notice tone="warn">{error}</Notice>{/if}
			<FormField label={t("설명")} hint={t("에이전트가 이 스킬을 언제 쓸지 판단하는 근거입니다. 무엇을 하고 언제 쓰는지 적으세요.")}>
				<textarea class="field area" bind:value={description} rows="3" maxlength="1024" required></textarea>
			</FormField>
			<FormField label={t("자동 호출")} group hint={manualOnly ? t("에이전트는 이 스킬을 모릅니다. /skill:이름 으로 직접 부를 때만 쓰입니다.") : t("에이전트가 필요할 때 스스로 읽어 씁니다.")}>
				<Switch checked={!manualOnly} disabled={busy} onchange={(on) => (manualOnly = !on)} label={t("자동 호출")} />
			</FormField>
			<FormField label={t("지침")}>
				<textarea class="field mono area" bind:value={body} rows="14" spellcheck="false"></textarea>
			</FormField>
			{#if source.extraFiles}<p class="hint">{t("이 스킬 폴더에는 파일 {n}개가 더 있습니다. 여기서는 SKILL.md만 고칩니다.", { n: source.extraFiles })}</p>{/if}
			<div class="actions">
				<Button onclick={onclose} disabled={busy}>{t("취소")}</Button>
				<Button variant="primary" type="submit" disabled={busy}>{t("저장")}</Button>
			</div>
		</form>
	</DialogBody>
</Modal>

<style>
	.form { display: flex; flex-direction: column; gap: var(--dlg-gap); }
	.hint { margin: 0; font-size: var(--fs-xs); line-height: 1.5; color: var(--text-faint); }
	.area { height: auto; padding: 8px 12px; resize: vertical; font-size: var(--fs-sm); line-height: 1.5; }
	.actions { display: flex; justify-content: flex-end; gap: 8px; }
</style>
