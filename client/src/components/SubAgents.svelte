<script lang="ts">
	import { onMount } from "svelte";
	import ConfirmButton from "./ConfirmButton.svelte";
	import { reflow, rowIn, rowOut } from "../lib/motion";
	import { t } from "../lib/i18n";
	import { Api, ApiError, errorText } from "../lib/api";
	import { app } from "../lib/store.svelte";
	import type { ModelInfo, ProviderInfo, SubAgentDef, SubAgentSettings, SubAgentTool } from "../lib/types";
	import Accordion from "./Accordion.svelte";
	import Icon from "./Icon.svelte";
	import Notice from "./Notice.svelte";
	import Switch from "./Switch.svelte";
	import ModelField from "./ModelField.svelte";

	let { serverId }: { serverId: string } = $props();
	const server = $derived(app.servers.find((s) => s.id === serverId));
	const api = $derived(server ? new Api({ baseUrl: server.baseUrl, token: server.token }) : null);

	/** Same limits as the server (subagent-settings.ts); the server checks them again. */
	const NAME = /^[a-z][a-z0-9-]{0,39}$/;
	const MAX_AGENTS = 10;
	const TURNS = { min: 2, max: 30 };
	const DEFAULT_TURNS = 12;

	let loaded = $state(false);
	let error = $state("");
	let saving = $state(false);
	let settings = $state<SubAgentSettings | null>(null);
	let toolChoices = $state<SubAgentTool[]>(["read", "grep", "ls", "write", "edit", "bash"]);
	let models = $state<ModelInfo[]>([]);
	let providers = $state<ProviderInfo[]>([]);
	/** Name of the helper being deleted (asks again before removing). */
	/** Which helper panels are open, by name. */
	let openNames = $state<Record<string, boolean>>({});
	/** Text fields keep a local draft and save when left, so typing does not send a request per key. */
	let drafts = $state<Record<string, Partial<Pick<SubAgentDef, "description" | "prompt">> & { turns?: string }>>({});
	let fieldError = $state<Record<string, string>>({});

	async function load() {
		if (!api) return;
		error = "";
		try {
			const [info, list, provs] = await Promise.all([
				api.subagents(),
				api.models().catch(() => [] as ModelInfo[]),
				api.providers().catch(() => [] as ProviderInfo[]),
			]);
			settings = info.settings;
			if (info.toolChoices?.length) toolChoices = info.toolChoices;
			models = list;
			providers = provs;
			loaded = true;
		} catch (e) {
			// A server that predates sub-agents answers "not found" for /subagents: say so instead of a bare "not found".
			error = e instanceof ApiError && (e.code === "not_found" || e.status === 404)
				? t("이 서버는 서브에이전트 설정을 지원하지 않습니다. 서버를 최신 버전으로 업데이트하고 재시작하세요.")
				: errorText(e);
		}
	}
	onMount(() => void load());

	/** Each change is saved at once; the form shows the new value immediately and puts the old one back if the server refuses. */
	async function save(next: SubAgentSettings): Promise<boolean> {
		if (!api || !settings) return false;
		const before = settings;
		settings = next;
		saving = true;
		error = "";
		try {
			settings = (await api.setSubagents(next)).settings;
			return true;
		} catch (e) {
			settings = before;
			error = t("서브에이전트 설정을 저장하지 못했습니다: {error}", { error: errorText(e) });
			return false;
		} finally {
			saving = false;
		}
	}

	const patch = (name: string, change: Partial<SubAgentDef>) =>
		save({ ...settings!, agents: settings!.agents.map((a) => (a.name === name ? { ...a, ...change } : a)) });

	/* ---------- adding ---------- */
	let adding = $state(false);
	let newName = $state("");
	let newDesc = $state("");
	let addError = $state("");

	function startAdd() {
		adding = true;
		newName = "";
		newDesc = "";
		addError = "";
	}
	async function add() {
		const name = newName.trim();
		const description = newDesc.trim();
		if (!NAME.test(name)) return void (addError = t("이름은 소문자로 시작하고 소문자, 숫자, 하이픈만 쓸 수 있습니다 (최대 40자)."));
		if (settings!.agents.some((a) => a.name === name)) return void (addError = t("같은 이름의 서브에이전트가 이미 있습니다."));
		if (!description) return void (addError = t("설명을 입력하세요."));
		const def: SubAgentDef = { name, description, enabled: true, model: null, tools: ["read", "grep", "ls"], maxTurns: DEFAULT_TURNS, prompt: "" };
		if (await save({ ...settings!, agents: [...settings!.agents, def] })) {
			adding = false;
			openNames[name] = true;
		}
	}
	async function remove(name: string) {
		await save({ ...settings!, agents: settings!.agents.filter((a) => a.name !== name) });
	}

	/* ---------- editing ---------- */
	async function commitText(a: SubAgentDef, key: "description" | "prompt") {
		const draft = drafts[a.name]?.[key];
		if (draft === undefined || draft === a[key]) return;
		if (key === "description" && !draft.trim()) {
			fieldError[a.name] = t("설명을 입력하세요.");
			return;
		}
		delete fieldError[a.name];
		await patch(a.name, { [key]: key === "description" ? draft.trim() : draft });
		delete drafts[a.name]![key];
	}
	async function commitTurns(a: SubAgentDef) {
		const raw = drafts[a.name]?.turns;
		if (raw === undefined) return;
		const n = Math.round(Number(raw));
		delete drafts[a.name]!.turns;
		if (!Number.isFinite(n) || n === a.maxTurns) return;
		await patch(a.name, { maxTurns: Math.min(TURNS.max, Math.max(TURNS.min, n)) });
	}
	function toggleTool(a: SubAgentDef, tool: SubAgentTool, on: boolean) {
		const tools = toolChoices.filter((x) => (x === tool ? on : a.tools.includes(x)));
		if (!tools.length) return void (fieldError[a.name] = t("도구는 하나 이상 필요합니다."));
		delete fieldError[a.name];
		void patch(a.name, { tools });
	}
	const draftOf = (a: SubAgentDef, key: "description" | "prompt") => drafts[a.name]?.[key] ?? a[key];
	function setDraft(name: string, key: "description" | "prompt" | "turns", value: string) {
		drafts[name] = { ...drafts[name], [key]: value };
	}

	const infoOf = (a: SubAgentDef) => (a.model ? models.find((m) => m.provider === a.model!.provider && m.id === a.model!.model) : undefined);
	const favs = $derived(serverId === app.serverId ? app.favModels : []);
