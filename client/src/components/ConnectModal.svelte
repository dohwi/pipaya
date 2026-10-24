<script lang="ts">
	import Button from "./Button.svelte";
	import { onDestroy } from "svelte";
	import { t } from "../lib/i18n";
	import Icon from "./Icon.svelte";
	import Badge from "./Badge.svelte";
	import Modal from "./Modal.svelte";
	import ModalHeader from "./ModalHeader.svelte";
	import { app } from "../lib/store.svelte";
	import { Api, errorText } from "../lib/api";
	import { copyText } from "../lib/clipboard";
	import { openExternal } from "../lib/tauri";
	import Segmented from "./Segmented.svelte";
	import { paneIn } from "../lib/motion";
	import type { LoginState, ProviderInfo } from "../lib/types";

	/**
	 * "Add connection": every way to connect a model, in two groups.
	 *  - OAuth: sign in with an account (the server runs the provider's login; a redirect URL can be pasted back).
	 *  - API key: cloud services (a key), local runtimes (Ollama …) and any OpenAI-compatible endpoint.
	 */
	let {
		serverId,
		locals,
		taken,
		onclose,
		onchange,
		oncustom,
	}: {
		serverId: string;
		/** Local runtimes the connection form can prefill */
		locals: { id: string; name: string; baseUrl: string }[];
		/** Ids that are already connected as custom endpoints */
		taken: Set<string>;
		onclose: () => void;
		onchange?: () => void;
		/** Open the endpoint form (optionally prefilled with a local runtime id) */
		oncustom: (presetId?: string) => void;
	} = $props();

	const server = $derived(app.servers.find((s) => s.id === serverId));
	const api = () => (server ? new Api({ baseUrl: server.baseUrl, token: server.token }) : null);

	let tab = $state<"oauth" | "key">("oauth");
	let providers = $state<ProviderInfo[]>([]);
	let query = $state("");
	let error = $state("");
	let busy = $state(false);

	let login = $state<LoginState | null>(null);
	let keyFor = $state<ProviderInfo | null>(null);
	let keyValue = $state("");
	let answer = $state("");
	let opened = new Set<string>();
	let launched = $state(false);
	let timer: ReturnType<typeof setTimeout> | undefined;
	let closer: ReturnType<typeof setTimeout> | undefined;

	const builtin = $derived(providers.filter((p) => p.builtin));
	const match = (name: string) => !query.trim() || name.toLowerCase().includes(query.trim().toLowerCase());
	const byName = (a: ProviderInfo, b: ProviderInfo) => Number(a.configured) - Number(b.configured) || a.name.localeCompare(b.name);
	const oauthList = $derived(builtin.filter((p) => p.loginMethods?.includes("oauth") && match(p.name)).sort(byName));
	const keyList = $derived(builtin.filter((p) => match(p.name)).sort(byName));
	const localList = $derived(locals.filter((l) => match(l.name)));
	const nameOf = (id: string) => providers.find((p) => p.id === id)?.name ?? id;

	async function load() {
		const a = api();
		if (!a) return;
		try {
			providers = await a.providers();
		} catch (e) {
			error = errorText(e);
		}
	}
	void load();
	onDestroy(() => {
		stop();
		clearTimeout(closer);
		void cancel();
	});

	function stop() {
		clearTimeout(timer);
		timer = undefined;
	}

	function apply(next: LoginState) {
		login = next;
		for (const e of next.events) {
			// The sign-in page opens by itself once; the button stays in case a popup blocker stopped it.
			if (e.type === "auth_url" && !opened.has(e.url)) {
				opened.add(e.url);
				launched = true;
				void openExternal(e.url);
			}
		}
		if (next.status === "running") {
			stop();
			timer = setTimeout(poll, 1000);
			return;
		}
		stop();
		void load();
		onchange?.();
		if (serverId === app.serverId) void app.refreshProviders();
		if (next.status === "done") closer = setTimeout(onclose, 1100);
	}
	async function poll() {
		const a = api();
		if (!a || !login) return;
		try {
			apply(await a.login(login.id));
		} catch (e) {
			stop();
			login = { ...login, status: "error", error: errorText(e) };
		}
	}

	async function start(p: ProviderInfo, type: "api_key" | "oauth") {
		const a = api();
		if (!a) return;
		busy = true;
		answer = "";
		opened = new Set();
		launched = false;
		try {
			apply(await a.startLogin(p.id, type));
		} catch (e) {
			app.toast(t("로그인을 시작하지 못했습니다: {error}", { error: errorText(e) }), "error");
		} finally {
			busy = false;
		}
	}
	async function submitAnswer(value: string) {
		const a = api();
		const l = login;
		if (!a || !l?.prompt) return;
		busy = true;
		try {
			apply(await a.answerLogin(l.id, l.prompt.id, value));
			answer = "";
		} catch (e) {
			app.toast(errorText(e), "error");
			void poll();
		} finally {
			busy = false;
		}
	}
	async function cancel() {
		const a = api();
		const l = login;
		stop();
		if (!a || !l || l.status !== "running") return;
		try {
			await a.cancelLogin(l.id);
		} catch {
			/* the flow ended on its own */
		}
	}
	async function back() {
		await cancel();
		login = null;
		keyFor = null;
		keyValue = "";
	}

	/** A key connection: the provider's own key setup when it has one, else a plain key field. */
	function pickKey(p: ProviderInfo) {
		if (p.loginMethods?.includes("api_key")) void start(p, "api_key");
		else {
			keyFor = p;
			keyValue = "";
		}
	}
	async function saveKey() {
		const a = api();
		const p = keyFor;
		if (!a || !p || !keyValue.trim()) return;
		busy = true;
		try {
			await a.setCredential(p.id, keyValue.trim());
			onchange?.();
			if (serverId === app.serverId) await app.refreshProviders();
			app.toast(t("{name} 연결됨", { name: p.name }), "ok");
			onclose();
		} catch (e) {
			app.toast(t("키를 저장하지 못했습니다: {error}", { error: errorText(e) }), "error");
		} finally {
			busy = false;
		}
	}
	function custom(id?: string) {
		onclose();
		oncustom(id);
	}

	const running = $derived(login?.status === "running");
	const inFlow = $derived(!!login || !!keyFor);
	const title = $derived(login ? nameOf(login.providerId) : keyFor ? keyFor.name : t("연결 추가"));
	const authUrl = $derived.by(() => {
		const list = login?.events ?? [];
		for (let i = list.length - 1; i >= 0; i--) {
			const e = list[i]!;
			if (e.type === "auth_url") return e;
		}
		return undefined;
	});
