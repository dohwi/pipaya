<script lang="ts">
	import Button from "./Button.svelte";
	import CountdownClose from "./CountdownClose.svelte";
	import { t } from "../lib/i18n";
	import { app } from "../lib/store.svelte";
	import { updater } from "../lib/updater.svelte";
	import { serverUpdater } from "../lib/server-update.svelte";
	import { surfaceIn, surfaceOut } from "../lib/motion";

	/**
	 * Says why things may not work when the app and the server are not the same age (lib/protocol.ts decides which case).
	 * It is a strip at the top of the chat area, in the same stack as the toasts (Toasts.svelte), so every notice lives in one place.
	 *  - The server needs a newer app: nothing else works, so the strip stays until the app is updated.
	 *  - The server is older than the app: it works, but newer features are missing. Shown once when connecting, it goes by
	 *    itself after a while (the ring on its close button) and is not shown again for that server in this session. If the
	 *    server can update itself, the button does it; otherwise the text says to update it (install.sh update).
	 */
	const STAY_MS = 12000;
	let closed = $state<string>("");
	const kind = $derived(app.compat);
	const key = $derived(`${app.serverId}:${kind}`);
	const show = $derived(app.serverId !== null && kind !== "ok" && closed !== key && !(kind === "update-server" && app.net !== "online"));
	const busy = $derived(serverUpdater.busy);

	// once per connection: an old-server strip leaves by itself, unless the server is being updated right now
	$effect(() => {
		if (!show || kind !== "update-server" || busy) return;
		const k = key;
		const timer = setTimeout(() => (closed = k), STAY_MS);
		return () => clearTimeout(timer);
	});

	async function updateServer() {
		if (!app.api) return;
		const ok = await serverUpdater.apply(app.api);
		if (ok) {
			app.toast(t("서버를 업데이트했습니다"), "ok");
			await app.sync();
		}
	}
	function updateApp() {
		void updater.check(true).then(() => {
			if (updater.phase === "available") updater.dismissed = "";
		});
	}
</script>

{#if show}
	<!-- the same box, tint and hairline as a toast strip (ToastStrip.svelte) -->
	<div class="strip" class:danger={kind === "update-app"} role={kind === "update-app" ? "alert" : "status"} in:surfaceIn={{ y: -10 }} out:surfaceOut={{ y: -10 }}>
		<span class="msg">
			{#if kind === "update-app"}
				{t("이 서버는 더 새로운 앱이 필요합니다. 앱을 업데이트하세요")}
			{:else if serverUpdater.available}
				{t("서버가 앱보다 오래된 버전입니다. 일부 기능이 동작하지 않을 수 있습니다")}
			{:else}
				{t("서버가 앱보다 오래된 버전입니다. 서버에서 업데이트를 실행하세요 (install.sh update)")}
			{/if}
			{#if serverUpdater.error}<span class="err">{serverUpdater.error}</span>{/if}
		</span>
		{#if kind === "update-app" && updater.supported}
			<Button size="sm" onclick={updateApp}>{t("업데이트 확인")}</Button>
		{:else if kind === "update-server" && serverUpdater.available}
			<Button size="sm" disabled={busy} onclick={updateServer}>
				{busy ? t("서버를 업데이트하는 중…") : t("서버 업데이트")}
			</Button>
		{/if}
		{#if kind === "update-server"}
			<CountdownClose ms={STAY_MS} onclick={() => (closed = key)} label={t("나중에")} />
		{/if}
	</div>
{/if}

<style>
	.strip {
		--tone: var(--warn);
		pointer-events: auto;
		display: flex;
		align-items: center;
		gap: 8px;
		min-height: 44px;
		padding: 4px 8px 4px 16px;
		background: color-mix(in srgb, var(--tone) 16%, var(--bg-elev));
		border-bottom: 1px solid color-mix(in srgb, var(--tone) 25%, var(--border-strong));
		color: var(--text);
		font-size: var(--fs-sm);
		line-height: 1.4;
	}
	.strip.danger {
		--tone: var(--danger);
	}
	.msg {
		flex: 1;
		min-width: 0;
		overflow-wrap: anywhere;
		word-break: keep-all;
	}
	.err {
		display: block;
		color: var(--danger);
	}
	/* the button is the page-coloured one, like the connection bar's: a solid green on a tinted strip looks stranded */
	.strip :global(.btn) {
		flex: none;
		white-space: nowrap;
		background: var(--bg);
	}
</style>
