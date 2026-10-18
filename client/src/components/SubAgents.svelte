<script lang="ts">
	import { onMount } from "svelte";
	import { reflow, rowIn, rowOut } from "../lib/motion";
	import { t } from "../lib/i18n";
	import { Api, ApiError, errorText } from "../lib/api";
	import { app } from "../lib/store.svelte";
	import type { ModelInfo, SubAgentInfo, SubAgentList } from "../lib/types";
	import Accordion from "./Accordion.svelte";
	import Badge from "./Badge.svelte";
	import Notice from "./Notice.svelte";
	import Switch from "./Switch.svelte";

	let { serverId }: { serverId: string } = $props();
	const server = $derived(app.servers.find((s) => s.id === serverId));
	const api = $derived(server ? new Api({ baseUrl: server.baseUrl, token: server.token }) : null);
	/** Project helpers (`<project>/.agents/subagents`) are only known for the server the app is showing. */
	const cwd = $derived(serverId === app.serverId ? app.workdirAbs || undefined : undefined);

	let loaded = $state(false);
	let error = $state("");
	let saving = $state(false);
	let data = $state<SubAgentList | null>(null);
	let models = $state<ModelInfo[]>([]);
	let openNames = $state<Record<string, boolean>>({});

	async function load() {
		if (!api) {
			error = t("대상을 찾을 수 없습니다");
			return;
		}
		error = "";
		try {
			const [list, ms] = await Promise.all([api.subagents(cwd, AbortSignal.timeout(15_000)), api.models().catch(() => [] as ModelInfo[])]);
			// A server from before agent files answers with `{ settings, defaults }`; rendering that would throw and leave "loading" up.
			if (!isSubAgentList(list)) throw new ApiError(404, "not_found", "route not found");
			data = list;
			models = ms;
			loaded = true;
		} catch (e) {
			error = (e as Error)?.name === "TimeoutError" ? t("서버에 연결할 수 없습니다") : errorText(e);
		}
	}
	const isSubAgentList = (v: unknown): v is SubAgentList =>
		Boolean(v) && typeof (v as SubAgentList).enabled === "boolean" && Array.isArray((v as SubAgentList).agents) && Array.isArray((v as SubAgentList).warnings);
	onMount(() => void load());
	// Agent files edited on disk arrive as skills_updated (same watcher as skills).
	let seen = app.skillsTick;
	$effect(() => {
		if (app.skillsTick !== seen) {
			seen = app.skillsTick;
			void load();
		}
	});

	async function change(run: () => Promise<SubAgentList>) {
		saving = true;
		error = "";
		try {
			data = await run();
		} catch (e) {
			error = t("서브에이전트 설정을 저장하지 못했습니다: {error}", { error: errorText(e) });
		} finally {
			saving = false;
		}
	}
	const setMaster = (v: boolean) => change(() => api!.setSubagentsEnabled(v, cwd));
	const setAgent = (a: SubAgentInfo, v: boolean) => change(() => api!.setSubagentEnabled(a.name, v, cwd));

	const infoOf = (a: SubAgentInfo) => (a.model ? models.find((m) => m.provider === a.model!.provider && m.id === a.model!.model) : undefined);
	const home = (p: string) => p.replace(/^\/home\/[^/]+/, "~");
</script>

