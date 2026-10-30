<script lang="ts">
	import { t } from "../lib/i18n";
	import { collapseIn, collapseOut, easeEnter, easeExit, fadeIn, fadeOut, ms } from "../lib/motion";
	import Icon from "./Icon.svelte";
	import ToolChip from "./ToolChip.svelte";
	import Modal from "./Modal.svelte";
	import ToolCard from "./ToolCard.svelte";
	import QuestionReply from "./QuestionReply.svelte";
	import { app } from "../lib/store.svelte";
	import { getPane } from "../lib/pane";
	import { duration } from "../lib/format";
	import { isImageTool, toolIcon, toolKind, toolLabel, toolSummary } from "../lib/tools";
	import PaintingCanvas from "./message/PaintingCanvas.svelte";
	import type { Step, ToolRun } from "../lib/types";

	/** `live`: the agent is still working and this box is the newest thing in the reply. */
	let { steps, live = false }: { steps: Step[]; live?: boolean } = $props();

	/** The status line rolls: the old line leaves upward as the new one comes in from below. */
	const rollIn = (_: Element) => ({ duration: ms("normal"), easing: easeEnter, css: (t: number, u: number) => `opacity:${t.toFixed(3)};transform:translateY(${(u * 14).toFixed(2)}px)` });
	const rollOut = (_: Element) => ({ duration: ms("fast"), easing: easeExit, css: (t: number, u: number) => `opacity:${t.toFixed(3)};transform:translateY(${(-u * 14).toFixed(2)}px)` });

	const pane = getPane();
	const runOf = (id: string): ToolRun => (id && app.chatOf(pane.id)?.tools[id]) || { state: "pending", output: "" };
	/** Per step: the tool's run state, or null for a thought. */
	const runs = $derived(steps.map((s) => (s.kind === "tool" ? runOf(s.id) : null)));
	const tools = $derived(steps.filter((s) => s.kind === "tool"));
	const thoughts = $derived(steps.filter((s) => s.kind === "think").length);

	const awaitingIdx = $derived(runs.findIndex((r) => r?.state === "awaiting_input"));
	const runningIdx = $derived(live ? runs.findIndex((r) => r?.state === "running" || r?.state === "pending") : -1);
	const thinkingIdx = $derived(live ? steps.findIndex((s) => s.kind === "think" && !s.done) : -1);
	/** What the box is about right now: what needs the user, else what is running, else the open thought. */
	const cur = $derived(awaitingIdx >= 0 ? awaitingIdx : runningIdx >= 0 ? runningIdx : thinkingIdx);
	const active = $derived(awaitingIdx >= 0 || live);

	const settled = (r: ToolRun | null) => !!r && r.state !== "pending" && r.state !== "running" && r.state !== "awaiting_input";
	const finished = $derived(runs.filter(settled).length);
	const failed = $derived(runs.filter((r) => r && (r.state === "error" || (r.state === "done" && Number(r.details?.exitCode) > 0))).length);
	const tone = $derived(awaitingIdx >= 0 ? "warn" : active ? "accent" : failed ? "danger" : "ok");
	const total = $derived(runs.reduce((n, r) => n + (r?.durationMs ?? 0), 0));

	const tally = $derived.by(() => {
		const m = new Map<string, number>();
		for (const tool of tools) m.set(tool.name, (m.get(tool.name) ?? 0) + 1);
		return [...m].map(([n, k]) => (k > 1 ? `${n} ×${k}` : n)).join(" · ");
	});

	/** The single line the box shows; changing `key` rolls the old line up and the new one in. */
	/** The step the header names. Between two steps it stays on the tool that just finished instead of a bare "작업 중". */
	const shown = $derived(cur >= 0 ? cur : active && steps.at(-1)?.kind === "tool" ? steps.length - 1 : -1);
	const line = $derived.by(() => {
		const s = shown >= 0 ? steps[shown] : undefined;
		if (s?.kind === "tool") return { key: `t${shown}`, kind: toolKind(s.name, s.args), icon: toolIcon(s.name, s.args), name: toolLabel(s.name, s.args), sum: s.id ? toolSummary(s.name, s.args) : t("준비 중…"), shimmer: shown === cur && awaitingIdx < 0 };
		if (s?.kind === "think") return { key: `k${shown}`, kind: "think" as const, icon: "brain" as const, name: t("생각 중"), sum: "", shimmer: false };
		if (active) return { key: steps.length ? "gap" : "start", kind: "think" as const, icon: "brain" as const, name: steps.length ? t("작업 중") : t("생각 중"), sum: "", shimmer: false };
		const only = tools[0];
		if (!only) return { key: "done", kind: "think" as const, icon: "brain" as const, name: t("생각 과정"), sum: "", shimmer: false };
		if (tools.length === 1 && !thoughts) return { key: "done", kind: toolKind(only.name, only.args), icon: toolIcon(only.name, only.args), name: toolLabel(only.name, only.args), sum: toolSummary(only.name, only.args), shimmer: false };
		return { key: "done", kind: "other" as const, icon: "list" as const, name: t("도구 {n}개", { n: tools.length }), sum: tally, shimmer: false };
	});
	/**
	 * Live preview: the last lines of what the box is about right now. Between two steps (nothing running, the
	 * next one not started) it keeps showing the step that just finished, so the preview is never an empty box.
	 */
	const PEEK_LINES = 4;
	const LINE_H = 18;
	/** Natural height of the preview text. The window follows it, up to PEEK_LINES lines, so a short output stays a small box. */
	let peekH = $state(0);
	const peekWin = $derived(Math.min(peekH, PEEK_LINES * LINE_H));
	const tail = (text: string) =>
		text
			.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "")
			.split(/\r?\n/)
			.map((l) => l.trimEnd())
			.filter((l) => l.trim())
			.slice(-PEEK_LINES * 3) // long lines wrap, so keep more than fit; the box clips the top
			.map((l) => (l.length > 400 ? `${l.slice(0, 399)}…` : l));
	const text = (v: unknown) => (typeof v === "string" ? v : "");
	const peekIdx = $derived(cur >= 0 ? cur : steps.length - 1);
	const peek = $derived.by((): { lines: string[]; kind: "out" | "src" | "think" } => {
		const none = { lines: [], kind: "out" as const };
		if (!active) return none;
		const s = steps[peekIdx];
		if (!s) return none;
		if (s.kind === "think") return { lines: tail(s.text), kind: "think" };
		if (!s.id) return none;
		const out = tail(runs[peekIdx]?.output ?? "");
		if (out.length) return { lines: out, kind: "out" };
		const a = s.args;
		const src = s.name === "bash" ? text(a.command) : s.name === "write" ? text(a.content) : s.name === "edit" ? text(a.newText) : "";
		// a tool with nothing to show but its target (read, ls, grep …): say what it touched
		return { lines: tail(src || toolSummary(s.name, a)), kind: "src" };
	});
	/** The picture tool is the step being worked on: the box opens a canvas that fills in, instead of a text preview. */
	const painting = $derived.by(() => {
		if (!active) return false;
		const s = steps[peekIdx];
		return s?.kind === "tool" && isImageTool(s.name) && (runs[peekIdx]?.state === "running" || runs[peekIdx]?.state === "pending");
	});
	const awaitingCall = $derived(awaitingIdx >= 0 ? (steps[awaitingIdx] as Extract<Step, { kind: "tool" }>) : null);
	/** The question the waiting call asks the user (ctx.ask); it is answered right here. */
	const question = $derived(awaitingIdx >= 0 ? runs[awaitingIdx]?.question : undefined);

	let modal = $state(false);

