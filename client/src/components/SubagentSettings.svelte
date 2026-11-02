<script lang="ts">
	import { untrack } from "svelte";
	import Badge from "./Badge.svelte";
	import Button from "./Button.svelte";
	import ConfirmButton from "./ConfirmButton.svelte";
	import EmptyState from "./EmptyState.svelte";
	import FilterChip from "./FilterChip.svelte";
	import FormField from "./FormField.svelte";
	import ExtrasIntro from "./ExtrasIntro.svelte";
	import ListGroup from "./ListGroup.svelte";
	import ListItem from "./ListItem.svelte";
	import ModelField from "./ModelField.svelte";
	import Notice from "./Notice.svelte";
	import Segmented from "./Segmented.svelte";
	import Select from "./Select.svelte";
	import Switch from "./Switch.svelte";
	import { Api, errorText } from "../lib/api";
	import { t } from "../lib/i18n";
	import { reflow, rowIn, rowOut } from "../lib/motion";
	import { app } from "../lib/store.svelte";
	import type { ModelInfo, SubagentInfo, SubagentList, ThinkingLevel } from "../lib/types";

	/**
	 * The helper roles `delegate` can start: the files in `~/.agents/subagents` (global) and the default working folder's
	 * `.agents/subagents` (project), listed, added, edited and removed here. The server writes the role files; a role changed
	 * by hand on disk shows up here by itself. Shown in the settings (project scope = the default working folder) and in the
	 * footer's dialog (`cwd` = that conversation's folder). `bare` drops the settings-card chrome for use inside a dialog.
	 */
	let { serverId, models, cwd, bare = false, refresh = 0, count = $bindable(null) }: { serverId: string; models: ModelInfo[]; cwd?: string; bare?: boolean; refresh?: number; count?: { on: number; total: number } | null } = $props();

	const server = $derived(app.servers.find((s) => s.id === serverId));
	const api = $derived(server ? new Api({ baseUrl: server.baseUrl, token: server.token }) : null);

	let data = $state<{ id: string; list: SubagentList } | null>(null);
	let loadError = $state("");
	let error = $state("");
	let busy = $state(false);
	const list = $derived(data && data.id === serverId ? data.list : null);
	// the dialog's header says how many are on
	$effect(() => { count = list ? { on: list.subagents.filter((r) => r.enabled).length, total: list.subagents.length } : null; });

	// Re-read when the server changes, and when role files change on disk (the same `skills_updated` event the file watcher sends).
	$effect(() => {
		void app.skillsTick;
		void refresh; // the dialog's refresh button
		const id = serverId;
		const a = api;
		const dir = cwd;
		untrack(() => {
			if (!a) return;
			a.subagents(dir).then((l) => { data = { id, list: l }; loadError = ""; }).catch((e) => (loadError = errorText(e)));
		});
	});

	/* ---------- form ---------- */
	type Form = {
		/** null = a new role */
		original: string | null;
		name: string;
		scope: "global" | "project";
		description: string;
		model: string;
		thinking: ThinkingLevel | null;
		tools: string[];
		maxTurns: number;
		prompt: string;
	};
	let form = $state<Form | null>(null);

	const DEFAULT_TOOLS = ["read", "grep", "ls"];
	function add() {
		error = "";
		form = { original: null, name: "", scope: "global", description: "", model: "", thinking: null, tools: DEFAULT_TOOLS, maxTurns: 12, prompt: "" };
	}
	function edit(r: SubagentInfo) {
		error = "";
		form = { original: r.name, name: r.name, scope: r.scope, description: r.description, model: r.model ?? "", thinking: (r.thinking as ThinkingLevel | undefined) ?? null, tools: r.tools, maxTurns: r.maxTurns, prompt: r.prompt };
	}

	const splitModel = (spec: string) => {
		const i = spec.indexOf("/");
		return i > 0 ? { provider: spec.slice(0, i), model: spec.slice(i + 1) } : null;
	};
	const toggleTool = (name: string) => {
		if (form) form.tools = form.tools.includes(name) ? form.tools.filter((x) => x !== name) : [...form.tools, name];
	};
	const turnOptions = (n: number) => [...new Set([3, 5, 8, 12, 16, 20, 30, n])].sort((a, b) => a - b).map((v) => ({ value: v, label: String(v) }));

	async function run(job: (a: Api) => Promise<SubagentList>): Promise<boolean> {
		const a = api;
		if (!a || busy) return false;
		busy = true;
		error = "";
		try {
			data = { id: serverId, list: await job(a) };
			return true;
		} catch (e) {
			error = errorText(e);
			return false;
		} finally {
			busy = false;
		}
	}
	async function submit(e: Event) {
		e.preventDefault();
		const f = form;
		if (!f) return;
		const body = { description: f.description, ...(f.model ? { model: f.model, ...(f.thinking ? { thinking: f.thinking } : {}) } : {}), tools: f.tools, maxTurns: f.maxTurns, prompt: f.prompt };
		const ok = await run((a) => (f.original ? a.saveSubagent(f.original, f.scope, body, cwd) : a.createSubagent(f.name.trim(), f.scope, body, cwd)));
		if (ok) form = null;
	}
	const toggle = (r: SubagentInfo, on: boolean) => run((a) => a.setSubagentEnabled(r.name, r.scope, on, cwd));
	const remove = (r: SubagentInfo) => run((a) => a.deleteSubagent(r.name, r.scope, cwd));

	const scopeText = (s: "global" | "project") => (s === "global" ? t("전역") : t("프로젝트"));
	/** Project roles first (they win), then global ones; a group with nothing in it is left out. */
	const groups = $derived(
		(["project", "global"] as const)
			.map((scope) => ({ scope, items: (list?.subagents ?? []).filter((r) => r.scope === scope), path: scope === "project" ? tilde(list?.projectDir ?? "") : "~/.agents/subagents" }))
			.filter((g) => g.items.length),
	);
	/** `~` for the home folder, and a long path loses its front (the end is the part that tells folders apart). */
	const tilde = (p: string) => {
		const h = p.replace(/^\/home\/[^/]+/, "~");
		return h.length > 44 ? `…${h.slice(-43)}` : h;
	};
	const scopeHint = $derived(form?.scope === "project" ? (list?.projectDir ?? "") : "~/.agents/subagents");
