<script lang="ts">
	import { onDestroy } from "svelte";
	import { t } from "../lib/i18n";
	import { Api, errorText } from "../lib/api";
	import { app } from "../lib/store.svelte";
	import { buildPairingLink, isLoopbackUrl } from "../lib/pairing";
	import { copyText } from "../lib/clipboard";
	import QrCode from "./QrCode.svelte";
	import Icon from "./Icon.svelte";

	let { serverId }: { serverId: string } = $props();
	const server = $derived(app.servers.find((s) => s.id === serverId));

	/** The address the phone should use. Starts as the one this PC uses; editable because a PC often reaches the server as localhost. */
	// svelte-ignore state_referenced_locally
	let address = $state(server?.baseUrl ?? "");
	let link = $state("");
	let expiresAt = $state(0);
	let now = $state(Date.now());
	let error = $state("");
	let busy = $state(false);
	let copied = $state(false);

	const left = $derived(Math.max(0, Math.ceil((expiresAt - now) / 1000)));
	const expired = $derived(!!link && left === 0);
	const loopback = $derived(isLoopbackUrl(address));
	const clock = setInterval(() => (now = Date.now()), 500);
	let issued = 0;

	async function create() {
		if (!server || busy) return;
		busy = true;
		error = "";
		const mine = ++issued;
		try {
			const made = await new Api({ baseUrl: server.baseUrl, token: server.token }).createPairing();
			if (mine !== issued) return;
			link = buildPairingLink(address.trim().replace(/\/+$/, ""), made.code, app.serverLabel(server));
			expiresAt = made.expiresAt;
			now = Date.now();
		} catch (e) {
			error = errorText(e);
			link = "";
		} finally {
			busy = false;
		}
	}

	/** A code on screen is a key to the server: drop it when the panel goes away or the address changes. */
	function revoke() {
		issued++;
		if (link && server) void new Api({ baseUrl: server.baseUrl, token: server.token }).revokePairing().catch(() => {});
		link = "";
	}
	onDestroy(() => {
		clearInterval(clock);
		revoke();
	});

	/** A code was made for one address: editing the address drops it, so the QR on screen never points somewhere else. */
	function addressChanged() {
		if (!link) return;
		revoke();
	}

	// refresh by itself so the QR on screen is always one that still works
	$effect(() => {
		if (expired && !busy) void create();
	});

	async function copy() {
		if (!link) return;
		copied = await copyText(link);
		setTimeout(() => (copied = false), 1600);
	}
</script>

<div class="pair">
	<p class="lead">{t("폰에서 앱을 열고 이 QR을 카메라로 스캔하면 서버가 바로 등록됩니다.")}</p>

	<label class="addr">
		<span>{t("폰이 접속할 주소")}</span>
		<input class="field mono" bind:value={address} oninput={addressChanged} inputmode="url" autocapitalize="off" autocomplete="off" spellcheck="false" placeholder="http://100.x.x.x:8787" />
	</label>
	{#if loopback}
		<div class="warn" role="alert">
			<Icon name="alert" />
			<span>{t("localhost 주소는 폰에서 이 PC가 아니라 폰 자신을 가리킵니다. Tailscale 주소나 PC의 LAN 주소로 바꿔 주세요.")}</span>
		</div>
	{/if}

	{#if link && !expired}
		<div class="code">
			<QrCode value={link} />
			<div class="timer" class:low={left <= 20}>
				<span class="bar"><span style:transform="scaleX({left / 120})"></span></span>
				<span class="num">{t("{n}초 남음", { n: left })}</span>
			</div>
		</div>
		<div class="row">
			<button class="btn" onclick={copy}><Icon name={copied ? "check" : "copy"} /> {copied ? t("복사됨") : t("링크 복사")}</button>
			<button class="btn ghost" onclick={create} disabled={busy}>{t("새 QR")}</button>
		</div>
	{:else}
		<button class="btn primary make" onclick={create} disabled={busy || !address.trim()}>
			{#if busy}<span class="spinner"></span>{t("만드는 중…")}{:else}{t("QR 만들기")}{/if}
		</button>
	{/if}

	{#if error}<div class="warn" role="alert"><Icon name="alert" /><span>{error}</span></div>{/if}

	<p class="hint">{t("QR에는 접근 토큰이 들어 있지 않습니다. 2분 동안 한 번만 쓸 수 있는 코드라, 사용하거나 시간이 지나면 무효가 됩니다.")}</p>
</div>

<style>
	.pair {
		display: flex;
		flex-direction: column;
		gap: 14px;
	}
	.lead {
		margin: 0;
		font-size: var(--fs-sm);
		line-height: 1.55;
		color: var(--text-dim);
		word-break: keep-all;
	}
	.addr {
		display: flex;
		flex-direction: column;
		gap: 6px;
		font-size: var(--fs-sm);
		font-weight: 600;
		color: var(--text-dim);
	}
	.code {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 12px;
		padding: 18px;
		border: 1px solid var(--border);
		border-radius: var(--radius-panel);
		background: var(--bg-elev, transparent);
	}
	.timer {
		display: flex;
		align-items: center;
		gap: 10px;
		width: 232px;
		font-size: var(--fs-xs);
		color: var(--text-dim);
	}
	.timer.low {
		color: var(--warn);
	}
	.bar {
		flex: 1;
		height: 4px;
		border-radius: 2px;
		background: var(--border);
		overflow: hidden;
	}
	.bar > span {
		display: block;
		height: 100%;
		background: currentColor;
		transform-origin: left center;
		transition: transform var(--motion-slow) linear;
	}
	.num {
		font-variant-numeric: tabular-nums;
		min-width: 56px;
		text-align: right;
	}
	.row {
		display: flex;
		gap: 8px;
		justify-content: center;
	}
	.row :global(svg) {
		width: 16px;
		height: 16px;
		stroke: currentColor;
		fill: none;
		stroke-width: 1.9;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	.make {
		align-self: center;
		height: 44px;
		padding: 0 28px;
	}
	.warn {
		display: flex;
		gap: 8px;
		align-items: flex-start;
		padding: 10px 12px;
		border-radius: var(--radius);
		background: var(--warn-soft);
		color: var(--warn);
		font-size: var(--fs-sm);
		line-height: 1.5;
	}
	.warn :global(svg) {
		width: 17px;
		height: 17px;
		flex: none;
		margin-top: 1px;
		stroke: currentColor;
		fill: none;
		stroke-width: 1.8;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	.hint {
		margin: 0;
		line-height: 1.5;
		word-break: keep-all;
	}
</style>
