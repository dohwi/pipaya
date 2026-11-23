<script lang="ts">
	import { untrack } from "svelte";
	import Badge from "../ui/Badge.svelte";
	import Button from "../ui/Button.svelte";
	import ConfirmButton from "../ui/ConfirmButton.svelte";
	import DialogBody from "../ui/DialogBody.svelte";
	import DialogFooter from "../ui/DialogFooter.svelte";
	import FormField from "../ui/FormField.svelte";
	import Modal from "../ui/Modal.svelte";
	import Segmented from "../ui/Segmented.svelte";
	import { errorText } from "../../lib/api";
	import { compact } from "../../lib/format";
	import { localeTag, t } from "../../lib/i18n";
	import { goalLabel, goalLevel, goalTime, goalTone, resumable } from "../../lib/goals";
	import { app } from "../../lib/store.svelte";

	/**
	 * One conversation's goal: what to keep working on and, if wanted, how many tokens it may spend (none by default:
	 * the goal runs until it is done, stalls or is stopped, compacting the context as it fills). Opened from the goal row
	 * above the input, `/goal` or `/goal edit`. A new goal starts as soon as it is saved; editing a running one changes what
	 * the next turn reads, and a larger budget lets a goal the old one stopped carry on. The footer pauses / resumes it and
	 * clears it (asked twice).
	 */
	const id = $derived(app.goalDialog);
	const serverId = $derived(app.serverId);
	const g = $derived(app.goals.of(serverId, id));
	const MAX = 4000;
	let objective = $state(untrack(() => g?.objective ?? ""));
	const PRESETS = ["500000", "1000000", "2000000", "5000000"];
	// a budget set some other way (an API call) that is not a preset stays as one more choice
	const own = untrack(() => g?.tokenBudget ?? null);
	const choices = own && !PRESETS.includes(String(own)) ? [...PRESETS, String(own)].sort((a, b) => Number(a) - Number(b)) : PRESETS;
	const budgets = $derived([{ id: "none", label: t("제한 없음") }, ...choices.map((v) => ({ id: v, label: compact(Number(v)).replace(/\.0(?=[kM])/, "") }))]);
	let budget = $state(own === null ? "none" : String(own));
	const budgetValue = $derived(budget === "none" ? null : Number(budget));
	const fresh = $derived(!g || g.status === "complete");
	let busy = $state(false);
	const close = () => { if (!busy) app.goalDialog = null; };

	async function run(fn: () => Promise<void>) {
		if (busy) return;
		busy = true;
		try {
			await fn();
			app.goalDialog = null;
		} catch (e) {
			app.toast(errorText(e), "error", id);
		} finally {
			busy = false;
		}
	}

	function save(e?: SubmitEvent) {
		e?.preventDefault();
		const text = objective.trim();
		const api = app.api;
		if (!id || !serverId || !api || !text) return;
		const wasFresh = fresh;
		void run(async () => {
			const saved = await api.putGoal(id, { objective: text, tokenBudget: budgetValue });
			app.goals.patch(serverId, id, saved);
			app.toast(wasFresh ? t("목표를 정했습니다. 끝날 때까지 이어서 작업합니다") : t("목표를 고쳤습니다"), "ok", id);
		});
	}

	function setStatus(status: "paused" | "active") {
		const api = app.api;
		if (!id || !serverId || !api) return;
		void run(async () => {
			const saved = await api.patchGoal(id, { status });
			app.goals.patch(serverId, id, saved);
			app.toast(status === "paused" ? t("목표를 일시정지했습니다") : t("목표를 다시 이어 갑니다"), "ok", id);
		});
	}

	function clearGoal() {
		const api = app.api;
		if (!id || !serverId || !api) return;
		void run(async () => {
			await api.deleteGoal(id);
			app.goals.patch(serverId, id, null);
			app.toast(t("목표를 지웠습니다"), "ok", id);
		});
	}

	const tokens = $derived(g ? (g.tokenBudget ? t("{used} / {budget} 토큰", { used: compact(g.tokensUsed), budget: compact(g.tokenBudget) }) : t("{n} 토큰", { n: compact(g.tokensUsed) })) : "");
</script>

<Modal onclose={close} dismissible={!busy} title={t("목표")} width="m" safeArea>
	<form id="goal-form" onsubmit={save}>
		<DialogBody gap>
			{#if g && !fresh}
				<p class="now">
					<Badge size="sm" tone={goalTone(g.status)}>{goalLabel(g.status)}</Badge>
					<span class="mono {goalLevel(g)}">{tokens}</span>
					<span class="mono">{goalTime(g.timeUsedSeconds)}</span>
				</p>
			{/if}
			<FormField label={t("무엇을 끝낼까요")} hint={t("끝났다고 판단하거나, 같은 문제로 세 번 막히거나, 멈출 때까지 이어서 작업합니다. 컨텍스트가 차면 압축하고 계속합니다.")}>
				<!-- svelte-ignore a11y_autofocus -->
				<textarea class="field area" rows="5" maxlength={MAX} bind:value={objective} disabled={busy} placeholder={t("예: 실패하는 테스트를 모두 고치고 bun run test가 통과할 때까지")} required autofocus></textarea>
			</FormField>
			<FormField label={t("토큰 예산")} hint={budget === "none" ? t("자리를 비울 때 끝없이 돌지 않게 하려면 정해 두세요. 다 쓰면 지금 턴을 정리하고 멈춥니다.") : t("다 쓰면 지금 턴을 정리하고 멈춥니다. 늘리면 이어서 진행합니다.")} group>
				<Segmented label={t("토큰 예산")} value={budget} options={budgets} onchange={(b) => (budget = b)} />
			</FormField>
		</DialogBody>
	</form>
	<DialogFooter rule>
		{#snippet start()}
			{#if g}<ConfirmButton disabled={busy} confirmLabel={t("지울까요?")} onconfirm={clearGoal}>{t("지우기")}</ConfirmButton>{/if}
		{/snippet}
		{#if g && g.status === "active"}
			<Button disabled={busy} onclick={() => setStatus("paused")}>{t("일시정지")}</Button>
		{:else if g && resumable(g.status)}
			<Button disabled={busy} onclick={() => setStatus("active")}>{t("재개")}</Button>
		{/if}
		<Button variant="primary" type="submit" form="goal-form" disabled={busy || !objective.trim()} title={`${objective.length.toLocaleString(localeTag())} / ${MAX.toLocaleString(localeTag())}`}>{fresh ? t("시작") : t("저장")}</Button>
	</DialogFooter>
</Modal>

<style>
	form {
		display: contents;
	}
	/* where the goal stands: its state and what it has used, one quiet line above the form */
	.now {
		display: flex;
		align-items: center;
		gap: 8px;
		margin: 0;
		font-size: var(--fs-xs);
		line-height: 20px;
		color: var(--text-dim);
	}
	.now .warn {
		color: var(--warn);
	}
	.now .danger {
		color: var(--danger);
	}
	.area {
		height: auto;
		padding: 8px 12px;
		resize: vertical;
		font-size: var(--fs-sm);
		line-height: 1.5;
	}
	/* touch: 16px, or iOS zooms the page in when the field takes focus */
	@media (pointer: coarse) {
		.area {
			font-size: var(--fs-lg);
		}
	}
</style>