</script>

<section class:set-group={!bare} class:bare>
	{#if !bare}<div class="section-label">{t("도우미 역할")}</div>{/if}
	<ExtrasIntro
		what={t("에이전트가 delegate 도구로 일을 맡길 수 있는 도우미입니다. 각자 모델, 도구, 지침을 따로 가집니다.")}
		how={t("역할마다 파일 하나(.md)이고, 같은 이름이면 프로젝트 역할이 전역 역할보다 우선합니다.")}
	/>
	{#if loadError}<Notice tone="warn">{loadError}</Notice>{/if}
	{#if error}<Notice tone="warn">{error}</Notice>{/if}

	{#if form}
		<form class="form" onsubmit={submit}>
			{#if form.original}
				<div class="ftitle"><span class="name mono">{form.original}</span><Badge size="sm" variant="outline">{scopeText(form.scope)}</Badge></div>
			{:else}
				<FormField label={t("이름")}>
					<input class="field mono" bind:value={form.name} placeholder="reviewer" maxlength="40" autocomplete="off" autocapitalize="off" spellcheck="false" required />
				</FormField>
				<FormField label={t("저장 위치")} group hint={scopeHint}>
					<Segmented
						label={t("저장 위치")}
						value={form.scope}
						options={[{ id: "global", label: t("전역") }, { id: "project", label: t("프로젝트") }]}
						onchange={(id) => { if (form) form.scope = id; }}
					/>
				</FormField>
			{/if}
			<FormField label={t("설명")} hint={t("에이전트가 이 역할을 언제 고를지 알려 주는 한두 문장")}>
				<input class="field" bind:value={form.description} maxlength="500" autocomplete="off" />
			</FormField>
			<FormField label={t("모델")} group hint={t("비워 두면 호출한 대화의 모델로 실행합니다")}>
				<ModelField
					conn={server ? { baseUrl: server.baseUrl, token: server.token } : null}
					{models}
					value={splitModel(form.model)}
					level={form.thinking}
					favs={serverId === app.serverId ? app.favModels : []}
					allowUnset
					unsetLabel={t("호출한 대화의 모델")}
					placeholder={t("호출한 대화의 모델")}
					disabled={busy}
					label={t("도우미 모델")}
					onpick={(c) => { if (form) { form.model = c ? `${c.provider}/${c.model}` : ""; form.thinking = c?.thinkingLevel ?? null; } }}
				/>
			</FormField>
			<FormField label={t("쓸 수 있는 도구")} group>
				<div class="chips" role="group" aria-label={t("쓸 수 있는 도구")}>
					{#each list?.tools ?? [] as name (name)}
						<FilterChip size="sm" mono on={form.tools.includes(name)} onclick={() => toggleTool(name)}>{name}</FilterChip>
					{/each}
				</div>
			</FormField>
			<FormField label={t("최대 모델 호출")} group hint={t("한 번 일하는 동안 모델을 부를 수 있는 횟수 (위의 상한을 넘지 않습니다)")}>
				<Select width="120px" label={t("최대 모델 호출")} value={form.maxTurns} options={turnOptions(form.maxTurns)} onchange={(n) => { if (form) form.maxTurns = n; }} />
			</FormField>
			<FormField label={t("지침")}>
				<textarea class="field mono area" bind:value={form.prompt} rows="8" placeholder={t("이 도우미가 할 일, 지킬 규칙, 답하는 형식")} spellcheck="false"></textarea>
			</FormField>
			<div class="actions">
				<Button onclick={() => (form = null)} disabled={busy}>{t("취소")}</Button>
				<Button variant="primary" type="submit" disabled={busy}>{t("저장")}</Button>
			</div>
		</form>
	{:else if list}
		<div class="groups">
		{#each groups as g (g.scope)}
			<ListGroup title={scopeText(g.scope)} count={t("{on}/{total}개 사용", { on: g.items.filter((r) => r.enabled).length, total: g.items.length })} path={g.path}>
				<ul class="list">
					{#each g.items as r (`${r.scope}/${r.name}`)}
						<li animate:reflow in:rowIn out:rowOut>
							<ListItem off={!r.enabled || r.overridden}>
								{#snippet lead()}<Switch checked={r.enabled} disabled={busy} onchange={(on) => toggle(r, on)} label={r.name} />{/snippet}
								{#snippet title()}
									<span class="name mono">{r.name}</span>
									{#if !r.enabled}<Badge size="sm">{t("꺼짐")}</Badge>{:else if r.overridden}<Badge size="sm" tone="warn">{t("프로젝트 역할이 우선")}</Badge>{/if}
								{/snippet}
								{#snippet actions()}
									<Button size="sm" onclick={() => edit(r)} disabled={busy}>{t("수정")}</Button>
									<ConfirmButton size="sm" danger confirmLabel={t("정말 삭제")} onconfirm={() => remove(r)} disabled={busy}>{t("삭제")}</ConfirmButton>
								{/snippet}
								{#if r.description}<p class="desc">{r.description}</p>{/if}
								<p class="meta mono">{r.model ?? t("호출한 대화의 모델")}{r.thinking ? ` · ${r.thinking}` : ""} · {t("도구 {n}개", { n: r.tools.length })} · {t("최대 {n}회", { n: r.maxTurns })}</p>
							</ListItem>
						</li>
					{/each}
				</ul>
			</ListGroup>
		{:else}
			<EmptyState>{t("등록된 도우미 역할이 없습니다.")}</EmptyState>
		{/each}
		</div>
		<Button variant="dashed" onclick={add}>{t("도우미 역할 추가")}</Button>
	{:else if !loadError}
		<EmptyState loading />
	{/if}
</section>

<style>
	section { display: flex; flex-direction: column; gap: 8px; }
	.bare { gap: var(--dlg-gap); }
	/* in the settings the heading is 8px above the text, and the text is 16px above the groups (the dialog spacing) */
	section:not(.bare) > :global(.intro) { margin-bottom: 8px; }
	.groups { display: flex; flex-direction: column; gap: var(--dlg-gap); }
	.list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
	.form { display: flex; flex-direction: column; gap: var(--dlg-gap); }
	.ftitle { display: flex; align-items: center; gap: 8px; min-height: 22px; }
	.ftitle .name { font-size: var(--fs-sm); line-height: 20px; font-weight: 600; overflow-wrap: anywhere; }
	.chips { display: flex; flex-wrap: wrap; gap: 8px; }
	.area { height: auto; padding: 8px 12px; resize: vertical; font-size: var(--fs-sm); line-height: 1.5; }
	.actions { display: flex; justify-content: flex-end; gap: 8px; }
</style>
