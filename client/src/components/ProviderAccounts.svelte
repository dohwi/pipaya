<script lang="ts">
	import { t } from "../lib/i18n";
	import Icon from "./Icon.svelte";
	import { app } from "../lib/store.svelte";
	import { Api, errorText } from "../lib/api";
	import type { ProviderInfo } from "../lib/types";

	/** Built-in providers that are signed in (OAuth) or have a stored key. Adding one happens in ConnectModal. */
	let { serverId, refresh = 0, onchange }: { serverId: string; refresh?: number; onchange?: () => void } = $props();
	const server = $derived(app.servers.find((s) => s.id === serverId));
	const api = () => (server ? new Api({ baseUrl: server.baseUrl, token: server.token }) : null);

	let providers = $state<ProviderInfo[]>([]);
	let error = $state("");
	let busy = $state(false);
	let seq = 0;

	const connected = $derived(providers.filter((p) => p.builtin && p.storedCredential).sort((a, b) => a.name.localeCompare(b.name)));

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
		void refresh;
		void load();
	});
	// Another client signed in or out.
	let lastTick = app.configTick;
	$effect(() => {
		const tick = app.configTick;
		if (tick !== lastTick) void load();
		lastTick = tick;
	});

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
</script>

{#if error}<p class="bad" role="alert">{error}</p>{/if}
{#if connected.length}
	<ul class="list">
		{#each connected as p (p.id)}
			<li>
				<span class="pname">{p.name}{#if p.accountEmail}<span class="email">{p.accountEmail}</span>{/if}</span>
				<span class="chip">{p.storedCredential === "oauth" ? "OAuth" : "API KEY"}</span>
				{#if p.configured}<span class="chip ok"><Icon name="check" /> {t("사용 가능")}</span>{/if}
				<button class="btn ghost sm" disabled={busy} onclick={() => logout(p)}>{t("연결 해제")}</button>
			</li>
		{/each}
	</ul>
{/if}

<style>
	.list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
	li { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--radius); }
	.pname { flex: 1; min-width: 120px; font-size: var(--fs-sm); display: flex; flex-direction: column; }
	.email { font-size: var(--fs-xs); color: var(--text-dim); overflow-wrap: anywhere; }
	.bad { color: var(--danger); margin: 0; font-size: var(--fs-sm); }
	.chip { display: inline-flex; align-items: center; gap: 3px; font-size: var(--fs-xs); padding: 1px 7px; border-radius: 999px; border: 1px solid var(--border); color: var(--text-dim); }
	.chip.ok { color: var(--ok, #2a9d4b); }
	.chip :global(svg) { width: 11px; height: 11px; stroke: currentColor; fill: none; stroke-width: 2.6; }
</style>
