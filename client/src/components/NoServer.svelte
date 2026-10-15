<script lang="ts">
	import { t } from "../lib/i18n";
	import PipayaMark from "./PipayaMark.svelte";
	import Wordmark from "./Wordmark.svelte";
	import Icon from "./Icon.svelte";
	import Backdrop from "./Backdrop.svelte";
	import { app } from "../lib/store.svelte";
	import { isTauri } from "../lib/tauri";
	import { notificationPlatform } from "../lib/notifications";
	import { parsePairingLink } from "../lib/pairing";

	/** The phone app: the QR comes from a PC that is already connected, and the camera is opened right here. */
	const scannable = isTauri() && ["android", "ios"].includes(notificationPlatform());

	let error = $state("");
	let scanning = $state(false);

	async function scan() {
		if (scanning) return;
		error = "";
		scanning = true;
		try {
			const { checkPermissions, requestPermissions, scan: startScan, Format } = await import("@tauri-apps/plugin-barcode-scanner");
			let permission = await checkPermissions();
			if (permission !== "granted") permission = await requestPermissions();
			if (permission !== "granted") return void (error = t("카메라 권한이 필요합니다. 설정에서 카메라를 허용해 주세요."));
			const result = await startScan({ windowed: false, formats: [Format.QRCode] });
			const link = parsePairingLink(result.content);
			if (link) app.connectByLink(link);
			else error = t("pipaya 연결 QR이 아닙니다. PC 앱에 표시된 QR을 스캔해 주세요.");
		} catch (e) {
			// closing the camera without a code is not an error
			const text = e instanceof Error ? e.message : String(e);
			if (!/cancel/i.test(text)) error = t("카메라를 열지 못했습니다.");
		} finally {
			scanning = false;
		}
	}

</script>

