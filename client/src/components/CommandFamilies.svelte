<script lang="ts">
	import EmptyState from "./EmptyState.svelte";
	import SearchField from "./SearchField.svelte";
	import IconButton from "./IconButton.svelte";
	import { abortable } from "../lib/abortable";
	import Notice from "./Notice.svelte";
	import Badge from "./Badge.svelte";
	import { t } from "../lib/i18n";
	import { app } from "../lib/store.svelte";
	import { errorText, type Api } from "../lib/api";
	import type { CommandFamily } from "../lib/types";
	import DialogBody from "./DialogBody.svelte";
	import ListItem from "./ListItem.svelte";
	import Modal from "./Modal.svelte";

	/** Every `/prefix:name` command the server's extensions offer for one folder (`pi.registerCommands`), e.g. prompt files. */
	let { dialog: target, api, onclose }: { dialog: { cwd: string }; api: Api; onclose: () => void } = $props();

	let data = $state<{ cwd: string; families: CommandFamily[] } | null>(null);
	let loading = $state(true);
	let error = $state("");
	let refresh = $state(0);
	let query = $state("");

	$effect(() => {
		refresh;
		// Files added or edited on disk arrive as skills_updated; a reloaded extension as extensions_updated.
		app.skillsTick;
		app.serverExtensionsTick;
		error = "";
		return abortable((signal) => api.commandFamilies(target.cwd, signal), {
			ok: (list) => (data = list),
			fail: (e) => (error = errorText(e)),
			done: () => (loading = false),
		});
	});

	const total = $derived(data?.families.reduce((n, f) => n + f.entries.length, 0) ?? 0);
	const match = (f: CommandFamily, e: CommandFamily["entries"][number]) => {
		const q = query.trim().toLowerCase();
		return !q || `${f.prefix}:${e.name}`.toLowerCase().includes(q) || (e.description ?? "").toLowerCase().includes(q);
	};
	const shown = $derived((data?.families ?? []).map((f) => ({ ...f, entries: f.entries.filter((e) => match(f, e)) })).filter((f) => f.entries.length));

	const home = (p: string) => p.replace(/^\/home\/[^/]+/, "~");
</script>

<Modal {onclose} title={t("확장 명령")} sub={data ? `${t("{n}개", { n: total })} · ${home(data.cwd)}` : null} width="680px" maxHeight="760px" safeArea>
	{#snippet headerActions()}
		<IconButton icon="retry" label={t("새로고침")} tip onclick={() => refresh++} disabled={loading} />
	{/snippet}
	{#if total > 6}
		<div class="tools"><SearchField label={t("명령 검색")} bind:value={query} /></div>
	{/if}
	<p class="hint">{t("서버 확장이 이 폴더에서 제공하는 명령입니다. 입력창에 /접두어:이름 [내용]을 쓰면 서버가 실행합니다.")}</p>

	<DialogBody busy={loading}>
		{#if error}
			<div class="gap"><Notice tone="warn">{error}{#snippet action()}<button onclick={() => refresh++}>{t("다시 시도")}</button>{/snippet}</Notice></div>
		{/if}
		{#if !data && loading}
			<EmptyState loading />
		{:else if data}
			{#each shown as f (f.prefix)}
				<h3 class="fam">{f.label ?? f.prefix} <Badge size="sm">{f.extension}</Badge></h3>
				<ul class="list">
					{#each f.entries as e (e.name)}
						<li>
							<ListItem>
								{#snippet title()}<span class="name mono">/{f.prefix}:{e.name}{#if e.args}<span class="args"> {e.args}</span>{/if}</span>{/snippet}
								{#if e.description}<p class="desc">{e.description}</p>{/if}
							</ListItem>
						</li>
					{/each}
				</ul>
			{:else}
				<EmptyState>{total ? t("일치하는 명령이 없습니다.") : t("이 폴더에서 쓸 수 있는 확장 명령이 없습니다.")}</EmptyState>
			{/each}
		{/if}
	</DialogBody>
</Modal>

<style>
	.tools { display: flex; padding: 0 var(--dlg-px); flex: none; }
	.hint { margin: 8px var(--dlg-px) 12px; flex: none; }
	.fam { display: flex; align-items: center; gap: 8px; margin: 4px 0 8px; font-size: var(--fs-sm); font-weight: 600; }
	.fam:not(:first-child) { margin-top: 16px; }
	.list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
	.args { font-weight: 400; color: var(--text-faint); }
	.gap { margin-bottom: 8px; }
	@media (max-width: 640px) {
		.tools { padding: 0 var(--dlg-px); }
		.hint { margin: 8px var(--dlg-px) 12px; }
	}
</style>
