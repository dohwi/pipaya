<script lang="ts">
	import { untrack } from "svelte";
	import { errorText } from "../../lib/api";
	import { t } from "../../lib/i18n";
	import { app } from "../../lib/store.svelte";
	import type { RewindDialogTarget } from "../../lib/store/ui-overlay.svelte";
	import type { RewindFileItem, RewindMode, RewindResult } from "../../lib/types";
	import Badge from "../ui/Badge.svelte";
	import Button from "../ui/Button.svelte";
	import DialogBody from "../ui/DialogBody.svelte";
	import DialogFooter from "../ui/DialogFooter.svelte";
	import EmptyState from "../ui/EmptyState.svelte";
	import Modal from "../ui/Modal.svelte";
	import Notice from "../ui/Notice.svelte";
	import Segmented from "../ui/Segmented.svelte";

	let kept = $state<RewindDialogTarget | null>(null);
	let mode = $state<RewindMode>("files_only");
	let loading = $state(false);
	let applying = $state(false);
	let loadErr = $state("");
	let preview = $state<RewindResult | null>(null);
	let reqToken = 0;

	$effect(() => {
		const target = app.rewindDialog;
		if (!target) return;
		untrack(() => {
			kept = target;
			mode = "files_only";
			preview = null;
			loadErr = "";
			void loadPreview(target);
		});
	});

	async function loadPreview(target: RewindDialogTarget) {
		const tok = ++reqToken;
		loading = true;
		loadErr = "";
		try {
			const res = await app.previewRewind(target.serverId, target.sessionId, target.turnSeq);
			if (tok !== reqToken) return;
			preview = res;
		} catch (e) {
			if (tok !== reqToken) return;
			loadErr = errorText(e, t("되돌릴 파일 목록을 불러오지 못했습니다"));
		} finally {
			if (tok === reqToken) loading = false;
		}
	}

	function close() {
		if (applying) return;
		app.closeRewind();
	}

	async function run(force: boolean) {
		const target = app.rewindDialog;
		if (!target || applying) return;
		applying = true;
		try {
			const res = await app.executeRewind(target.serverId, target.sessionId, target.turnSeq, mode, force, target.userText);
			if (!res) return;
			if (!res.applied && res.conflicts.length > 0) {
				// External modification happened between preview and confirm; refresh preview with conflict warning.
				preview = res;
				return;
			}
			app.closeRewind();
		} finally {
			applying = false;
		}
	}

	function skipReasonLabel(reason: string | null | undefined): string {
		switch (reason) {
			case "too_large":
				return t("2MB 초과");
			case "binary":
				return t("바이너리 파일");
			case "symlink_escape":
				return t("심볼릭 링크 차단");
			case "outside_workspace":
				return t("작업 폴더 외부");
			case "sensitive_path":
				return t("보호된 경로");
			case "limit_exceeded":
				return t("체크포인트 한도 초과");
			default:
				return t("건너뜀");
		}
	}

	function conflictLabel(item: RewindFileItem): string {
		if (item.conflictReason === "deleted") return t("외부 삭제");
		return t("외부 수정");
	}

	const hasConflicts = $derived((preview?.conflicts.length ?? 0) > 0);
	const actionableCount = $derived(preview ? preview.files.filter((f) => f.action !== "skip").length : 0);
	const canSubmit = $derived(!loading && !applying && (mode === "files_and_chat" || actionableCount > 0));
	const modeOptions = $derived([
		{ id: "files_only" as const, label: t("파일만 되돌리기") },
		{ id: "files_and_chat" as const, label: t("대화 + 파일 되돌리기") },
	]);
</script>

{#if app.rewindDialog && kept}
	<Modal
		title={t("파일 되돌리기")}
		sub={t("이 턴과 이후 턴에서 수정된 파일을 이전 상태로 되돌립니다.")}
		width="m"
		onclose={close}
		dismissible={!applying}
	>
		<DialogBody gap busy={loading || applying}>
			<Segmented
				options={modeOptions}
				value={mode}
				onchange={(next) => (mode = next)}
				label={t("되돌리기 방식")}
			/>

			{#if mode === "files_and_chat"}
				<Notice tone="warn" size="sm">
					{t("이 메시지부터 이후 대화 기록도 함께 삭제되며, 메시지는 입력창에 다시 채워집니다.")}
				</Notice>
			{/if}

			{#if loading}
				<EmptyState>{t("변경 내역 확인 중…")}</EmptyState>
			{:else if loadErr}
				<Notice tone="danger" onretry={() => kept && void loadPreview(kept)}>{loadErr}</Notice>
			{:else if !preview || preview.files.length === 0}
				<EmptyState>{t("되돌릴 파일 변경 내역이 없습니다.")}</EmptyState>
			{:else}
				{#if hasConflicts}
					<Notice tone="warn" size="sm" role="alert">
						{t("외부에서 변경된 파일이 {n}개 있습니다. 강제로 되돌리면 외부 변경 사항을 덮어씁니다.", { n: preview.conflicts.length })}
					</Notice>
				{/if}

				<div class="group" role="region" aria-label={t("영향받는 파일")}>
					<ul class="list">
						{#each preview.files as f (f.path)}
							<li class="row">
								<div class="path-wrap">
									<span class="path" title={f.path}>{f.path}</span>
									{#if f.action === "skip" && f.skippedReason}
										<span class="reason">{skipReasonLabel(f.skippedReason)}</span>
									{/if}
								</div>
								<div class="badges">
									{#if f.conflict}
										<Badge size="sm" tone="warn">{conflictLabel(f)}</Badge>
									{/if}
									{#if f.action === "restore"}
										<Badge size="sm" tone="info">{t("복원")}</Badge>
									{:else if f.action === "delete"}
										<Badge size="sm" tone="danger">{t("삭제")}</Badge>
									{:else}
										<Badge size="sm" tone="neutral">{t("건너뜀")}</Badge>
									{/if}
								</div>
							</li>
						{/each}
					</ul>
				</div>
			{/if}
		</DialogBody>

		<DialogFooter rule safe wrap>
			<Button onclick={close} disabled={applying}>{t("취소")}</Button>
			<Button
				variant={hasConflicts || mode === "files_and_chat" ? "danger" : "primary"}
				disabled={!canSubmit}
				onclick={() => void run(hasConflicts)}
			>
				{#if applying}
					{t("되돌리는 중…")}
				{:else if hasConflicts}
					{t("충돌 무시하고 되돌리기")}
				{:else}
					{t("되돌리기")}
				{/if}
			</Button>
		</DialogFooter>
	</Modal>
{/if}

<style>
	.group {
		background: var(--bg-set);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		overflow: hidden;
	}
	.list {
		list-style: none;
		margin: 0;
		padding: 0;
		max-height: 280px;
		overflow-y: auto;
	}
	.row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		padding: 8px 12px;
		min-height: 36px;
	}
	.row + .row {
		border-top: 1px solid var(--border);
	}
	.path-wrap {
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.path {
		font-family: var(--mono);
		font-size: var(--fs-sm);
		line-height: 18px;
		color: var(--text);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.reason {
		font-size: var(--fs-xs);
		line-height: 16px;
		color: var(--text-dim);
	}
	.badges {
		flex: none;
		display: flex;
		align-items: center;
		gap: 4px;
	}
</style>
