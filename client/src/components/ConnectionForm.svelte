<script lang="ts" module>
	export { localPresets, type LocalPreset } from "../lib/connection-form";
</script>

<script lang="ts">
	import { msg, t, tc } from "../lib/i18n";
	import { collapseIn, collapseOut } from "../lib/motion";
	import { sheetPull } from "../lib/sheet";
	import { errorText, type Api } from "../lib/api";
	import { indexCatalog } from "../lib/catalog-match";
	import Icon from "./Icon.svelte";
	import Modal from "./Modal.svelte";
	import DiscardConfirm from "./DiscardConfirm.svelte";
	import Switch from "./Switch.svelte";
	import Select from "./Select.svelte";
	import Badge from "./Badge.svelte";
	import IconPickerModal from "./IconPickerModal.svelte";
	import CatalogPickerModal from "./CatalogPickerModal.svelte";
	import ModelLogo from "./ModelLogo.svelte";
	import ModelPage from "./ModelPage.svelte";
	import { ICON_LABEL } from "../lib/brand";
	import { isImageIcon } from "../lib/model-icon-image";
	import type { ApiFormat, CatalogModel, CustomProvider } from "../lib/types";
	import { ALL_LEVELS, applyMatch, collectModels, formFromProvider, headerError, modelMeta, newForm, newRow, slug, snapshot, type Form, type LocalPreset, type Row } from "../lib/connection-form";

	/**
	 * The add / edit dialog for one custom (OpenAI- or Anthropic-compatible) connection: its address and format, and
	 * its models with their limits, capabilities and OpenRouter match. Opened by ModelConnections; `onsaved` runs after
	 * the server accepted it (the caller reloads), `onclose` when it is dismissed.
	 */
	let {
		api,
		start,
		onclose,
		onsaved,
	}: {
		api: () => Api | null;
		start: { kind: "new"; preset?: LocalPreset } | { kind: "edit"; provider: CustomProvider };
		onclose: () => void;
		onsaved: () => void;
	} = $props();

	let busy = $state(false);
	let formError = $state("");

	let form = $state<Form | null>(null);
	/** Index of the model whose details are open inside the dialog; null = the connection page. */
	let editing = $state<number | null>(null);
	let fresh = $state(false);

	const formats: { id: ApiFormat; label: string }[] = [
		{ id: "openai-completions", label: msg("OpenAI 호환 (Chat Completions)") },
		{ id: "openai-responses", label: "OpenAI Responses" },
		{ id: "anthropic-messages", label: "Anthropic Messages" },
	];

	/** Esc steps back from a model's page to the connection first; a second Esc closes the dialog. */
	function escape() {
		if (editing !== null) closeModel();
		else close();
	}

	/* ---------- OpenRouter catalog (autocomplete + match status) ---------- */

	let catalog = $state<CatalogModel[]>([]);
	let catalogLoaded = $state(false);
	let catalogPending: Promise<void> | null = null;
	function ensureCatalog(): Promise<void> {
		const a = api();
		if (!a || catalogLoaded) return Promise.resolve();
		catalogPending ??= a
			.catalog()
			.then((r) => {
				catalog = r.models;
				catalogLoaded = true;
			})
			.catch(() => {
				/* no catalog: everything stays manual */
			})
			.finally(() => {
				catalogPending = null;
			});
		return catalogPending;
	}

	/* ---------- upstream model list ---------- */

	let discovering = $state(false);
	let discoverNote = $state("");
	/** Fetch the upstream's own /models and add what is not listed yet. Fetched models keep their id fixed. */
	async function discover(): Promise<boolean> {
		const a = api();
		const f = form;
		if (!a || !f) return false;
		formError = "";
		discoverNote = "";
		if (!f.baseUrl.trim()) return void (formError = t("Endpoint URL을 입력하세요.")), false;
		discovering = true;
		try {
			const [res] = await Promise.all([a.discoverModels({ baseUrl: f.baseUrl.trim(), api: f.api, ...(f.isNew ? {} : { providerId: f.id }), ...(f.apiKey.trim() ? { apiKey: f.apiKey.trim() } : {}) }), ensureCatalog()]);
			f.rows = f.rows.filter((r) => r.id.trim() || r.name.trim());
			const have = new Set(f.rows.map((r) => r.id.trim()));
			let added = 0;
			for (const m of res.models) {
				if (have.has(m.id)) {
					const existing = f.rows.find((r) => r.id.trim() === m.id);
					if (existing) existing.fromUpstream = true;
					continue;
				}
				const row: Row = { ...newRow(), id: m.id, name: m.name ?? "", fromUpstream: true };
				const hit = matchOf(m.id);
				if (hit) applyMatch(row, hit);
				f.rows.push(row);
				added++;
			}
			discoverNote = added ? t("{n}개 모델을 불러왔습니다.", { n: added }) : t("새로 추가할 모델이 없습니다.");
			return true;
		} catch (e) {
			formError = errorText(e);
			return false;
		} finally {
			discovering = false;
		}
	}
	const index = $derived(indexCatalog(catalog));
	/** The catalog entry a model id resolves to, like the server does (lib/catalog-match.ts). */
	const matchOf = (id: string): CatalogModel | undefined => index.match(id);
	/** The catalog entry a row is matched to: the explicit choice, else the name match. null = manual. */
	const matchedOf = (r: Row): CatalogModel | null => {
		if (r.catalogId === null) return null;
		if (r.catalogId !== undefined) return index.byId(r.catalogId) ?? null;
		return matchOf(r.id) ?? null;
	};
	let matchFor = $state<number | null>(null);
	let iconFor = $state<number | null>(null);


	function begin(next: Form) {
		void ensureCatalog();
		formError = "";
		discoverNote = "";
		editing = null;
		form = next;
	}

	function openModel(i: number, isFresh = false) {
		formError = "";
		fresh = isFresh;
		editing = i;
	}
	function addModel() {
		if (!form) return;
		form.rows.push(newRow());
		openModel(form.rows.length - 1, true);
	}
	/** Back to the connection page; a just-added model that was left blank is dropped. */
	function closeModel() {
		if (form && editing !== null) {
			const r = form.rows[editing];
			if (fresh && r && !r.id.trim() && !r.name.trim()) form.rows.splice(editing, 1);
		}
		formError = "";
		fresh = false;
		editing = null;
	}
	function removeModel() {
		if (!form || editing === null) return;
		form.rows.splice(editing, 1);
		fresh = false;
		editing = null;
	}
	function onName(v: string) {
		if (!form) return;
		form.name = v;
		if (form.isNew && !form.idTouched) form.id = slug(v);
	}

	function submit(e: SubmitEvent) {
		e.preventDefault();
		void save();
	}

	/** Validate the form and build the models payload. An explicit save (`strict`) jumps to the model that needs fixing. */
	function collect(f: Form, strict: boolean) {
		const res = collectModels(f, strict, (r) => matchedOf(r)?.id, catalogLoaded);
		if ("error" in res && strict && res.at !== undefined) editing = res.at;
		return res;
	}

	/* ---------- unsaved changes ---------- */

	/** The form as the dialog opened it; closing with anything different asks first. */
	let initial = "";
	let confirmClose = $state(false);
	const dirty = () => !!form && snapshot(form) !== initial;

	/** A connection can be saved without models; a new one with none listed tries the upstream's list but never depends on it. */
	async function save() {
		const a = api();
		const f = form;
		if (!a || !f) return;
		if (editing !== null) return closeModel(); // Enter inside a model page just goes back
		formError = "";
		confirmClose = false;
		const invalid = headerError(f);
		if (invalid) return void (formError = invalid);
		// A new connection with no models yet tries to read them from its upstream; if that fails it is still saved, empty.
		if (!f.rows.some((r) => r.id.trim())) {
			busy = true;
			await discover();
			busy = false;
			formError = "";
		}
		f.rows = f.rows.filter((r) => r.id.trim() || r.name.trim());
		const res = collect(f, true);
		if ("error" in res) return void (formError = res.error);
		const out = res.out;
		busy = true;
		try {
			await a.saveCustomProvider(f.id, { name: f.name.trim(), baseUrl: f.baseUrl.trim(), api: f.api, authRequired: f.authRequired, models: out });
			if (f.isNew && f.authRequired && f.apiKey.trim()) {
				try {
					await a.setCredential(f.id, f.apiKey.trim());
				} catch (err) {
					// The connection exists now: stay in the dialog as an edit so the key can be added from the list.
					f.isNew = false;
					f.apiKey = "";
					formError = t("연결은 저장했지만 키를 저장하지 못했습니다: {error}", { error: errorText(err) });
					return;
				}
			}
			onsaved();
		} catch (err) {
			formError = errorText(err);
		} finally {
			busy = false;
		}
	}


	// svelte-ignore state_referenced_locally
	if (start.kind === "edit") begin(formFromProvider(start.provider));
	// svelte-ignore state_referenced_locally
	else begin(newForm(start.preset));
	// svelte-ignore state_referenced_locally
	if (form) initial = snapshot(form);
	/** Closing with unsaved edits asks first (save / discard / keep editing); `force` discards. */
	const close = (force = false) => {
		if (!force && !busy && dirty()) {
			confirmClose = true;
			return;
		}
		form = null;
		onclose();
	};