</script>

<div class="sub">
	{#if error}<Notice tone="danger">{error}</Notice>{/if}
	{#if !loaded && !error}
		<p class="hint">{t("불러오는 중…")}</p>
	{:else if settings}
		<section class="card" aria-labelledby="sa-main">
			<div class="row">
				<div class="grow">
					<div id="sa-main" class="label">{t("서브에이전트")}</div>
					<p class="hint">{t("메인 에이전트가 파일을 여러 번 읽고 검색해야 하는 조사를 서브에이전트에게 맡기고, 짧은 보고서만 받습니다. 서브에이전트가 읽은 파일은 대화에 쌓이지 않습니다.")}</p>
				</div>
				<Switch checked={settings.enabled} disabled={saving} label={t("서브에이전트")} onchange={(v) => void save({ ...settings!, enabled: v })} />
			</div>
		</section>

		<section class="list" class:off={!settings.enabled} aria-labelledby="sa-list">
			<div class="row">
				<div id="sa-list" class="label grow">{t("서브에이전트 목록")}</div>
				<button type="button" class="btn sm" disabled={saving || !settings.enabled || settings.agents.length >= MAX_AGENTS} onclick={startAdd}>
					<Icon name="plus" /> {t("서브에이전트 추가")}
				</button>
			</div>
			{#if settings.agents.length >= MAX_AGENTS}<p class="hint">{t("최대 {n}개까지 만들 수 있습니다.", { n: MAX_AGENTS })}</p>{/if}

			{#if adding}
				<form class="card" onsubmit={(e) => { e.preventDefault(); void add(); }}>
					<label class="fl">
						<span class="label">{t("이름")}</span>
						<input class="field" bind:value={newName} placeholder="explore" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="40" />
					</label>
					<label class="fl">
						<span class="label">{t("설명")}</span>
						<input class="field" bind:value={newDesc} maxlength="200" />
						<span class="hint">{t("메인 에이전트가 이 서브에이전트를 언제 고를지 알 수 있게 짧게 적어 주세요.")}</span>
					</label>
					{#if addError}<Notice tone="danger">{addError}</Notice>{/if}
					<div class="row end">
						<button type="button" class="btn ghost sm" onclick={() => (adding = false)}>{t("취소")}</button>
						<button class="btn primary sm" disabled={saving}>{t("서브에이전트 추가")}</button>
					</div>
				</form>
			{/if}

			{#if !settings.agents.length}
				<p class="hint">{t("서브에이전트가 없습니다. 추가하기 전에는 서브에이전트를 쓸 수 없습니다.")}</p>
			{/if}

			{#each settings.agents as a (a.name)}
				{@const info = infoOf(a)}
				<div class="agent" class:dim={!a.enabled} animate:reflow in:rowIn out:rowOut>
					<Accordion variant="box" open={openNames[a.name] ?? false} onchange={(o) => (openNames[a.name] = o)}>
						{#snippet head()}
							<span class="aname">{a.name}</span>
							{#if !a.enabled}<span class="chip">{t("꺼짐")}</span>{/if}
							<span class="meta">{a.model ? (info?.name ?? a.model.model) : t("대화의 모델 그대로 사용")} · {t("{n}단계", { n: a.maxTurns })}</span>
						{/snippet}

						<div class="body">
							<div class="row">
								<p class="hint grow">{a.description}</p>
								<Switch checked={a.enabled} disabled={saving} label={t("서브에이전트 {name} 켜기", { name: a.name })} onchange={(v) => void patch(a.name, { enabled: v })} />
							</div>

							<label class="fl">
								<span class="label">{t("설명")}</span>
								<input
									class="field"
									value={draftOf(a, "description")}
									maxlength="200"
									disabled={saving}
									oninput={(e) => setDraft(a.name, "description", e.currentTarget.value)}
									onblur={() => void commitText(a, "description")}
								/>
							</label>

							<div class="fl">
								<span class="label">{t("서브에이전트 모델")}</span>
								<ModelField
									{models}
									{providers}
									value={a.model}
									level={a.model?.thinkingLevel ?? null}
									{favs}
									onfav={serverId === app.serverId ? (p, id) => app.toggleFavModel(p, id) : undefined}
									allowUnset
									unsetLabel={t("대화의 모델 그대로 사용")}
									placeholder={t("대화의 모델 그대로 사용")}
									disabled={saving}
									label={`${t("서브에이전트 모델")}: ${a.name}`}
									onpick={(c) => void patch(a.name, { model: c })}
								/>
								<p class="hint">
									{#if !a.model}
										{t("서브에이전트를 부른 대화가 쓰는 모델로 실행합니다. 비용을 줄이려면 가볍고 저렴한 모델을 고르세요.")}
									{:else if info && !info.configured}
										{t("이 모델의 연결에 키가 없어 서브에이전트가 실패합니다. 키를 설정하거나 다른 모델을 고르세요.")}
									{:else if info && !info.reasoning}
										{t("이 모델은 추론 모드를 지원하지 않아 추론 강도는 쓰이지 않습니다.")}
									{:else if a.model.thinkingLevel}
										{t("추론 강도 {level}로 실행합니다. 탐색과 인용에는 보통 낮은 강도로 충분하고, 높일수록 비용이 늘어납니다.", { level: a.model.thinkingLevel })}
									{:else}
										{t("추론 강도를 고르지 않으면 minimal로 실행합니다. 탐색과 인용에는 보통 낮은 강도로 충분합니다.")}
									{/if}
								</p>
							</div>

							<fieldset class="fl tools">
								<legend class="label">{t("도구")}</legend>
								<div class="checks">
									{#each toolChoices as tool}
										<label class="check" class:on={a.tools.includes(tool)} class:write={tool === "write" || tool === "edit" || tool === "bash"}>
											<input type="checkbox" checked={a.tools.includes(tool)} disabled={saving} onchange={(e) => toggleTool(a, tool, e.currentTarget.checked)} />
											<span class="tname">{tool}</span>
										</label>
									{/each}
								</div>
								<p class="hint">{t("read·grep·ls는 읽기 전용입니다. write·edit·bash를 주면 서브에이전트가 파일을 수정하고 명령을 실행하며, 세션의 승인 설정을 따릅니다.")}</p>
							</fieldset>

							<label class="fl">
								<span class="label">{t("최대 단계")}</span>
								<input
									class="field narrow"
									type="number"
									inputmode="numeric"
									min={TURNS.min}
									max={TURNS.max}
									value={drafts[a.name]?.turns ?? String(a.maxTurns)}
									disabled={saving}
									oninput={(e) => setDraft(a.name, "turns", e.currentTarget.value)}
									onblur={() => void commitTurns(a)}
								/>
								<span class="hint">{t("이 횟수만큼 모델을 부르면 서브에이전트를 멈추고 그때까지의 보고서를 받습니다. ({min}–{max})", { min: TURNS.min, max: TURNS.max })}</span>
							</label>

							<label class="fl">
								<span class="label">{t("추가 지침")}</span>
								<textarea
									class="field area"
									rows="4"
									maxlength="2000"
									value={draftOf(a, "prompt")}
									disabled={saving}
									oninput={(e) => setDraft(a.name, "prompt", e.currentTarget.value)}
									onblur={() => void commitText(a, "prompt")}
								></textarea>
								<span class="hint">{t("기본 읽기 전용 조사 지침 뒤에 덧붙입니다. 비워 두면 기본 지침만 씁니다.")}</span>
							</label>

							{#if fieldError[a.name]}<Notice tone="danger">{fieldError[a.name]}</Notice>{/if}

							<div class="row end">
								<ConfirmButton size="sm" class="ghost" confirmLabel={t("정말 삭제")} disabled={saving} onconfirm={() => void remove(a.name)} ariaLabel={t("서브에이전트 {name} 삭제", { name: a.name })}>
									<Icon name="trash" /> {t("삭제")}
								</ConfirmButton>
							</div>
						</div>
					</Accordion>
				</div>
			{/each}
		</section>
	{/if}
</div>

<style>
	.sub {
		display: flex;
		flex-direction: column;
		gap: 14px;
	}
	.card {
		padding: 14px;
		border: 1px solid var(--border);
		border-radius: var(--radius-panel);
		display: flex;
		flex-direction: column;
		gap: 10px;
	}
	.list {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}
	.list.off {
		opacity: 0.55;
	}
	.agent.dim {
		opacity: 0.65;
	}
	.row {
		display: flex;
		align-items: center;
		gap: 12px;
	}
	.row.end {
		justify-content: flex-end;
	}
	.grow {
		flex: 1;
		min-width: 0;
	}
	.label {
		font-size: var(--fs-sm);
		font-weight: 650;
	}
	.hint {
		margin: 0;
		font-size: var(--fs-xs);
		line-height: 1.5;
		color: var(--text-faint);
	}
	.aname {
		font-weight: 600;
		font-family: var(--mono);
		font-size: var(--fs-sm);
		letter-spacing: 0;
	}
	.meta {
		margin-left: auto;
		font-size: var(--fs-xs);
		color: var(--text-faint);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.body {
		display: flex;
		flex-direction: column;
		gap: 14px;
		padding: 4px 2px 8px;
	}
	.fl {
		display: flex;
		flex-direction: column;
		gap: 6px;
		min-width: 0;
		border: 0;
		margin: 0;
		padding: 0;
	}
	.checks {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
	}
	.check {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		height: 34px;
		padding: 0 14px 0 10px;
		border: 1px solid var(--border);
		border-radius: var(--radius-pill);
		background: var(--bg-elev);
		cursor: pointer;
		user-select: none;
		transition:
			background-color var(--motion-fast) var(--ease-std),
			border-color var(--motion-fast) var(--ease-std);
	}
	.check:hover {
		background: var(--bg-hover);
		border-color: var(--border-strong);
	}
	.check.on {
		background: var(--accent-soft);
		border-color: var(--border-strong);
	}
	.check.on.write {
		background: var(--warn-soft);
		border-color: color-mix(in srgb, var(--warn) 45%, transparent);
	}
	.tname {
		font-family: var(--mono);
		font-size: var(--fs-xs);
		font-weight: 500;
		letter-spacing: 0;
		word-spacing: 0;
		color: var(--text-dim);
	}
	.check.on .tname {
		color: var(--text);
	}
	.narrow {
		width: 110px;
	}
	.area {
		height: auto;
		padding: 10px 12px;
		resize: vertical;
		line-height: 1.5;
	}
</style>
