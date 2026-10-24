<script lang="ts" module>
	export { localPresets, type LocalPreset } from "../lib/connection-form";
</script>

<script lang="ts">
	import IconButton from "./IconButton.svelte";
	import Button from "./Button.svelte";
	import { t } from "../lib/i18n";
	import { collapseIn, collapseOut } from "../lib/motion";
	import { sheetPull } from "../lib/sheet";
	import { errorText, type Api } from "../lib/api";
	import { indexCatalog } from "../lib/catalog-match";
	import Icon from "./Icon.svelte";
	import ConnectionFields from "./connection/ConnectionFields.svelte";
	import ModelList from "./connection/ModelList.svelte";
	import Modal from "./Modal.svelte";
	import DiscardConfirm from "./DiscardConfirm.svelte";
	import IconPickerModal from "./IconPickerModal.svelte";
	import CatalogPickerModal from "./CatalogPickerModal.svelte";
	import ModelPage from "./ModelPage.svelte";
	import type { CatalogModel, CustomProvider } from "../lib/types";
	import { applyMatch, collectModels, formFromProvider, headerError, newForm, newRow, slug, snapshot, type Form, type LocalPreset, type Row } from "../lib/connection-form";

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
					<IconButton icon="chevron-left" label={t("연결로 돌아가기")} class="back" onclick={closeModel} />
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
				<IconButton icon="x" label={t("닫기")} onclick={() => close()} disabled={busy} />
			</header>

			<div class="fbody">
				{#if editing !== null}
					{@const r = form.rows[editing]}
					{#if r}
						<ModelPage {r} providerId={form.id} connection={api()?.connection} {catalogLoaded} matched={matchedOf(r)} {fresh} onpickmatch={() => (matchFor = editing)} onpickicon={() => (iconFor = editing)} onremove={removeModel} />
					{/if}
				{:else}
					<ConnectionFields {form} onname={onName} />
					<ModelList
						{form}
						connection={api()?.connection}
						{busy}
						{discovering}
						note={discoverNote}
						{catalogLoaded}
						{matchedOf}
						onopen={openModel}
						onadd={addModel}
						ondiscover={discover}
					/>
				{/if}
			</div>

			<footer>
				{#if formError}<div class="ferr" role="alert" in:collapseIn out:collapseOut><Icon name="alert" /><span>{formError}</span></div>{/if}
				<div class="fbtns">
					{#if editing !== null}
						<Button variant="primary" onclick={closeModel}>{t("완료")}</Button>
					{:else}
						<Button variant="ghost" onclick={() => close()} disabled={busy}>{t("취소")}</Button>
						<Button variant="primary" type="submit" disabled={busy}>{busy ? (form.isNew ? t("확인 중…") : t("저장 중…")) : t("저장")}</Button>
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
	:global(.iconbtn.back) {
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
		stroke-width: 1.8;
	}
	.fbtns {
		align-items: center;
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: 8px;
	}

</style>