<div class="sub">
	{#if error}<Notice tone="danger">{error}</Notice>{/if}
	{#if !loaded && !error}
		<p class="hint">{t("불러오는 중…")}</p>
	{:else if data}
		<section class="card" aria-labelledby="sa-main">
			<div class="row">
				<div class="grow">
					<div id="sa-main" class="label">{t("서브에이전트")}</div>
					<p class="hint">{t("메인 에이전트가 파일을 여러 번 읽고 검색해야 하는 조사를 서브에이전트에게 맡기고, 짧은 보고서만 받습니다. 서브에이전트가 읽은 파일은 대화에 쌓이지 않습니다.")}</p>
				</div>
				<Switch checked={data.enabled} disabled={saving} label={t("서브에이전트")} onchange={(v) => void setMaster(v)} />
			</div>
		</section>

		<section class="list" class:off={!data.enabled} aria-labelledby="sa-list">
			<div id="sa-list" class="label">{t("서브에이전트 목록")}</div>
			<p class="hint">{t("서브에이전트는 파일로 정의합니다. 파일을 고치면 다음 메시지부터 적용되고, 여기서는 켜고 끄기만 합니다.")}</p>

			{#each data.warnings as w}
				<Notice tone="warn"><span class="mono">{home(w.path)}</span><br />{w.message}</Notice>
			{/each}

			{#if !data.agents.length}
				<p class="hint">{t("서브에이전트가 없습니다.")} <span class="mono">~/.agents/subagents/&lt;{t("이름")}&gt;.md</span> {t("또는 프로젝트의")} <span class="mono">.agents/subagents/</span>{t("에 추가하세요.")}</p>
			{/if}

			{#each data.agents as a (a.name)}
				{@const info = infoOf(a)}
				<div class="agent" class:dim={!a.enabled} animate:reflow in:rowIn out:rowOut>
					<Accordion variant="box" open={openNames[a.name] ?? false} onchange={(o) => (openNames[a.name] = o)}>
						{#snippet head()}
							<span class="aname">{a.name}</span>
							<Badge size="sm">{a.scope === "project" ? t("프로젝트") : t("전역")}</Badge>
							{#if !a.enabled}<span class="chip">{t("꺼짐")}</span>{/if}
							<span class="meta">{a.model ? (info?.name ?? a.model.model) : t("대화의 모델 그대로 사용")} · {t("{n}단계", { n: a.maxTurns })}</span>
						{/snippet}

						<div class="body">
							<div class="row">
								<p class="hint grow">{a.description}</p>
								<Switch
									checked={a.enabled}
									disabled={saving || !a.fileEnabled}
									label={t("서브에이전트 {name} 켜기", { name: a.name })}
									onchange={(v) => void setAgent(a, v)}
								/>
							</div>
							{#if !a.fileEnabled}<p class="hint">{t("파일에서 enabled: false로 꺼져 있습니다. 파일을 고쳐야 켤 수 있습니다.")}</p>{/if}

							<div class="fl">
								<span class="label">{t("서브에이전트 모델")}</span>
								<p class="hint">
									{#if !a.model}
										{t("서브에이전트를 부른 대화가 쓰는 모델로 실행합니다. 비용을 줄이려면 가볍고 저렴한 모델을 고르세요.")}
									{:else}
										<span class="mono">{a.model.provider}/{a.model.model}</span>{a.model.thinkingLevel ? ` · ${a.model.thinkingLevel}` : ""}
										{#if models.length && !info} · {t("등록되지 않은 모델이라 대화의 모델로 대신 실행합니다.")}
										{:else if info && !info.configured} · {t("이 모델의 연결에 키가 없어 서브에이전트가 실패합니다. 키를 설정하거나 다른 모델을 고르세요.")}{/if}
									{/if}
								</p>
							</div>

							<div class="fl">
								<span class="label">{t("도구")}</span>
								<div class="checks">
									{#each a.tools as tool}
										<span class="check on" class:write={tool === "write" || tool === "edit" || tool === "bash"}><span class="tname">{tool}</span></span>
									{/each}
								</div>
							</div>

							{#if a.prompt}
								<div class="fl">
									<span class="label">{t("추가 지침")}</span>
									<pre class="prompt">{a.prompt}</pre>
								</div>
							{/if}

							<p class="path mono">{home(a.path)}</p>
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
	.prompt {
		margin: 0;
		padding: 10px 12px;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		font-family: var(--mono);
		font-size: var(--fs-xs);
		line-height: 1.5;
		color: var(--text-dim);
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: var(--radius);
	}
	.path {
		margin: 0;
		font-size: var(--fs-2xs);
		color: var(--text-faint);
		overflow-wrap: anywhere;
	}
	.mono {
		font-family: var(--mono);
	}
</style>
