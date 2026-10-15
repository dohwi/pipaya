<script lang="ts">
	import { msg, t, tc } from "../lib/i18n";
	import { sheetPull } from "../lib/sheet";
	import Icon from "./Icon.svelte";
	import Modal from "./Modal.svelte";
	import Switch from "./Switch.svelte";
	import Accordion from "./Accordion.svelte";
	import ModelField from "./ModelField.svelte";
	import { app } from "../lib/store.svelte";
	import { Api, errorText } from "../lib/api";
	import Badge from "./Badge.svelte";
	import CatalogPickerModal from "./CatalogPickerModal.svelte";
	import CompactionSection from "./CompactionSection.svelte";
	import ProviderAccounts from "./ProviderAccounts.svelte";
	import ConnectModal from "./ConnectModal.svelte";
	import { indexCatalog } from "../lib/catalog-match";
	import type {
		ApiFormat,
		CatalogModel,
		ConfigurationInfo,
		ConnectionResult,
		CustomModel,
		CustomProvider,
		DefaultModelSelection,
		ModelInfo,
		ModelSelection,
		ProviderInfo,
		ThinkingLevel,
	} from "../lib/types";

	/** Model connection settings live on each server, so this talks to the chosen server directly, not only the open one. */
	let { serverId }: { serverId: string } = $props();
	const server = $derived(app.servers.find((s) => s.id === serverId));

	let cfg = $state<ConfigurationInfo | null>(null);
	let models = $state<ModelInfo[]>([]);
	let loading = $state(false);
	let loadError = $state("");
	let busy = $state(false);
	let formError = $state("");
	let tests = $state<Record<string, ConnectionResult | "running">>({});
	let keyFor = $state<string | null>(null);
	let confirmDelete = $state<string | null>(null);
	let keyValue = $state("");

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
		rows: Row[];
	}
	let form = $state<Form | null>(null);
	/** Index of the model whose details are open inside the dialog; null = the connection page. */
	let editing = $state<number | null>(null);
	let fresh = $state(false);
	/** The "add connection" picker, and a counter that makes the signed-in account list reload after it changes something. */
	let picking = $state(false);
	let accountsTick = $state(0);

	const formats: { id: ApiFormat; label: string }[] = [
		{ id: "openai-completions", label: msg("OpenAI 호환 (Chat Completions)") },
		{ id: "openai-responses", label: "OpenAI Responses" },
		{ id: "anthropic-messages", label: "Anthropic Messages" },
	];

	/** Esc steps back from a model's page to the connection first; a second Esc closes the dialog. */
	function escape() {
		if (editing !== null) closeModel();
		else form = null;
	}

	const newRow = (): Row => ({ id: "", name: "", contextWindow: "128000", maxTokens: "8192", reasoning: false, vision: false, thinkingLevels: [] });
	const slug = (s: string) =>
		s
			.toLowerCase()
			.replace(/[^a-z0-9_-]+/g, "-")
			.replace(/^[^a-z]+/, "")
			.replace(/-+$/, "")
			.slice(0, 64);

	/* ---------- loading (per selected server) ---------- */

	let loadSeq = 0;
	async function load(id: string) {
		const s = app.servers.find((x) => x.id === id);
		cfg = null;
		models = [];
		loadError = "";
		form = null;
		keyFor = null;
		confirmDelete = null;
		tests = {};
		if (!s) return;
		const seq = ++loadSeq;
		loading = true;
		try {
			const api = new Api({ baseUrl: s.baseUrl, token: s.token });
			const [c, m] = await Promise.all([api.configuration(), api.models()]);
			if (seq !== loadSeq) return;
			cfg = c;
			models = m;
		} catch (e) {
			if (seq !== loadSeq) return;
			loadError = errorText(e);
		} finally {
			if (seq === loadSeq) loading = false;
		}
	}

	$effect(() => {
		void load(serverId);
	});

	// Another client (or this one) changed the open server's configuration: keep the list current.
	let lastTick = app.modelPickerTick;
	$effect(() => {
		const tick = app.configTick;
		if (tick !== lastTick && !busy && !form && serverId === app.serverId) void load(serverId);
		lastTick = tick;
	});

	const api = () => (server ? new Api({ baseUrl: server.baseUrl, token: server.token }) : null);

	/** After any change: refresh this view, and the app's own model list when it is the open server. */
	async function reload() {
		await load(serverId);
		if (serverId === app.serverId) await app.refreshProviders();
	}

	/* ---------- defaults ---------- */

	const providerList = $derived<ProviderInfo[]>(
		(cfg?.providers ?? []).map((p) => ({ id: p.id, name: p.name, configured: p.configured, storedCredential: null })),
	);
	const saved = $derived(cfg?.defaults ?? null);
	/** The model the chooser shows: the saved default, else the one new chats really get (the startup default), if any. */
	const shownModel = $derived(saved ?? cfg?.effectiveDefaults ?? null);
	const shownThinking = $derived<ThinkingLevel | null>(saved?.thinkingLevel ?? null);
	const shownInfo = $derived(shownModel ? models.find((m) => m.provider === shownModel.provider && m.id === shownModel.model) : undefined);

	/** Save a new default. The reasoning strength only travels with a model that has reasoning. */
	async function saveDefault(next: DefaultModelSelection | null) {
		const a = api();
		if (!a) return;
		busy = true;
		try {
			const r = await a.setDefaultModel(next);
			if (cfg) cfg = { ...cfg, ...r };
			// The open server's new chats follow the default at once (the same refresh a provider change does).
			if (serverId === app.serverId) await app.refreshProviders();
		} catch (e) {
			app.toast(t("기본 모델을 바꾸지 못했습니다: {error}", { error: errorText(e) }), "error");
		} finally {
			busy = false;
		}
	}
	/** The model and its strength are one choice, saved together. */
	function pickDefault(c: DefaultModelSelection | null) {
		void saveDefault(c);
	}

	/* ---------- form ---------- */

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
	async function discover() {
		const a = api();
		const f = form;
		if (!a || !f) return;
		formError = "";
		discoverNote = "";
		if (!f.baseUrl.trim()) return void (formError = t("Endpoint URL을 입력하세요."));
		discovering = true;
		try {
			const [res] = await Promise.all([a.discoverModels({ baseUrl: f.baseUrl.trim(), api: f.api, ...(f.isNew ? {} : { providerId: f.id }) }), ensureCatalog()]);
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
			if (!f.rows.length) f.rows.push(newRow());
			discoverNote = added ? t("{n}개 모델을 불러왔습니다.", { n: added }) : t("새로 추가할 모델이 없습니다.");
		} catch (e) {
			formError = errorText(e);
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

	/** Local runtimes that speak the OpenAI-compatible API without a key. The URL is reached from the server, so localhost means the server's machine. */
	const localPresets = [
		{ name: "Ollama", id: "ollama", baseUrl: "http://localhost:11434/v1" },
		{ name: "LM Studio", id: "lm-studio", baseUrl: "http://localhost:1234/v1" },
		{ name: "llama.cpp", id: "llama-cpp", baseUrl: "http://localhost:8080/v1" },
		{ name: "vLLM", id: "vllm", baseUrl: "http://localhost:8000/v1" },
	];

	function startNew(preset?: (typeof localPresets)[number]) {
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
			rows: [newRow()],
		};
		// Local servers list their installed models: fill them in right away (a failure just shows the hint).
		if (preset) void discover();
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
			if (fresh && r && !r.id.trim() && !r.name.trim() && form.rows.length > 1) form.rows.splice(editing, 1);
		}
		formError = "";
		fresh = false;
		editing = null;
	}
	function removeModel() {
		if (!form || editing === null || form.rows.length === 1) return;
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

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		const a = api();
		const f = form;
		if (!a || !f) return;
		if (editing !== null) return closeModel(); // Enter inside a model page just goes back
		formError = "";
		if (!f.name.trim()) return void (formError = t("이름을 입력하세요."));
		if (!/^[a-z][a-z0-9_-]{0,63}$/.test(f.id)) return void (formError = t("ID는 영문 소문자로 시작하고 소문자·숫자·-·_ 만 쓸 수 있습니다."));
		if (!f.baseUrl.trim()) return void (formError = t("Endpoint URL을 입력하세요."));
		if (!f.rows.length) return void (formError = t("모델을 하나 이상 추가하세요."));
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
			form = null;
			await reload();
		} catch (err) {
			formError = errorText(err);
		} finally {
			busy = false;
		}
	}

	/* ---------- provider actions ---------- */

	async function remove(p: CustomProvider) {
		const a = api();
		if (!a) return;
		busy = true;
		try {
			await a.deleteCustomProvider(p.id);
			confirmDelete = null;
			await reload();
		} catch (e) {
			confirmDelete = null;
			app.toast(t("삭제하지 못했습니다: {error}", { error: errorText(e) }), "error");
		} finally {
			busy = false;
		}
	}

	async function saveKey(p: CustomProvider) {
		const a = api();
		if (!a || !keyValue.trim()) return;
		busy = true;
		try {
			await a.setCredential(p.id, keyValue.trim());
			keyFor = null;
			keyValue = "";
			await reload();
		} catch (e) {
			app.toast(t("키를 저장하지 못했습니다: {error}", { error: errorText(e) }), "error");
		} finally {
			busy = false;
		}
	}

	async function removeKey(p: CustomProvider) {
		const a = api();
		if (!a) return;
		busy = true;
		try {
			await a.removeCredential(p.id);
			await reload();
		} catch (e) {
			app.toast(t("키를 삭제하지 못했습니다: {error}", { error: errorText(e) }), "error");
		} finally {
			busy = false;
		}
	}

	async function test(provider: string, model: string) {
		const a = api();
		if (!a) return;
		const k = `${provider}\u0000${model}`;
		tests[k] = "running";
		try {
			tests[k] = await a.testModel({ provider, model });
		} catch (e) {
			tests[k] = { ok: false, durationMs: 0, error: errorText(e) };
		}
	}
