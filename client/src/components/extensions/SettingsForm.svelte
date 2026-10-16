<script lang="ts">
	import { t } from "../../lib/i18n";
	import { untrack } from "svelte";
	import Accordion from "../Accordion.svelte";
	import Select from "../Select.svelte";
	import { describeSettingErrors, fillSettingDefaults, resolveSettings, type SettingField } from "../../lib/extensions/schema";

	interface Props {
		id: string;
		fields: SettingField[];
		/** Saved settings of the extension (defaults are applied for display). */
		value: Record<string, unknown>;
		disabled?: boolean;
		saveLabel: string;
		/** Throws a user-facing error when the host refuses the values. */
		onsave: (settings: Record<string, unknown>) => void;
	}
	let { id, fields, value, disabled = false, saveLabel, onsave }: Props = $props();

	const clone = (input: Record<string, unknown>): Record<string, unknown> => JSON.parse(JSON.stringify(input));
	const saved = $derived(fillSettingDefaults(fields, value));
	const signature = $derived(JSON.stringify(saved));
	let draft = $state<Record<string, unknown>>(untrack(() => clone(saved)));
	let jsonDraft = $state<string | null>(null);

	// Number inputs report an unset field as null/undefined; everything else is already the stored type.
	const clean = $derived.by(() => {
		const out: Record<string, unknown> = {};
		for (const field of fields) {
			const v = draft[field.key];
			if (v !== null && v !== undefined) out[field.key] = v;
		}
		return out;
	});
	const resolved = $derived(resolveSettings(fields, clean));
	const dirty = $derived(JSON.stringify(clean) !== signature);

	// Follow saves and server syncs, but never overwrite what the user is typing.
	$effect(() => {
		signature;
		untrack(() => { if (!dirty) draft = clone(saved); });
	});

	const jsonText = $derived(jsonDraft ?? JSON.stringify(value, null, 2));
	const jsonProblem = $derived.by(() => {
		if (jsonDraft === null) return "";
		let parsed: unknown;
		try { parsed = JSON.parse(jsonDraft); } catch { return t("JSON 형식이 올바르지 않습니다."); }
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return t("JSON 객체만 저장할 수 있습니다.");
		const result = resolveSettings(fields, parsed);
		return result.ok ? "" : describeSettingErrors(fields, result.errors, 5);
	});

	const fieldId = (key: string) => `ext-set-${id}-${key}`;
	const errorId = (key: string) => `${fieldId(key)}-error`;
	const hintId = (key: string) => `${fieldId(key)}-hint`;
	const describedBy = (field: SettingField) =>
		[field.description ? hintId(field.key) : "", resolved.errors[field.key] ? errorId(field.key) : ""].filter(Boolean).join(" ") || undefined;

	function saveForm(event: SubmitEvent) {
		event.preventDefault();
		if (!resolved.ok) return;
		onsave({ ...clean });
		jsonDraft = null;
	}
	function saveJson() {
		if (jsonDraft === null || jsonProblem) return;
		onsave(JSON.parse(jsonDraft) as Record<string, unknown>);
		jsonDraft = null;
	}
</script>

