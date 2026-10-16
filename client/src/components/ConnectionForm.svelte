<script lang="ts" module>
	/** Local runtimes that speak the OpenAI-compatible API without a key. The URL is reached from the server, so localhost means the server's machine. */
	export const localPresets = [
		{ name: "Ollama", id: "ollama", baseUrl: "http://localhost:11434/v1" },
		{ name: "LM Studio", id: "lm-studio", baseUrl: "http://localhost:1234/v1" },
		{ name: "llama.cpp", id: "llama-cpp", baseUrl: "http://localhost:8080/v1" },
		{ name: "vLLM", id: "vllm", baseUrl: "http://localhost:8000/v1" },
	];
	export type LocalPreset = (typeof localPresets)[number];
</script>

<script lang="ts">
	import { msg, t, tc } from "../lib/i18n";
	import { collapseIn, collapseOut } from "../lib/motion";
	import { sheetPull } from "../lib/sheet";
	import { errorText, type Api } from "../lib/api";
	import { indexCatalog } from "../lib/catalog-match";
	import Icon from "./Icon.svelte";
	import Modal from "./Modal.svelte";
	import Switch from "./Switch.svelte";
	import Select from "./Select.svelte";
	import Badge from "./Badge.svelte";
	import CatalogPickerModal from "./CatalogPickerModal.svelte";
	import type { ApiFormat, CatalogModel, CustomModel, CustomProvider, ThinkingLevel } from "../lib/types";

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

	interface Row {
		id: string;
		name: string;
		contextWindow: string;
		maxTokens: string;
		reasoning: boolean;
		vision: boolean;
		/** Listed by the upstream itself: the id is fixed and cannot be edited */
		fromUpstream?: boolean;
		/** Empty = automatic (looked up by name on the server) */
		thinkingLevels: ThinkingLevel[];
		/** OpenRouter model this upstream model is matched to. null = manual; undefined = not chosen yet (matched by name). */
		catalogId?: string | null;
		/** What the server matched this model to, for display only */
		thinkingSource?: CustomModel["thinkingSource"];
		/** The upstream's model list no longer contains it */
		unavailable?: boolean;
	}
	const allLevels: ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];
	interface Form {
		isNew: boolean;
		id: string;
		idTouched: boolean;
		name: string;
		baseUrl: string;
		api: ApiFormat;
		authRequired: boolean;
		/** Typed into a new connection; sent to the server only on save (never kept in the list). */
		apiKey: string;
		rows: Row[];
	}

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

	const newRow = (): Row => ({ id: "", name: "", contextWindow: "128000", maxTokens: "8192", reasoning: false, vision: false, thinkingLevels: [] });
	const slug = (s: string) =>
		s
			.toLowerCase()
			.replace(/[^a-z0-9_-]+/g, "-")
			.replace(/^[^a-z]+/, "")
			.replace(/-+$/, "")
			.slice(0, 64);


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
				/* older server without /configuration/catalog: everything stays manual */
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
				if (hit) pickMatch(row, hit);
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
	/** The upstream model id is never touched; choosing an OpenRouter match only fills limits/capabilities from it. */
	function pickMatch(r: Row, c: CatalogModel | null) {
		if (!c) {
			r.catalogId = null;
			return;
		}
		r.catalogId = c.id;
		r.contextWindow = String(c.contextWindow);
		r.maxTokens = String(Math.min(c.maxTokens, c.contextWindow));
		r.vision = c.vision;
		r.reasoning = c.reasoning;
		r.thinkingLevels = [];
	}
	let matchFor = $state<number | null>(null);


	function startNew(preset?: LocalPreset) {
		void ensureCatalog();
		formError = "";
		discoverNote = "";
		editing = null;
		form = {
			isNew: true,
			id: preset?.id ?? "",
			idTouched: Boolean(preset),
			name: preset?.name ?? "",
			baseUrl: preset?.baseUrl ?? "",
			api: "openai-completions",
			authRequired: false,
			apiKey: "",
			rows: [],
		};
	}

	function startEdit(p: CustomProvider) {
		void ensureCatalog();
		formError = "";
		discoverNote = "";
		editing = null;
		form = {
			isNew: false,
			id: p.id,
			idTouched: true,
			name: p.name,
			baseUrl: p.baseUrl,
			api: p.api,
			authRequired: p.authRequired,
			apiKey: "",
			rows: p.models.map((m) => ({
				id: m.id,
				name: m.name ?? "",
				contextWindow: String(m.contextWindow),
				maxTokens: String(m.maxTokens),
				reasoning: m.reasoning,
				vision: m.vision,
				fromUpstream: m.fromUpstream,
				thinkingLevels: m.thinkingLevels ?? [],
				catalogId: m.catalogId,
				thinkingSource: m.thinkingSource,
				unavailable: m.unavailable,
			})),
		};
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
	const modelMeta = (r: Row) => {
		const ctx = Number(r.contextWindow);
		return [Number.isFinite(ctx) && ctx > 0 ? `${Math.round(ctx / 1000)}k` : "", r.reasoning ? t("추론") : "", r.vision ? t("이미지") : ""].filter(Boolean).join(" · ");
	};

	function onName(v: string) {
		if (!form) return;
		form.name = v;
		if (form.isNew && !form.idTouched) form.id = slug(v);
	}

	function submit(e: SubmitEvent) {
		e.preventDefault();
		void save();
	}

	/** A connection can be saved without models; a new one with none listed tries the upstream's list but never depends on it. */
	async function save() {
		const a = api();
		const f = form;
		if (!a || !f) return;
		if (editing !== null) return closeModel(); // Enter inside a model page just goes back
		formError = "";
		if (!f.name.trim()) return void (formError = t("이름을 입력하세요."));
		if (!/^[a-z][a-z0-9_-]{0,63}$/.test(f.id)) return void (formError = t("ID는 영문 소문자로 시작하고 소문자·숫자·-·_ 만 쓸 수 있습니다."));
		if (!f.baseUrl.trim()) return void (formError = t("Endpoint URL을 입력하세요."));
		// A new connection with no models yet tries to read them from its upstream; if that fails it is still saved, empty.
		if (f.isNew && !f.rows.some((r) => r.id.trim())) {
			busy = true;
			await discover();
			busy = false;
			formError = "";
		}
		f.rows = f.rows.filter((r) => r.id.trim() || r.name.trim());
		const out = [];
		for (const [i, r] of f.rows.entries()) {
			const ctx = Number(r.contextWindow);
			const max = Number(r.maxTokens);
			const bad = (problem: string) => {
				editing = i; // jump to the model that needs fixing
				formError = problem;
			};
			if (!r.id.trim()) return bad(t("{n}번째 모델의 ID를 입력하세요.", { n: i + 1 }));
			if (!Number.isInteger(ctx) || ctx < 128) return bad(t("{id}: 컨텍스트 크기는 128 이상의 정수여야 합니다.", { id: r.id }));
			if (!Number.isInteger(max) || max < 1) return bad(t("{id}: 최대 출력은 1 이상의 정수여야 합니다.", { id: r.id }));
			if (max > ctx) return bad(t("{id}: 최대 출력은 컨텍스트 크기를 넘을 수 없습니다.", { id: r.id }));
			const hit = matchedOf(r);
			out.push({
				id: r.id.trim(),
				...(r.fromUpstream ? { fromUpstream: true } : {}),
				...(hit ? { catalogId: hit.id } : catalogLoaded ? { catalogId: null } : {}),
				...(r.name.trim() ? { name: r.name.trim() } : {}),
				contextWindow: ctx,
				maxTokens: max,
				reasoning: r.reasoning,
				vision: r.vision,
				...(r.reasoning && r.thinkingLevels.length ? { thinkingLevels: allLevels.filter((l) => r.thinkingLevels.includes(l)) } : {}),
			});
		}
		if (new Set(out.map((m) => m.id)).size !== out.length) return void (formError = t("모델 ID가 중복되었습니다."));
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
	if (start.kind === "edit") startEdit(start.provider);
	// svelte-ignore state_referenced_locally
	else startNew(start.preset);
	const close = () => {
		form = null;
		onclose();
	};
</script>

{#if form}
	<!-- nested inside another (transformed) modal, so lifted to <body> to stay fixed to the viewport -->
	<Modal onclose={close} onescape={escape} dismissible={!busy} label={form.isNew ? t("연결 추가") : t("연결 수정")} width="l" maxHeight="760px" layer={4} portal>
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
				<button type="button" class="iconbtn" onclick={close} aria-label={t("닫기")} disabled={busy}><Icon name="x" /></button>
			</header>

			<div class="fbody">
				{#if editing !== null}
					{@const r = form.rows[editing]}
					{#if r}
						<section class="fsec">
							<label>
								<span class="idlabel">{t("모델 ID")}{#if r.fromUpstream}<Badge tone="neutral" size="sm"><Icon name="shield" />{t("업스트림 제공")}</Badge>{/if}</span>
								<!-- svelte-ignore a11y_autofocus -->
								<input class="field mono" bind:value={r.id} readonly={r.fromUpstream} aria-readonly={r.fromUpstream} placeholder="upstream-model-id" autocomplete="off" autocapitalize="off" spellcheck="false" autofocus={fresh && !r.fromUpstream} />
								<small class="hint">{r.fromUpstream ? t("업스트림 모델 목록에서 불러온 ID라 수정할 수 없습니다. 바꾸려면 모델을 삭제하고 다시 불러오세요.") : t("업스트림이 제공하는 ID입니다. 요청에 그대로 쓰이므로 OpenRouter 선택으로 바뀌지 않습니다.")}</small>
							</label>
							{#if catalogLoaded}
								{@const hit = matchedOf(r)}
								<div class="matchrow">
									<span class="mlabel">{t("OpenRouter 매칭 모델")}</span>
									<button type="button" class="mtrigger" onclick={() => (matchFor = editing)}>
										{#if hit}
											<Icon name="check" />
											<span class="mono mtext">{hit.id}</span>
										{:else}
											<Icon name="unlink" />
											<span class="mtext dim">{t("수동 입력")}</span>
										{/if}
										<Icon name="chevron-down" />
									</button>
								</div>
								{#if hit}
									<p class="note mono src ok"><Icon name="check" /> {t("추론 강도: {levels}", { levels: hit.levels.join(", ") || "-" })}</p>
								{:else if r.catalogId === undefined && r.id.trim()}
									<p class="note src bad"><Icon name="alert" /> {t("자동으로 찾지 못했습니다. 매칭 모델을 고르거나 아래 값을 직접 입력하세요.")}</p>
								{/if}
							{/if}
							<label>
								<span>{t("표시 이름")} <em>({tc("optional", "선택")})</em></span>
								<input class="field" bind:value={r.name} placeholder={t("ID와 같으면 비워 두세요")} autocomplete="off" />
							</label>
						</section>
						<section class="fsec">
							<div class="mono-label">{t("제한")}</div>
							<div class="grid2">
								<label>
									<span>{t("컨텍스트 크기")}</span>
									<input class="field mono" inputmode="numeric" bind:value={r.contextWindow} />
								</label>
								<label>
									<span>{t("최대 출력")}</span>
									<input class="field mono" inputmode="numeric" bind:value={r.maxTokens} />
								</label>
							</div>
						</section>
						<section class="fsec">
							<div class="mono-label">{t("기능")}</div>
							<div class="caps">
								<button type="button" class="cap" aria-pressed={r.reasoning} onclick={() => (r.reasoning = !r.reasoning)}><Icon name="brain" /> {t("추론")}</button>
								<button type="button" class="cap" aria-pressed={r.vision} onclick={() => (r.vision = !r.vision)}><Icon name="image" /> {t("이미지 입력")}</button>
							</div>
						</section>
						{#if r.reasoning && !matchedOf(r)}
							<section class="fsec">
								<div class="mono-label">{t("추론 강도")} <em>({tc("optional", "선택")})</em></div>
								<div class="caps" role="group" aria-label={t("추론 강도")}>
									{#each allLevels as l (l)}
										<button
											type="button"
											class="cap"
											aria-pressed={r.thinkingLevels.includes(l)}
											onclick={() => (r.thinkingLevels = r.thinkingLevels.includes(l) ? r.thinkingLevels.filter((x) => x !== l) : [...r.thinkingLevels, l])}
										>{l}</button>
									{/each}
								</div>
								<p class="note">{r.thinkingLevels.length ? t("고른 강도만 이 모델에서 선택할 수 있습니다.") : t("고르지 않으면 모델 이름으로 자동 설정하고, 찾지 못하면 minimal부터 high까지 보여줍니다.")}</p>
								{#if r.thinkingSource}
									{@const s = r.thinkingSource}
									{#if s.catalogId}
										<p class="note mono src ok"><Icon name="check" /> {t("OpenRouter {id}와 일치: {levels}", { id: s.catalogId, levels: s.levels.join(", ") })}{s.kind === "custom" ? ` (${t("직접 지정")})` : ""}</p>
									{:else}
										<p class="note mono src off"><Icon name="unlink" /> {t("OpenRouter 모델과 연결되지 않음: {levels}", { levels: s.levels.join(", ") })}</p>
									{/if}
								{/if}
							</section>
						{/if}
						<button type="button" class="btn ghost danger-text" onclick={removeModel}><Icon name="trash" /> {t("이 모델 삭제")}</button>
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
						{#if form.isNew}<p class="note">{t("모델이 없어도 저장할 수 있습니다. 비워 두면 저장할 때 이 주소에서 모델 목록을 불러오고, 불러오지 못해도 연결은 저장됩니다.")}</p>{/if}
					</section>

					<section class="fsec">
						<div class="mhead">
							<div class="mono-label">{t("모델 ({n})", { n: form.rows.length })}</div>
							<button type="button" class="btn sm" disabled={discovering || busy} onclick={discover}>
								<Icon name="download" /> {discovering ? t("불러오는 중…") : t("업스트림에서 불러오기")}
							</button>
						</div>
						{#if discoverNote}<p class="note" role="status" in:collapseIn out:collapseOut>{discoverNote}</p>{/if}
						<div class="mpick">
							{#each form.rows as r, i (i)}
								<button type="button" class="mitem" onclick={() => openModel(i)}>
									<span class="mname">{r.name.trim() || r.id.trim() || t("새 모델")}</span>
									<span class="mmeta">{modelMeta(r)}</span>
									{#if r.fromUpstream}<span class="lockic" title={t("업스트림 제공")}><Icon name="shield" /></span>{/if}
									{#if r.unavailable}
										<Badge tone="danger" size="sm"><Icon name="alert" />{t("불러오지 못함")}</Badge>
									{:else if !r.id.trim()}
										<Badge tone="danger" size="sm" mono><Icon name="alert" />{t("ID 필요")}</Badge>
									{:else if matchedOf(r)}
										<Badge tone="ok" size="sm" mono><Icon name="check" />{matchedOf(r)?.id}</Badge>
									{:else if catalogLoaded}
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
						<button type="button" class="btn ghost" onclick={close} disabled={busy}>{t("취소")}</button>
						<button class="btn primary" disabled={busy}>{busy ? (form.isNew ? t("확인 중…") : t("저장 중…")) : t("저장")}</button>
					{/if}
				</div>
			</footer>
		</form>
		{#if matchFor !== null && form.rows[matchFor]}
			{@const mr = form.rows[matchFor]!}
			<CatalogPickerModal
				{catalog}
				value={matchedOf(mr)?.id ?? null}
				suggested={matchOf(mr.id)}
				onpick={(c) => { pickMatch(mr, c); matchFor = null; }}
				onclose={() => (matchFor = null)}
			/>
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
	.idlabel {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.lockic {
		flex: none;
		display: inline-flex;
	}
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
	.idlabel {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.lockic {
		flex: none;
		display: inline-flex;
	}
	.src {
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.src :global(svg) {
		width: 14px;
		height: 14px;
		flex: none;
		stroke: currentColor;
		fill: none;
		stroke-width: 2;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	.src.off {
		color: var(--text-faint);
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
	label em {
		font-style: normal;
		font-weight: 400;
		color: var(--text-faint);
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
	.mmeta {
		flex: none;
		font-size: var(--fs-xs);
		color: var(--text-faint);
	}
	.mitem :global(svg) {
		flex: none;
		width: 16px;
		height: 16px;
		stroke: var(--text-faint);
		fill: none;
		stroke-width: 1.9;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	.back {
		margin-left: -8px;
	}
	.hint {
		font-size: var(--fs-xs);
		color: var(--text-faint);
	}
	.matchrow {
		display: flex;
		flex-direction: column;
		gap: 5px;
	}
	.mlabel {
		font-size: var(--fs-xs);
		font-weight: 600;
		color: var(--text-dim);
	}
	.mtrigger {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		height: 42px;
		padding: 0 12px;
		background: var(--bg);
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-sm);
		color: var(--text);
		font-size: var(--fs-md);
		text-align: left;
		transition: border-color var(--motion-fast) var(--ease-std);
	}
	.mtrigger:hover {
		border-color: var(--accent);
	}
	.mtext {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: var(--fs-sm);
	}
	.mtext.dim {
		color: var(--text-dim);
	}
	.mtrigger :global(svg) {
		width: 15px;
		height: 15px;
		flex: none;
		stroke: currentColor;
		fill: none;
		stroke-width: 2;
		stroke-linecap: round;
		stroke-linejoin: round;
		color: var(--text-dim);
	}
	.danger-text {
		align-self: flex-start;
		color: var(--danger);
	}
	.caps {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}
	.cap {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		height: 32px;
		padding: 0 12px;
		border-radius: var(--radius-pill);
		border: 1px solid var(--border-strong);
		background: transparent;
		color: var(--text-dim);
		font-size: var(--fs-sm);
		font-weight: 500;
		transition: background var(--motion-fast) var(--ease-std), color var(--motion-fast) var(--ease-std), border-color var(--motion-fast) var(--ease-std);
	}
	.cap :global(svg) {
		width: 16px;
		height: 16px;
		stroke: currentColor;
		fill: none;
		stroke-width: 1.8;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	.cap:hover {
		background: var(--bg-hover);
	}
	.cap[aria-pressed="true"] {
		background: var(--accent-soft);
		border-color: var(--text-dim);
		color: var(--text);
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
		display: flex;
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
		font-size: var(--fs-xs);
		color: var(--text-faint);
	}
	.field[readonly] {
		color: var(--text-dim);
		background: var(--bg-elev);
		cursor: default;
	}
	.field[readonly] {
		color: var(--text-dim);
		background: var(--bg-elev);
		cursor: default;
	}
	.src.ok :global(svg) {
		color: var(--text);
	}
	.src.bad {
		color: var(--danger);
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
		.fsec .grid2:has(input[inputmode="numeric"]) {
			grid-template-columns: 1fr 1fr;
		}
	}
	@media (max-width: 640px) {
		/* name/ID and model ID/display name stack; the two numbers stay side by side */
		.grid2 {
			grid-template-columns: 1fr;
		}
		.fsec .grid2:has(input[inputmode="numeric"]) {
			grid-template-columns: 1fr 1fr;
		}
	}
</style>
