<script lang="ts">
	import { app } from "../../lib/store.svelte";
	import { t } from "../../lib/i18n";
	import { compact, duration, tilde } from "../../lib/format";
	import { copyText } from "../../lib/clipboard";
	import { abortable } from "../../lib/abortable";
	import { sessionTitle } from "../../lib/session-title";
	import { agoText } from "../../lib/tab-overview";
	import { BRAND_LABEL } from "../../lib/brand";
	import { connectionState } from "../../lib/sidebar-model";
	import type { Card, Graph } from "../../lib/graph";
	import { modelDisplayName, modelIcon, providerDisplayName, splitModelRef } from "../../lib/model-name";
	import { callState, roleStats, under, type CallState } from "../../lib/graph-detail";
	import { graphRuns } from "../../lib/graph-runs.svelte";
	import { activityOf } from "../../lib/activity";
	import type { SettingsTabId } from "../../lib/settings-search";
	import type { SubagentInfo } from "../../lib/types";
	import Modal from "../ui/Modal.svelte";
	import DialogBody from "../ui/DialogBody.svelte";
	import DialogFooter from "../ui/DialogFooter.svelte";
	import ListGroup from "../ui/ListGroup.svelte";
	import Button from "../ui/Button.svelte";
	import Icon from "../ui/Icon.svelte";
	import ModelLogo from "../models/ModelLogo.svelte";
	import AgentBadge from "../shell/AgentBadge.svelte";

	/**
	 * The graph view's look at a server, provider, model or subagent card: what it is (address and version, sign-in,
	 * the model's limits, a role's definition and how its calls went) and what hangs under it. A row opens what it names:
	 * a chat its quick look, a provider, model or role this dialog for that card. It reads the live graph, so its counts
	 * move with the view; a card that leaves the graph closes it. (A chat card opens the chat itself: `GraphQuick`.)
	 */
	let { graph, id, onpick, onpeek, onclose }: {
		graph: Graph;
		id: string;
		/** Show another card here instead (a provider's model, a server's role). */
		onpick: (id: string) => void;
		/** Look at a chat (the graph's quick look). */
		onpeek: (server: string, session: string) => void;
		onclose: () => void;
	} = $props();

	const card = $derived(graph.cards.get(id));
	$effect(() => {
		if (!card) onclose();
	});
	const link = $derived(card ? app.links[card.server] : undefined);
	const saved = $derived(card ? app.servers.find((s) => s.id === card.server) : undefined);
	const serverName = $derived(saved?.name ?? card?.server ?? "");

	let now = $state(Date.now());
	$effect(() => {
		const timer = setInterval(() => (now = Date.now()), 30_000);
		return () => clearInterval(timer);
	});
	const ago = (at: number) => agoText(at, now);

	// ---- what each kind shows ----
	const chats = $derived(card && card.kind !== "subagent" && card.kind !== "session" ? under(graph, card.id, "session") : []);
	const providers = $derived(card?.kind === "server" ? under(graph, card.id, "provider") : []);
	const models = $derived(card?.kind === "provider" ? under(graph, card.id, "model") : []);
	const roles = $derived(card?.kind === "server" ? [...graph.cards.values()].filter((c) => c.kind === "subagent" && c.server === card.server) : []);

	const STATE_TEXT = { online: () => t("연결됨"), offline: () => t("연결 안 됨"), unauthorized: () => t("토큰 거부됨"), incompatible: () => t("앱 업데이트 필요"), checking: () => t("확인 중") };
	const serverState = $derived(connectionState(link?.net ?? "connecting"));

	/** A connection the owner added: its address, API format and key (built-in providers have none of these). */
	const custom = $derived(card?.kind === "provider" ? link?.customProviders.find((p) => p.id === card.label) : undefined);
	const FORMAT: Record<string, string> = { "openai-completions": "OpenAI Chat Completions", "openai-responses": "OpenAI Responses", "anthropic-messages": "Anthropic Messages" };
	const keyText = $derived(!custom ? "" : custom.hasStoredKey ? t("저장됨") : custom.authRequired ? t("필요하지만 저장 안 됨") : t("필요 없음"));
	const providerInfo = $derived(card?.kind === "provider" ? link?.providers.find((p) => p.id === card.label) : undefined);
	const providerModels = $derived(card?.kind === "provider" ? (link?.models ?? []).filter((m) => m.provider === card.label && m.available) : []);
	const signIn = $derived.by(() => {
		const p = providerInfo;
		if (!p) return null;
		if (!p.configured) return t("연결 안 됨");
		if (p.storedCredential === "oauth") return "OAuth";
		if (p.storedCredential) return t("API 키");
		return t("연결됨");
	});

	const modelInfo = $derived(card?.kind === "model" ? link?.models.find((m) => m.provider === card.provider && m.id === card.label) : undefined);

	// a role's calls, counted like its card (calls from open chats), and its file (read from the folder of the chat that
	// called it last: a project's role files win over the global ones)
	const stats = $derived.by(() => {
		if (card?.kind !== "subagent") return null;
		const server = card.server;
		return roleStats(graphRuns.runs[server] ?? [], card.label, (sid) => graph.cards.has(`s:${server}/${sid}`));
	});
	const callerCwd = $derived(stats?.callers[0] ? link?.sessionById.get(stats.callers[0].sessionId)?.cwd : undefined);
	let role = $state<{ key: string; def: SubagentInfo | null } | null>(null);
	const roleKey = $derived(card?.kind === "subagent" && !card.free ? `${card.server}|${callerCwd ?? ""}|${card.label}` : "");
	$effect(() => {
		const key = roleKey;
		const api = link?.api;
		const name = card?.label;
		const cwd = callerCwd;
		if (!key || !api || !name) return;
		return abortable((signal) => api.subagents(cwd, signal), {
			ok: (l) => (role = { key, def: l.subagents.find((r) => r.name === name && !r.overridden) ?? l.subagents.find((r) => r.name === name) ?? null }),
			fail: () => (role = { key, def: null }),
		});
	});
	const def = $derived(role && role.key === roleKey ? role.def : null);

	const CALL_TEXT: Record<CallState, () => string> = { running: () => t("실행 중"), failed: () => t("실패"), cut: () => t("중단됨"), done: () => t("완료") };
	const chatName = (server: string, sid: string) => {
		const s = app.links[server]?.sessionById.get(sid);
		return s ? (s.name ? `@${s.name}` : sessionTitle(s.title)) : sid;
	};

	// ---- header ----
	const title = $derived(card?.name ?? "");
	/** A model's provider by the connection's name, a model or a call's model by the name the owner gave it. */
	const providerName = (id: string | undefined) => providerDisplayName(link?.providers ?? [], id);
	const refName = (ref: string) => { const r = splitModelRef(ref); return modelDisplayName(link?.models ?? [], r.provider, r.id); };
	const iconOf = (provider: string | undefined, id: string) => modelIcon(link?.models ?? [], provider, id);
	const sub = $derived.by(() => {
		if (!card) return "";
		if (card.kind === "server") return card.host ?? "";
		if (card.kind === "provider") return serverName;
		if (card.kind === "model") return [providerName(card.provider), serverName].join(" · ");
		return [t("서브에이전트"), serverName].join(" · ");
	});

	// ---- footer ----
	const settingsTab = $derived<SettingsTabId>(card?.kind === "server" ? "info" : card?.kind === "subagent" ? "tools" : "models");
	function openSettings() {
		if (!card) return;
		const server = card.server;
		onclose();
		app.openSettings(settingsTab, server);
	}
	/** The server's address, or a connection's endpoint. */
	async function copyAddress() {
		const url = card?.kind === "provider" ? custom?.baseUrl : saved?.baseUrl;
		if (!url) return;
		const ok = await copyText(url);
		app.toast(ok ? t("주소를 복사했습니다") : t("복사하지 못했습니다"), ok ? "ok" : "error");
	}
