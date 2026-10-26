<script lang="ts">
	import Button from "./Button.svelte";
	import { t } from "../lib/i18n";
	import { app } from "../lib/store.svelte";
	import { updater } from "../lib/updater.svelte";
	import { serverUpdater } from "../lib/server-update.svelte";

	/**
	 * Says why things may not work when the app and the server are not the same age (lib/protocol.ts decides which case).
	 *  - The server needs a newer app: nothing else works, so this is shown until the app is updated.
	 *  - The server is older than the app: it works, but newer features are missing. If the server can update itself, the
	 *    button does it; otherwise the text says to update it (install.sh update).
	 * The notice for an older server can be closed for the rest of the session.
	 */
	let closed = $state<string>("");
	const kind = $derived(app.compat);
	const key = $derived(`${app.serverId}:${kind}`);
	const show = $derived(app.serverId !== null && kind !== "ok" && closed !== key && !(kind === "update-server" && app.net !== "online"));
	const busy = $derived(serverUpdater.busy);

	/**
	 * Centred on the chat area (the stage), not the window, so the sidebar does not push it off the input's centre; it sits
	 * just above the composer (Composer publishes --composer-top) instead of covering it. Without a chat area it spans the window.
	 */
	let box = $state<{ left: number; width: number } | null>(null);
	$effect(() => {
		if (!show) return;
		const stage = document.querySelector<HTMLElement>(".stage");
		if (!stage) { box = null; return; }
		const measure = () => { const r = stage.getBoundingClientRect(); box = { left: r.left, width: r.width }; };
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(stage);
		window.addEventListener("resize", measure);
		return () => { ro.disconnect(); window.removeEventListener("resize", measure); };
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
	<div class="notice" class:danger={kind === "update-app"} class:anchored={!!box} style:left={box ? `${box.left + box.width / 2}px` : null} style:--stage-w={box ? `${box.width}px` : null} role={kind === "update-app" ? "alert" : "status"}>
		<p class="text">
			{#if kind === "update-app"}
				{t("이 서버는 더 새로운 앱이 필요합니다. 앱을 업데이트하세요")}
			{:else if serverUpdater.available}
				{t("서버가 앱보다 오래된 버전입니다. 일부 기능이 동작하지 않을 수 있습니다")}
			{:else}
				{t("서버가 앱보다 오래된 버전입니다. 서버에서 업데이트를 실행하세요 (install.sh update)")}
			{/if}
		</p>
		{#if serverUpdater.error}<p class="text err">{serverUpdater.error}</p>{/if}
		<div class="actions">
			{#if kind === "update-app" && updater.supported}
				<Button variant="primary" size="sm" onclick={updateApp}>{t("업데이트 확인")}</Button>
			{:else if kind === "update-server" && serverUpdater.available}
				<Button variant="primary" size="sm" disabled={busy} onclick={updateServer}>
					{busy ? t("서버를 업데이트하는 중…") : t("서버 업데이트")}
				</Button>
			{/if}
			{#if kind === "update-server"}<Button size="sm" onclick={() => (closed = key)}>{t("나중에")}</Button>{/if}
		</div>
	</div>
{/if}

<style>
	.notice {
		position: fixed;
		z-index: 30;
		left: 50%;
		bottom: max(calc(16px + env(safe-area-inset-bottom, 0px)), calc(var(--composer-top, 0px) + 12px));
		transform: translateX(-50%);
		width: min(440px, calc(var(--stage-w, var(--vw)) - 24px));
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 12px 14px;
		border-radius: var(--radius);
		border: 1px solid var(--border);
		background: var(--bg-elev);
		box-shadow: 0 6px 24px rgba(0, 0, 0, 0.25);
		font-size: var(--fs-sm);
	}
	.notice.danger {
		border-color: var(--danger);
	}
	.text {
		margin: 0;
		line-height: 1.5;
		word-break: keep-all;
		color: var(--text);
	}
	.err {
		color: var(--danger);
	}
	.actions {
		display: flex;
		gap: 8px;
		justify-content: flex-end;
	}
	.actions:empty {
		display: none;
	}
</style>
