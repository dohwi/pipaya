<script lang="ts">
	import { app } from "../../lib/store.svelte";
	import { t } from "../../lib/i18n";
	import { compact, duration, fullTime, tilde } from "../../lib/format";
	import { livePast } from "../../lib/minute-clock.svelte";
	import { copyText } from "../../lib/clipboard";
	import { abortable } from "../../lib/abortable";
	import { sessionTitle } from "../../lib/session-title";
	import { BRAND_LABEL } from "../../lib/brand";
	import { connectionState } from "../../lib/sidebar-model";
	import { ROLE_STALE_MS, type Card, type DelegateRun, type Graph } from "../../lib/graph";
	import { modelDisplayName, modelIcon, providerDisplayName, splitModelRef } from "../../lib/model-name";
	import { callState, roleStats, settingsTarget, splitLive, under, type CallState } from "../../lib/graph-detail";
	import { graphRuns } from "../../lib/graph-runs.svelte";
	import { activityOf } from "../../lib/activity";
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
	 * move with the view; a card that leaves the graph closes it. (A chat card opens the chat itself: `SessionQuickModal`.)
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
	const cardServers = $derived(card ? (card.servers ?? [card.server]) : []);
	const multiServers = $derived(cardServers.length > 1);
	const serverDisplayName = (sid: string) => app.servers.find((s) => s.id === sid)?.name ?? sid;
	const link = $derived(card ? (app.links[card.server] ?? cardServers.map((s) => app.links[s]).find(Boolean)) : undefined);
	const saved = $derived(card ? app.servers.find((s) => s.id === card.server) : undefined);
	const serverName = $derived(saved?.name ?? card?.server ?? "");
	const providerIdOn = (sid: string) => {
		if (!card) return "";
		if (card.kind === "provider") return card.ep?.byServer[sid] ?? card.label;
		if (card.kind === "model") return graph.cards.get(card.parent ?? "")?.ep?.byServer[sid] ?? card.provider ?? "";
		return card.label;
	};

	const ago = (ts: number) => livePast(ts, { time: false });

	// ---- what each kind shows ----
	const chats = $derived(card && card.kind !== "subagent" && card.kind !== "session" ? under(graph, card.id, "session") : []);
	/** The chats at work lead in their own group, so what runs on this server, connection or model now reads first. */
	const chatGroups = $derived(splitLive(chats));
	const providers = $derived(card?.kind === "server" ? under(graph, card.id, "provider") : []);
	const models = $derived(card?.kind === "provider" ? under(graph, card.id, "model") : []);
	/** The subagent cards that ran on this model (across any server sharing it). */
	const modelRoles = $derived.by(() => {
		if (card?.kind !== "model") return [];
		const refs = new Map(cardServers.map((sid) => [sid, `${providerIdOn(sid)}/${card.label}`]));
		return [...graph.cards.values()].filter((c) => c.kind === "subagent" && refs.get(c.server) === c.model?.model);
	});
	/** The same role's cards on other models, the one used last first. */
	const siblings = $derived(
		card?.kind === "subagent" ? [...graph.cards.values()].filter((c) => c.kind === "subagent" && c.server === card.server && c.label === card.label && c.id !== card.id).sort((a, b) => b.last! - a.last!) : [],
	);
	// one row per role and model, a role's models together (the one used last first)
	const roles = $derived(card?.kind === "server" ? [...graph.cards.values()].filter((c) => c.kind === "subagent" && c.server === card.server).sort((a, b) => a.label.localeCompare(b.label) || b.last! - a.last!) : []);

	const STATE_TEXT = { online: () => t("연결됨"), offline: () => t("연결 안 됨"), unauthorized: () => t("토큰 거부됨"), incompatible: () => t("앱 업데이트 필요"), checking: () => t("확인 중") };
	const serverState = $derived(connectionState(link?.net ?? "connecting"));

	/** A connection the owner added: its address, API format and key (built-in providers have none of these). */
	const primaryPid = $derived(card ? providerIdOn(card.server) : "");
	const custom = $derived(card?.kind === "provider" ? link?.customProviders.find((p) => p.id === primaryPid) : undefined);
	const FORMAT: Record<string, string> = { "openai-completions": "OpenAI Chat Completions", "openai-responses": "OpenAI Responses", "anthropic-messages": "Anthropic Messages" };
	const keyText = $derived(!custom ? "" : custom.hasStoredKey ? t("저장됨") : custom.authRequired ? t("필요하지만 저장 안 됨") : t("필요 없음"));
	const providerInfo = $derived(card?.kind === "provider" ? link?.providers.find((p) => p.id === primaryPid) : undefined);
	const providerModels = $derived(card?.kind === "provider" ? (link?.models ?? []).filter((m) => m.provider === primaryPid && m.available) : []);
	const signIn = $derived.by(() => {
		const p = providerInfo;
		if (!p) return null;
		if (!p.configured) return t("연결 안 됨");
		if (p.storedCredential === "oauth") return "OAuth";
		if (p.storedCredential) return t("API 키");
		return t("연결됨");
	});
	const serverSummary = (sid: string) => {
		const sLink = app.links[sid];
		if (!sLink) return t("연결 안 됨");
		const st = connectionState(sLink.net);
		if (st !== "online") return STATE_TEXT[st]();
		const pid = providerIdOn(sid);
		const cp = sLink.customProviders.find((p) => p.id === pid);
		if (cp) return cp.hasStoredKey ? t("API 키") : cp.authRequired ? t("키 없음") : t("연결됨");
		const pi = sLink.providers.find((p) => p.id === pid);
		if (!pi) return STATE_TEXT[st]();
		if (!pi.configured) return t("연결 안 됨");
		return pi.storedCredential === "oauth" ? (pi.accountEmail ?? "OAuth") : pi.storedCredential ? t("API 키") : t("연결됨");
	};

	const modelInfo = $derived.by(() => {
		if (card?.kind !== "model") return undefined;
		for (const sid of [card.server, ...cardServers]) {
			const pid = providerIdOn(sid);
			const hit = app.links[sid]?.models.find((m) => m.provider === pid && m.id === card.label);
			if (hit) return hit;
		}
		return undefined;
	});

	// the calls of this card (its role on its model), counted like the card (calls from open chats), and its file (read from
	// the folder of the chat that called it last: a project's role files win over the global ones)
	const stats = $derived.by(() => {
		if (card?.kind !== "subagent") return null;
		const server = card.server, model = card.model?.model;
		return roleStats((graphRuns.runs[server] ?? []).filter((r) => r.model === model), card.label, (sid) => graph.cards.has(`s:${server}/${sid}`));
	});
	/** A role card's row end: its calls, and when it was last used if that was a while ago (a model the role moved off). */
	const roleEnd = (c: Card) => (c.last && Date.now() - c.last > ROLE_STALE_MS ? `${t("{n}회", { n: c.count })} · ${ago(c.last)}` : t("{n}회", { n: c.count }));
	/** Calls of the role on every model, when it ran on more than this one. */
	const roleTotal = $derived(siblings.length ? siblings.reduce((n, c) => n + c.count, card?.count ?? 0) : 0);
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
	const chatOf = (server: string, sid: string) => app.links[server]?.sessionById.get(sid);
	const chatName = (server: string, sid: string) => {
		const s = chatOf(server, sid);
		return s ? (s.name ? `@${s.name}` : sessionTitle(s.title)) : sid;
	};
	/** The model a role runs on when the call names none: its file's, else the calling chat's own. */
	const roleModel = $derived(def ? (def.model ?? null) : null);

	// ---- header ----
	const title = $derived(card?.name ?? "");
	/** A model's provider by the connection's name, a model or a call's model by the name the owner gave it. */
	const providerName = (id: string | undefined) => providerDisplayName(link?.providers ?? [], id);
	const refName = (ref: string) => { const r = splitModelRef(ref); return modelDisplayName(link?.models ?? [], r.provider, r.id); };
	const iconOf = (provider: string | undefined, id: string) => {
		const hit = modelIcon(link?.models ?? [], provider, id);
		if (hit || !multiServers) return hit;
		for (const sid of cardServers) {
			const x = modelIcon(app.links[sid]?.models ?? [], providerIdOn(sid) || provider, id);
			if (x) return x;
		}
		return undefined;
	};
	const sub = $derived.by(() => {
		if (!card) return "";
		if (card.kind === "server") return card.host ?? "";
		if (card.kind === "provider") return cardServers.map(serverDisplayName).join(", ");
		if (card.kind === "model") return [providerName(card.provider), cardServers.map(serverDisplayName).join(", ")].join(" · ");
		return [t("서브에이전트"), card.model?.name, serverName].filter(Boolean).join(" · ");
	});
	const serverChatCount = (c: Card) => (card?.kind === "server" ? under(graph, c.id, "session").filter((s) => s.server === card.server).length : c.count);

	// ---- footer ----
	/** Opens the settings on this card's own row: its connection, its model in that connection's list, its role. */
	function openSettings() {
		if (!card) return;
		const sid = cardServers.find((s) => app.links[s]?.online) ?? card.server;
		const sLink = app.links[sid];
		const pid = card.kind === "model" || card.kind === "provider" ? providerIdOn(sid) : card.label;
		const builtin = sLink?.providers.find((p) => p.id === pid && p.builtin);
		const normalized = card.kind === "provider" ? { ...card, label: pid } : card.kind === "model" ? { ...card, provider: pid } : card;
		const target = settingsTarget(normalized, { custom: sLink?.customProviders.find((p) => p.id === pid), builtin, roleScope: def?.scope ?? null });
		onclose();
		app.openSettings(target.tab, sid, target.focus);
	}
	/** The server's address, or a connection's endpoint. */
	async function copyAddress() {
		const url = card?.kind === "provider" ? (card.ep?.baseUrl ?? custom?.baseUrl) : saved?.baseUrl;
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
			<span class="nm {c.activity}" class:who={!!s.name}>{s.name ? `@${s.name}` : sessionTitle(s.title)}</span>
			{#if s.name}<span class="sub">{sessionTitle(s.title)}</span>{/if}
			<span class="end" title={fullTime(s.updatedAt)}>{#if multiServers}<span>{serverDisplayName(c.server)}</span><i>·</i>{/if}{ago(s.updatedAt)}</span>
		</button>
	</li>
{/snippet}

<!-- one delegate call: the chat that made it (its handle in its state colour), the model it ran on with its mark, how it went -->
{#snippet callRow(server: string, r: DelegateRun)}
	{@const st = callState(r)}
	{@const act = link ? activityOf(link.data, r.sessionId) : "idle"}
	{@const ref = splitModelRef(r.model)}
	{@const mn = refName(r.model)}
	<li>
		<button class="row" onclick={() => onpeek(server, r.sessionId)} title={t("빠른 보기")}>
			<span class="mark"><AgentBadge id={r.sessionId} {server} state={act} size={20} /></span>
			<span class="nm {act}" class:who={!!chatOf(server, r.sessionId)?.name}>{chatName(server, r.sessionId)}</span>
			<span class="sub model" title={r.model}><ModelLogo conn={link?.conn} icon={iconOf(ref.provider, ref.id)} provider={ref.provider} model={ref.id} size={16} colored /><span class="mn" class:mono={mn === ref.id}>{mn}</span></span>
			<span class="end">
				<span class="st {st}">{CALL_TEXT[st]()}</span>
				{#if r.doneAt !== null && !r.running}<i>·</i><span class="mono">{duration(Math.max(0, r.doneAt - r.at))}</span>{/if}
				<i>·</i><span title={fullTime(r.at)}>{ago(r.at)}</span>
			</span>
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
			{#if c.kind === "subagent" && c.model}
				{@const ref = splitModelRef(c.model.model)}
				<!-- a role card is one role on one model: the row says which -->
				<span class="sub model" title={c.model.model}><ModelLogo conn={link?.conn} icon={iconOf(ref.provider, ref.id)} provider={ref.provider} model={ref.id} size={16} colored /><span class="mn" class:mono={c.model.name === ref.id}>{c.model.name}</span></span>
			{/if}
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
					<dd><span class="mono">{saved?.baseUrl ?? card.host}</span></dd>
					{#if link?.versions?.version}<dt>{t("서버 버전")}</dt><dd><span class="mono">v{link.versions.version}</span></dd>{/if}
					{#if link?.workspace?.root}<dt>{t("기본 작업 폴더")}</dt><dd><span class="mono">{tilde(link.workspace.root, link.workspace.home)}</span></dd>{/if}
					<dt>{t("대화")}</dt>
					<dd>{t("대화 {n}개", { n: card.count })}{#if card.live}<span class="faint">{" · "}{t("작업 중")}</span>{/if}</dd>
				{:else if card.kind === "provider"}
					<dt>ID</dt>
					<dd><span class="mono">{card.label}</span></dd>
					<dt>{t("종류")}</dt>
					<dd>{custom ? t("직접 추가한 연결") : t("내장")}</dd>
					{#if custom}
						<dt>{t("주소")}</dt>
						<dd><span class="mono">{custom.baseUrl}</span></dd>
						<dt>{t("API 방식")}</dt>
						<dd>{FORMAT[custom.api] ?? custom.api}</dd>
						<dt>{t("API 키")}</dt>
						<dd class:bad={custom.authRequired && !custom.hasStoredKey}>{keyText}</dd>
					{/if}
					<!-- a connection the owner added says it with its key line above -->
					{#if signIn && !custom}<dt>{t("인증")}</dt><dd class:bad={!providerInfo?.configured}>{signIn}</dd>{/if}
					{#if providerInfo?.accountEmail}<dt>{t("계정")}</dt><dd><span class="mono">{providerInfo.accountEmail}</span></dd>{/if}
					{#if link?.loaded}<dt>{t("모델")}</dt><dd>{t("모델 {n}개", { n: providerModels.length })}<span class="faint">{" · "}{t("대화에서 쓰는 모델 {n}개", { n: card.children.length })}</span></dd>{/if}
					<dt>{t("대화")}</dt>
					<dd>{t("대화 {n}개", { n: card.count })}</dd>
				{:else if card.kind === "model"}
					{#if card.name !== card.label}<dt>{t("모델 ID")}</dt><dd><span class="mono">{card.label}</span></dd>{/if}
					<dt>{t("프로바이더")}</dt>
					<dd>{providerName(card.provider)}{#if providerName(card.provider) !== card.provider}<span class="faint mono">{" · "}{card.provider}</span>{/if}{#if card.brand}<span class="faint">{" · "}{BRAND_LABEL[card.brand]}</span>{/if}</dd>
					{#if modelInfo}
						<dt>{t("컨텍스트 창")}</dt>
						<dd><span class="mono">{compact(modelInfo.contextWindow)}</span></dd>
						<dt>{t("최대 출력")}</dt>
						<dd><span class="mono">{compact(modelInfo.maxTokens)}</span></dd>
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
						<dd><span class="mono">{tilde(def.file, link?.workspace?.home)}</span></dd>
						<dt>{t("도구")}</dt>
						<dd><span class="mono">{def.tools.join(", ") || t("없음")}</span></dd>
						<dt>{t("최대 턴")}</dt>
						<dd><span class="mono">{def.maxTurns}</span></dd>
						<dt>{t("기본 모델")}</dt>
						<dd>
							{#if roleModel}{@const ref = splitModelRef(roleModel)}<span class="model"><ModelLogo conn={link?.conn} icon={iconOf(ref.provider, ref.id)} provider={ref.provider} model={ref.id} size={16} colored /><span class="mn" class:mono={refName(roleModel) === ref.id}>{refName(roleModel)}</span></span>
							{:else}{t("호출한 대화의 모델")}{/if}
						</dd>
					{/if}
					{#if card.model}
						{@const m = card.model}
						{@const ref = splitModelRef(m.model)}
						<dt>{t("실행한 모델")}</dt>
						<dd>
							<span class="model" title={m.name !== ref.id ? m.model : undefined}><ModelLogo conn={link?.conn} icon={iconOf(ref.provider, ref.id)} provider={ref.provider} model={ref.id} size={16} colored /><span class="mn" class:mono={m.name === ref.id}>{m.name}</span></span>
							{#if card.asked}<span class="faint">{t("에이전트가 모델을 직접 골랐습니다 ({n}회)", { n: card.asked })}</span>{/if}
						</dd>
					{/if}
					<dt>{t("호출")}</dt>
					<dd>
						{t("{n}회", { n: stats.calls })}
						{#if roleTotal}<span class="faint">{" · "}{t("역할 전체 {n}회", { n: roleTotal })}</span>{/if}
						{#if stats.running}<span class="run">{" · "}{t("실행 중 {n}", { n: stats.running })}</span>{/if}
						{#if stats.failed}<span class="bad">{" · "}{t("실패 {n}", { n: stats.failed })}</span>{/if}
					</dd>
					{#if stats.avgMs !== null}<dt>{t("평균 소요")}</dt><dd><span class="mono">{duration(stats.avgMs)}</span></dd>{/if}
					{#if stats.tokens}<dt>{t("토큰 합계")}</dt><dd><span class="mono">{compact(stats.tokens)}{#if stats.turns}<span class="faint">{" · "}{t("{n}턴", { n: stats.turns })}</span>{/if}</span></dd>{/if}
				{/if}
			</dl>

			{#if multiServers && (card.kind === "provider" || card.kind === "model")}
				<ListGroup title={t("서버")} count={String(cardServers.length)}>
					<ul class="list">
						{#each cardServers as sid (sid)}
							<li>
								<button class="row" onclick={() => onpick(`v:${sid}`)}>
									<span class="mark"><Icon name="server" /></span>
									<span class="nm">{serverDisplayName(sid)}</span>
									<span class="end">{serverSummary(sid)}</span>
									<span class="chev"><Icon name="chevron-right" /></span>
								</button>
							</li>
						{/each}
					</ul>
				</ListGroup>
			{/if}
			{#if providers.length}
				<ListGroup title={t("프로바이더")} count={String(providers.length)}>
					<ul class="list">{#each providers as c (c.id)}{@render cardRow(c, t("대화 {n}개", { n: serverChatCount(c) }))}{/each}</ul>
				</ListGroup>
			{/if}
			{#if models.length}
				<ListGroup title={t("모델")} count={String(models.length)}>
					<ul class="list">{#each models as c (c.id)}{@render cardRow(c, t("대화 {n}개", { n: serverChatCount(c) }))}{/each}</ul>
				</ListGroup>
			{/if}
			{#if modelRoles.length}
				<ListGroup title={t("서브에이전트")} count={String(modelRoles.length)}>
					<ul class="list">{#each modelRoles as c (c.id)}{@render cardRow(c, t("{n}회", { n: c.count }))}{/each}</ul>
				</ListGroup>
			{/if}
			{#if roles.length}
				<ListGroup title={t("서브에이전트")} count={String(roles.length)}>
					<ul class="list">{#each roles as c (c.id)}{@render cardRow(c, roleEnd(c))}{/each}</ul>
				</ListGroup>
			{/if}
			{#if chatGroups.live.length}
				<ListGroup title={t("작업 중")} count={String(chatGroups.live.length)}>
					<ul class="list">{#each chatGroups.live as c (c.id)}{@render chatRow(c)}{/each}</ul>
				</ListGroup>
			{/if}
			{#if chatGroups.rest.length}
				<ListGroup title={chatGroups.live.length ? t("최근") : t("대화")} count={String(chatGroups.rest.length)}>
					<ul class="list">{#each chatGroups.rest as c (c.id)}{@render chatRow(c)}{/each}</ul>
				</ListGroup>
			{/if}
			{#if siblings.length}
				<ListGroup title={t("다른 모델")} count={String(siblings.length)}>
					<ul class="list">{#each siblings as c (c.id)}{@render cardRow(c, roleEnd(c))}{/each}</ul>
				</ListGroup>
			{/if}
			{#if stats?.active.length}
				<ListGroup title={t("실행 중")} count={String(stats.active.length)}>
					<ul class="list">{#each stats.active as r (r.callId)}{@render callRow(card.server, r)}{/each}</ul>
				</ListGroup>
			{/if}
			{#if stats?.recent.length}
				{@const done = stats.calls - stats.active.length}
				<ListGroup title={t("최근 호출")} count={stats.recent.length < done ? `${stats.recent.length}/${done}` : String(done)}>
					<ul class="list">{#each stats.recent as r (r.callId)}{@render callRow(card.server, r)}{/each}</ul>
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
	/* A mono value sits in the label's line: JetBrains Mono's ascent is taller than Manrope's, so a dd set in mono put its
	   baseline 1px above the label's (measured on ID, 주소, 버전, 컨텍스트 창). The dd keeps the body face, which sets the
	   line, and the mono run inside it takes no line height of its own. */
	.kv dd :global(.mono) {
		line-height: 1;
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
	/* a chat's `@name` in its badge's state colour, as the Handle shows it everywhere else */
	.row .nm.who.working {
		color: var(--info);
	}
	.row .nm.who.asking {
		color: var(--warn);
	}
	.row .nm.who.done {
		color: var(--ok);
	}
	.row .nm.who.failed {
		color: var(--danger);
	}
	.row .sub.model {
		display: inline-flex;
		align-items: center;
		gap: 8px;
	}
	.row .sub.model .mn {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
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
