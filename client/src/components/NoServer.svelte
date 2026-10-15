<script lang="ts">
	import { t } from "../lib/i18n";
	import PipayaLogo from "./PipayaLogo.svelte";
	import Wordmark from "./Wordmark.svelte";
	import Icon from "./Icon.svelte";
	import Backdrop from "./Backdrop.svelte";
	import { app } from "../lib/store.svelte";
	import { copyText } from "../lib/clipboard";
	import { viewport } from "../lib/viewport.svelte";
	import { isTauri } from "../lib/tauri";
	import { slidingIndicator } from "../lib/sliding-indicator";

	const INSTALL = "curl -fsSL https://raw.githubusercontent.com/pipaya/main/install.sh | bash";
	const INSTALL_DOCKER = "git clone https://github.com/dohwi/pipaya.git && cd pipaya && docker compose up -d --build";

	/** The phone case: the QR comes from a PC that is already connected, so the phone only has to open this app. */
	const phone = $derived(viewport.narrow);

	let route = $state<"have" | "none">("have");
	let how = $state<"script" | "docker">("script");
	let copied = $state(false);
	const command = $derived(how === "script" ? INSTALL : INSTALL_DOCKER);

	async function copy() {
		copied = await copyText(command);
		setTimeout(() => (copied = false), 1600);
	}
</script>

<div class="screen">
	<Backdrop />
	<div class="card">
		<div class="logo"><PipayaLogo size={40} /></div>
		<h1><Wordmark size={30} /></h1>
		<p class="sub">{t("내 서버에서 코딩 에이전트를 돌리고, 어느 기기에서든 이어서 쓰는 클라이언트입니다.")}</p>

		<div class="seg full" role="tablist" aria-label={t("시작 방법")} use:slidingIndicator={{ selector: "button.on", variant: "fill", radius: "calc(var(--radius) - 3px)" }}>
			<button role="tab" aria-selected={route === "have"} class:on={route === "have"} onclick={() => (route = "have")}>{t("서버가 있어요")}</button>
			<button role="tab" aria-selected={route === "none"} class:on={route === "none"} onclick={() => (route = "none")}>{t("처음이에요")}</button>
		</div>

		{#if route === "have"}
			<div class="panel" role="tabpanel">
				<button class="btn primary add" onclick={() => (app.serverForm = "new")}>
					<Icon name="plus" /> {t("서버 주소로 연결")}
				</button>
				{#if phone}
					<div class="tip">
						<Icon name="server" />
						<p><b>{t("QR로 한 번에 연결")}</b><br />{t("PC 앱에서 설정 → 서버 → 서버 선택 → ‘기기’ 탭의 ‘폰 추가’ QR을 폰 카메라로 스캔하면 이 앱이 열리면서 바로 연결됩니다.")}</p>
					</div>
				{:else}
					<p class="hint">{t("주소와 접근 토큰이 필요합니다. 토큰은 서버의 data/token 파일에 있습니다.")}</p>
				{/if}
			</div>
		{:else}
			<div class="panel" role="tabpanel">
				<ol class="steps">
					<li>
						<b>{t("서버를 설치합니다")}</b>
						<span>{t("Linux/macOS 서버(PC, 홈서버, VPS)에서 한 줄이면 됩니다.")}</span>
						<div class="how">
							<button class:on={how === "script"} onclick={() => (how = "script")}>{t("바로 설치")}</button>
							<button class:on={how === "docker"} onclick={() => (how = "docker")}>{t("Docker 샌드박스")}</button>
						</div>
						<div class="cmd">
							<code>{command}</code>
							<button class="iconbtn" onclick={copy} aria-label={t("명령 복사")} title={t("복사")}><Icon name={copied ? "check" : "copy"} /></button>
						</div>
					</li>
					<li>
						<b>{t("주소와 토큰을 확인합니다")}</b>
						<span>{t("설치가 끝나면 서버 주소와 토큰 위치가 출력됩니다. 폰에서 쓰려면 Tailscale 주소를 권장합니다.")}</span>
					</li>
					<li>
						<b>{t("여기서 서버를 추가합니다")}</b>
						<button class="btn primary" onclick={() => (app.serverForm = "new")}><Icon name="plus" /> {t("서버 추가")}</button>
					</li>
				</ol>
				{#if isTauri()}
					<p class="hint">{t("모델 API 키는 서버에만 저장되고 이 앱에는 남지 않습니다.")}</p>
				{/if}
			</div>
		{/if}
	</div>
</div>

<style>
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
		width: 60px;
		height: 60px;
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
