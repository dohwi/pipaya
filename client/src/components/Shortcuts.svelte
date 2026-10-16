<script lang="ts">
	import { msg, t } from "../lib/i18n";
	import { onDestroy } from "svelte";
	import { app } from "../lib/store.svelte";
	import Icon from "./Icon.svelte";
	import { ACTIONS, DEFAULT_BINDINGS, MAX_KEYS, emptyRecording, formatCombo, recordKey, recordingCombo, recordingIsEmpty, recordingLabel, undoRecording, type ActionId } from "../lib/keys";

	/** `filter` narrows the list by name, hint or key; the Settings search hands it over when a shortcut result is opened. */
	let { filter = $bindable("") }: { filter?: string } = $props();

	let recording = $state<ActionId | null>(null);
	let note = $state<{ id: ActionId; text: string; bad?: boolean } | null>(null);
	/** Keys pressed so far. Nothing is saved until the user confirms with the check button. */
	let rec = $state(emptyRecording());
	const live = $derived(recordingLabel(rec));
	const canConfirm = $derived(rec.keys.length > 0);

	const GROUPS = [
		{ id: "general", title: msg("일반") },
		{ id: "chat", title: msg("대화") },
		{ id: "model", title: msg("모델 · 추론") },
		{ id: "layout", title: msg("화면 분할") },
	] as const;

	const label = (id: ActionId) => t(ACTIONS.find((a) => a.id === id)?.label ?? id);
	const q = $derived(filter.trim().toLowerCase());
	/** Both the shown language and the Korean source text match, so either can be searched. */
	const shown = (a: (typeof ACTIONS)[number]) => {
		const combo = app.prefs.bindings[a.id];
		return [t(a.label), a.label, a.hint ? t(a.hint) : "", combo, formatCombo(combo)].join("\n").toLowerCase();
	};
	const matches = (a: (typeof ACTIONS)[number]) => !q || q.split(/\s+/).every((w) => shown(a).includes(w));
	const visible = $derived(ACTIONS.filter(matches));
	const changed = $derived(ACTIONS.some((a) => app.prefs.bindings[a.id] !== a.default));

	function start(id: ActionId) {
		recording = id;
		note = null;
		rec = emptyRecording();
		app.prefs.recordingKey = true;
	}

	function stop() {
		recording = null;
		rec = emptyRecording();
		app.prefs.recordingKey = false;
	}

	function bind(id: ActionId, combo: string) {
		const taken = app.prefs.setBinding(id, combo);
		note = taken ? { id, text: t('"{name}"에서 이 단축키를 가져왔습니다', { name: label(taken) }) } : null;
	}

	function confirm() {
		if (!recording || !canConfirm) return;
		bind(recording, recordingCombo(rec));
		stop();
	}

	/** Capture phase + stopPropagation so neither the app's shortcuts nor the dialog's Esc see the key. */
	function onKey(e: KeyboardEvent) {
		if (!recording) return;
		e.preventDefault();
		e.stopPropagation();
		if (e.repeat) return;
		const plain = !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey;
		if (e.key === "Escape" && plain) return stop();
		if (e.key === "Backspace" && plain) {
			// removes the last key; with nothing left it clears the shortcut
			if (recordingIsEmpty(rec)) {
				bind(recording, "");
				return stop();
			}
			rec = undoRecording(rec);
			note = null;
			return;
		}
		const { next, rejected } = recordKey(rec, e);
		if (rejected) {
			note = { id: recording, text: t("일반 키는 {n}개까지 함께 누를 수 있습니다", { n: MAX_KEYS }), bad: true };
			return;
		}
		note = null;
		rec = next;
	}

	/** Releasing keys does nothing: the shortcut only changes when the check button is pressed. */
	function onKeyUp(e: KeyboardEvent) {
		if (!recording) return;
		e.preventDefault();
		e.stopPropagation();
	}

	onDestroy(() => (app.prefs.recordingKey = false));
</script>

<svelte:window onkeydowncapture={onKey} onkeyupcapture={onKeyUp} onblur={stop} />