</script>

<div class="mc">
	{#if loading && !cfg}
		<p class="note">{t("불러오는 중…")}</p>
	{:else if loadError}
		<div class="err" role="alert">
			<span>{loadError}</span>
			<button class="btn sm" onclick={() => load(serverId)}><Icon name="retry" /> {t("다시 시도")}</button>
		</div>
	{:else if cfg}
		<section>
			<div class="label">{t("새 대화 기본 모델")}</div>
			<ModelField
				{models}
				providers={providerList}
				value={shownModel}
				level={shownThinking}
				favs={serverId === app.serverId ? app.favModels : []}
				onfav={serverId === app.serverId ? (p, id) => app.toggleFavModel(p, id) : undefined}
				allowUnset
				unsetLabel={t("서버 기본값")}
				placeholder={t("서버 기본값")}
				disabled={busy}
				label={t("기본 모델")}
				onpick={pickDefault}
			/>
			<p class="note">
				{#if !saved}
					{t("지정하지 않아 서버 기본값을 씁니다.")}{#if cfg.effectiveDefaults} ({cfg.effectiveDefaults.provider}/{cfg.effectiveDefaults.model}){/if}
				{:else if shownInfo && !shownInfo.reasoning}
					{t("이 모델은 추론 모드를 지원하지 않아 추론 강도는 쓰이지 않습니다.")}
				{:else if saved.thinkingLevel}
					{t("새 대화는 추론 강도 {level}로 시작합니다.", { level: saved.thinkingLevel })}
				{:else}
					{t("추론 강도를 지정하지 않아 새 대화는 이 기기의 마지막 설정으로 시작합니다.")}
				{/if}
			</p>
		</section>

		<CompactionSection {serverId} {models} providers={providerList} />

		<section>
			<div class="label">{t("연결")}</div>
			<ProviderAccounts {serverId} refresh={accountsTick} onchange={() => void load(serverId)} />
			{#if cfg.providers.length}
				<div class="plist">
					{#each cfg.providers as p (p.id)}
						<div class="prov">
							<div class="phead">
								<div class="pname">
									<span class="ptitle">{p.name}</span>
									<span class="pid mono url">{p.baseUrl}</span>
								</div>
								{#if p.configured}<span class="chip ok">{t("사용 가능")}</span>{:else}<span class="chip warn">{t("키 필요")}</span>{/if}
							</div>

							<div class="models">
							<Accordion variant="text">
							{#snippet head()}{t("모델 {n}개", { n: p.models.length })}{/snippet}
							<ul class="mlist">
								{#each p.models as m (m.id)}
									{@const probe = tests[`${p.id}\u0000${m.id}`]}
									<li>
										<span class="minfo">
											<span class="mid mono">{m.name ?? m.id}</span>
											{#if m.name && m.name !== m.id}<span class="msub mono">{m.id}</span>{/if}
										</span>
										<span class="mtags">
											{#if m.reasoning}<span class="tag" title={t("추론")}><Icon name="brain" /></span>{/if}
											{#if m.vision}<span class="tag" title={t("이미지 입력")}><Icon name="image" /></span>{/if}
											<span class="tag mono">{Math.round(m.contextWindow / 1000)}k</span>
										</span>
										<button class="btn ghost sm" disabled={probe === "running" || !p.configured} onclick={() => test(p.id, m.id)} title={t("실제 모델 요청을 1회 보냅니다 (요금이 발생할 수 있음)")}>
											{probe === "running" ? t("확인 중…") : t("테스트")}
										</button>
										{#if probe && probe !== "running"}
											<span class="res {probe.ok ? 'ok' : 'bad'}" role="status">{probe.ok ? `${t("성공")} ${probe.durationMs}ms${probe.text ? ` · “${probe.text.trim().slice(0, 40)}”` : ""}` : (probe.error ?? t("실패"))}</span>
										{/if}
									</li>
								{/each}
							</ul>
							</Accordion>
							</div>

							<div class="actions">
								{#if p.authRequired}
									{#if p.hasStoredKey}
										<button class="btn ghost sm" disabled={busy} onclick={() => removeKey(p)}><Icon name="key" /> {t("키 삭제")}</button>
									{:else}
										<button class="btn sm" onclick={() => { keyFor = keyFor === p.id ? null : p.id; keyValue = ""; }}><Icon name="key" /> {t("키 추가")}</button>
									{/if}
								{/if}
								<button class="btn sm" disabled={busy} onclick={() => startEdit(p)}><Icon name="pencil" /> {t("수정")}</button>
								{#if confirmDelete === p.id}
									<button class="btn danger sm" disabled={busy} onclick={() => remove(p)}>{t("정말 삭제")}</button>
									<button class="btn ghost sm" onclick={() => (confirmDelete = null)}>{t("취소")}</button>
								{:else}
									<button class="btn ghost sm" disabled={busy} onclick={() => (confirmDelete = p.id)}>{t("삭제")}</button>
								{/if}
							</div>
							{#if keyFor === p.id}
								<form class="keyform" onsubmit={(e) => { e.preventDefault(); void saveKey(p); }}>
									<!-- svelte-ignore a11y_autofocus -->
									<input class="field" type="password" placeholder={t("API 키")} bind:value={keyValue} autocomplete="off" autocapitalize="off" spellcheck="false" autofocus />
									<button class="btn primary" disabled={busy || !keyValue.trim()}>{t("저장")}</button>
								</form>
							{/if}
						</div>
					{/each}
				</div>
			{/if}

			{#if !form}
				<button class="btn dashed" onclick={() => (picking = true)}><Icon name="plus" /> {t("연결 추가")}</button>
			{/if}
		</section>

		{#if picking}
			<ConnectModal
				{serverId}
				locals={localPresets}
				taken={new Set(cfg.providers.map((x) => x.id))}
				onclose={() => (picking = false)}
				onchange={() => { accountsTick++; void load(serverId); }}
				oncustom={(id) => startNew(localPresets.find((l) => l.id === id))}
			/>
		{/if}

		{#if form}
			<!-- nested inside another (transformed) modal, so lifted to <body> to stay fixed to the viewport -->
			<Modal onclose={() => (form = null)} onescape={escape} dismissible={!busy} label={form.isNew ? t("연결 추가") : t("연결 수정")} width="l" maxHeight="760px" layer={4} portal>
				<form class="fform" onsubmit={submit}>
					<header use:sheetPull={{ onclose: () => !busy && (form = null), disabled: busy }}>
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
						<button type="button" class="iconbtn" onclick={() => (form = null)} aria-label={t("닫기")} disabled={busy}><Icon name="x" /></button>
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
									<div class="label">{t("제한")}</div>
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
									<div class="label">{t("기능")}</div>
									<div class="caps">
										<button type="button" class="cap" aria-pressed={r.reasoning} onclick={() => (r.reasoning = !r.reasoning)}><Icon name="brain" /> {t("추론")}</button>
										<button type="button" class="cap" aria-pressed={r.vision} onclick={() => (r.vision = !r.vision)}><Icon name="image" /> {t("이미지 입력")}</button>
									</div>
								</section>
								{#if r.reasoning && !matchedOf(r)}
									<section class="fsec">
										<div class="label">{t("추론 강도")} <em>({tc("optional", "선택")})</em></div>
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
								<button type="button" class="btn ghost danger-text" disabled={form.rows.length === 1} onclick={removeModel}><Icon name="trash" /> {t("이 모델 삭제")}</button>
							{/if}
						{:else}
							<section class="fsec">
								<div class="label">{t("연결 정보")}</div>
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
									<select class="field" bind:value={form.api}>
										{#each formats as f (f.id)}<option value={f.id}>{t(f.label)}</option>{/each}
									</select>
								</label>
								<div class="switchrow">
									<span class="swtext">
										<b id="auth-req-l">{t("API 키 필요")}</b>
										<small id="auth-req-d">{t("켜면 저장된 키가 있어야 이 연결의 모델을 쓸 수 있습니다")}</small>
									</span>
									<Switch checked={form.authRequired} label={t("API 키 필요")} describedby="auth-req-d" onchange={(on) => { if (form) form.authRequired = on; }} />
								</div>
							</section>

							<section class="fsec">
								<div class="mhead">
									<div class="label">{t("모델 ({n})", { n: form.rows.length })}</div>
									<button type="button" class="btn sm" disabled={discovering || busy} onclick={discover}>
										<Icon name="download" /> {discovering ? t("불러오는 중…") : t("업스트림에서 불러오기")}
									</button>
								</div>
								{#if discoverNote}<p class="note" role="status">{discoverNote}</p>{/if}
								<div class="mpick">
									{#each form.rows as r, i (i)}
										<button type="button" class="mitem" onclick={() => openModel(i)}>
											<span class="mname">{r.name.trim() || r.id.trim() || t("새 모델")}</span>
											<span class="mmeta">{modelMeta(r)}</span>
											{#if r.fromUpstream}<span class="lockic" title={t("업스트림 제공")}><Icon name="shield" /></span>{/if}
											{#if !r.id.trim()}
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
						{#if formError}<div class="ferr" role="alert"><Icon name="alert" /><span>{formError}</span></div>{/if}
						<div class="fbtns">
							{#if editing !== null}
								<button type="button" class="btn primary" onclick={closeModel}>{t("완료")}</button>
							{:else}
								<button type="button" class="btn ghost" onclick={() => (form = null)} disabled={busy}>{t("취소")}</button>
								<button class="btn primary" disabled={busy}>{busy ? t("저장 중…") : t("저장")}</button>
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
	{/if}
</div>


<style>
	.mc {
		display: flex;
		flex-direction: column;
		gap: 22px;
	}
	section {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}
	.label {
		font-family: var(--mono);
		font-size: var(--fs-2xs);
		font-weight: 500;
		letter-spacing: 0.04em;
		color: var(--text-faint);
	}
	.note {
		margin: 0;
		font-size: var(--fs-xs);
		color: var(--text-faint);
	}
	.url {
		font-size: var(--fs-xs);
		color: var(--text-dim);
		overflow-wrap: anywhere;
	}
	.plist {
		display: flex;
		flex-direction: column;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		overflow: hidden;
	}
	.prov {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 10px 14px 12px;
		border-bottom: 1px solid var(--border);
		background: var(--bg-elev);
	}
	.prov:last-child {
		border-bottom: 0;
	}
	.phead {
		display: flex;
		align-items: center;
		gap: 10px;
	}
	.pname {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
	}
	.pid {
		font-size: var(--fs-2xs);
		color: var(--text-faint);
	}
	.ptitle {
		font-weight: 550;
		font-size: var(--fs-md);
	}
	.mlist {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.mlist li {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 4px 10px;
		padding: 6px 8px 6px 10px;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: var(--bg);
		font-size: var(--fs-sm);
	}
	.minfo {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
	}
	.mid {
		font-size: var(--fs-sm);
		font-weight: 550;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.msub {
		font-size: var(--fs-2xs);
		color: var(--text-faint);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.mtags {
		display: flex;
		align-items: center;
		gap: 6px;
		color: var(--text-faint);
	}
	.tag {
		display: inline-flex;
		align-items: center;
		font-size: var(--fs-2xs);
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
	.field[readonly] {
		color: var(--text-dim);
		background: var(--bg-elev);
		cursor: default;
	}
	.tag :global(svg) {
		width: 14px;
		height: 14px;
		stroke: currentColor;
		fill: none;
		stroke-width: 1.8;
		stroke-linecap: round;
		stroke-linejoin: round;
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
	.field[readonly] {
		color: var(--text-dim);
		background: var(--bg-elev);
		cursor: default;
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
	.src.ok :global(svg) {
		color: var(--text);
	}
	.src.bad {
		color: var(--danger);
	}
	.src.off {
		color: var(--text-faint);
	}
	.res {
		flex-basis: 100%;
		font-size: var(--fs-xs);
		overflow-wrap: anywhere;
	}
	.res.ok {
		color: var(--ok);
	}
	.res.bad {
		color: var(--danger);
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}
	.keyform {
		display: flex;
		gap: 8px;
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
	label > span {
		font-size: var(--fs-xs);
		font-weight: 600;
		color: var(--text-dim);
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
	.err {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		padding: 10px 12px;
		border: 1px solid var(--danger);
		border-radius: var(--radius);
		font-size: var(--fs-sm);
		color: var(--danger);
		overflow-wrap: anywhere;
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
