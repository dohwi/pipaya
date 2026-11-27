<script lang="ts">
	import { onDestroy, untrack } from "svelte";
	import Accordion from "../ui/Accordion.svelte";
	import Badge from "../ui/Badge.svelte";
	import Button from "../ui/Button.svelte";
	import Icon from "../ui/Icon.svelte";
	import ConfirmButton from "../ui/ConfirmButton.svelte";
	import EmptyState from "../ui/EmptyState.svelte";
	import ExtrasIntro from "../ui/ExtrasIntro.svelte";
	import FormField from "../ui/FormField.svelte";
	import ListGroup from "../ui/ListGroup.svelte";
	import ListItem from "../ui/ListItem.svelte";
	import Notice from "../ui/Notice.svelte";
	import Segmented from "../ui/Segmented.svelte";
	import Select from "../ui/Select.svelte";
	import SettingRow from "../ui/SettingRow.svelte";
	import Switch from "../ui/Switch.svelte";
	import { abortable } from "../../lib/abortable";
	import { recentreOn } from "../../lib/dialog";
	import { Api, ApiError, errorText } from "../../lib/api";
	import { keepDraft } from "../../lib/settings-drafts.svelte";
	import { t } from "../../lib/i18n";
	import { fullTime, shortDate } from "../../lib/format";
	import { reflow, rowIn, rowOut } from "../../lib/motion";
	import {
		DEFAULT_HISTORY_DAYS,
		MAX_PROMPT,
		MAX_TASKS,
		MAX_TITLE,
		cadence,
		everyMs,
		everyProblem,
		isUsedUp,
		labelOf,
		parseLocal,
		purgeAt,
		resultOf,
		splitEvery,
		splitSchedules,
		toLocalInput,
		type EveryUnit,
	} from "../../lib/schedules";
	import { livePast, liveNext } from "../../lib/minute-clock.svelte";
	import { app } from "../../lib/store.svelte";
	import type { Schedule, Session } from "../../lib/types";

	/**
	 * Settings > Scheduled tasks. A task sends a prompt to an existing conversation once, or every so often. It never
	 * wakes a closed conversation and never queues behind a running one: that run is skipped and the list says so.
	 * The list and the form are for one server (`serverId`), read from and saved to that server only.
	 */
	let { serverId }: { serverId: string } = $props();

	const api = $derived.by(() => {
		const s = app.servers.find((x) => x.id === serverId);
		return s ? new Api({ baseUrl: s.baseUrl, token: s.token }) : null;
	});
	/** Active conversations of this server (a closed one cannot get a new task; its old tasks show as "닫힌 대화"). */
	const sessions = $derived<Session[]>(app.links[serverId]?.data.sessions ?? []);
	const sessionOf = (id: string) => sessions.find((x) => x.id === id);

	let list = $state<Schedule[] | null>(null);
	let historyDays = $state(DEFAULT_HISTORY_DAYS);
	let savingHistory = $state(false);
	let loading = $state(true);
	let error = $state("");
	let busy = $state(false);

	const online = $derived(app.links[serverId]?.online ?? false);

	// Read again when a task changes (schedules_updated), the server reconnects, or the account behind it changes.
	$effect(() => {
		void app.schedulesTick;
		const a = api;
		if (!a || !online) return;
		untrack(() => { if (!list) loading = true; });
		return abortable((signal) => a.schedules(undefined, signal), {
			ok: (r) => {
				list = r.schedules;
				if (typeof r.historyDays === "number") historyDays = r.historyDays;
				error = "";
			},
			fail: (e) => (error = errorText(e)),
			done: () => (loading = false),
		});
	});

	const historyOptions = $derived([
		{ value: "1", label: t("1일 뒤") },
		{ value: "3", label: t("3일 뒤") },
		{ value: "7", label: t("7일 뒤") },
		{ value: "14", label: t("14일 뒤") },
		{ value: "30", label: t("30일 뒤") },
		{ value: "0", label: t("자동 삭제 안 함") },
	]);
	const historyKeepMs = $derived(historyDays * 86_400_000);

	async function changeHistoryDays(raw: string) {
		const next = Number(raw);
		const a = api;
		if (!a || savingHistory || !Number.isInteger(next) || next === historyDays) return;
		const prev = historyDays;
		historyDays = next;
		savingHistory = true;
		error = "";
		try {
			const res = await a.setScheduleSettings({ historyDays: next });
			historyDays = res.historyDays;
			app.schedulesTick++;
		} catch (e) {
			historyDays = prev;
			if (e instanceof ApiError && e.status === 404) {
				app.toast(t("서버를 업데이트하면 자동 삭제 기간을 저장할 수 있습니다"), "info");
			} else {
				error = errorText(e);
			}
		} finally {
			savingHistory = false;
		}
	}

	async function reload() {
		if (!api) return;
		try {
			list = (await api.schedules()).schedules;
		} catch (e) {
			error = errorText(e);
		}
	}

	const split = $derived(splitSchedules((list ?? []).filter((s) => !hidden.includes(s.id))));
	const pending = $derived(split.pending);
	const finished = $derived(split.finished);
	// finished one-time tasks are history: they do not take one of the MAX_TASKS places
	const full = $derived(pending.length >= MAX_TASKS);
	let historyOpen = $state(false);

	/** Runs an action on the server, then re-reads the list. Returns whether it worked. */
	async function act(fn: (a: Api) => Promise<unknown>): Promise<boolean> {
		if (!api || busy) return false;
		busy = true;
		error = "";
		try {
			await fn(api);
			await reload();
			return true;
		} catch (e) {
			error = errorText(e);
			return false;
		} finally {
			busy = false;
		}
	}

	/* ---------- form ---------- */
	type Form = {
		/** The task being edited; null = a new one */
		original: Schedule | null;
		sessionId: string;
		title: string;
		prompt: string;
		kind: "once" | "interval";
		/** datetime-local value */
		at: string;
		amount: string;
		unit: EveryUnit;
		/** Switching a used-up one-time task back on: the new time is required */
		revive: boolean;
	};
	let form = $state<Form | null>(null);
	// a half-filled schedule survives leaving the section or Settings
	keepDraft(() => `schedule:${serverId}`, () => form, (f) => (form = f));
	let formError = $state("");
	/** A neutral line above a form that is not wrong yet (scheduling a past task again). */
	let formNote = $state("");

	function add(sessionId?: string) {
		const first = sessionId && sessionOf(sessionId) ? sessionId : (app.activeId && sessionOf(app.activeId) ? app.activeId : (sessions[0]?.id ?? ""));
		form = { original: null, sessionId: first, title: "", prompt: "", kind: "interval", at: "", amount: "1", unit: "hour", revive: false };
		formError = "";
		formNote = "";
	}
	function edit(s: Schedule, revive = false) {
		const e = splitEvery(s.everyMs ?? 3_600_000);
		form = {
			original: s,
			sessionId: s.sessionId,
			title: s.title ?? "",
			prompt: s.prompt,
			kind: s.kind,
			at: revive || !s.runAt ? "" : toLocalInput(s.runAt),
			amount: String(e.amount),
			unit: e.unit,
			revive,
		};
		// From the past tasks this is a normal step, not a mistake: say what happens instead of warning.
		const again = revive && isUsedUp(s);
		formNote = again ? t("새 시각을 정하면 예정된 작업으로 돌아갑니다.") : "";
		formError = revive && !again ? t("지난 시각입니다. 새 시각을 정해야 다시 켤 수 있습니다.") : "";
	}

	// A conversation's menu ("예약 추가…") opens this page with that conversation chosen.
	$effect(() => {
		const id = app.scheduleFor;
		if (!id || !api) return;
		app.scheduleFor = null;
		untrack(() => add(id));
	});

	// A task's row above the input opens this page with that task in the edit form (a used-up or past one-time task
	// asks for a new time, as "다시 예약" does). Waits for the list; a task that is gone by then just shows the list.
	$effect(() => {
		const id = app.scheduleEdit;
		if (!id || !list) return;
		app.scheduleEdit = null;
		const s = list.find((x) => x.id === id);
		if (s) untrack(() => edit(s, s.kind === "once" && (isUsedUp(s) || (!s.enabled && (s.runAt ?? 0) <= Date.now()))));
	});

	async function submit(e: Event) {
		e.preventDefault();
		const f = form;
		if (!f || busy) return;
		const prompt = f.prompt;
		if (!prompt.trim()) return void (formError = t("프롬프트를 입력하세요."));
		if (prompt.length > MAX_PROMPT) return void (formError = t("프롬프트는 {n}자까지 쓸 수 있습니다.", { n: MAX_PROMPT }));
		if (!f.original && !sessionOf(f.sessionId)) return void (formError = t("대화를 고르세요."));
		const title = f.title.trim() || null;
		let runAt: number | null = null;
		let every: number | null = null;
		if (f.kind === "once") {
			runAt = parseLocal(f.at);
			if (runAt === null) return void (formError = t("날짜와 시각을 입력하세요."));
			if (runAt <= Date.now()) return void (formError = t("지난 시각은 고를 수 없습니다."));
		} else {
			const amount = f.amount.trim() === "" ? Number.NaN : Number(f.amount);
			const problem = everyProblem({ amount, unit: f.unit });
			if (problem) return void (formError = problem);
			every = everyMs({ amount, unit: f.unit });
		}
		const o = f.original;
		const ok = await act((a) =>
			o
				? a.patchSchedule(o.id, {
						title,
						prompt,
						// Only what changed is sent: an interval is re-timed from now when its length is sent, a one-time task must be in the future.
						...(f.kind === "once" && (f.revive || runAt !== o.runAt) ? { runAt } : {}),
						...(f.kind === "interval" && every !== o.everyMs ? { everyMs: every } : {}),
						...(f.revive ? { enabled: true } : {}),
					})
				: a.createSchedule({ sessionId: f.sessionId, title, prompt, kind: f.kind, ...(f.kind === "once" ? { runAt } : { everyMs: every }) }),
		);
		if (ok) form = null;
		else {
			formError = error;
			error = "";
		}
	}

	/* ---------- row actions ---------- */
	function toggle(s: Schedule, on: boolean) {
		// A one-time task that already ran (or whose time passed) needs a new time before it can be switched on.
		if (on && s.kind === "once" && (s.runAt ?? 0) <= Date.now()) return edit(s, true);
		void act((a) => a.patchSchedule(s.id, { enabled: on }));
	}
	const runNow = (s: Schedule) => act((a) => a.runSchedule(s.id));

	/* ---------- delete with undo ---------- */
	/**
	 * A delete waits UNDO_MS before it reaches the server; meanwhile the task is hidden and a bar at the bottom of the page offers
	 * "되돌리기". The bar lives in the pane, not in a global toast: the settings dialog covers the toast strip.
	 */
	const UNDO_MS = 5000;
	type Pending = { key: number; ids: string[]; text: string; timer: ReturnType<typeof setTimeout> };
	let pendingDeletes = $state<Pending[]>([]);
	const hidden = $derived(pendingDeletes.flatMap((d) => d.ids));
	const lastDelete = $derived(pendingDeletes.at(-1) ?? null);
	let seq = 0;

	async function commit(d: Pending) {
		clearTimeout(d.timer);
		const failed: string[] = [];
		const a = api;
		if (a) for (const id of d.ids) await a.deleteSchedule(id).catch(() => failed.push(id));
		await reload();
		pendingDeletes = pendingDeletes.filter((x) => x.key !== d.key);
		if (failed.length) error = t("예약 작업을 지우지 못했습니다");
	}
	function remove(ids: string[], text: string) {
		if (!api || !ids.length) return;
		const key = ++seq;
		const d: Pending = { key, ids, text, timer: setTimeout(() => { const x = pendingDeletes.find((p) => p.key === key); if (x) void commit(x); }, UNDO_MS) };
		pendingDeletes = [...pendingDeletes, d];
	}
	function undo(d: Pending) {
		clearTimeout(d.timer);
		pendingDeletes = pendingDeletes.filter((x) => x.key !== d.key);
	}
	// Leaving the page does not cancel a delete: what is still waiting goes out now.
	onDestroy(() => {
		for (const d of pendingDeletes) void commit(d);
	});
	const removeOne = (s: Schedule) => remove([s.id], t("‘{name}’ 작업을 지웠습니다", { name: labelOf(s, 30) }));
	const clearHistory = () => remove(finished.map((s) => s.id), t("지난 작업 {n}개를 지웠습니다", { n: finished.length }));

	const sessionLabel = (id: string) => {
		const s = sessionOf(id);
		return s ? `${s.title}${s.name ? ` · @${s.name}` : ""}` : t("닫힌 대화");
	};
	/** The time field of a task being scheduled again: it is the one thing to fill in, often below the fold. */
	const focusWhen = (node: HTMLElement, on: boolean) => {
		if (!on) return;
		node.scrollIntoView({ block: "center" });
		node.focus({ preventScroll: true });
	};
	const sessionOptions = $derived(sessions.map((s) => ({ value: s.id, label: sessionLabel(s.id) })));
	const unitOptions = $derived([
		{ id: "minute" as const, label: t("분") },
		{ id: "hour" as const, label: t("시간") },
		{ id: "day" as const, label: t("일") },
	]);
	const minAt = $derived(toLocalInput(Date.now()));
