<script lang="ts">
	import { untrack } from "svelte";
	import Badge from "../ui/Badge.svelte";
	import Button from "../ui/Button.svelte";
	import ConfirmButton from "../ui/ConfirmButton.svelte";
	import EmptyState from "../ui/EmptyState.svelte";
	import ExtrasIntro from "../ui/ExtrasIntro.svelte";
	import FormField from "../ui/FormField.svelte";
	import IconButton from "../ui/IconButton.svelte";
	import ListGroup from "../ui/ListGroup.svelte";
	import ListItem from "../ui/ListItem.svelte";
	import Notice from "../ui/Notice.svelte";
	import Segmented from "../ui/Segmented.svelte";
	import Select from "../ui/Select.svelte";
	import Switch from "../ui/Switch.svelte";
	import { abortable } from "../../lib/abortable";
	import { recentreModal } from "../../lib/dialog";
	import { Api, errorText } from "../../lib/api";
	import { t } from "../../lib/i18n";
	import { nameInLang } from "../../lib/member-names";
	import { reflow, rowIn, rowOut } from "../../lib/motion";
	import {
		MAX_PROMPT,
		MAX_TASKS,
		MAX_TITLE,
		cadence,
		everyMs,
		everyProblem,
		isUsedUp,
		labelOf,
		parseLocal,
		resultOf,
		sortSchedules,
		splitEvery,
		toLocalInput,
		type EveryUnit,
	} from "../../lib/schedules";
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
	let loading = $state(true);
	let error = $state("");
	let busy = $state(false);

	// Read again when a task changes (schedules_updated) and when the server or the account behind it changes.
	$effect(() => {
		void app.schedulesTick;
		const a = api;
		if (!a) return;
		untrack(() => { if (!list) loading = true; });
		return abortable((signal) => a.schedules(undefined, signal), {
			ok: (r) => { list = r.schedules; error = ""; },
			fail: (e) => (error = errorText(e)),
			done: () => (loading = false),
		});
	});

	async function reload() {
		if (!api) return;
		try {
			list = (await api.schedules()).schedules;
		} catch (e) {
			error = errorText(e);
		}
	}

	const shown = $derived(list ? sortSchedules(list) : []);
	const full = $derived((list?.length ?? 0) >= MAX_TASKS);

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
	let formError = $state("");

	function add(sessionId?: string) {
		const first = sessionId && sessionOf(sessionId) ? sessionId : (app.activeId && sessionOf(app.activeId) ? app.activeId : (sessions[0]?.id ?? ""));
		form = { original: null, sessionId: first, title: "", prompt: "", kind: "interval", at: "", amount: "1", unit: "hour", revive: false };
		formError = "";
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
		formError = revive ? t("지난 시각입니다. 새 시각을 정해야 다시 켤 수 있습니다.") : "";
	}

	// A conversation's menu ("예약 추가…") opens this page with that conversation chosen.
	$effect(() => {
		const id = app.scheduleFor;
		if (!id || !api) return;
		app.scheduleFor = null;
		untrack(() => add(id));
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
	const remove = (s: Schedule) => act((a) => a.deleteSchedule(s.id));

	const sessionLabel = (id: string) => {
		const s = sessionOf(id);
		return s ? `${s.title}${s.name ? ` · @${nameInLang(s.name)}` : ""}` : t("닫힌 대화");
	};
	const when = (ms: number) => new Date(ms).toLocaleString();
	const sessionOptions = $derived(sessions.map((s) => ({ value: s.id, label: sessionLabel(s.id) })));
	const unitOptions = $derived([
		{ id: "minute" as const, label: t("분") },
		{ id: "hour" as const, label: t("시간") },
		{ id: "day" as const, label: t("일") },
	]);
	const minAt = $derived(toLocalInput(Date.now()));

	// The list and the form are two pages of different heights: in the sidebar's dialog, centre it again on each switch
	// (the modal otherwise keeps its top, and the taller form would sit pinned to the window's bottom edge).
	let root: HTMLDivElement | undefined = $state();
	const editing = $derived(form !== null);
	$effect(() => {
		void editing;
		if (root) recentreModal(root);
	});
</script>

<div class="body" aria-busy={loading} bind:this={root}>
	{#if error}<Notice tone="warn">{error}</Notice>{/if}
	<ExtrasIntro
		what={t("정해진 때나 일정한 간격으로 기존 대화에 프롬프트를 자동으로 보냅니다.")}
		how={t("대화가 그때 실행 중이거나 닫혀 있으면 보내지 않고 건너뜁니다. 서버가 꺼져 있던 동안 놓친 반복은 한 번만 실행하고, 하루 넘게 지난 한 번짜리는 실행하지 않습니다. 연속 5번 실패하면 꺼집니다.")}
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
				<FormField label={t("날짜와 시각")}>
					<input class="field" type="datetime-local" bind:value={form.at} min={minAt} required />
				</FormField>
			{:else}
				<FormField label={t("반복 간격")} hint={t("5분부터 30일까지. 저장하거나 켠 때부터 셉니다.")} group>
					<div class="every">
						<input class="field" type="number" inputmode="numeric" min="1" step="1" bind:value={form.amount} aria-label={t("간격 숫자")} required />
						<Segmented label={t("간격 단위")} value={form.unit} options={unitOptions} onchange={(id) => { if (form) form.unit = id; }} />
					</div>
				</FormField>
			{/if}
			<div class="actions">
				<Button onclick={() => (form = null)} disabled={busy}>{t("취소")}</Button>
				<Button variant="primary" type="submit" disabled={busy}>{t("저장")}</Button>
			</div>
		</form>
	{:else if !list && loading}
		<EmptyState loading />
	{:else if list}
		<ListGroup title={t("예약 작업")} count={t("{n}/{max}개", { n: list.length, max: MAX_TASKS })}>
			<ul class="list">
				{#each shown as s (s.id)}
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
								<IconButton icon="send" size="sm" label={t("지금 실행")} tip disabled={busy} onclick={() => runNow(s)} />
								<Button size="sm" onclick={() => edit(s)} disabled={busy}>{t("수정")}</Button>
								<ConfirmButton size="sm" danger confirmLabel={t("정말 삭제")} onconfirm={() => remove(s)} disabled={busy}>{t("삭제")}</ConfirmButton>
							{/snippet}
							<p class="desc">{s.prompt}</p>
							<p class="meta">{sessionLabel(s.sessionId)}</p>
							<p class="meta">
								{#if s.enabled && s.nextRunAt}{t("다음 실행 {when}", { when: when(s.nextRunAt) })}
								{:else if isUsedUp(s)}{t("실행을 마쳤습니다")}
								{:else}{t("꺼져 있음")}{/if}
								{#if s.lastRunAt} · {t("마지막 {when}", { when: when(s.lastRunAt) })}{/if}
							</p>
							{#if s.lastStatus === "error" && s.lastError}<p class="meta err">{s.lastError}</p>{/if}
						</ListItem>
					</li>
				{:else}
					<EmptyState as="li">{t("예약된 작업이 없습니다.")}</EmptyState>
				{/each}
			</ul>
		</ListGroup>
		{#if full}
			<p class="hint">{t("예약 작업은 {n}개까지 만들 수 있습니다.", { n: MAX_TASKS })}</p>
		{:else if sessions.length === 0}
			<p class="hint">{t("예약할 대화가 없습니다. 먼저 대화를 시작하세요.")}</p>
		{:else}
			<Button variant="dashed" onclick={() => add()}>{t("예약 추가")}</Button>
		{/if}
	{/if}
</div>

<style>
	.body { display: flex; flex-direction: column; gap: var(--dlg-gap); }
	.hint { margin: 0; font-size: var(--fs-xs); line-height: 18px; color: var(--text-dim); }
	.list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
	.err { color: var(--danger); }
	.form { display: flex; flex-direction: column; gap: var(--dlg-gap); }
	.area { height: auto; padding: 8px 12px; resize: vertical; font-size: var(--fs-sm); line-height: 1.5; }
	.every { display: grid; grid-template-columns: 96px minmax(0, 1fr); gap: 8px; align-items: stretch; }
	/* the Segmented beside it is 44px tall: the number field takes the same height instead of floating 2px inside it */
	.every :global(.field) { height: auto; }
	.actions { display: flex; justify-content: flex-end; gap: 8px; }
	/* the prompt can be long: ListItem clamps .desc to three lines, and a prompt keeps its own line breaks */
	.list :global(.desc) { white-space: pre-line; }
</style>
