<script lang="ts">
	import { msg, t } from "../../lib/i18n";
	import { collapseIn, collapseOut } from "../../lib/motion";
	import type { ApiFormat } from "../../lib/types";
	import type { Form } from "../../lib/connection-form";
	import Select from "../Select.svelte";
	import Switch from "../Switch.svelte";

	/**
	 * The connection's own settings: its name and id, the endpoint, the API format, whether a key is needed (and, for a
	 * new one, the key). Edits go straight into `form`; the id follows the name until the user types one (`onname`).
	 */
	let { form, onname }: { form: Form; onname: (name: string) => void } = $props();

	const formats: { id: ApiFormat; label: string }[] = [
		{ id: "openai-completions", label: msg("OpenAI 호환 (Chat Completions)") },
		{ id: "openai-responses", label: "OpenAI Responses" },
		{ id: "anthropic-messages", label: "Anthropic Messages" },
	];
</script>

<section class="fsec">
	<div class="section-label">{t("연결 정보")}</div>
	<div class="grid2">
		<label>
			<span>{t("이름")}</span>
			<input class="field" value={form.name} oninput={(e) => onname(e.currentTarget.value)} placeholder={t("예: 내 프록시")} autocomplete="off" />
		</label>
		<label>
			<span>ID</span>
			<input
				class="field mono"
				value={form.id}
				oninput={(e) => { form.id = e.currentTarget.value; form.idTouched = true; }}
				disabled={!form.isNew}
				placeholder="my-proxy"
				autocomplete="off"
				autocapitalize="off"
				spellcheck="false"
			/>
		</label>
	</div>
	<label>
		<span>Endpoint (Base URL)</span>
		<input class="field mono" bind:value={form.baseUrl} placeholder="https://host.example/v1" autocomplete="off" autocapitalize="off" spellcheck="false" inputmode="url" />
	</label>
	<label>
		<span>{t("API 형식")}</span>
		<Select value={form.api} onchange={(api) => { form.api = api; }} options={formats.map((f) => ({ value: f.id, label: t(f.label) }))} />
	</label>
	<div class="switchrow">
		<span class="swtext">
			<b id="auth-req-l">{t("API 키 필요")}</b>
			<small id="auth-req-d">{t("켜면 저장된 키가 있어야 이 연결의 모델을 쓸 수 있습니다")}</small>
		</span>
		<Switch checked={form.authRequired} label={t("API 키 필요")} describedby="auth-req-d" onchange={(on) => { form.authRequired = on; }} />
	</div>
	{#if form.isNew && form.authRequired}
		<label in:collapseIn out:collapseOut>
			<span>{t("API 키")}</span>
			<input class="field mono" type="password" bind:value={form.apiKey} placeholder={t("API 키")} autocomplete="off" autocapitalize="off" spellcheck="false" />
		</label>
	{/if}
	{#if form.isNew}<p class="hint note">{t("모델이 없어도 저장할 수 있습니다. 비워 두면 저장할 때 이 주소에서 모델 목록을 불러오고, 불러오지 못해도 연결은 저장됩니다.")}</p>{/if}
</section>

<style>
	label {
		display: flex;
		flex-direction: column;
		gap: 5px;
		min-width: 0;
	}
	label > span {
		font-size: var(--fs-xs);
		font-weight: 600;
		color: var(--text-dim);
	}
	.grid2 {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 10px;
	}
	.switchrow {
		display: flex;
		flex-direction: row;
		align-items: center;
		gap: 12px;
		padding: 10px 12px;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--bg-elev);
		justify-content: space-between;
	}
	.swtext {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}
	.swtext b {
		font-size: var(--fs-sm);
		font-weight: 600;
		color: var(--text);
	}
	.swtext small {
		font-size: var(--fs-xs);
		color: var(--text-faint);
	}
	.note {
		margin: 0;
	}
	.fsec {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}
	@media (max-width: 640px) {
		/* name/ID and model ID/display name stack; the two numbers stay side by side */
		.grid2 {
			grid-template-columns: 1fr;
		}
	}
</style>
