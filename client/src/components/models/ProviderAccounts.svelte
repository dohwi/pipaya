<script lang="ts">
	import Button from "../ui/Button.svelte";
	import { localeTag, t } from "../../lib/i18n";
	import Icon from "../ui/Icon.svelte";
	import Badge from "../ui/Badge.svelte";
	import { app } from "../../lib/store.svelte";
	import { Api, errorText } from "../../lib/api";
	import type { ProviderInfo } from "../../lib/types";

	/** Built-in providers that are signed in (OAuth) or have a stored key. Adding one happens in ConnectModal. */
	let { serverId, refresh = 0, onchange }: { serverId: string; refresh?: number; onchange?: () => void } = $props();
	const server = $derived(app.servers.find((s) => s.id === serverId));
	const api = () => (server ? new Api({ baseUrl: server.baseUrl, token: server.token }) : null);

	let providers = $state<ProviderInfo[]>([]);
	let error = $state("");
	let busy = $state(false);
	let seq = 0;

	const connected = $derived(providers.filter((p) => p.builtin && p.storedCredential).sort((a, b) => a.name.localeCompare(b.name, localeTag())));

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
			<li data-provider={p.id}>
				<div class="meta">
					<span class="pname">{p.name}{#if p.accountEmail}<span class="email">{p.accountEmail}</span>{/if}</span>
					<div class="tags">
						<Badge variant="outline" size="sm" mono>{p.storedCredential === "oauth" ? "OAuth" : "API KEY"}</Badge>
						{#if p.configured}<Badge tone="ok" size="sm"><Icon name="check" /> {t("사용 가능")}</Badge>{/if}
					</div>
				</div>
				<Button size="sm" class="act" disabled={busy} onclick={() => logout(p)}>{t("연결 해제")}</Button>
			</li>
		{/each}
	</ul>
{/if}

<style>
	.list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
	/* borderless page-tinted surface inside .set-group (no box-in-box, matching ListItem) */
	li { display: flex; align-items: center; gap: 8px 12px; flex-wrap: wrap; padding: 12px; border-radius: var(--radius-sm); background: var(--item-bg, var(--bg)); }
	.meta { flex: 1 1 160px; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
	.pname { font-size: var(--fs-sm); line-height: 20px; font-weight: 500; display: flex; flex-direction: column; }
	.email { font-size: var(--fs-xs); line-height: 16px; font-weight: 400; color: var(--text-dim); overflow-wrap: anywhere; }
	.tags { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; }
	li :global(.act) { flex: none; margin-left: auto; white-space: nowrap; }
	@media (max-width: 640px) {
		li :global(.act) { width: 100%; margin-left: 0; }
	}
	.bad { color: var(--danger); margin: 0; font-size: var(--fs-sm); }
</style>