</script>

<div class="group {tone}" class:live={active}>
	<button class="box wide" onclick={() => (modal = true)} aria-haspopup="dialog" aria-label={t("작업 {n}단계 자세히 보기", { n: steps.length })}>
		<span class="roll" aria-live="polite">
			{#key line.key}
				<span class="line" in:rollIn out:rollOut>
					<ToolChip kind={line.kind} icon={line.icon} label={line.name} shimmer={line.shimmer} />
					{#if line.sum}<span class="sum mono">{line.sum}</span>{/if}
				</span>
			{/key}
		</span>

		<span class="meta">
			{#if awaitingIdx >= 0}
				<span class="sr-only">{t("답변 필요")}</span>
			{:else if active}
				<span class="dots" role="status" aria-label={t("작업 중")}><i></i><i></i><i></i></span>
				{#if tools.length > 1}<span class="count mono">{finished}/{tools.length}</span>{/if}
			{:else}
				{#if failed}<span class="fail-dot" title={t("실패")}></span><span class="sr-only">{t("실패")} {failed}</span>{/if}
				{#if total}<span class="dur">{duration(total)}</span>{/if}
			{/if}
			<span class="open"><Icon name="chevron-right" /></span>
		</span>
	</button>

	{#if painting}
		<div class="canvas" in:collapseIn out:collapseOut><PaintingCanvas /></div>
	{:else if active && peek.lines.length}
		<!-- A mouse shortcut to the same dialog the "details" button above opens (hidden from assistive tech on purpose). -->
		<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
		<div class="peek mono {peek.kind}" onclick={() => (modal = true)} aria-hidden="true" in:collapseIn out:collapseOut>
			<div class="pin" class:clip={peekH > PEEK_LINES * LINE_H} style:height="{peekWin}px">
				<div class="inner" bind:clientHeight={peekH}>
					{#each peek.lines as l, i (i)}
						<div class="pl">{l}</div>
					{/each}
				</div>
			</div>
		</div>
	{/if}

	{#if awaitingCall && question}
		<div in:fadeIn out:fadeOut><QuestionReply id={awaitingCall.id} paneId={pane.id} question={question} /></div>
	{/if}
</div>

{#if modal}
	<Modal onclose={() => (modal = false)} label={t("작업 상세")} title={t("작업 {n}단계", { n: steps.length })} sub={`${tally || t("생각 과정")}${total ? ` · ${duration(total)}` : ""}`} subMono divider width="xl" maxHeight="760px" portal safeArea>
		<div class="list">
			{#each steps as s, i (i)}
				{#if s.kind === "think"}
					<div class="thought">
						<div class="thead"><Icon name="brain" /> {s.done ? t("생각 과정") : t("생각 중")}</div>
						<div class="tbody">{s.text}</div>
					</div>
				{:else if s.id}
					<ToolCard id={s.id} name={s.name} args={s.args} />
				{:else}
					<div class="prep"><span class="dots" aria-hidden="true"><i></i><i></i><i></i></span> {t("도구 호출 준비 중…")}</div>
				{/if}
			{/each}
		</div>
	</Modal>
{/if}

<style>
	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}
	.group {
		margin: 8px 0;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--bg-elev);
		overflow: hidden;
		transition: border-color var(--motion-fast) var(--ease-std);
	}
	.group.warn {
		border-color: var(--warn);
	}
	.box {
		position: relative;
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		height: 44px;
		padding: 0 12px;
		text-align: left;
		overflow: hidden;
	}
	.box:hover {
		background: var(--bg-hover);
	}
	/* the group clips (overflow: hidden) and the button fills it, so an outer ring would be cut away entirely */
	.box:focus-visible {
		outline-offset: -2px;
		border-radius: var(--radius);
	}
	.ico {
		display: grid;
		color: var(--text-dim);
	}
	.ico :global(svg),
	.open :global(svg) {
		width: 16px;
		height: 16px;
		stroke-width: 1.8;
	}
	.roll {
		position: relative;
		flex: 1;
		min-width: 0;
		height: 22px;
	}
	.line {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
		white-space: nowrap;
	}
	.name {
		flex: none;
		font-weight: 600;
		font-size: var(--fs-sm);
	}
	.sum {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		font-size: var(--fs-xs);
		color: var(--text-dim);
	}
	.meta {
		flex: none;
		display: flex;
		align-items: center;
		gap: 8px;
		color: var(--text-dim);
	}
	.count,
	/* an even 16px box like the dot (8) and the arrow (16): the 11px text's own 17.05px height is odd, so the row's centring rounded it a pixel low */
	.dur {
		font-size: var(--fs-2xs);
		line-height: 16px;
		color: var(--text-faint);
	}
	.open {
		display: grid;
		color: var(--text-faint);
	}
	/* the live preview is plain text under the header, not a box of its own: no border or fill, only a thin guide line */
	.peek {
		margin: 0 12px 12px 20px; /* the guide line sits under the header icon's centre */
		padding: 0 0 0 16px;
		cursor: pointer;
		border-left: 2px solid var(--border);
		font-size: var(--fs-xs);
		line-height: 18px;
		color: var(--text-dim);
		overflow: hidden;
	}
	/* as tall as its text, up to four lines, newest at the bottom: past that, older text scrolls off the top under a soft fade */
	.pin {
		display: flex;
		flex-direction: column;
		justify-content: flex-end;
		overflow: hidden;
		/* no height transition: the window follows the streaming text every frame, so a transition restarts constantly and, with the
		   pinned scroll re-placed on each resize, made the whole view shake (WebKit/macOS) */
		contain: layout paint;
	}
	.pin.clip {
		mask-image: linear-gradient(to bottom, transparent 0, #000 14px);
	}
	.inner {
		flex: none;
	}
	.pl {
		flex: none;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	.pl:last-child {
		color: var(--text);
	}
	.peek.think {
		font-family: inherit;
		font-style: italic;
	}

	/* the canvas sits under the header inside the same frame while the picture is drawn; the finished picture goes in the reply, not here */
	.canvas {
		padding: 4px 12px 12px;
	}
	.list {
		padding: 4px 16px 16px;
		overflow-y: auto;
	}
	.prep {
		display: flex;
		align-items: center;
		gap: 8px;
		margin: 8px 0;
		color: var(--text-dim);
		font-size: var(--fs-sm);
	}
	.thought {
		margin: 8px 0;
		padding: 8px 12px;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--bg-elev);
	}
	.thead {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: var(--fs-sm);
		font-weight: 600;
		color: var(--text-dim);
	}
	.thead :global(svg) {
		width: 16px;
		height: 16px;
		stroke-width: 1.8;
	}
	.tbody {
		margin-top: 4px;
		color: var(--text-dim);
		font-size: var(--fs-sm);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		max-height: 300px;
		overflow: auto;
	}
</style>