</script>

<!-- the list and the form are two pages of different heights: centre the dialog again on each switch -->
<div class="body" aria-busy={loading} use:recentreOn={form !== null}>
	{#if error}<Notice tone="warn">{error}</Notice>{/if}
	<ExtrasIntro
		what={t("정해진 때나 일정한 간격으로 기존 대화에 프롬프트를 자동으로 보냅니다.")}
		how={historyDays > 0
			? t("대화가 그때 실행 중이거나 닫혀 있으면 보내지 않고 건너뜁니다. 서버가 꺼져 있던 동안 놓친 반복은 한 번만 실행하고, 하루 넘게 지난 한 번짜리는 실행하지 않습니다. 연속 5번 실패하면 꺼집니다. 실행을 마친 한 번짜리는 지난 작업으로 옮겨지고 {days}일 뒤 지워집니다.", { days: historyDays })
			: t("대화가 그때 실행 중이거나 닫혀 있으면 보내지 않고 건너뜁니다. 서버가 꺼져 있던 동안 놓친 반복은 한 번만 실행하고, 하루 넘게 지난 한 번짜리는 실행하지 않습니다. 연속 5번 실패하면 꺼집니다. 실행을 마친 한 번짜리는 지난 작업으로 옮겨지며 자동으로 지워지지 않습니다.")}
	/>

	{#if form}
		<form class="form" onsubmit={submit}>
			{#if formError}<Notice tone="warn">{formError}</Notice>{/if}
			<FormField label={t("대화")} group>
				<Select label={t("대화")} value={form.sessionId} options={sessionOptions} disabled={!!form.original} placeholder={t("대화를 고르세요")} onchange={(id) => { if (form) form.sessionId = id; }} />
			</FormField>
			<FormField label={t("이름 (선택)")}>
				<input class="field" bind:value={form.title} maxlength={MAX_TITLE} placeholder={t("예: 아침 점검")} autocomplete="off" />
			</FormField>
			<FormField label={t("보낼 프롬프트")}>
				<textarea class="field area" bind:value={form.prompt} rows="4" maxlength={MAX_PROMPT} placeholder={t("대화에 그대로 보낼 내용")} required></textarea>
			</FormField>
			{#if !form.original}
				<FormField label={t("실행")} group>
					<Segmented label={t("실행")} value={form.kind} options={[{ id: "interval", label: t("반복") }, { id: "once", label: t("한 번") }]} onchange={(id) => { if (form) form.kind = id; }} />
				</FormField>
			{/if}
			{#if form.kind === "once"}
				<!-- the note sits under the one field to fill in, on the form's gutter (a bare info Notice has no box on this page and floated 12px in) -->
				<FormField label={t("날짜와 시각")} hint={formNote || undefined}>
					<input class="field" type="datetime-local" bind:value={form.at} min={minAt} required use:focusWhen={form.revive} />
				</FormField>
			{:else}
				<FormField label={t("반복 간격")} hint={t("5분부터 30일까지. 저장하거나 켠 때부터 셉니다.")} group>
					<div class="every">
						<input class="field" type="number" inputmode="numeric" min="1" step="1" bind:value={form.amount} aria-label={t("간격 숫자")} required />
						<Segmented label={t("간격 단위")} value={form.unit} options={unitOptions} onchange={(id) => { if (form) form.unit = id; }} />
					</div>
				</FormField>
			{/if}
			<div class="actions form-actions">
				<Button onclick={() => (form = null)} disabled={busy}>{t("취소")}</Button>
				<Button variant="primary" type="submit" disabled={busy}>{form.revive ? t("다시 예약") : t("저장")}</Button>
			</div>
		</form>
	{:else if !list && loading}
		<EmptyState loading />
	{:else if list}
		<ListGroup title={t("예약 작업")} count={t("{n}/{max}개", { n: pending.length, max: MAX_TASKS })}>
			<ul class="list">
				{#each pending as s (s.id)}
					{@const result = resultOf(s)}
					<li animate:reflow in:rowIn out:rowOut>
						<ListItem off={!s.enabled}>
							{#snippet lead()}<Switch checked={s.enabled} disabled={busy} onchange={(on) => toggle(s, on)} label={labelOf(s)} />{/snippet}
							{#snippet title()}
								<span class="name">{labelOf(s)}</span>
								<Badge size="sm" variant="outline">{cadence(s)}</Badge>
								{#if result}<Badge size="sm" tone={result.tone}>{result.label}</Badge>{/if}
							{/snippet}
							{#snippet actions()}
								<Button size="sm" onclick={() => runNow(s)} disabled={busy}>{t("지금 실행")}</Button>
								<Button size="sm" onclick={() => edit(s)} disabled={busy}>{t("수정")}</Button>
								<Button size="sm" variant="danger" onclick={() => removeOne(s)} disabled={busy}>{t("삭제")}</Button>
							{/snippet}
							<p class="desc">{s.prompt}</p>
							<p class="meta">{sessionLabel(s.sessionId)}</p>
							<p class="meta">
								{#if s.enabled && s.nextRunAt}<span title={fullTime(s.nextRunAt)}>{t("다음 실행 {when}", { when: liveNext(s.nextRunAt) })}</span>
								{:else}{t("꺼져 있음")}{/if}
								{#if s.lastRunAt}{" · "}<span title={fullTime(s.lastRunAt)}>{t("마지막 {when}", { when: livePast(s.lastRunAt) })}</span>{/if}
							</p>
							{#if s.lastStatus === "error" && s.lastError}<p class="meta err">{s.lastError}</p>{/if}
						</ListItem>
					</li>
				{:else}
					<EmptyState as="li">{finished.length ? t("예정된 작업이 없습니다.") : t("예약된 작업이 없습니다.")}</EmptyState>
				{/each}
			</ul>
		</ListGroup>
		{#if full}
			<p class="hint">{t("예약 작업은 {n}개까지 만들 수 있습니다.", { n: MAX_TASKS })}</p>
		{:else if sessions.length === 0}
			<p class="hint">{t("예약할 대화가 없습니다. 먼저 대화를 시작하세요.")}</p>
		{:else}
			<Button variant="dashed" onclick={() => add()}><Icon name="plus" /> {t("예약 추가")}</Button>
		{/if}
		<section class="set-group">
			<SettingRow label={t("지난 작업 자동 삭제")} hint={t("실행을 마친 한 번짜리 작업의 보관 기간입니다.")}>
				<div class="keep-select">
					<Select label={t("지난 작업 자동 삭제")} value={String(historyDays)} options={historyOptions} disabled={savingHistory} onchange={changeHistoryDays} />
				</div>
			</SettingRow>
		</section>
		{#if finished.length}
			<!-- "text", not "line": the line variant pads its body 4px and would pull these cards off the gutter of the cards above -->
			<Accordion variant="text" bind:open={historyOpen}>
				{#snippet head()}<span class="hhead">{t("지난 작업")}</span><span class="hhead count">{t("{n}개", { n: finished.length })}</span>{/snippet}
				<div class="history">
					<p class="hint">
						{#if historyDays > 0}
							{t("실행을 마친 한 번짜리 작업입니다. 마지막 실행 {days}일 뒤 자동으로 지워집니다.", { days: historyDays })}
						{:else}
							{t("실행을 마친 한 번짜리 작업입니다. 자동으로 지워지지 않습니다.")}
						{/if}
					</p>
					<ul class="list">
						{#each finished as s (s.id)}
							{@const result = resultOf(s)}
							<li animate:reflow in:rowIn out:rowOut>
								<ListItem off>
									{#snippet title()}
										<span class="name">{labelOf(s)}</span>
										{#if result}<Badge size="sm" tone={result.tone}>{result.label}</Badge>{/if}
									{/snippet}
									{#snippet actions()}
										<Button size="sm" onclick={() => edit(s, true)} disabled={busy || full}>{t("다시 예약")}</Button>
										<Button size="sm" variant="danger" onclick={() => removeOne(s)} disabled={busy}>{t("삭제")}</Button>
									{/snippet}
									<p class="desc">{s.prompt}</p>
									<p class="meta">{sessionLabel(s.sessionId)}</p>
									<p class="meta">
										{#if historyDays > 0}
											{#if s.lastRunAt}<span title={fullTime(s.lastRunAt)}>{s.lastStatus?.startsWith("skipped") ? t("{when} 건너뜀 · {day}에 지워짐", { when: livePast(s.lastRunAt), day: shortDate(purgeAt(s, historyKeepMs)) }) : t("{when} 실행 · {day}에 지워짐", { when: livePast(s.lastRunAt), day: shortDate(purgeAt(s, historyKeepMs)) })}</span>
											{:else}{t("{day}에 지워짐", { day: shortDate(purgeAt(s, historyKeepMs)) })}{/if}
										{:else if s.lastRunAt}
											<span title={fullTime(s.lastRunAt)}>{s.lastStatus?.startsWith("skipped") ? t("{when} 건너뜀", { when: livePast(s.lastRunAt) }) : t("{when} 실행", { when: livePast(s.lastRunAt) })}</span>
										{/if}
									</p>
									{#if s.lastStatus === "error" && s.lastError}<p class="meta err">{s.lastError}</p>{/if}
								</ListItem>
							</li>
						{/each}
					</ul>
					<div class="actions">
						<ConfirmButton size="sm" danger confirmLabel={t("정말 모두 지우기")} onconfirm={clearHistory} disabled={busy}>{t("지난 작업 모두 지우기")}</ConfirmButton>
					</div>
				</div>
			</Accordion>
		{/if}
	{/if}
	{#if lastDelete}
		{@const d = lastDelete}
		<div class="undo">
			<Notice tone="ok" raised animated role="status">
				{d.text}
				{#snippet action()}<Button size="sm" onclick={() => undo(d)}>{t("되돌리기")}</Button>{/snippet}
			</Notice>
		</div>
	{/if}
</div>

<style>
	.body { display: flex; flex-direction: column; gap: var(--dlg-gap); }
	.hint { margin: 0; font-size: var(--fs-xs); line-height: 18px; color: var(--text-dim); }
	.list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
	.err { color: var(--danger); }
	.count { font-weight: 400; color: var(--text-faint); }
	/* whole-pixel line box: the inherited body line-height made the fold's header 18.59px tall */
	.hhead { line-height: 20px; }
	.history { display: flex; flex-direction: column; gap: 8px; }
	.keep-select { width: 152px; }
	/* pinned to the bottom of the scrolling settings page while a delete can still be undone; above the cards (a local layer) */
	.undo { position: sticky; bottom: 16px; z-index: 1; }
	.form { display: flex; flex-direction: column; gap: var(--dlg-gap); }
	.area { height: auto; padding: 8px 12px; resize: vertical; font-size: var(--fs-sm); line-height: 1.5; }
	/* touch: 16px, or iOS zooms the page in when the field takes focus */
	@media (pointer: coarse) { .area { font-size: var(--fs-lg); } }
	.every { display: grid; grid-template-columns: 96px minmax(0, 1fr); gap: 8px; align-items: stretch; }
	/* the Segmented beside it is 44px tall: the number field takes the same height instead of floating 2px inside it */
	.every :global(.field) { height: auto; }
	.actions { display: flex; justify-content: flex-end; gap: 8px; }
	/* the prompt can be long: ListItem clamps .desc to three lines, and a prompt keeps its own line breaks */
	.list :global(.desc) { white-space: pre-line; }
</style>
