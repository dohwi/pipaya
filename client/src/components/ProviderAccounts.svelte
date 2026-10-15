<script lang="ts">
	import { onDestroy } from "svelte";
	import { t } from "../lib/i18n";
	import Icon from "./Icon.svelte";
	import Accordion from "./Accordion.svelte";
	import { app } from "../lib/store.svelte";
	import { Api, errorText } from "../lib/api";
	import { copyText } from "../lib/clipboard";
	import { openExternal } from "../lib/tauri";
	import type { LoginState, ProviderInfo } from "../lib/types";

	/** Built-in providers (OpenAI, Anthropic, Google, OpenRouter, Copilot …): sign in with an account (OAuth) or a key. */
	let { serverId, onchange }: { serverId: string; onchange?: () => void } = $props();
	const server = $derived(app.servers.find((s) => s.id === serverId));
	const api = () => (server ? new Api({ baseUrl: server.baseUrl, token: server.token }) : null);

	let providers = $state<ProviderInfo[]>([]);
	let error = $state("");
	let busy = $state(false);
	let login = $state<LoginState | null>(null);
	let answer = $state("");
	let opened = new Set<string>();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let seq = 0;

	const builtin = $derived(
		providers
			.filter((p) => p.builtin)
			.sort((a, b) => Number(b.configured) - Number(a.configured) || Number(!!b.loginMethods?.includes("oauth")) - Number(!!a.loginMethods?.includes("oauth")) || a.name.localeCompare(b.name)),
	);
	const nameOf = (id: string) => providers.find((p) => p.id === id)?.name ?? id;

	async function load() {
		const a = api();
		const mine = ++seq;
		if (!a) return;
		try {
			const list = await a.providers();
			if (mine === seq) providers = list;
			error = "";
		} catch (e) {
			if (mine === seq) error = errorText(e);
		}
	}
	$effect(() => {
		void serverId;
		stop();
		login = null;
		void load();
	});
	// Another client signed in or out.
	let lastTick = app.configTick;
	$effect(() => {
		const tick = app.configTick;
		if (tick !== lastTick) void load();
		lastTick = tick;
	});
	onDestroy(() => { stop(); void cancel(); });

	function stop() {
		clearTimeout(timer);
		timer = undefined;
	}

	function apply(next: LoginState) {
		login = next;
		for (const e of next.events) {
			// The browser sign-in page opens by itself once; the link stays available in case a popup blocker stopped it.
			if (e.type === "auth_url" && !opened.has(e.url)) {
				opened.add(e.url);
				void openExternal(e.url);
			}
		}
		if (next.status === "running") {
			stop();
			timer = setTimeout(poll, 1000);
		} else {
			stop();
			void load();
			onchange?.();
			if (serverId === app.serverId) void app.refreshProviders();
		}
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
		try { apply(await a.cancelLogin(l.id)); } catch { /* the flow ended on its own */ }
	}
	async function logout(p: ProviderInfo) {
		const a = api();
		if (!a) return;
		busy = true;
		try {
			await a.removeCredential(p.id);
			await load();
			onchange?.();
			if (serverId === app.serverId) await app.refreshProviders();
		} catch (e) {
			app.toast(t("연결을 해제하지 못했습니다: {error}", { error: errorText(e) }), "error");
		} finally {
			busy = false;
		}
	}
	const running = $derived(login?.status === "running");
</script>