<section>
	<span class="hint">
		{t("항목을 누른 뒤 원하는 키를 차례로 누르면 하나씩 쌓입니다. Ctrl·Alt·Shift에 더해 일반 키를 최대 3개까지 지정할 수 있고, 확인(✓) 버튼을 눌러야 저장됩니다.")} <kbd>Esc</kbd> {t("취소")} · <kbd>Backspace</kbd> {t("마지막 키 지우기 (비었을 때는 해제)")}. {t("모델과 추론 단계는 지금 열려 있는 대화에만 적용됩니다.")}
	</span>

	<input class="search" type="search" placeholder={t("단축키 검색")} aria-label={t("단축키 검색")} bind:value={filter} />
	{#if !visible.length}<span class="hint">{t("검색 결과가 없습니다")}</span>{/if}

	{#each GROUPS.filter((g) => visible.some((x) => x.group === g.id)) as g (g.id)}
	<div class="group">{t(g.title)}</div>
	<ul>
		{#each visible.filter((x) => x.group === g.id) as a (a.id)}
			{@const combo = app.prefs.bindings[a.id]}
			<li>
				<div class="what">
					<span class="name">{t(a.label)}</span>
					{#if a.hint}<span class="sub">{t(a.hint)}</span>{/if}
					{#if combo && !a.fixed && !/Mod|Alt/.test(combo)}<span class="sub">{t("입력창에서 글자를 쓰는 중에는 실행되지 않습니다")}</span>{/if}
					{#if note?.id === a.id}<span class="note" class:bad={note.bad}>{note.text}</span>{/if}
				</div>
				{#if a.fixed}
					<span class="key fixed" title={t("고정된 단축키입니다")}>{formatCombo(combo)}</span>
					<span class="slot" aria-hidden="true"></span>
				{:else}
					{#if recording === a.id}
						<span class="key rec" aria-live="polite">{live || t("키를 누르세요…")}</span>
						<button class="step ok" disabled={!canConfirm} onclick={confirm} title={t("이 단축키로 저장")} aria-label={t("이 단축키로 저장")}><Icon name="check" /></button>
						<button class="step" onclick={stop} title={t("취소")} aria-label={t("취소")}><Icon name="x" /></button>
					{:else}
						<button class="key" class:none={!combo} onclick={() => start(a.id)}>
							{#if combo}{formatCombo(combo)}{:else}{t("없음")}{/if}
						</button>
						<button class="reset" disabled={!combo} onclick={() => bind(a.id, "")} title={t("단축키 없애기")} aria-label={t("{name} 단축키 없애기", { name: t(a.label) })}><Icon name="x" /></button>
						<button class="reset" disabled={combo === DEFAULT_BINDINGS[a.id]} onclick={() => app.prefs.resetBindings(a.id)} title={t("기본값으로")} aria-label={t("{name} 기본값으로", { name: t(a.label) })}><Icon name="undo" /></button>
					{/if}
				{/if}
			</li>
		{/each}
	</ul>
	{/each}

	<div class="foot">
		<button class="all" disabled={!changed} onclick={() => app.prefs.resetBindings()}>{t("모두 기본값으로")}</button>
	</div>
</section>

<style>
	section {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}
	.search {
		width: 100%;
		height: 34px;
		padding: 0 12px;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--bg-elev);
		color: var(--text);
		font: inherit;
		font-size: var(--fs-md);
	}
	.group {
		margin-top: 14px;
		font-size: var(--fs-sm);
		font-weight: 600;
	}
	.hint {
		font-size: var(--fs-xs);
		color: var(--text-faint);
		line-height: 1.5;
	}
	.hint kbd {
		font-family: var(--mono);
		font-size: var(--fs-2xs);
		padding: 1px 5px;
		border: 1px solid var(--border);
		border-radius: var(--radius-xs);
	}
	ul {
		list-style: none;
		margin: 4px 0 0;
		padding: 0;
		display: flex;
		flex-direction: column;
	}
	li {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 9px 0;
		border-top: 1px solid var(--border);
	}
	li:first-child {
		border-top: 0;
	}
	.what {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.name {
		font-size: var(--fs-md);
	}
	.sub {
		font-size: var(--fs-xs);
		color: var(--text-faint);
	}
	.note {
		font-size: var(--fs-xs);
		color: var(--text-dim);
	}
	.note.bad {
		color: var(--danger);
	}
	.key {
		min-width: 108px;
		height: 32px;
		padding: 0 10px;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		font-family: var(--mono);
		font-size: var(--fs-xs);
		color: var(--text);
		background: var(--bg-elev, transparent);
		white-space: nowrap;
	}
	.key:hover {
		background: var(--bg-hover);
	}
	.key.fixed {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		color: var(--text-dim);
		background: transparent;
		border-style: dashed;
		cursor: default;
	}
	.slot {
		flex: none;
		width: 28px;
	}
	.key.none {
		color: var(--text-faint);
	}
	.key.rec {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border-color: var(--text);
		background: var(--bg-active);
		color: var(--text);
	}
	/* confirm / cancel while recording; together they take the width of the ↺ button plus a little */
	.step {
		flex: none;
		display: grid;
		place-items: center;
		width: 28px;
		height: 28px;
		border-radius: var(--radius);
		color: var(--text-dim);
	}
	.step:hover:not(:disabled) {
		background: var(--bg-hover);
		color: var(--text);
	}
	.step.ok:not(:disabled) {
		color: var(--ok);
	}
	.step:disabled {
		opacity: 0.3;
	}
	.step :global(svg) {
		width: 16px;
		height: 16px;
		stroke: currentColor;
		fill: none;
		stroke-width: 2.2;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	.reset {
		display: grid;
		place-items: center;
		width: 28px;
		height: 28px;
		flex: none;
		border-radius: var(--radius);
		color: var(--text-dim);
	}
	.reset :global(svg) {
		width: 14px;
		height: 14px;
		stroke: currentColor;
		fill: none;
		stroke-width: 2.2;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	.reset:hover:not(:disabled) {
		background: var(--bg-hover);
		color: var(--text);
	}
	.reset:disabled {
		opacity: 0.25;
	}
	.foot {
		display: flex;
		justify-content: flex-end;
		margin-top: 6px;
	}
	.all {
		height: 32px;
		padding: 0 12px;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		font-size: var(--fs-sm);
	}
	.all:hover:not(:disabled) {
		background: var(--bg-hover);
	}
	.all:disabled {
		opacity: 0.4;
	}
</style>
