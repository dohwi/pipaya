<script lang="ts">
	import { onMount } from "svelte";
	import Button from "./Button.svelte";
	import Switch from "./Switch.svelte";
	import SettingRow from "./SettingRow.svelte";
	import { collapseIn, collapseOut } from "../lib/motion";
	import { t } from "../lib/i18n";
	import { app } from "../lib/store.svelte";

	/** Desktop app only: let other devices reach the bundled server (this PC only by default). */
	let available = $state(false);
	let shared = $state(false);
	let host = $state("");
	let port = $state("");
	let saved = $state({ host: "", port: 0 });
	let busy = $state(false);
	let error = $state("");

	const wanted = $derived({ host: shared ? host.trim() || "0.0.0.0" : "", port: Number(port) || 0 });
	const dirty = $derived(wanted.host !== saved.host || wanted.port !== saved.port);
	const badPort = $derived(port !== "" && !(Number(port) >= 1 && Number(port) <= 65535));

	onMount(async () => {
		const b = await app.localBind();
		if (!b) return;
		available = true;
		saved = b;
		shared = !!b.host;
		host = b.host;
		port = b.port ? String(b.port) : "";
	});

	async function apply() {
		busy = true;
		error = "";
		try {
			await app.setLocalBind(wanted.host, wanted.port);
			saved = wanted;
		} catch (e) {
			error = String(e);
		} finally {
			busy = false;
		}
	}
</script>

{#if available}
	<div class="section-label">{t("내장 서버")}</div>
	<SettingRow label={t("다른 기기에서 접속 허용")} hint={t("끄면 이 PC에서만 접속됩니다. 접속은 토큰이 있어야 합니다")}>
		<Switch checked={shared} label={t("다른 기기에서 접속 허용")} onchange={(on) => (shared = on)} />
	</SettingRow>
	{#if shared}
		<div in:collapseIn out:collapseOut>
			<SettingRow label={t("수신 주소")} for="local-host" hint={t("Tailscale IP를 권장합니다. 0.0.0.0은 같은 네트워크의 모든 기기에 열립니다")}>
				<input id="local-host" type="text" placeholder="0.0.0.0" bind:value={host} autocomplete="off" spellcheck="false" />
			</SettingRow>
		</div>
	{/if}
	<SettingRow label={t("포트")} for="local-port" hint={t("비워 두면 8788을 쓰고, 사용 중이면 빈 포트를 고릅니다")}>
		<input id="local-port" type="number" min="1" max="65535" placeholder="8788" bind:value={port} />
	</SettingRow>
	<div class="actions">
		<Button size="sm" disabled={!dirty || busy || badPort} onclick={apply}>{busy ? t("적용 중…") : t("적용")}</Button>
	</div>
	{#if error}<p class="hint danger" role="alert" in:collapseIn out:collapseOut>{error}</p>{/if}
	<p class="hint">{t("적용하면 내장 서버가 다시 시작됩니다. 진행 중인 작업은 중단됩니다")}</p>
{/if}

<style>
	.actions {
		display: flex;
		justify-content: flex-end;
		margin-top: 4px;
	}
	input {
		width: 160px;
		padding: 4px 8px;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg-input, transparent);
		color: inherit;
		font: inherit;
	}
	input:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}
</style>