</script>

<Modal onclose={() => !busy && onclose()} onescape={() => (inFlow ? void back() : onclose())} dismissible={!busy} label={t("연결 추가")} width="m" maxHeight="720px" layer={3} portal>
	<div class="cm">
		<ModalHeader {title} divider onback={inFlow ? back : undefined} {onclose} closeDisabled={busy} />

		<div class="body">
			{#if error}<p class="bad" role="alert">{error}</p>{/if}

			{#if login}
				<div class="flow" role="status" aria-live="polite">
					{#if login.status === "done"}
						<div class="done"><Icon name="check" /> <b>{t("연결됨")}</b></div>
					{:else}
						{#if login.type === "oauth"}
							<ol class="steps">
								<li class:on={!!authUrl} class:ok={!!authUrl && launched}>
									<b>{t("브라우저에서 로그인")}</b>
									{#if authUrl}
										<span>{authUrl.instructions ?? t("로그인 페이지가 열립니다. 열리지 않으면 아래 버튼을 누르세요.")}</span>
										<div class="row">
											<Button variant="primary" size="sm" onclick={() => openExternal(authUrl.url)}>{t("로그인 페이지 열기")}</Button>
											<Button variant="ghost" size="sm" onclick={() => copyText(authUrl.url)}><Icon name="copy" /> {t("주소 복사")}</Button>
										</div>
									{:else}
										<span>{t("로그인 주소를 준비하는 중…")}</span>
									{/if}
								</li>
								<li class:on={running}>
									<b>{t("로그인 완료")}</b>
									<span>{t("로그인이 끝나면 자동으로 연결됩니다. 이 서버가 다른 컴퓨터에 있어 자동으로 안 끝나면, 로그인 후 열린 페이지(localhost로 시작하는 주소가 열리지 않아도 됩니다)의 주소 전체를 복사해 아래에 붙여넣으세요.")}</span>
								</li>
							</ol>
						{/if}

						{#each login.events as e}
							{#if e.type === "device_code"}
								<div class="device">
									<span>{t("아래 코드를 입력하세요.")}</span>
									<code class="code">{e.userCode}</code>
									<Button size="sm" onclick={() => openExternal(e.verificationUri)}>{e.verificationUri}</Button>
								</div>
							{:else if e.type === "info" || e.type === "progress"}
								<p class="msg">{e.message}</p>
								{#if e.type === "info"}<div class="row">{#each e.links ?? [] as l}<Button variant="ghost" size="sm" onclick={() => openExternal(l.url)}>{l.label ?? l.url}</Button>{/each}</div>{/if}
							{/if}
						{/each}

						{#if login.prompt}
							{@const pr = login.prompt}
							<div class="ask">
								<p class="msg">{pr.type === "manual_code" ? t("리디렉션 URL 또는 코드 붙여넣기") : pr.message}</p>
								{#if pr.type === "manual_code" && pr.message}<p class="hint">{pr.message}</p>{/if}
								{#if pr.type === "select"}
									<div class="row">{#each pr.options as o (o.id)}<Button size="sm" disabled={busy} title={o.description} onclick={() => submitAnswer(o.id)}>{o.label}</Button>{/each}</div>
								{:else}
									<form class="row" onsubmit={(e) => { e.preventDefault(); if (answer.trim()) void submitAnswer(answer.trim()); }}>
										<!-- svelte-ignore a11y_autofocus -->
										<input class="field mono" type={pr.type === "secret" ? "password" : "text"} placeholder={pr.type === "manual_code" ? "http://localhost:…/callback?code=…" : (pr.placeholder ?? "")} bind:value={answer} autocomplete="off" autocapitalize="off" spellcheck="false" autofocus />
										<Button variant="primary" type="submit" disabled={busy || !answer.trim()}>{t("확인")}</Button>
									</form>
								{/if}
							</div>
						{/if}
						{#if login.error}<p class="bad" role="alert">{login.error}</p>{/if}
						{#if login.status === "cancelled"}<p class="hint">{t("취소됨")}</p>{/if}
					{/if}
				</div>
			{:else if keyFor}
				<form class="flow" onsubmit={(e) => { e.preventDefault(); void saveKey(); }}>
					<p class="hint">{t("{name}의 API 키를 붙여넣으세요. 키는 서버에만 저장됩니다.", { name: keyFor.name })}</p>
					<!-- svelte-ignore a11y_autofocus -->
					<input class="field mono" type="password" placeholder={t("API 키")} bind:value={keyValue} autocomplete="off" autocapitalize="off" spellcheck="false" autofocus />
					<Button variant="primary" type="submit" disabled={busy || !keyValue.trim()}>{t("저장")}</Button>
				</form>
			{:else}
				<Segmented tabs label={t("연결 방식")} value={tab} onchange={(id) => (tab = id)} options={[{ id: "oauth", label: "OAuth" }, { id: "key", label: "API KEY" }]} />
				<p class="hint lead">{tab === "oauth" ? t("계정으로 로그인해 구독이나 계정에 묶인 모델을 씁니다. 키를 직접 다룰 필요가 없습니다.") : t("API 키로 연결합니다. 로컬 모델과 OpenAI 호환 주소도 여기서 추가합니다.")}</p>
				<div class="search"><Icon name="search" /><input class="field" placeholder={t("검색")} bind:value={query} aria-label={t("검색")} autocomplete="off" spellcheck="false" /></div>

				{#key tab}
				<div class="tabpane" in:paneIn={{ x: tab === "oauth" ? -18 : 18 }}>
				{#if tab === "oauth"}
					<ul class="list">
						{#each oauthList as p (p.id)}
							<li>
								<button class="item" disabled={busy} onclick={() => start(p, "oauth")}>
									<span class="pname">{p.name}</span>
									{#if p.configured}<Badge tone="ok" size="sm">{t("사용 가능")}</Badge>{/if}
									<Icon name="chevron-right" />
								</button>
							</li>
						{:else}
							<li class="empty">{t("해당하는 서비스가 없습니다")}</li>
						{/each}
					</ul>
				{:else}
					<div class="group">{t("서비스")}</div>
					<ul class="list">
						{#each keyList as p (p.id)}
							<li>
								<button class="item" disabled={busy} onclick={() => pickKey(p)}>
									<span class="pname">{p.name}</span>
									{#if p.configured}<Badge tone="ok" size="sm">{t("사용 가능")}</Badge>{/if}
									<Icon name="chevron-right" />
								</button>
							</li>
						{/each}
					</ul>
					<div class="group">{t("로컬 모델 (서버 PC에서 실행 중인 것)")}</div>
					<ul class="list">
						{#each localList as l (l.id)}
							<li>
								<button class="item" disabled={taken.has(l.id)} onclick={() => custom(l.id)}>
									<span class="pname">{l.name}</span>
									<span class="mono sub">{l.baseUrl}</span>
									{#if taken.has(l.id)}<Badge variant="outline" size="sm">{t("추가됨")}</Badge>{/if}
									<Icon name="chevron-right" />
								</button>
							</li>
						{/each}
					</ul>
					<div class="group">{t("직접 입력")}</div>
					<ul class="list">
						<li>
							<button class="item" onclick={() => custom()}>
								<span class="pname">{t("OpenAI 호환 / Anthropic 호환 주소")}</span>
								<Icon name="chevron-right" />
							</button>
						</li>
					</ul>
				{/if}
				</div>
				{/key}
			{/if}
		</div>
	</div>
</Modal>

<style>
	.cm { display: flex; flex-direction: column; min-height: 0; flex: 1; }
	.body { display: flex; flex-direction: column; gap: 12px; padding: 16px 22px 20px; overflow-y: auto; min-height: 0; }
	.hint { margin: 0; line-height: 1.55; word-break: keep-all; }
	.hint.lead { margin-top: -4px; }
	.bad { color: var(--danger); margin: 0; font-size: var(--fs-sm); overflow-wrap: anywhere; }
	.search { position: relative; display: flex; align-items: center; }
	.search :global(svg) { position: absolute; left: 11px; width: 15px; height: 15px; stroke: var(--text-faint); stroke-width: 2; pointer-events: none; }
	.search .field { width: 100%; padding-left: 34px; }
	.group { margin-top: 6px; font-size: var(--fs-xs); font-weight: 600; color: var(--text-dim); }
	.list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
	.tabpane { display: flex; flex-direction: column; gap: 12px; }
	.item { width: 100%; display: flex; align-items: center; gap: 8px; padding: 10px 12px; text-align: left; border: 1px solid var(--border); border-radius: var(--radius); background: var(--bg-elev, var(--bg)); color: var(--text); }
	.item:hover:not(:disabled) { border-color: var(--border-strong); background: var(--bg-active); }
	.item:disabled { opacity: 0.55; cursor: default; }
	.item :global(svg) { flex: none; width: 15px; height: 15px; stroke: var(--text-faint); stroke-width: 2; }
	.pname { flex: 1; min-width: 0; font-size: var(--fs-sm); }
	.sub { font-size: var(--fs-xs); color: var(--text-faint); }
	.empty { padding: 14px; text-align: center; font-size: var(--fs-sm); color: var(--text-faint); }
	.flow { display: flex; flex-direction: column; gap: 14px; }
	.steps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 14px; counter-reset: s; }
	.steps li { position: relative; display: flex; flex-direction: column; gap: 6px; padding-left: 34px; counter-increment: s; font-size: var(--fs-sm); color: var(--text-dim); line-height: 1.55; word-break: keep-all; opacity: 0.6; }
	.steps li.on { opacity: 1; }
	.steps li::before { content: counter(s); position: absolute; left: 0; top: -1px; width: 24px; height: 24px; display: grid; place-items: center; border: 1px solid var(--border-strong); border-radius: 50%; background: var(--bg); color: var(--text); font-size: var(--fs-xs); font-weight: 700; }
	.steps li.ok::before { content: "✓"; }
	.steps b { color: var(--text); font-size: var(--fs-md); }
	.row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
	.row .field { flex: 1; min-width: 0; }
	.row :global(svg) { width: 14px; height: 14px; stroke-width: 2; }
	.ask { display: flex; flex-direction: column; gap: 8px; padding: 12px; border: 1px dashed var(--border-strong); border-radius: var(--radius); background: var(--bg); }
	.msg { margin: 0; font-size: var(--fs-sm); overflow-wrap: anywhere; }
	.device { display: flex; flex-direction: column; gap: 8px; align-items: flex-start; font-size: var(--fs-sm); }
	.code { font-size: 1.4em; font-weight: 700; letter-spacing: 0.1em; user-select: all; }
	.done { display: flex; align-items: center; gap: 8px; justify-content: center; padding: 22px 0; color: var(--ok, #2a9d4b); }
	.done :global(svg) { width: 20px; height: 20px; stroke-width: 2.4; }
</style>
