<script lang="ts">
	import EmptyState from "../ui/EmptyState.svelte";
	import SearchField from "../ui/SearchField.svelte";
	import IconButton from "../ui/IconButton.svelte";
	import { abortable } from "../../lib/abortable";
	import Notice from "../ui/Notice.svelte";
	import Badge from "../ui/Badge.svelte";
	import { t } from "../../lib/i18n";
	import { app } from "../../lib/store.svelte";
	import { errorText, type Api } from "../../lib/api";
	import type { CommandFamily } from "../../lib/types";
	import DialogBody from "../ui/DialogBody.svelte";
	import ExtrasIntro from "../ui/ExtrasIntro.svelte";
	import ListGroup from "../ui/ListGroup.svelte";
	import ListItem from "../ui/ListItem.svelte";
	import Modal from "../ui/Modal.svelte";

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

<Modal {onclose} title={t("확장 명령")} sub={data ? `${t("{n}개", { n: total })} · ${home(data.cwd)}` : null} width="xl" maxHeight="760px" safeArea>
	{#snippet headerActions()}
		<IconButton icon="retry" label={t("새로고침")} tip onclick={() => refresh++} disabled={loading} />
	{/snippet}
	{#if total > 6}
		<div class="tools"><SearchField label={t("명령 검색")} bind:value={query} /></div>
	{/if}

	<DialogBody gap busy={loading}>
		<ExtrasIntro
			what={t("입력창에 /접두어:이름 을 써서 사람이 직접 실행하는 명령입니다. 확장이 이 폴더에 제공합니다.")}
			how={t("에이전트가 고르는 것이 아니라 사용자가 부르는 것이고, 실행은 서버가 합니다.")}
		/>
		{#if error}
			<Notice tone="warn">{error}{#snippet action()}<button onclick={() => refresh++}>{t("다시 시도")}</button>{/snippet}</Notice>
		{/if}
		{#if !data && loading}
			<EmptyState loading />
		{:else if data}
			{#each shown as f (f.prefix)}
				<ListGroup title={f.label ?? f.prefix} count={t("{n}개", { n: f.entries.length })}>
					{#snippet extra()}<Badge size="sm" variant="outline">{f.extension}</Badge>{/snippet}
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
				</ListGroup>
			{:else}
				<EmptyState>{total ? t("일치하는 명령이 없습니다.") : t("이 폴더에서 쓸 수 있는 확장 명령이 없습니다.")}</EmptyState>
			{/each}
		{/if}
	</DialogBody>
</Modal>

<style>
	.tools { display: flex; padding: 0 var(--dlg-px); flex: none; }
	.list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
	.args { font-weight: 400; color: var(--text-faint); }
	@media (max-width: 640px) {
		.tools { padding: 0 var(--dlg-px); }
	}
</style>
