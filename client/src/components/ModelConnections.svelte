<script lang="ts">
	import Button from "./Button.svelte";
	import { t } from "../lib/i18n";
	import { reflow, rowIn, rowOut } from "../lib/motion";
	import Icon from "./Icon.svelte";
	import ModelField from "./ModelField.svelte";
	import { app } from "../lib/store.svelte";
	import { Api, errorText } from "../lib/api";
	import ProviderCard from "./connection/ProviderCard.svelte";
	import ConnectionForm, { localPresets } from "./ConnectionForm.svelte";
	import CompactionSection from "./CompactionSection.svelte";
	import SystemModelSection from "./SystemModelSection.svelte";
	import ImageModelSection from "./ImageModelSection.svelte";
	import ProviderAccounts from "./ProviderAccounts.svelte";
	import ConnectModal from "./ConnectModal.svelte";
	import type {
		ConfigurationInfo,
		ConnectionResult,
		CustomProvider,
		DefaultModelSelection,
		ModelInfo,
		ProviderInfo,
		ThinkingLevel,
	} from "../lib/types";

	/** Model connection settings live on each server, so this talks to the chosen server directly, not only the open one. */
	let { serverId }: { serverId: string } = $props();
	const server = $derived(app.servers.find((s) => s.id === serverId));

	let cfg = $state<ConfigurationInfo | null>(null);
	let models = $state<ModelInfo[]>([]);
	/** Image models never run a chat: they are offered only as the image model. */
	const chatModels = $derived(models.filter((m) => !m.imageGeneration));
	let loading = $state(false);
	let loadError = $state("");
	let busy = $state(false);
	let tests = $state<Record<string, ConnectionResult | "running">>({});
	let keyFor = $state<string | null>(null);
	let keyValue = $state("");

	/** The "add connection" picker, and a counter that makes the signed-in account list reload after it changes something. */
	let picking = $state(false);
	/** The edit dialog (ConnectionForm) of one custom connection; null = closed. Adding one is a step inside ConnectModal. */
	let form = $state<{ kind: "edit"; provider: CustomProvider } | null>(null);
	let accountsTick = $state(0);

	/* ---------- loading (per selected server) ---------- */

	let loadSeq = 0;
	/** `quiet` refreshes in place (config changed elsewhere): keeps the current list on screen instead of blanking it. */
	async function load(id: string, quiet = false) {
		const s = app.servers.find((x) => x.id === id);
		if (!quiet) {
			cfg = null;
			models = [];
			form = null;
			keyFor = null;
			tests = {};
		}
		loadError = "";
		if (!s) return;
		const seq = ++loadSeq;
		loading = !quiet;
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
		if (tick !== lastTick && !busy && !form && serverId === app.serverId) void load(serverId, true);
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

	/** Ask the upstream for its model list now: new models are added, ones it no longer lists are marked. */
	let refreshingId = $state<string | null>(null);
	async function refreshModels(p: CustomProvider) {
		const a = api();
		if (!a || refreshingId) return;
		refreshingId = p.id;
		const before = new Set(p.models.map((m) => m.id));
		try {
			const r = await a.refreshCustomProvider(p.id);
			const added = r.models.filter((m) => !before.has(m.id)).length;
			const gone = r.models.filter((m) => m.unavailable).length;
			await reload();
			app.toast(
				added || gone
					? [added ? t("새 모델 {n}개", { n: added }) : "", gone ? t("사용 불가 {n}개", { n: gone }) : ""].filter(Boolean).join(" · ")
					: t("모델 목록이 최신입니다."),
				"ok",
			);
		} catch (e) {
			app.toast(t("모델 목록을 불러오지 못했습니다: {error}", { error: errorText(e) }), "error");
		} finally {
			refreshingId = null;
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
		<p class="hint note">{t("불러오는 중…")}</p>
	{:else if loadError}
		<div class="err" role="alert">
			<span>{loadError}</span>
			<Button size="sm" onclick={() => load(serverId)}><Icon name="retry" /> {t("다시 시도")}</Button>
		</div>
	{:else if cfg}
		<section>
			<div class="section-label">{t("새 대화 기본 모델")}</div>
			<ModelField
				conn={server ? { baseUrl: server.baseUrl, token: server.token } : null}
				models={chatModels}
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
			<p class="hint note">
				{#if !saved}
					{t("서버 기본값을 씁니다.")}{#if cfg.effectiveDefaults} ({cfg.effectiveDefaults.provider}/{cfg.effectiveDefaults.model}){/if}
				{:else if shownInfo && !shownInfo.reasoning}
					{t("이 모델은 추론 모드를 지원하지 않아 추론 강도는 쓰이지 않습니다.")}
				{:else if saved.thinkingLevel}
					{t("새 대화는 추론 강도 {level}로 시작합니다.", { level: saved.thinkingLevel })}
				{:else}
					{t("추론 강도를 지정하지 않아 새 대화는 이 기기의 마지막 설정으로 시작합니다.")}
				{/if}
			</p>
		</section>

		<CompactionSection {serverId} models={chatModels} providers={providerList} />

		<SystemModelSection {serverId} models={chatModels} providers={providerList} />

		<ImageModelSection {serverId} {models} providers={providerList} />

		<section>
			<div class="section-label">{t("연결")}</div>
			<ProviderAccounts {serverId} refresh={accountsTick} onchange={() => void load(serverId)} />
			{#if cfg.providers.length}
				<div class="plist">
					{#each cfg.providers as p (p.id)}
						<div class="provwrap" animate:reflow in:rowIn out:rowOut>
							<ProviderCard
								{p}
								conn={server ? { baseUrl: server.baseUrl, token: server.token } : null}
								{busy}
								{tests}
								keying={keyFor === p.id}
								bind:keyValue
								refreshing={refreshingId === p.id}
								anyRefreshing={refreshingId !== null}
								ontest={(model) => test(p.id, model)}
								ontogglekey={() => { keyFor = keyFor === p.id ? null : p.id; keyValue = ""; }}
								onsavekey={() => void saveKey(p)}
								onremovekey={() => removeKey(p)}
								onrefresh={() => refreshModels(p)}
								onedit={() => (form = { kind: "edit", provider: p })}
								onremove={() => remove(p)}
							/>
						</div>
					{/each}
				</div>
			{/if}

			{#if !form}
				<Button variant="dashed" onclick={() => (picking = true)}><Icon name="plus" /> {t("연결 추가")}</Button>
			{/if}
		</section>

		{#if picking}
			<ConnectModal
				{serverId}
				locals={localPresets}
				taken={new Set(cfg.providers.map((x) => x.id))}
				onclose={() => (picking = false)}
				onchange={() => { accountsTick++; void load(serverId); }}
				onsaved={() => { picking = false; void reload(); }}
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
		gap: 24px;
	}
	.plist {
		display: flex;
		flex-direction: column;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		overflow: hidden;
	}
	.err {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		padding: 8px 12px;
		border: 1px solid var(--danger);
		border-radius: var(--radius);
		font-size: var(--fs-sm);
		color: var(--danger);
		overflow-wrap: anywhere;
	}
	.err > :global(.btn) {
		flex: none;
	}
	section {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.note {
		margin: 0;
	}
	.provwrap:last-child :global(.prov) {
		border-bottom: 0;
	}
</style>
