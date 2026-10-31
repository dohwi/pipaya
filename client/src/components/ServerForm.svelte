<script lang="ts">
	import Button from "./Button.svelte";
	import FormField from "./FormField.svelte";
	import Notice from "./Notice.svelte";
	import { t, tc } from "../lib/i18n";
	import { paneIn } from "../lib/motion";
	import { slidingIndicator } from "../lib/sliding-indicator";
	import { rovingKeys } from "../lib/roving";
	import Icon from "./Icon.svelte";
	import Modal from "./Modal.svelte";
	import ModalHeader from "./ModalHeader.svelte";
	import ConfirmButton from "./ConfirmButton.svelte";
	import ModelConnections from "./ModelConnections.svelte";
	import ToolSettings from "./ToolSettings.svelte";
	import McpSettings from "./McpSettings.svelte";
	import DirPicker from "./DirPicker.svelte";
	import DevicesPanel from "./DevicesPanel.svelte";
	import RetentionSection from "./RetentionSection.svelte";
	import ServerUpdate from "./ServerUpdate.svelte";
	import LocalServerSettings from "./LocalServerSettings.svelte";
	import { app, defaultServerUrl } from "../lib/store.svelte";
	import { Api, describeConnectError, errorText, normalizeUrl, verifyServer } from "../lib/api";
	import type { WorkdirInfo } from "../lib/types";
	import { isPlainHttpOnOpenNetwork } from "../lib/pairing";

	/**
	 * `"new"` to add, or the id of the server being edited. `embedded` draws it as a page inside the settings window
	 * (with a back button) instead of a modal of its own; `onclose` is then how it hands control back to the list.
	 */
	type Section = "info" | "agent" | "sessions" | "devices";
	/** `section` pins one pane of an existing server (the settings window's sidebar picks it): no header, no tabs. */
	let { target, embedded = false, onclose, section }: { target: string | "new"; embedded?: boolean; onclose?: () => void; section?: Section } = $props();

	// App.svelte re-mounts this component per target ({#key}), so reading `target` once is intended.
	// svelte-ignore state_referenced_locally
	const editing = target === "new" ? null : (app.servers.find((s) => s.id === target) ?? null);

	/** Editing a server has four panes: its connection details, the agent (model connections and tools), its conversations (with the default folder), and its devices. */
	// svelte-ignore state_referenced_locally
	let tab = $state<Section>(section ?? "info");
	const tabOrder = ["info", "agent", "sessions", "devices"] as const;
	let dir = $state(1);
	function go(next: (typeof tabOrder)[number]) {
		if (next === tab) return;
		dir = tabOrder.indexOf(next) > tabOrder.indexOf(tab) ? 1 : -1;
		tab = next;
	}
	let name = $state(editing?.name ?? "");
	let url = $state(editing?.baseUrl ?? (app.servers.length ? "" : defaultServerUrl()));
	let token = $state(editing?.token ?? "");
	let showToken = $state(false);
	let busy = $state(false);
	let error = $state("");

	const close = () => {
		if (onclose) return onclose();
		if (section) {
			// pinned inside settings: nothing to go back to; "cancel" just restores the saved values
			const cur = app.servers.find((s) => s.id === editing?.id);
			name = cur?.name ?? "";
			url = cur?.baseUrl ?? "";
			token = cur?.token ?? "";
			error = "";
			return;
		}
		app.serverForm = null;
	};
	const openHttp = $derived(isPlainHttpOnOpenNetwork(normalizeUrl(url)));

	/* ---------- default working directory (saved on the server itself) ---------- */
	let pickDir = $state(false);
	let wd = $state<WorkdirInfo | null>(null);
	let wdError = $state("");
	const isOpen = $derived(!!editing && editing.id === app.serverId);
	// the open server's value is kept current by the app; any other server is asked directly
	const shownWd = $derived(isOpen ? (app.workdirInfo ?? wd) : wd);

	$effect(() => {
		if (!editing || tab !== "sessions" || isOpen) return;
		const s = editing;
		wdError = "";
		new Api({ baseUrl: s.baseUrl, token: s.token })
			.configuration()
			.then((c) => (wd = c.workdir ?? null))
			.catch((e) => (wdError = errorText(e)));
	});

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		error = "";
		const baseUrl = normalizeUrl(url);
		if (!baseUrl) return void (error = t("서버 주소를 입력하세요."));
		if (!token.trim()) return void (error = t("액세스 토큰을 입력하세요."));
		busy = true;
		try {
			await verifyServer(baseUrl, token.trim());
		} catch (err) {
			error = describeConnectError(err, baseUrl);
			busy = false;
			return;
		}
		busy = false;
		if (editing) {
			app.updateServer(editing.id, { name, baseUrl, token });
			app.toast(t("서버 정보를 저장했습니다"), "ok");
			if (section) return; // stays on its page; the saved values are what the fields show now
		} else {
			const before = app.servers.length;
			app.addServer({ name, baseUrl, token });
			app.toast(app.servers.length > before ? t("서버를 추가했습니다") : t("이미 등록된 주소라 정보를 갱신했습니다"), "ok");
		}
		close();
	}

	function remove() {
		if (!editing) return;
		app.removeServer(editing.id);
		app.toast(t("서버를 삭제했습니다"));
		close();
	}