<section class="pa">
	<div class="label">{t("계정 연결 (OpenAI, Anthropic, Google …)")}</div>
	{#if error}<p class="bad" role="alert">{error}</p>{/if}

	{#if login}
		<div class="flow" role="status">
			<div class="fhead"><b>{nameOf(login.providerId)}</b>
				{#if login.status === "done"}<span class="chip ok">{t("연결됨")}</span>
				{:else if login.status === "error"}<span class="chip bad">{t("실패")}</span>
				{:else if login.status === "cancelled"}<span class="chip">{t("취소됨")}</span>{/if}
			</div>
			{#each login.events as e}
				{#if e.type === "auth_url"}
					<p>{e.instructions ?? t("브라우저에서 로그인을 완료하세요.")}</p>
					<div class="row">
						<button class="btn sm" onclick={() => openExternal(e.url)}>{t("로그인 페이지 열기")}</button>
						<button class="btn ghost sm" onclick={() => copyText(e.url)}>{t("주소 복사")}</button>
					</div>
				{:else if e.type === "device_code"}
					<p>{t("아래 코드를 입력하세요.")} <code class="code">{e.userCode}</code></p>
					<div class="row"><button class="btn sm" onclick={() => openExternal(e.verificationUri)}>{e.verificationUri}</button></div>
				{:else}
					<p>{e.message}</p>
					{#if e.type === "info"}{#each e.links ?? [] as l}<button class="btn ghost sm" onclick={() => openExternal(l.url)}>{l.label ?? l.url}</button>{/each}{/if}
				{/if}
			{/each}
			{#if login.prompt}
				{@const pr = login.prompt}
				<p>{pr.message}</p>
				{#if pr.type === "select"}
					<div class="row">{#each pr.options as o (o.id)}<button class="btn sm" disabled={busy} title={o.description} onclick={() => submitAnswer(o.id)}>{o.label}</button>{/each}</div>
				{:else}
					<form class="row" onsubmit={(e) => { e.preventDefault(); if (answer.trim()) void submitAnswer(answer.trim()); }}>
						<!-- svelte-ignore a11y_autofocus -->
						<input class="field mono" type={pr.type === "secret" ? "password" : "text"} placeholder={pr.placeholder ?? ""} bind:value={answer} autocomplete="off" autocapitalize="off" spellcheck="false" autofocus />
						<button class="btn primary" disabled={busy || !answer.trim()}>{t("확인")}</button>
					</form>
				{/if}
			{/if}
			{#if login.error}<p class="bad">{login.error}</p>{/if}
			<div class="row">
				{#if running}<button class="btn ghost sm" onclick={cancel}>{t("취소")}</button>
				{:else}<button class="btn ghost sm" onclick={() => (login = null)}>{t("닫기")}</button>{/if}
			</div>
		</div>
	{/if}

	<Accordion variant="text">
		{#snippet head()}{t("서비스 {n}개", { n: builtin.length })}{/snippet}
		<ul class="list">
			{#each builtin as p (p.id)}
				<li>
					<span class="pname">{p.name}</span>
					{#if p.configured}<span class="chip ok">{t("사용 가능")}</span>{/if}
					<span class="acts">
						{#if p.storedCredential}
							<button class="btn ghost sm" disabled={busy || running} onclick={() => logout(p)}>{t("연결 해제")}</button>
						{:else}
							{#if p.loginMethods?.includes("oauth")}
								<button class="btn sm" disabled={busy || running} onclick={() => start(p, "oauth")}><Icon name="key" /> {p.oauthLabel ?? t("로그인")}</button>
							{/if}
							{#if p.loginMethods?.includes("api_key")}
								<button class="btn sm" disabled={busy || running} onclick={() => start(p, "api_key")}><Icon name="key" /> {t("API 키")}</button>
							{/if}
						{/if}
					</span>
				</li>
			{/each}
		</ul>
	</Accordion>
</section>

<style>
	.pa { display: flex; flex-direction: column; gap: 8px; }
	.label { font-size: var(--fs-xs); font-weight: 600; color: var(--text-dim); }
	.list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
	li { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
	.pname { flex: 1; min-width: 120px; font-size: var(--fs-sm); }
	.acts { display: flex; gap: 6px; flex-wrap: wrap; }
	.flow { display: flex; flex-direction: column; gap: 8px; padding: 10px; border: 1px solid var(--border); border-radius: 8px; }
	.flow p { margin: 0; font-size: var(--fs-sm); overflow-wrap: anywhere; }
	.fhead, .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
	.row .field { flex: 1; min-width: 0; }
	.code { font-size: var(--fs-lg, 1.2em); font-weight: 700; letter-spacing: 0.08em; user-select: all; }
	.bad { color: var(--danger); margin: 0; font-size: var(--fs-sm); }
	.chip { font-size: var(--fs-xs); padding: 1px 7px; border-radius: 999px; border: 1px solid var(--border); }
	.chip.ok { color: var(--ok, #2a9d4b); }
	.chip.bad { color: var(--danger); }
</style>
