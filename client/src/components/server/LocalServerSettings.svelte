<script lang="ts">
	import Notice from "../ui/Notice.svelte";
	import { settingsDrafts } from "../../lib/settings-drafts.svelte";
	import { onMount } from "svelte";
	import Button from "../ui/Button.svelte";
	import NumberField from "../ui/NumberField.svelte";
	import Switch from "../ui/Switch.svelte";
	import SettingRow from "../ui/SettingRow.svelte";
	import { collapseIn, collapseOut } from "../../lib/motion";
	import { t } from "../../lib/i18n";
	import { app } from "../../lib/store.svelte";

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
		// an unapplied change from an earlier visit wins over the applied values
		const kept = settingsDrafts.get<{ shared: boolean; host: string; port: string }>("local-bind");
		if (kept) ({ shared, host, port } = kept);
		else {
			shared = !!b.host;
			host = b.host;
			port = b.port ? String(b.port) : "";
		}
	});
	$effect(() => {
		if (!available) return;
		if (dirty) settingsDrafts.set("local-bind", { shared, host, port });
		else settingsDrafts.clear("local-bind");
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
<div class="stack" in:collapseIn> <!-- the card shows up after an async lookup: slide it open instead of popping in -->
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
		<NumberField id="local-port" width="160px" min={1} max={65535} placeholder="8788" bind:value={port} />
	</SettingRow>
	<div class="actions">
		<Button size="sm" {busy} disabled={!dirty || badPort} onclick={apply}>{busy ? t("적용 중…") : t("적용")}</Button>
	</div>
	{#if error}<Notice tone="danger" size="sm" animated>{error}</Notice>{/if}
	<p class="hint">{t("적용하면 내장 서버가 다시 시작됩니다. 진행 중인 작업은 중지됩니다")}</p>
</div>
{/if}

<style>
	/* rows and hints sat flush against each other: one 12px rhythm for the whole block */
	.stack {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}
	/* matches `.set-group > .section-label` in app.css since `.stack` sits between the group and the heading */
	.stack > .section-label {
		font-size: var(--fs-sm);
		line-height: 20px;
		color: var(--text);
	}
	.hint {
		margin: 0;
	}
	.actions {
		display: flex;
		justify-content: flex-end;
	}
	input {
		width: 160px;
		height: var(--control-h-sm);
		padding: 0 12px;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-control);
		background: var(--bg-input, transparent);
		color: inherit;
		font-size: var(--fs-sm);
	}
	input:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}
</style>