</script>

{#snippet inner()}
	{#if !section}
	{#if embedded}
		<header>
			<button type="button" class="back" onclick={close}><Icon name="chevron-left" /> {t("서버")}</button>
			<div class="title">
				<h2>{editing ? app.serverLabel(editing) : t("서버 추가")}</h2>
				{#if editing}<span class="sub mono">{editing.baseUrl}</span>{/if}
			</div>
		</header>
	{:else}
		<ModalHeader title={editing ? app.serverLabel(editing) : t("서버 추가")} sub={editing?.baseUrl} subMono onclose={close} />
	{/if}
	{/if}

	{#if editing && !section}
		<div
			class="tabs"
			role="tablist"
			aria-label={t("서버 설정 구역")}
			use:slidingIndicator={{ selector: "button.on", variant: "underline", edge: "bottom", thickness: 2 }}
			use:rovingKeys={{ item: '[role="tab"]' }}
		>
			<button role="tab" aria-selected={tab === "info"} tabindex={tab === "info" ? 0 : -1} class:on={tab === "info"} onclick={() => go("info")}>{t("정보")}</button>
			<button role="tab" aria-selected={tab === "agent"} tabindex={tab === "agent" ? 0 : -1} class:on={tab === "agent"} onclick={() => go("agent")}>{t("에이전트")}</button>
			<button role="tab" aria-selected={tab === "sessions"} tabindex={tab === "sessions" ? 0 : -1} class:on={tab === "sessions"} onclick={() => go("sessions")}>{t("대화")}</button>
			<button role="tab" aria-selected={tab === "devices"} tabindex={tab === "devices" ? 0 : -1} class:on={tab === "devices"} onclick={() => go("devices")}>{t("기기")}</button>
		</div>
	{/if}

	{#if editing && tab === "devices"}
		<div class="body pane" role="tabpanel" in:paneIn={{ x: dir * 18 }}>{#key editing.id}<DevicesPanel serverId={editing.id} />{/key}</div>
	{:else if editing && tab === "sessions"}
		<div class="body pane" role="tabpanel" in:paneIn={{ x: dir * 18 }}>
				<div class="section-label">{t("기본 작업 디렉터리")}</div>
		{#if wdError && !shownWd}
			<Notice tone="danger">{wdError}</Notice>
		{:else}
			<div class="wd">
				<Icon name="folder" />
				<span class="mono wdpath" title={shownWd?.effective}>{shownWd?.effective ?? "…"}</span>
				<Button size="sm" disabled={!shownWd} onclick={() => (pickDir = true)}>{t("변경")}</Button>
			</div>
			<p class="hint">{t("새 대화가 시작되는 폴더입니다. 바꾸면 바로 저장됩니다.")}</p>
		{/if}
	
			{#key editing.id}<RetentionSection serverId={editing.id} />{/key}
		</div>
	{:else if editing && tab === "agent"}
		<div class="body pane" role="tabpanel" in:paneIn={{ x: dir * 18 }}>{#key editing.id}<ModelConnections serverId={editing.id} /><ToolSettings serverId={editing.id} /><McpSettings serverId={editing.id} />{/key}</div>
	{:else}
		<form onsubmit={submit} in:paneIn={{ x: dir * 18 }}>
			<div class="body">
				<div class="set-group fields">
				<FormField label={`${t("이름")} (${tc("optional", "선택")})`}>
					<input class="field" bind:value={name} placeholder={t("예: 집 서버")} autocomplete="off" maxlength="40" />
				</FormField>
				<FormField label={t("서버 주소")}>
					<input
						class="field mono"
						bind:value={url}
						placeholder="http://100.x.x.x:8787"
						inputmode="url"
						autocapitalize="off"
						autocomplete="off"
						spellcheck="false"
					/>
				</FormField>
				<FormField label={t("액세스 토큰")}>
					<div class="tokenrow">
						<input
							class="field mono"
							type={showToken ? "text" : "password"}
							bind:value={token}
							placeholder={t("server/data/token 의 내용")}
							autocapitalize="off"
							autocomplete="off"
							spellcheck="false"
						/>
						<Button variant="ghost" class="eye" onclick={() => (showToken = !showToken)} aria-pressed={showToken}>
							{showToken ? t("숨기기") : t("보기")}
						</Button>
					</div>
				</FormField>

				{#if openHttp}<Notice tone="warn">{t("암호화되지 않은 http 주소입니다. Tailscale 주소나 https를 권장합니다.")}</Notice>{/if}
				{#if error}<Notice tone="danger">{error}</Notice>{/if}
				<p class="hint">{t("토큰은 이 기기에만 저장됩니다.")}</p>
				</div>
				{#if editing && isOpen}<section class="set-group"><ServerUpdate /></section>{/if}
				{#if editing?.local}<section class="set-group"><LocalServerSettings /></section>{/if}
			</div>

			<footer>
				{#if editing}
					<ConfirmButton danger confirmLabel={t("정말 삭제")} onconfirm={remove}>{t("삭제")}</ConfirmButton>
				{/if}
				<span class="grow"></span>
				<Button variant="ghost" onclick={close}>{t("취소")}</Button>
				<Button variant="primary" type="submit" disabled={busy}>
					{#if busy}<span class="spinner"></span>{t("확인 중…")}{:else}{editing ? t("저장") : t("추가")}{/if}
				</Button>
			</footer>
		</form>
	{/if}
{/snippet}

{#if embedded}
	<div class="embedded">{@render inner()}</div>
{:else}
	<!-- an existing server gets the wider dialog, the same on every tab so it does not jump when switching -->
	<Modal onclose={close} label={editing ? t("서버 설정") : t("서버 추가")} width={editing ? "l" : "m"} maxHeight="680px" layer={2}>
		{@render inner()}
	</Modal>
{/if}

{#if pickDir && editing}
	<DirPicker mode="default" serverId={editing.id} info={shownWd} onsaved={(i) => (wd = i)} onclose={() => (pickDir = false)} />
{/if}

<style>
	form {
		display: flex;
		flex-direction: column;
		min-height: 0;
	}
	/* a page of the settings window: it fills the content area and has no frame of its own */
	.embedded {
		display: flex;
		flex-direction: column;
		min-height: 0;
		flex: 1;
	}
	/* the settings window already pads its content: the page itself adds no side padding */
	.embedded header {
		padding: 0 0 4px;
	}
	.embedded .tabs {
		padding: 0;
	}
	/* It still scrolls, and a scroller clips: 4px of side room (taken back by the margin, so the content stays aligned
	   with the page) keeps full-width fields' and edge buttons' focus rings whole */
	.embedded .body,
	.embedded .body.pane {
		margin: 0 -4px;
		padding: 0 4px 8px; /* the settings pane already spaces its title from the content */
	}
	.embedded footer {
		padding: 12px 0 0;
	}
	.back {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		height: var(--control-h-sm);
		margin: 0 8px 0 -8px;
		padding: 0 8px 0 4px;
		border-radius: var(--radius-control);
		color: var(--text-dim);
		font-size: var(--fs-sm);
	}
	.back:hover {
		background: var(--bg-hover);
		color: var(--text);
	}
	.back :global(svg) {
		width: 18px;
		height: 18px;
		stroke-width: 1.9;
	}
	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: var(--dlg-head-t) calc(var(--dlg-px) - 9px) 4px var(--dlg-px);
	}
	.title {
		display: flex;
		align-items: baseline;
		gap: 8px;
		min-width: 0;
	}
	h2 {
		margin: 0;
		font-size: var(--fs-xl);
	}
	.sub {
		font-size: var(--fs-xs);
		color: var(--text-faint);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.tabs {
		position: relative;
		display: flex;
		margin-top: 4px;
		padding: 0 var(--dlg-px);
		border-bottom: 1px solid var(--border);
	}
	.tabs button {
		flex: 1;
		height: 40px;
		padding: 0 12px;
		text-align: center;
		color: var(--text-dim);
		border-bottom: 2px solid transparent;
		margin-bottom: -1px;
		font-family: var(--mono);
		font-size: var(--fs-sm);
		font-weight: 550;
	}
	.tabs button:hover {
		color: var(--text);
	}
	.tabs button.on {
		color: var(--text);
		border-color: var(--text);
	}
	.tabs:global([data-indicator-ready]) button.on {
		border-color: transparent;
	}
	.body {
		display: flex;
		flex-direction: column;
		gap: var(--dlg-gap);
		padding: var(--dlg-body-t) var(--dlg-px) 8px;
		overflow-y: auto;
		scroll-padding-block: 12px;
	}
	.body.pane {
		padding: var(--dlg-body-t) var(--dlg-px) var(--dlg-body-b);
	}
	.wd {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 12px;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--bg-elev, transparent);
	}
	.wd > :global(svg) {
		flex: none;
		width: 17px;
		height: 17px;
		stroke: var(--text-dim);
		stroke-width: 1.9;
	}
	.wdpath {
		flex: 1;
		min-width: 0;
		font-size: var(--fs-sm);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.mono {
		font-size: var(--fs-md);
	}
	.fields { display: flex; flex-direction: column; gap: var(--dlg-gap); }
	.tokenrow {
		display: flex;
		gap: 4px;
	}
	.tokenrow :global(.btn.eye) {
		flex: none;
		height: var(--control-h);
		padding: 0 12px;
		font-size: var(--fs-sm);
	}
	.hint {
		margin: 0;
	}
	footer {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: var(--dlg-foot-t) var(--dlg-px) calc(var(--dlg-foot-b) + var(--sab));
	}
	.grow {
		flex: 1;
	}
	@media (max-width: 640px) {
		.body.pane {
			padding-bottom: calc(var(--dlg-body-b) + var(--sab));
		}
	}
</style>
