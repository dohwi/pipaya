<script lang="ts">
	import Badge from "../ui/Badge.svelte";
	import DialogBody from "../ui/DialogBody.svelte";
	import EmptyState from "../ui/EmptyState.svelte";
	import IconButton from "../ui/IconButton.svelte";
	import Markdown from "../chat/Markdown.svelte";
	import Modal from "../ui/Modal.svelte";
	import Notice from "../ui/Notice.svelte";
	import { abortable } from "../../lib/abortable";
	import { errorText, type Api, type ApiError } from "../../lib/api";
	import { copyText } from "../../lib/clipboard";
	import { t } from "../../lib/i18n";
	import type { ActionId } from "../../lib/keys";
	import { app } from "../../lib/store.svelte";
	import type { SkillSource } from "../../lib/types";
	import { untrack } from "svelte";

	/**
	 * Read-only view of one skill's SKILL.md (summary metadata + rendered markdown instructions).
	 * Opened either directly from a `/skill:name` message chip (layer 1, with a button to jump to the full skills list)
	 * or from the skills list dialog (layer 2).
	 */
	let {
		name,
		cwd,
		sessionId = null,
		api,
		layer = 2,
		closeShortcut,
		onlist,
		onedit,
		onclose,
	}: {
		name: string;
		cwd: string;
		sessionId?: string | null;
		api: Api;
		layer?: 1 | 2;
		closeShortcut?: ActionId;
		onlist?: () => void;
		onedit?: (source: SkillSource) => void;
		onclose: () => void;
	} = $props();

	let source = $state<SkillSource | null>(null);
	let loading = $state(true);
	let error = $state("");
	let refresh = $state(0);
	let copied = $state(false);
	let copyTimer: ReturnType<typeof setTimeout> | undefined;

	$effect(() => {
		refresh;
		app.skillsTick;
		const skillName = name;
		const skillCwd = cwd;
		untrack(() => {
			if (!source || source.name !== skillName) {
				source = null;
				loading = true;
			}
			error = "";
		});
		return abortable((signal) => api.skillSource(skillName, skillCwd, signal), {
			ok: (res) => {
				source = res;
			},
			fail: (e) => {
				const err = e as ApiError;
				error = err?.status === 404
					? t("스킬을 찾을 수 없습니다. 삭제되었거나 다른 프로젝트의 스킬일 수 있습니다.")
					: errorText(e);
			},
			done: () => {
				loading = false;
			},
		});
	});

	$effect(() => () => clearTimeout(copyTimer));

	async function copy() {
		if (!source) return;
		const text = source.body || source.description;
		if (text && (await copyText(text))) {
			copied = true;
			clearTimeout(copyTimer);
			copyTimer = setTimeout(() => (copied = false), 1400);
		}
	}

	const home = (p: string) => p.replace(/^\/home\/[^/]+/, "~");
</script>

<Modal {onclose} {closeShortcut} title={source ? source.name : name} sub={source ? home(source.path) : null} subMono divider width="xl" maxHeight="760px" safeArea {layer}>
	{#snippet headerActions()}
		{#if source}
			<IconButton icon={copied ? "check" : "copy"} label={t("복사")} tip onclick={copy} />
		{/if}
		{#if source && source.scope !== "builtin" && onedit}
			<IconButton icon="edit" label={t("수정")} tip onclick={() => source && onedit(source)} />
		{/if}
		{#if onlist}
			<IconButton icon="list" label={t("전체 스킬")} tip onclick={onlist} />
		{/if}
	{/snippet}

	<DialogBody gap busy={loading}>
		{#if error}
			<Notice tone="warn" onretry={() => refresh++}>{error}</Notice>
		{/if}
		{#if !source && loading}
			<EmptyState loading />
		{:else if source}
			<section class="summary">
				<div class="badges">
					<Badge size="sm" variant="outline">{source.scope === "project" ? t("프로젝트") : source.scope === "builtin" ? t("기본 내장") : t("전역")}</Badge>
					{#if source.manualOnly}
						<Badge size="sm" variant="outline" title={t("에이전트는 이 스킬을 모릅니다. /skill:이름 으로 직접 부를 때만 쓰입니다.")}>{t("수동 전용")}</Badge>
					{/if}
					{#if source.linked}
						<Badge size="sm" variant="outline">{t("심볼릭 링크")}</Badge>
					{/if}
				</div>
				<p class="desc">{source.description}</p>
			</section>

			{#if source.body}
				<div class="body">
					<Markdown text={source.body} {sessionId} />
				</div>
			{:else}
				<EmptyState>{t("작성된 지침이 없습니다.")}</EmptyState>
			{/if}

			{#if source.extraFiles}
				<p class="hint">{t("이 스킬 폴더에는 파일 {n}개가 더 있습니다.", { n: source.extraFiles })}</p>
			{/if}
		{/if}
	</DialogBody>
</Modal>

<style>
	.summary {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 12px;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius);
		background: var(--bg);
	}
	.badges {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
	}
	.desc {
		margin: 0;
		font-size: var(--fs-sm);
		line-height: 20px;
		color: var(--text);
	}
	.body {
		min-width: 0;
	}
	.hint {
		margin: 0;
		font-size: var(--fs-xs);
		line-height: 20px;
		color: var(--text-faint);
	}
</style>