<form class="settings" novalidate onsubmit={saveForm}>
	{#each fields as field (field.key)}
		{@const error = resolved.errors[field.key]}
		<div class="field-row" class:invalid={!!error}>
			{#if field.type === "boolean"}
				<label class="check" for={fieldId(field.key)}>
					<input id={fieldId(field.key)} type="checkbox" checked={draft[field.key] === true} {disabled} aria-invalid={error ? "true" : undefined} aria-describedby={describedBy(field)} onchange={(event) => { draft[field.key] = event.currentTarget.checked; }} />
					<span class="name">{field.label}{#if field.required}<span class="req" aria-hidden="true"> *</span>{/if}</span>
				</label>
			{:else}
				<label class="name" for={fieldId(field.key)}>{field.label}{#if field.required}<span class="req" aria-hidden="true"> *</span><span class="sr-only"> ({t("필수")})</span>{/if}</label>
				{#if field.type === "select"}
					<Select
						id={fieldId(field.key)}
						{disabled}
						required={field.required}
						invalid={!!error}
						describedby={describedBy(field)}
						value={typeof draft[field.key] === "string" ? draft[field.key] as string : ""}
						onchange={(value) => { draft[field.key] = value; }}
						options={[
							...(!field.required && field.default === undefined ? [{ value: "", label: t("선택 안 함") }] : typeof draft[field.key] !== "string" || draft[field.key] === "" ? [{ value: "", label: t("선택하세요"), disabled: true }] : []),
							...(field.options ?? []),
						]}
					/>
				{:else if field.type === "number"}
					<input id={fieldId(field.key)} type="number" inputmode="decimal" step="any" min={field.min} max={field.max} placeholder={field.placeholder} {disabled} aria-required={field.required ? "true" : undefined} aria-invalid={error ? "true" : undefined} aria-describedby={describedBy(field)} value={typeof draft[field.key] === "number" ? draft[field.key] as number : ""} oninput={(event) => { const el = event.currentTarget; draft[field.key] = el.value === "" ? null : el.valueAsNumber; }} />
				{:else}
					<input id={fieldId(field.key)} type={field.secret ? "password" : "text"} autocomplete="off" autocapitalize="off" spellcheck="false" inputmode={field.format === "origin" ? "url" : undefined} placeholder={field.placeholder} {disabled} aria-required={field.required ? "true" : undefined} aria-invalid={error ? "true" : undefined} aria-describedby={describedBy(field)} value={typeof draft[field.key] === "string" ? draft[field.key] as string : ""} oninput={(event) => { draft[field.key] = event.currentTarget.value; }} />
				{/if}
			{/if}
			{#if field.description}<p class="hint" id={hintId(field.key)}>{field.description}</p>{/if}
			{#if error}<p class="error" id={errorId(field.key)}>{error}</p>{/if}
		</div>
	{/each}
	<p class="hint">{t("저장 위치는 확장의 settingsScope를 따릅니다. 활성 확장은 다시 불러와 적용하고, 비활성 확장은 다음 활성화 때 적용합니다.")}</p>
	<div class="row">
		<button type="submit" class="btn sm" disabled={disabled || !resolved.ok}>{saveLabel}</button>
		{#if !resolved.ok}<span class="hint" role="status">{t("입력값을 확인하세요.")}</span>{/if}
	</div>
</form>

<div class="advanced">
<Accordion>
	{#snippet head()}{t("고급: JSON 직접 편집")}{/snippet}
	<div class="body">
		<label class="name" for={fieldId("$json")}>{t("설정 JSON 객체")}</label>
		<textarea id={fieldId("$json")} rows="6" spellcheck="false" value={jsonText} {disabled} aria-invalid={jsonProblem ? "true" : undefined} aria-describedby={jsonProblem ? `${fieldId("$json")}-error` : undefined} oninput={(event) => { jsonDraft = event.currentTarget.value; }}></textarea>
		{#if jsonProblem}<p class="error" id="{fieldId("$json")}-error">{jsonProblem}</p>{/if}
		<p class="hint">{t("같은 스키마로 검증하며, 선언되지 않은 키는 저장되지 않습니다 (최대 16KB).")}</p>
		<div class="row">
			<button type="button" class="btn sm" disabled={disabled || jsonDraft === null || !!jsonProblem} onclick={saveJson}>{t("JSON 저장")}</button>
		</div>
	</div>
</Accordion>
</div>

<style>
	.settings, .field-row, .body { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
	.settings { gap: 12px; }
	.row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
	.name { font-size: var(--fs-xs); font-weight: 550; overflow-wrap: anywhere; }
	.req { color: var(--danger); }
	.hint { margin: 0; font-size: var(--fs-xs); color: var(--text-faint); overflow-wrap: anywhere; }
	.error { margin: 0; font-size: var(--fs-xs); color: var(--danger); overflow-wrap: anywhere; }
	.check { display: flex; align-items: flex-start; gap: 10px; cursor: pointer; }
	.check input { flex: none; width: 17px; height: 17px; margin: 1px 0 0; accent-color: var(--text); }
	input[type="text"], input[type="password"], input[type="number"], textarea {
		display: block; width: 100%; min-width: 0; box-sizing: border-box; padding: 0 12px; height: 38px;
		border: 1px solid var(--border-strong); border-radius: var(--radius-sm); background: var(--bg-code); color: var(--text);
		font-size: var(--fs-lg); /* >=16px stops iOS zooming on focus */ transition: border-color var(--motion-fast) var(--ease-std), box-shadow var(--motion-fast) var(--ease-std);
	}
	textarea { height: auto; min-height: 110px; resize: vertical; padding: 10px 12px; font-family: var(--mono); font-size: var(--fs-xs); line-height: 1.5; }
	input:focus-visible, textarea:focus-visible { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
	.check input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; box-shadow: none; }
	.invalid input:not([type="checkbox"]), textarea[aria-invalid="true"] { border-color: var(--danger); }
	input:disabled, textarea:disabled { opacity: 0.6; }
	.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
	.btn.sm { height: auto; min-height: 34px; padding: 6px 12px; white-space: normal; }
	.advanced { margin-top: 4px; }
	.body { gap: 10px; }
	@media (max-width: 640px) {
		.row > .btn { flex: 1 1 auto; }
	}
</style>