</script>

{#if form}
	<!-- nested inside another (transformed) modal, so lifted to <body> to stay fixed to the viewport -->
	<Modal onclose={() => close()} onescape={escape} dismissible={!busy} label={form.isNew ? t("연결 추가") : t("연결 수정")} width="l" maxHeight="760px" layer={4} portal>
		<form class="fform" onsubmit={submit}>
			<header use:sheetPull={{ onclose: () => !busy && close(), disabled: busy }}>
				{#if editing !== null}
					{@const r = form.rows[editing]}
					<button type="button" class="iconbtn back" onclick={closeModel} aria-label={t("연결로 돌아가기")}><Icon name="chevron-left" /></button>
					<div class="ftitle">
						<h3>{r?.name.trim() || r?.id.trim() || t("새 모델")}</h3>
						<span class="fsub">{t("모델 설정")}</span>
					</div>
				{:else}
					<div class="ftitle">
						<h3>{form.isNew ? t("연결 추가") : t("연결 수정")}</h3>
						{#if !form.isNew}<span class="mono fsub">{form.id}</span>{/if}
					</div>
				{/if}
				<button type="button" class="iconbtn" onclick={() => close()} aria-label={t("닫기")} disabled={busy}><Icon name="x" /></button>
			</header>

			<div class="fbody">
				{#if editing !== null}
					{@const r = form.rows[editing]}
					{#if r}
						<ModelPage {r} providerId={form.id} connection={api()?.connection} {catalogLoaded} matched={matchedOf(r)} {fresh} onpickmatch={() => (matchFor = editing)} onpickicon={() => (iconFor = editing)} onremove={removeModel} />
					{/if}
				{:else}
					<section class="fsec">
						<div class="mono-label">{t("연결 정보")}</div>
						<div class="grid2">
							<label>
								<span>{t("이름")}</span>
								<input class="field" value={form.name} oninput={(e) => onName(e.currentTarget.value)} placeholder={t("예: 내 프록시")} autocomplete="off" />
							</label>
							<label>
								<span>ID</span>
								<input
									class="field mono"
									value={form.id}
									oninput={(e) => { form!.id = e.currentTarget.value; form!.idTouched = true; }}
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
							<Select value={form.api} onchange={(api) => { if (form) form.api = api; }} options={formats.map((f) => ({ value: f.id, label: t(f.label) }))} />
						</label>
						<div class="switchrow">
							<span class="swtext">
								<b id="auth-req-l">{t("API 키 필요")}</b>
								<small id="auth-req-d">{t("켜면 저장된 키가 있어야 이 연결의 모델을 쓸 수 있습니다")}</small>
							</span>
							<Switch checked={form.authRequired} label={t("API 키 필요")} describedby="auth-req-d" onchange={(on) => { if (form) form.authRequired = on; }} />
						</div>
						{#if form.isNew && form.authRequired}
							<label in:collapseIn out:collapseOut>
								<span>{t("API 키")}</span>
								<input class="field mono" type="password" bind:value={form.apiKey} placeholder={t("API 키")} autocomplete="off" autocapitalize="off" spellcheck="false" />
							</label>
						{/if}
						{#if form.isNew}<p class="hint note">{t("모델이 없어도 저장할 수 있습니다. 비워 두면 저장할 때 이 주소에서 모델 목록을 불러오고, 불러오지 못해도 연결은 저장됩니다.")}</p>{/if}
					</section>

					<section class="fsec">
						<div class="mhead">
							<div class="mono-label">{t("모델 ({n})", { n: form.rows.length })}</div>
							<button type="button" class="btn sm" disabled={discovering || busy} onclick={discover}>
								<Icon name="download" /> {discovering ? t("불러오는 중…") : t("업스트림에서 불러오기")}
							</button>
						</div>
						{#if discoverNote}<p class="hint note" role="status" in:collapseIn out:collapseOut>{discoverNote}</p>{/if}
						<div class="mpick">
							{#each form.rows as r, i (i)}
								<button type="button" class="mitem" onclick={() => openModel(i)}>
									<span class="mlogo"><ModelLogo conn={api()?.connection} icon={r.icon} provider={form.id} model={r.id} size={18} /></span>
									<span class="mname">{r.name.trim() || r.id.trim() || t("새 모델")}{#if r.fromUpstream}<span class="lockic" title={t("업스트림 제공")}><Icon name="server" /></span>{/if}{#if matchedOf(r)}<span class="mchk" title={matchedOf(r)?.id}><Icon name="check" /></span>{/if}</span>
									<span class="mmeta">{modelMeta(r)}</span>
									{#if r.unavailable}
										<Badge tone="danger" size="sm"><Icon name="alert" />{t("불러오지 못함")}</Badge>
									{:else if !r.id.trim()}
										<Badge tone="danger" size="sm" mono><Icon name="alert" />{t("ID 필요")}</Badge>
									{:else if catalogLoaded && !matchedOf(r)}
										<Badge tone="neutral" size="sm"><Icon name="unlink" />{t("수동 입력")}</Badge>
									{/if}
									<Icon name="chevron-right" />
								</button>
							{/each}
						</div>
						<button type="button" class="btn dashed" onclick={addModel}><Icon name="plus" /> {t("모델 추가")}</button>
					</section>
				{/if}
			</div>

			<footer>
				{#if formError}<div class="ferr" role="alert" in:collapseIn out:collapseOut><Icon name="alert" /><span>{formError}</span></div>{/if}
				<div class="fbtns">
					{#if editing !== null}
						<button type="button" class="btn primary" onclick={closeModel}>{t("완료")}</button>
					{:else}
						<button type="button" class="btn ghost" onclick={() => close()} disabled={busy}>{t("취소")}</button>
						<button class="btn primary" disabled={busy}>{busy ? (form.isNew ? t("확인 중…") : t("저장 중…")) : t("저장")}</button>
					{/if}
				</div>
			</footer>
		</form>
		{#if confirmClose}
			<DiscardConfirm onsave={() => { confirmClose = false; void save(); }} oncancel={() => (confirmClose = false)} ondiscard={() => close(true)} />
		{/if}
		{#if matchFor !== null && form.rows[matchFor]}
			{@const mr = form.rows[matchFor]!}
			<CatalogPickerModal
				{catalog}
				value={matchedOf(mr)?.id ?? null}
				suggested={matchOf(mr.id)}
				onpick={(c) => { applyMatch(mr, c); matchFor = null; }}
				onclose={() => (matchFor = null)}
			/>
		{/if}
		{#if iconFor !== null && form.rows[iconFor]}
			{@const ir = form.rows[iconFor]!}
			<IconPickerModal api={api()} value={ir.icon} provider={form.id} model={ir.id} onpick={(i) => { ir.icon = i; iconFor = null; }} onclose={() => (iconFor = null)} />
		{/if}
	</Modal>
{/if}

<style>
	.mhead {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
	}
	.mhead :global(svg) {
		width: 14px;
		height: 14px;
		stroke: currentColor;
		fill: none;
		stroke-width: 2;
	}
	.lockic {
		flex: none;
		display: inline-flex;
	}
	.grid2 {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 10px;
	}
	label {
		display: flex;
		flex-direction: column;
		gap: 5px;
		min-width: 0;
	}
	/* ---------- edit dialog ---------- */
	.fform {
		display: flex;
		flex-direction: column;
		min-height: 0;
		flex: 1;
	}
	.fform > header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		padding: 14px 14px 12px 22px;
		border-bottom: 1px solid var(--border);
	}
	.ftitle {
		flex: 1;
		display: flex;
		align-items: baseline;
		gap: 10px;
		min-width: 0;
	}
	.ftitle h3 {
		margin: 0;
		font-size: var(--fs-xl);
	}
	.fsub {
		font-size: var(--fs-xs);
		color: var(--text-faint);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.fbody {
		display: flex;
		flex-direction: column;
		gap: 24px;
		padding: 18px 22px 20px;
		overflow-y: auto;
		min-height: 0;
	}
	.fsec {
		gap: 12px;
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
	.mpick {
		display: flex;
		flex-direction: column;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		overflow: hidden;
	}
	.mitem {
		display: flex;
		align-items: center;
		gap: 10px;
		min-height: 46px;
		padding: 0 12px 0 14px;
		background: var(--bg-elev);
		border-bottom: 1px solid var(--border);
		text-align: left;
		transition: background var(--motion-fast) var(--ease-std);
	}
	.mitem:last-child {
		border-bottom: 0;
	}
	.mitem:hover {
		background: var(--bg-hover);
	}
	.mname {
		flex: 1;
		min-width: 0;
		font-size: var(--fs-md);
		font-weight: 550;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.mitem :global(.badge svg) {
		width: 12px;
		height: 12px;
		stroke: currentColor;
		stroke-width: 2.2;
	}
	.mname :global(.lockic) {
		margin-left: 6px;
		vertical-align: -2px;
	}
	.mname :global(.lockic svg) {
		width: 13px;
		height: 13px;
		opacity: 0.7;
	}
	.mname :global(.mchk) {
		margin-left: 4px;
		vertical-align: -2px;
		display: inline-flex;
	}
	.mname :global(.mchk svg) {
		width: 13px;
		height: 13px;
		stroke: var(--ok);
		stroke-width: 2.4;
	}
	.mmeta {
		flex: none;
		font-size: var(--fs-xs);
		color: var(--text-faint);
	}
	.mitem :global(svg:not(.model):not(.logo)) {
		flex: none;
		width: 16px;
		height: 16px;
		stroke: var(--text-faint);
		fill: none;
		stroke-width: 1.9;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	.mlogo {
		flex: none;
		display: grid;
		place-items: center;
		color: var(--text-dim);
	}
	.mitem :global(svg.model) {
		stroke: none;
		fill: currentColor;
		width: 18px;
		height: 18px;
	}
	.back {
		margin-left: -8px;
	}
	.fform > footer {
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding: 12px 18px calc(14px + var(--sab));
		border-top: 1px solid var(--border);
	}
	.ferr {
		display: flex;
		gap: 8px;
		align-items: flex-start;
		padding: 9px 12px;
		border-radius: var(--radius);
		background: var(--danger-soft);
		color: var(--danger);
		font-size: var(--fs-sm);
		font-weight: 500;
		overflow-wrap: anywhere;
	}
	.ferr :global(svg) {
		flex: none;
		width: 17px;
		height: 17px;
		margin-top: 1px;
		stroke: currentColor;
		fill: none;
		stroke-width: 1.8;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	.fbtns {
		align-items: center;
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: 8px;
	}
	section {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}
	.note {
		margin: 0;
	}
	label > span {
		font-size: var(--fs-xs);
		font-weight: 600;
		color: var(--text-dim);
	}
	@media (max-width: 640px) {
		/* name/ID and model ID/display name stack; the two numbers stay side by side */
		.grid2 {
			grid-template-columns: 1fr;
		}
	}
</style>
