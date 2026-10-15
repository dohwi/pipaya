<script lang="ts">
	import { msg, t, tc } from "../lib/i18n";
	import ConfirmButton from "./ConfirmButton.svelte";
	import { collapseIn, collapseOut, reflow, rowIn, rowOut } from "../lib/motion";
	import { sheetPull } from "../lib/sheet";
	import Icon from "./Icon.svelte";
	import Modal from "./Modal.svelte";
	import Switch from "./Switch.svelte";
	import Accordion from "./Accordion.svelte";
	import ModelField from "./ModelField.svelte";
	import { app } from "../lib/store.svelte";
	import { Api, errorText } from "../lib/api";
	import Badge from "./Badge.svelte";
	import ConnectionForm, { localPresets, type LocalPreset } from "./ConnectionForm.svelte";
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
	let tests = $state<Record<string, ConnectionResult | "running">>({});
	let keyFor = $state<string | null>(null);
	let keyValue = $state("");

	/** The "add connection" picker, and a counter that makes the signed-in account list reload after it changes something. */
	let picking = $state(false);
	/** The add / edit dialog (ConnectionForm) and what it opened for; null = closed. */
	let form = $state<{ kind: "new"; preset?: LocalPreset } | { kind: "edit"; provider: CustomProvider } | null>(null);
	let accountsTick = $state(0);

	/* ---------- loading (per selected server) ---------- */

	let loadSeq = 0;
	async function load(id: string) {
		const s = app.servers.find((x) => x.id === id);
		cfg = null;
		models = [];
		loadError = "";
		form = null;
		keyFor = null;
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

	/* ---------- provider actions ---------- */

	async function remove(p: CustomProvider) {
		const a = api();
		if (!a) return;
		busy = true;
		try {
			await a.deleteCustomProvider(p.id);
			await reload();
		} catch (e) {
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
			<div class="mono-label">{t("새 대화 기본 모델")}</div>
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
			<div class="mono-label">{t("연결")}</div>
			<ProviderAccounts {serverId} refresh={accountsTick} onchange={() => void load(serverId)} />
			{#if cfg.providers.length}
				<div class="plist">
					{#each cfg.providers as p (p.id)}
						<div class="prov" animate:reflow in:rowIn out:rowOut>
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
								<button class="btn sm" disabled={busy} onclick={() => (form = { kind: "edit", provider: p })}><Icon name="pencil" /> {t("수정")}</button>
								<ConfirmButton size="sm" class="ghost" confirmLabel={t("정말 삭제")} disabled={busy} onconfirm={() => remove(p)}>{t("삭제")}</ConfirmButton>
							</div>
							{#if keyFor === p.id}
								<form class="keyform" in:collapseIn out:collapseOut onsubmit={(e) => { e.preventDefault(); void saveKey(p); }}>
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
				oncustom={(id) => (form = { kind: "new", preset: localPresets.find((l) => l.id === id) })}
			/>
		{/if}

		{#if form}
			<!-- nested inside another (transformed) modal, so it lifts itself to <body> -->
			<ConnectionForm {api} start={form} onclose={() => (form = null)} onsaved={() => { form = null; void reload(); }} />
		{/if}
	{/if}
</div>


<style>
	.mc {
		display: flex;
		flex-direction: column;
		gap: 22px;
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
	.tag :global(svg) {
		width: 14px;
		height: 14px;
		stroke: currentColor;
		fill: none;
		stroke-width: 1.8;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	.res {
		flex-basis: 100%;
		font-size: var(--fs-xs);
		overflow-wrap: anywhere;
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
	.res.ok {
		color: var(--ok);
	}
	.res.bad {
		color: var(--danger);
	}
</style>
