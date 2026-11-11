<script lang="ts">
	import { errorText } from "../lib/api";
	import Button from "./Button.svelte";
	import { t } from "../lib/i18n";
	import PipayaMark from "./PipayaMark.svelte";
	import Wordmark from "./Wordmark.svelte";
	import Icon from "./Icon.svelte";
	import IconButton from "./IconButton.svelte";
	import Backdrop from "./Backdrop.svelte";
	import { app } from "../lib/store.svelte";
	import { isTauri } from "../lib/tauri";
	import { notificationPlatform } from "../lib/notifications";
	import { parsePairingLink } from "../lib/pairing";
	import { onDestroy } from "svelte";
	import { CopyFlag } from "../lib/copy-flag.svelte";
	import { firstRunWays, INSTALL_SERVER_CMD, INSTALL_WINDOWS_CMD, TOKEN_CMD } from "../lib/first-run";

	/** Only the ways this app can really do: a phone app scans a QR (from a PC already connected), the desktop app has its own server, a browser types the address. */
	const ways = firstRunWays({ tauri: isTauri(), platform: notificationPlatform() });
	let starting = $state(false);
	const flags = [new CopyFlag(), new CopyFlag(), new CopyFlag()];
	onDestroy(() => flags.forEach((f) => f.dispose()));

	/** Desktop app only: the bundled server normally starts by itself; this is the retry when it did not. */
	async function startHere() {
		starting = true;
		try {
			await app.ensureLocalServer();
			if (app.servers.length === 0) error = t("이 컴퓨터에서 서버를 시작하지 못했습니다. 주소와 토큰으로 연결해 주세요.");
		} finally {
			starting = false;
		}
	}

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
			const text = errorText(e);
			if (!/cancel/i.test(text)) error = t("카메라를 열지 못했습니다.");
		} finally {
			scanning = false;
		}
	}

</script>

{#snippet cmd(label: string, text: string, i: number)}
	<div class="cmd">
		<span class="cap">{label}</span>
		<div class="line">
			<code>{text}</code>
			<IconButton icon={flags[i].done ? "check" : "copy"} label={t("복사")} onclick={() => void flags[i].copy(text)} />
		</div>
	</div>
{/snippet}

<div class="screen">
	<Backdrop />
	<div class="card">
		<div class="logo"><PipayaMark size={52} /></div>
		<h1><Wordmark size={34} /></h1>
		<p class="sub">{t("pipaya 서버에 연결해 대화를 시작합니다. 서버는 에이전트가 실제로 일하는 컴퓨터에서 돌아갑니다.")}</p>
		<div class="ways">
			{#if ways.includes("local")}
				<Button variant="primary" class="add" onclick={startHere} disabled={starting}><Icon name="plus" /> {t("이 컴퓨터에서 시작")}</Button>
			{/if}
			{#if ways.includes("scan")}
				<ol class="steps">
					<li><b>{t("PC에서 pipaya를 엽니다")}</b></li>
					<li><b>{t("설정 → 폰으로 연결할 서버 이름 아래 ‘기기’ → ‘폰 추가’")}</b><span>{t("화면에 QR이 나타납니다.")}</span></li>
					<li><b>{t("아래 버튼으로 카메라를 열어 QR을 스캔합니다")}</b></li>
				</ol>
				<Button variant="primary" class="add" onclick={scan} disabled={scanning}><Icon name="phone" /> {t("QR 스캔")}</Button>
				{#if error}<p class="hint danger" role="alert">{error}</p>{/if}
			{/if}
			<Button variant={ways[0] === "manual" ? "primary" : "default"} class="add" onclick={() => (app.serverForm = "new")}>{#if ways[0] === "manual"}<Icon name="plus" /> {/if}{t("주소와 토큰으로 연결")}</Button>
		</div>
		<details class="need">
			<summary>{t("서버가 아직 없나요?")}</summary>
			<div class="body">
				<p>{t("서버는 한 번 설치해 두면 PC·폰·웹 어느 기기에서든 같은 대화를 이어 가게 해 줍니다.")}</p>
				{@render cmd(t("서버 설치 (Linux·macOS)"), INSTALL_SERVER_CMD, 0)}
				{@render cmd(t("Windows 앱 + 서버"), INSTALL_WINDOWS_CMD, 1)}
				<p>{t("접근 토큰은 서버를 설치한 컴퓨터에서 확인합니다.")}</p>
				{@render cmd(t("토큰 확인"), TOKEN_CMD, 2)}
			</div>
		</details>
	</div>
</div>

<style>
	.screen {
		height: 100%;
		display: grid;
		/* minmax(0, …): the long install commands (nowrap) must not stretch the column past the screen */
		grid-template-columns: minmax(0, 1fr);
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
		padding: 32px 24px 24px;
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
	.card :global(.btn.add) {
		height: 46px;
		padding: 0 24px;
		font-size: var(--fs-md);
		border-radius: var(--radius);
	}
	.ways {
		width: 100%;
		display: flex;
		flex-direction: column;
		align-items: stretch;
		gap: 12px;
	}
	.need {
		width: 100%;
		text-align: left;
		border-top: 1px solid var(--border);
		padding-top: 12px;
		font-size: var(--fs-sm);
		color: var(--text-dim);
	}
	.need summary {
		cursor: pointer;
		line-height: 20px;
		color: var(--text);
		font-weight: 600;
	}
	.need .body {
		display: flex;
		flex-direction: column;
		gap: 12px;
		margin-top: 12px;
	}
	.need p {
		margin: 0;
		line-height: 20px;
		word-break: keep-all;
	}
	.cmd {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.cap {
		line-height: 16px;
		font-size: var(--fs-xs);
	}
	.line {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 4px 4px 4px 12px;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius);
		background: var(--bg);
	}
	.line code {
		flex: 1;
		min-width: 0;
		overflow-x: auto;
		white-space: nowrap;
		font-size: var(--fs-xs);
		line-height: 20px;
		color: var(--text);
		scrollbar-width: none;
	}
	.hint {
		margin: 0;
		line-height: 1.55;
		word-break: keep-all;
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
		gap: 4px;
		padding-left: 32px;
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
</style>