<div class="screen">
	<Backdrop />
	<div class="card">
		<div class="logo"><PipayaMark size={52} /></div>
		<h1><Wordmark size={34} /></h1>
		{#if scannable}
			<p class="sub">{t("QR로 서버에 연결합니다.")}</p>
			<ol class="steps">
				<li><b>{t("PC에서 pipaya를 엽니다")}</b></li>
				<li><b>{t("설정 → 폰으로 연결할 서버 이름 아래 ‘기기’ → ‘폰 추가’")}</b><span>{t("화면에 QR이 나타납니다.")}</span></li>
				<li><b>{t("아래 버튼으로 카메라를 열어 QR을 스캔합니다")}</b></li>
			</ol>
			<button class="btn primary add" onclick={scan} disabled={scanning}><Icon name="phone" /> {t("QR 스캔")}</button>
			{#if error}<p class="hint err" role="alert">{error}</p>{/if}
			<button class="btn ghost" onclick={() => (app.serverForm = "new")}>{t("서버 주소로 연결")}</button>
		{:else}
			<p class="sub">{t("서버에 연결하려면 주소와 접근 토큰이 필요합니다. 토큰은 서버의 data/token 파일에 있습니다.")}</p>
			<button class="btn primary add" onclick={() => (app.serverForm = "new")}><Icon name="plus" /> {t("서버 주소로 연결")}</button>
		{/if}
	</div>
</div>

<style>
	.err {
		color: var(--danger, #d33);
	}
	.screen {
		height: 100%;
		display: grid;
		place-items: center;
		padding: calc(20px + var(--sat)) 20px calc(20px + var(--sab));
		overflow-y: auto;
		background: var(--bg);
		position: relative;
	}
	.card {
		position: relative;
		z-index: 1;
		width: min(460px, 100%);
		display: flex;
		flex-direction: column;
		align-items: center;
		text-align: center;
		gap: 12px;
		padding: 34px 26px 26px;
		border: 1px solid var(--border);
		border-radius: var(--radius-panel);
		background: var(--bg-side);
		box-shadow: var(--shadow);
		animation: rise var(--motion-slow) var(--ease) both;
	}
	@keyframes rise {
		from {
			opacity: 0;
			transform: translateY(14px) scale(0.98);
		}
	}
	.logo {
		width: 76px;
		height: 76px;
		display: grid;
		place-items: center;
		border-radius: var(--radius);
		border: 1px solid var(--border-strong);
		background: var(--bg);
		color: var(--text);
	}
	h1 {
		margin: 0;
		font-size: 28px;
		font-weight: 700;
		letter-spacing: -0.03em;
	}
	.sub {
		margin: 0 0 4px;
		color: var(--text-dim);
		line-height: 1.6;
		word-break: keep-all;
		max-width: 34ch;
	}
	.panel {
		width: 100%;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 14px;
		padding-top: 6px;
		animation: rise var(--motion-normal) var(--ease) both;
	}
	.add {
		height: 46px;
		padding: 0 26px;
		font-size: var(--fs-md);
		border-radius: var(--radius);
	}
	.hint {
		margin: 0;
		font-size: var(--fs-xs);
		color: var(--text-faint);
		line-height: 1.55;
		word-break: keep-all;
	}
	.tip {
		display: flex;
		gap: 10px;
		align-items: flex-start;
		text-align: left;
		padding: 12px 14px;
		border: 1px dashed var(--border-strong);
		border-radius: var(--radius);
		background: var(--bg);
		font-size: var(--fs-sm);
		line-height: 1.6;
		color: var(--text-dim);
		word-break: keep-all;
	}
	.tip p {
		margin: 0;
	}
	.tip b {
		color: var(--text);
	}
	.tip :global(svg) {
		flex: none;
		width: 18px;
		height: 18px;
		margin-top: 2px;
		stroke: currentColor;
		fill: none;
		stroke-width: 1.8;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	.steps {
		list-style: none;
		margin: 0;
		padding: 0;
		width: 100%;
		display: flex;
		flex-direction: column;
		gap: 16px;
		text-align: left;
		counter-reset: step;
	}
	.steps li {
		position: relative;
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 6px;
		padding-left: 34px;
		counter-increment: step;
		font-size: var(--fs-sm);
		color: var(--text-dim);
		line-height: 1.55;
		word-break: keep-all;
	}
	.steps li::before {
		content: counter(step);
		position: absolute;
		left: 0;
		top: -1px;
		width: 24px;
		height: 24px;
		display: grid;
		place-items: center;
		border: 1px solid var(--border-strong);
		border-radius: 50%;
		background: var(--bg);
		color: var(--text);
		font-size: var(--fs-xs);
		font-weight: 700;
	}
	.steps b {
		color: var(--text);
		font-size: var(--fs-md);
	}
	.how {
		display: flex;
		gap: 6px;
	}
	.how button {
		height: 28px;
		padding: 0 10px;
		border: 1px solid var(--border);
		border-radius: var(--radius-pill);
		font-size: var(--fs-xs);
		color: var(--text-dim);
	}
	.how button.on {
		border-color: var(--text);
		color: var(--text);
	}
	.cmd {
		display: flex;
		align-items: center;
		gap: 6px;
		width: 100%;
		padding: 8px 6px 8px 12px;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--bg-code, var(--bg));
	}
	.cmd code {
		flex: 1;
		min-width: 0;
		font-family: var(--mono);
		font-size: var(--fs-xs);
		color: var(--text);
		overflow-x: auto;
		white-space: nowrap;
		scrollbar-width: none;
	}
	.cmd code::-webkit-scrollbar {
		display: none;
	}
	.cmd :global(svg) {
		width: 16px;
		height: 16px;
		stroke: currentColor;
		fill: none;
		stroke-width: 1.9;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	.steps .btn :global(svg) {
		width: 16px;
		height: 16px;
		stroke: currentColor;
		fill: none;
		stroke-width: 2;
		stroke-linecap: round;
	}
</style>