</script>

{#snippet chatRow(c: Card)}
	{@const s = c.session!}
	<li>
		<button class="row" onclick={() => onpeek(c.server, s.id)} title={t("빠른 보기")}>
			<span class="mark"><AgentBadge id={s.id} server={c.server} state={c.activity} size={20} /></span>
			<span class="nm">{s.name ? `@${s.name}` : sessionTitle(s.title)}</span>
			{#if s.name}<span class="sub">{sessionTitle(s.title)}</span>{/if}
			<span class="end">{ago(s.updatedAt)}</span>
		</button>
	</li>
{/snippet}

{#snippet cardRow(c: Card, end: string)}
	<li>
		<button class="row" onclick={() => onpick(c.id)}>
			<span class="mark">
				{#if c.kind === "model"}<ModelLogo conn={link?.conn} icon={iconOf(c.provider, c.label)} provider={c.provider} model={c.label} size={20} colored />
				{:else}<Icon name={c.kind === "provider" ? "plug" : "bot"} />{/if}
			</span>
			<span class="nm" class:mono={c.kind === "model" && c.name === c.label}>{c.name}</span>
			<span class="end">{end}</span>
			<span class="chev"><Icon name="chevron-right" /></span>
		</button>
	</li>
{/snippet}

{#if card}
	<Modal {onclose} label={title} {title} {sub} subMono={card.kind === "server"} width="l" maxHeight="720px" quick>
		{#snippet headerLead()}
			<span class="hl" class:ok={card.kind === "server" && serverState === "online"} class:bad={card.kind === "server" && serverState !== "online" && serverState !== "checking"}>
				{#if card.kind === "model"}<ModelLogo conn={link?.conn} icon={iconOf(card.provider, card.label)} provider={card.provider} model={card.label} size={24} colored />
				{:else}<Icon name={card.kind === "server" ? "server" : card.kind === "provider" ? "plug" : "bot"} />{/if}
			</span>
		{/snippet}
		<DialogBody gap>
			<dl class="kv">
				{#if card.kind === "server"}
					<dt>{t("상태")}</dt>
					<dd class:bad={serverState !== "online" && serverState !== "checking"}>{STATE_TEXT[serverState]()}{#if link?.netError && serverState !== "online"}<span class="faint">{" · "}{link.netError}</span>{/if}</dd>
					<dt>{t("주소")}</dt>
					<dd class="mono">{saved?.baseUrl ?? card.host}</dd>
					{#if link?.versions?.version}<dt>{t("서버 버전")}</dt><dd class="mono">v{link.versions.version}</dd>{/if}
					{#if link?.workspace?.root}<dt>{t("기본 작업 폴더")}</dt><dd class="mono">{tilde(link.workspace.root, link.workspace.home)}</dd>{/if}
					<dt>{t("대화")}</dt>
					<dd>{t("대화 {n}개", { n: card.count })}{#if card.live}<span class="faint">{" · "}{t("작업 중")}</span>{/if}</dd>
				{:else if card.kind === "provider"}
					<dt>ID</dt>
					<dd class="mono">{card.label}</dd>
					<dt>{t("종류")}</dt>
					<dd>{custom ? t("직접 추가한 연결") : t("내장")}</dd>
					{#if custom}
						<dt>{t("주소")}</dt>
						<dd class="mono">{custom.baseUrl}</dd>
						<dt>{t("API 방식")}</dt>
						<dd>{FORMAT[custom.api] ?? custom.api}</dd>
						<dt>{t("API 키")}</dt>
						<dd class:bad={custom.authRequired && !custom.hasStoredKey}>{keyText}</dd>
					{/if}
					<!-- a connection the owner added says it with its key line above -->
					{#if signIn && !custom}<dt>{t("인증")}</dt><dd class:bad={!providerInfo?.configured}>{signIn}</dd>{/if}
					{#if providerInfo?.accountEmail}<dt>{t("계정")}</dt><dd class="mono">{providerInfo.accountEmail}</dd>{/if}
					{#if link?.loaded}<dt>{t("모델")}</dt><dd>{t("모델 {n}개", { n: providerModels.length })}<span class="faint">{" · "}{t("대화에서 쓰는 모델 {n}개", { n: card.children.length })}</span></dd>{/if}
					<dt>{t("대화")}</dt>
					<dd>{t("대화 {n}개", { n: card.count })}</dd>
				{:else if card.kind === "model"}
					{#if card.name !== card.label}<dt>{t("모델 ID")}</dt><dd class="mono">{card.label}</dd>{/if}
					<dt>{t("프로바이더")}</dt>
					<dd>{providerName(card.provider)}{#if providerName(card.provider) !== card.provider}<span class="faint mono">{" · "}{card.provider}</span>{/if}{#if card.brand}<span class="faint">{" · "}{BRAND_LABEL[card.brand]}</span>{/if}</dd>
					{#if modelInfo}
						<dt>{t("컨텍스트 창")}</dt>
						<dd class="mono">{compact(modelInfo.contextWindow)}</dd>
						<dt>{t("최대 출력")}</dt>
						<dd class="mono">{compact(modelInfo.maxTokens)}</dd>
						<dt>{t("추론")}</dt>
						<dd>{#if modelInfo.thinkingLevels.length}<span class="mono">{modelInfo.thinkingLevels.join(" · ")}</span>{:else}{t("지원 안 함")}{/if}</dd>
						<dt>{t("이미지 입력")}</dt>
						<dd>{modelInfo.vision ? t("지원") : t("지원 안 함")}</dd>
						{#if !modelInfo.configured || !modelInfo.available}
							<dt>{t("상태")}</dt>
							<dd class="bad">{!modelInfo.available ? t("연결 목록에 없음") : t("연결 안 됨")}</dd>
						{/if}
					{/if}
					<dt>{t("대화")}</dt>
					<dd>{t("대화 {n}개", { n: card.count })}</dd>
				{:else if card.kind === "subagent" && stats}
					{#if card.free}
						<dt>{t("역할")}</dt>
						<dd>{t("즉석")}<span class="faint">{" · "}{t("역할 파일 없이 에이전트가 이름을 정한 서브에이전트입니다. 읽기 전용 도구만 쓰고 작업 내용이 곧 지침입니다")}</span></dd>
					{:else if def}
						{#if def.description}<dt>{t("설명")}</dt><dd>{def.description}</dd>{/if}
						<dt>{t("역할 파일")}</dt>
						<dd class="mono">{tilde(def.file, link?.workspace?.home)}</dd>
						<dt>{t("도구")}</dt>
						<dd class="mono">{def.tools.join(", ") || t("없음")}</dd>
						<dt>{t("최대 턴")}</dt>
						<dd class="mono">{def.maxTurns}</dd>
					{/if}
					<dt>{t("모델")}</dt>
					<dd>
						{#each card.models ?? [] as m (m.model)}
							{@const ref = splitModelRef(m.model)}
							<span class="model" title={m.name !== ref.id ? m.model : undefined}><ModelLogo conn={link?.conn} icon={iconOf(ref.provider, ref.id)} provider={ref.provider} model={ref.id} size={16} colored /><span class="mn" class:mono={m.name === ref.id}>{m.name}</span><span class="faint">{t("{n}회", { n: m.n })}</span></span>
						{/each}
						{#if card.asked}<span class="faint">{t("에이전트가 모델을 직접 골랐습니다 ({n}회)", { n: card.asked })}</span>{/if}
					</dd>
					<dt>{t("호출")}</dt>
					<dd>
						{t("{n}회", { n: stats.calls })}
						{#if stats.running}<span class="run">{" · "}{t("실행 중 {n}", { n: stats.running })}</span>{/if}
						{#if stats.failed}<span class="bad">{" · "}{t("실패 {n}", { n: stats.failed })}</span>{/if}
					</dd>
					{#if stats.avgMs !== null}<dt>{t("평균 소요")}</dt><dd class="mono">{duration(stats.avgMs)}</dd>{/if}
					{#if stats.tokens}<dt>{t("토큰 합계")}</dt><dd class="mono">{compact(stats.tokens)}{#if stats.turns}<span class="faint">{" · "}{t("{n}턴", { n: stats.turns })}</span>{/if}</dd>{/if}
				{/if}
			</dl>

			{#if providers.length}
				<ListGroup title={t("프로바이더")} count={String(providers.length)}>
					<ul class="list">{#each providers as c (c.id)}{@render cardRow(c, t("대화 {n}개", { n: c.count }))}{/each}</ul>
				</ListGroup>
			{/if}
			{#if models.length}
				<ListGroup title={t("모델")} count={String(models.length)}>
					<ul class="list">{#each models as c (c.id)}{@render cardRow(c, t("대화 {n}개", { n: c.count }))}{/each}</ul>
				</ListGroup>
			{/if}
			{#if roles.length}
				<ListGroup title={t("서브에이전트")} count={String(roles.length)}>
					<ul class="list">{#each roles as c (c.id)}{@render cardRow(c, t("{n}회", { n: c.count }))}{/each}</ul>
				</ListGroup>
			{/if}
			{#if chats.length}
				<ListGroup title={t("대화")} count={String(chats.length)}>
					<ul class="list">{#each chats as c (c.id)}{@render chatRow(c)}{/each}</ul>
				</ListGroup>
			{/if}
			{#if stats?.recent.length}
				<ListGroup title={t("최근 호출")} count={stats.recent.length < stats.calls ? `${stats.recent.length}/${stats.calls}` : String(stats.calls)}>
					<ul class="list">
						{#each stats.recent as r (r.callId)}
							{@const st = callState(r)}
							<li>
								<button class="row" onclick={() => onpeek(card.server, r.sessionId)} title={t("빠른 보기")}>
									<span class="mark"><AgentBadge id={r.sessionId} server={card.server} state={link ? activityOf(link.data, r.sessionId) : "idle"} size={20} /></span>
									<span class="nm">{chatName(card.server, r.sessionId)}</span>
									<span class="sub" class:mono={refName(r.model) === splitModelRef(r.model).id}>{refName(r.model)}</span>
									<span class="end">
										<span class="st {st}">{CALL_TEXT[st]()}</span>
										{#if r.doneAt !== null && !r.running}<i>·</i><span class="mono">{duration(Math.max(0, r.doneAt - r.at))}</span>{/if}
										<i>·</i><span>{ago(r.at)}</span>
									</span>
								</button>
							</li>
						{/each}
					</ul>
				</ListGroup>
			{/if}
		</DialogBody>
		<DialogFooter rule safe>
			{#snippet start()}
				{#if (card.kind === "server" && saved) || custom}<Button size="sm" onclick={copyAddress}><Icon name="copy" />{t("주소 복사")}</Button>{/if}
			{/snippet}
			<Button size="sm" onclick={openSettings}><Icon name="settings" />{t("설정 열기")}</Button>
		</DialogFooter>
	</Modal>
{/if}

<style>
	.hl {
		display: inline-grid;
		place-items: center;
		width: 24px;
		height: 24px;
		font-size: 24px; /* the card's own 24px mark */
		color: var(--text-dim);
	}
	.hl.ok {
		color: var(--ok);
	}
	.hl.bad {
		color: var(--danger);
	}

	/* key-value facts (not the global mono `.facts`): a label column as wide as its longest label (a fixed 112px left a
	   short "ID" 90px from its value), the values on one line after it; whole-pixel 20px lines, 8px between rows */
	.kv {
		display: grid;
		grid-template-columns: max-content minmax(0, 1fr);
		gap: 8px 24px;
		margin: 0;
		font-size: var(--fs-sm);
		line-height: 20px;
	}
	.kv dt {
		white-space: nowrap;
		color: var(--text-faint);
	}
	.kv dd {
		margin: 0;
		min-width: 0;
		overflow-wrap: anywhere;
		color: var(--text);
	}
	.faint {
		color: var(--text-faint);
	}
	.bad {
		color: var(--danger);
	}
	.run {
		color: var(--info);
	}
	.model {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
	}
	.model .mn {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* rows: one bordered list, 36px rows (8 + 20 + 8) and a 1px hairline between them */
	.list {
		list-style: none;
		margin: 0;
		padding: 0;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius);
		background: var(--bg);
		overflow: hidden;
	}
	.list li + li {
		border-top: 1px solid var(--border);
	}
	.row {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		padding: 8px 12px;
		border: 0;
		background: none;
		color: var(--text);
		font: inherit;
		font-size: var(--fs-sm);
		line-height: 20px;
		text-align: left;
		cursor: pointer;
	}
	@media (hover: hover) {
		.row:hover {
			background: var(--bg-hover);
		}
	}
	.row:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: -2px; /* inside the list's clip */
	}
	.mark {
		flex: none;
		display: inline-grid;
		place-items: center;
		width: 20px;
		height: 20px;
		font-size: 16px;
		color: var(--text-dim);
	}
	.row .nm {
		flex: none;
		max-width: 50%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-weight: 600;
	}
	.row .nm.mono {
		font-weight: 500;
	}
	.row .sub {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--text-dim);
	}
	.row .end {
		flex: none;
		display: inline-flex;
		gap: 4px;
		margin-left: auto;
		font-size: var(--fs-xs);
		color: var(--text-faint);
		white-space: nowrap;
	}
	.row .end i {
		font-style: normal;
	}
	.st.running {
		color: var(--info);
	}
	.st.failed {
		color: var(--danger);
	}
	.chev {
		flex: none;
		display: inline-grid;
		place-items: center;
		width: 16px;
		height: 16px;
		font-size: 14px;
		color: var(--text-faint);
	}
	@media (max-width: 640px) {
		.kv {
			gap: 8px 16px;
		}
	}
</style>
