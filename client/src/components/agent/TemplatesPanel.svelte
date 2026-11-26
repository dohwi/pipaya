<script lang="ts">
	import { untrack } from "svelte";
	import { keepDraft } from "../../lib/settings-drafts.svelte";
	import Badge from "../ui/Badge.svelte";
	import Button from "../ui/Button.svelte";
	import ConfirmButton from "../ui/ConfirmButton.svelte";
	import EmptyState from "../ui/EmptyState.svelte";
	import ExtrasIntro from "../ui/ExtrasIntro.svelte";
	import FormField from "../ui/FormField.svelte";
	import Icon from "../ui/Icon.svelte";
	import ListGroup from "../ui/ListGroup.svelte";
	import ListItem from "../ui/ListItem.svelte";
	import Notice from "../ui/Notice.svelte";
	import Segmented from "../ui/Segmented.svelte";
	import { Api, errorText } from "../../lib/api";
	import { recentreOn } from "../../lib/dialog";
	import { t } from "../../lib/i18n";
	import { sortActiveFirst } from "../../lib/list-order";
	import { reflow, rowIn, rowOut } from "../../lib/motion";
	import { app } from "../../lib/store.svelte";
	import type { TemplateInfo, TemplateList, TemplateScope } from "../../lib/types";

	/**
	 * Built-in `/prompt:<name>` templates stored in `~/.agents/templates` (global) and `<cwd>/.agents/templates` (project).
	 * Shown in Settings (for the server's default workdir) and in the footer dialog (`cwd` = that chat's folder).
	 */
	let {
		serverId,
		cwd,
		bare = false,
		refresh = 0,
		count = $bindable(null),
	}: {
		serverId: string;
		cwd?: string;
		bare?: boolean;
		refresh?: number;
		count?: { total: number } | null;
	} = $props();

	const server = $derived(app.servers.find((s) => s.id === serverId));
	const api = $derived(server ? new Api({ baseUrl: server.baseUrl, token: server.token }) : null);

	let data = $state<{ id: string; list: TemplateList } | null>(null);
	let loadError = $state("");
	let error = $state("");
	let busy = $state(false);
	const list = $derived(data && data.id === serverId ? data.list : null);

	$effect(() => {
		count = list ? { total: list.templates.filter((x) => !x.overridden).length } : null;
	});

	$effect(() => {
		void app.skillsTick;
		void refresh;
		const id = serverId;
		const a = api;
		const dir = cwd;
		untrack(() => {
			if (!a) return;
			a.templates(dir)
				.then((l) => {
					data = { id, list: l };
					loadError = "";
				})
				.catch((e) => (loadError = errorText(e)));
		});
	});

	type Form = {
		original: string | null;
		name: string;
		scope: TemplateScope;
		description: string;
		body: string;
	};
	let form = $state<Form | null>(null);
	keepDraft(() => `template:${serverId}`, () => form, (f) => (form = f));

	function add() {
		error = "";
		form = { original: null, name: "", scope: tab, description: "", body: "" };
	}
	function edit(tpl: TemplateInfo) {
		error = "";
		form = { original: tpl.name, name: tpl.name, scope: tpl.scope, description: tpl.description, body: tpl.body };
	}

	async function run(job: (a: Api) => Promise<TemplateList>): Promise<boolean> {
		const a = api;
		if (!a || busy) return false;
		busy = true;
		error = "";
		try {
			data = { id: serverId, list: await job(a) };
			app.skillsTick++;
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
		const desc = f.description.trim();
		const ok = await run((a) =>
			f.original
				? a.saveTemplate(f.original, { scope: f.scope, ...(desc ? { description: desc } : {}), body: f.body }, cwd)
				: a.createTemplate({ name: f.name.trim(), scope: f.scope, ...(desc ? { description: desc } : {}), body: f.body }, cwd),
		);
		if (ok) form = null;
	}

	const remove = (tpl: TemplateInfo) => run((a) => a.deleteTemplate(tpl.name, tpl.scope, cwd));

	const scopeText = (s: TemplateScope) => (s === "global" ? t("전역") : t("프로젝트"));
	let tab = $state<TemplateScope>("project");
	const tilde = (p: string) => {
		const h = p.replace(/^\/home\/[^/]+/, "~");
		return h.length > 44 ? `…${h.slice(-43)}` : h;
	};
	const groups = $derived(
		(["project", "global"] as const).map((scope) => ({
			scope,
			items: sortActiveFirst((list?.templates ?? []).filter((x) => x.scope === scope), (x) => !x.overridden),
			path: tilde(scope === "project" ? (list?.projectDir ?? "") : (list?.globalDir ?? "~/.agents/templates")),
		})),
	);
	const current = $derived(groups.find((g) => g.scope === tab) ?? groups[0]);
	const scopeHint = $derived(form?.scope === "project" ? (list?.projectDir ?? "") : (list?.globalDir ?? "~/.agents/templates"));
</script>

<section class:set-group={!bare} class:bare use:recentreOn={form !== null} data-focus="templates">
	{#if !bare}<div class="section-label">{t("프롬프트 템플릿")}</div>{/if}
	<ExtrasIntro
		what={t("입력창에 /prompt:이름 을 입력해 자주 쓰는 프롬프트를 빠르게 불러오는 템플릿입니다.")}
		how={t("템플릿마다 파일 하나(.md)이며, 본문의 $ARGUMENTS 자리에 뒤에 적은 내용이 들어갑니다. 같은 이름이면 프로젝트 템플릿이 우선합니다.")}
	/>
	{#if loadError}<Notice tone="warn" raised={!bare}>{loadError}</Notice>{/if}
	{#if error}<Notice tone="warn" raised={!bare} animated>{error}</Notice>{/if}
	{#if list?.warnings.length}
		{#each list.warnings as w (w.path + w.message)}
			<Notice tone="warn" raised={!bare}><span class="mono">{tilde(w.path)}</span><br />{w.message}</Notice>
		{/each}
	{/if}

	{#if form}
		<form class="form" onsubmit={submit}>
			{#if form.original}
				<div class="ftitle"><span class="name mono">/prompt:{form.original}</span><Badge size="sm" variant="outline">{scopeText(form.scope)}</Badge></div>
			{:else}
				<FormField label={t("이름")} hint={t("소문자, 숫자, 하이픈(-)만 쓸 수 있습니다. 입력창에서는 /prompt:이름 으로 부릅니다.")}>
					<input class="field mono" bind:value={form.name} placeholder="code-review" maxlength="64" autocomplete="off" autocapitalize="off" spellcheck="false" required />
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
			<FormField label={t("설명")} hint={t("슬래시 메뉴에 보일 한 줄 설명입니다. 비워 두면 본문 첫 줄을 씁니다.")}>
				<input class="field" bind:value={form.description} maxlength="1024" autocomplete="off" />
			</FormField>
			<FormField label={t("본문")} hint={t("$ARGUMENTS 를 적으면 그 자리에 입력한 인자가 들어가고, 없으면 본문 끝에 이어 붙습니다.")}>
				<textarea class="field mono area" onfocus={(e) => e.currentTarget.scrollIntoView({ block: "nearest", inline: "nearest" })} bind:value={form.body} rows="8" placeholder={t("이 템플릿을 실행했을 때 에이전트에게 보낼 프롬프트 내용")} spellcheck="false" required></textarea>
			</FormField>
			<div class="actions form-actions">
				<Button onclick={() => (form = null)} disabled={busy}>{t("취소")}</Button>
				<Button variant="primary" type="submit" disabled={busy}>{t("저장")}</Button>
			</div>
		</form>
	{:else if list}
		<div class="groups">
			<Segmented
				tabs
				label={t("적용 범위")}
				value={tab}
				onchange={(id) => (tab = id)}
				options={groups.map((g) => ({ id: g.scope, label: `${scopeText(g.scope)} ${g.items.length}` }))}
			/>
			<ListGroup title={scopeText(current.scope)} count={t("{n}개", { n: current.items.length })} path={current.path}>
				<ul class="list">
					{#each current.items as tpl (`${tpl.scope}/${tpl.name}:${tpl.path}`)}
						<li animate:reflow in:rowIn out:rowOut data-template={tpl.name}>
							<ListItem off={tpl.overridden}>
								{#snippet title()}
									<span class="name mono">/prompt:{tpl.name}</span>
									{#if tpl.overridden}<Badge size="sm" tone="warn">{t("다른 템플릿이 우선")}</Badge>{/if}
								{/snippet}
								{#snippet actions()}
									<Button size="sm" onclick={() => edit(tpl)} disabled={busy}>{t("수정")}</Button>
									<ConfirmButton size="sm" danger confirmLabel={t("정말 삭제")} onconfirm={() => remove(tpl)} disabled={busy}>{t("삭제")}</ConfirmButton>
								{/snippet}
								{#if tpl.description}<p class="desc">{tpl.description}</p>{/if}
								<p class="meta mono">{tilde(tpl.path)}</p>
							</ListItem>
						</li>
					{:else}
						<EmptyState as="li">{t("등록된 프롬프트 템플릿이 없습니다.")}</EmptyState>
					{/each}
				</ul>
			</ListGroup>
		</div>
		<Button variant="dashed" onclick={add}><Icon name="plus" /> {t("프롬프트 템플릿 추가")}</Button>
	{:else if !loadError}
		<EmptyState loading />
	{/if}
</section>

<style>
	section { display: flex; flex-direction: column; gap: 8px; }
	.bare { gap: var(--dlg-gap); }
	section:not(.bare) > :global(.intro) { margin-bottom: 8px; }
	.groups { display: flex; flex-direction: column; gap: var(--dlg-gap); }
	.list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
	.list > li { border-radius: var(--radius); }
	.form { display: flex; flex-direction: column; gap: var(--dlg-gap); }
	.ftitle { display: flex; align-items: center; gap: 8px; min-height: 22px; }
	.ftitle .name { font-size: var(--fs-sm); line-height: 20px; font-weight: 600; overflow-wrap: anywhere; }
	.area { height: auto; padding: 8px 12px; resize: vertical; font-size: var(--fs-sm); line-height: 1.5; }
	.actions { display: flex; justify-content: flex-end; gap: 8px; }
</style>
