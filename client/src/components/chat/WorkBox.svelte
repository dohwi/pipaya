<script lang="ts">
	import { localeTag, t } from "../../lib/i18n";
	import { collapseIn, collapseOut, easeEnter, easeExit, fadeIn, fadeOut, ms } from "../../lib/motion";
	import Icon from "../ui/Icon.svelte";
	import ToolCard from "./ToolCard.svelte";
	import QuestionReply from "./QuestionReply.svelte";
	import { app } from "../../lib/store.svelte";
	import { getPane } from "../../lib/pane";
	import { duration } from "../../lib/format";
	import { isImageTool, toolIcon, toolSummary } from "../../lib/tools";
	import { workIcon, workSummary } from "../../lib/work-summary";
	import PaintingCanvas from "./PaintingCanvas.svelte";
	import type { Step, ToolRun } from "../../lib/types";

	/** `live`: the agent is still working and this box is the newest thing in the reply. */
	let { steps, live = false }: { steps: Step[]; live?: boolean } = $props();
	const uid = $props.id();

	/** The "now" line changes by fading in place: no vertical shift, so a new call that looks like the old one (bash after bash) does not wobble. */
	const rollIn = (_: Element) => ({ duration: ms("normal"), easing: easeEnter, css: (t: number) => `opacity:${t.toFixed(3)}` });
	const rollOut = (_: Element) => ({ duration: ms("fast"), easing: easeExit, css: (t: number) => `opacity:${t.toFixed(3)}` });

	const pane = getPane();
	const runOf = (id: string): ToolRun => (id && app.chatOf(pane.id)?.tools[id]) || { state: "pending", output: "" };
	/** Per step: the tool's run state, or null for a thought. */
	const runs = $derived(steps.map((s) => (s.kind === "tool" ? runOf(s.id) : null)));
	const tools = $derived(steps.filter((s) => s.kind === "tool"));

	const awaitingIdx = $derived(runs.findIndex((r) => r?.state === "awaiting_input"));
	const runningIdx = $derived(live ? runs.findIndex((r) => r?.state === "running" || r?.state === "pending") : -1);
	const thinkingIdx = $derived(live ? steps.findIndex((s) => s.kind === "think" && !s.done) : -1);
	/** What the box is about right now: what needs the user, else what is running, else the open thought. */
	const cur = $derived(awaitingIdx >= 0 ? awaitingIdx : runningIdx >= 0 ? runningIdx : thinkingIdx);
	const active = $derived(awaitingIdx >= 0 || live);

	const settled = (r: ToolRun | null) => !!r && r.state !== "pending" && r.state !== "running" && r.state !== "awaiting_input";
	const finished = $derived(runs.filter(settled).length);
	const failed = $derived(runs.filter((r) => r && (r.state === "error" || (r.state === "done" && Number(r.details?.exitCode) > 0))).length);
	const total = $derived(runs.reduce((n, r) => n + (r?.durationMs ?? 0), 0));
	/** When the last call finished: the duration shows how long the work took, hovering it says on which day and at what time. */
	const endedAt = $derived(runs.reduce((n, r) => Math.max(n, r?.endedAt ?? 0), 0));
	const endedTitle = $derived(endedAt ? t("{when} 완료", { when: new Date(endedAt).toLocaleString(localeTag()) }) : undefined);

	/** The quiet line: what the calls did, kind by kind ("명령 4개 실행 및 웹 1회 검색"). While nothing but thoughts came yet, "생각 중". */
	const summary = $derived(active && !tools.length ? t("생각 중") : workSummary(steps));
	/** What kind of work the box holds at a glance: the icon of the kind the summary names first. */
	const icon = $derived(workIcon(steps));
	/** A box of one call (and no thoughts) also names what it touched, the way its card would. */
	const single = $derived(tools.length === 1 && steps.length === 1 && !active ? toolSummary(tools[0]!.name, tools[0]!.args) : "");

	/**
	 * Folded by default; opening shows every step in place. The "expand work" setting (Ctrl/⌘+O) opens or folds every
	 * box at once; a box opened or folded by hand keeps that until the setting changes again.
	 */
	let open = $state(app.prefs.expandWork);
	$effect.pre(() => {
		open = app.prefs.expandWork;
	});

	/** The step the "now" line names. Between two steps it stays on the tool that just finished instead of going blank. */
	const shown = $derived(cur >= 0 ? cur : active && steps.at(-1)?.kind === "tool" ? steps.length - 1 : -1);
	const now = $derived.by(() => {
		if (!active || shown < 0) return null;
		const s = steps[shown]!;
		if (s.kind === "think") return { key: `k${shown}`, icon: "brain" as const, text: t("생각 중"), mono: false };
		return { key: `t${shown}`, icon: toolIcon(s.name, s.args), text: s.id ? toolSummary(s.name, s.args) || s.name : t("준비 중…"), mono: !!s.id };
	});
	/**
	 * Live preview: the last lines of what the box is about right now. Between two steps (nothing running, the
	 * next one not started) it keeps showing the step that just finished, so the preview is never an empty box.
	 */
	const PEEK_LINES = 2;
	const LINE_H = 18;
	/** Natural height of the preview text. The window follows it, up to PEEK_LINES lines, so a short output stays short. */
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
	/**
	 * Between two steps the next one has nothing to show yet (a call still preparing, a thought with no text), so `peek` is
	 * empty for a moment. Closing the preview and reopening it a frame later made the box and everything under it bounce;
	 * keep the last preview on screen until the new one has lines, and drop it only when the box stops being live.
	 */
	let held = $state<{ lines: string[]; kind: "out" | "src" | "think" }>({ lines: [], kind: "out" });
	$effect.pre(() => {
		if (!active) held = { lines: [], kind: "out" };
		else if (peek.lines.length) held = peek;
	});
	const shownPeek = $derived(peek.lines.length ? peek : active ? held : peek);
	/** The picture tool is the step being worked on: the box opens a canvas that fills in, instead of a text preview. */
	const painting = $derived.by(() => {
		if (!active) return false;
		const s = steps[peekIdx];
		return s?.kind === "tool" && isImageTool(s.name) && (runs[peekIdx]?.state === "running" || runs[peekIdx]?.state === "pending");
	});
	/**
	 * The picture of the step that just finished (a read picture, a screenshot, a drawn image), shown under the header
	 * only while the box is live: one at a time, replaced by the next step's. When the box settles it goes away, so
	 * pictures never pile up here; a generated picture reaches the user through the agent's reply.
	 */
	const drawn = $derived.by(() => {
		if (!active) return [];
		for (let i = steps.length - 1; i >= 0; i--) {
			if (steps[i].kind !== "tool") continue;
			// Only the latest tool step counts: a step without a picture (bash) must not bring back an older step's picture.
			return runs[i]?.state === "done" ? (runs[i]?.images ?? []) : [];
		}
		return [];
	});
	/** Who drew them: the image model the tool reports (provider/id), by its name when the server lists it. Shown when hovering the picture. */
	const drawnBy = $derived.by(() => {
		const ref = steps
			.flatMap((s, i) => (s.kind === "tool" && isImageTool(s.name) && runs[i]?.state === "done" ? [runs[i]!] : []))
			.map((r) => (typeof r.details?.model === "string" ? (r.details.model as string) : ""))
			.find(Boolean);
		if (!ref) return null;
		const cut = ref.indexOf("/");
		const provider = cut < 0 ? "" : ref.slice(0, cut);
		const id = cut < 0 ? ref : ref.slice(cut + 1);
		return app.models.find((m) => m.provider === provider && m.id === id)?.name ?? id;
	});
	const awaitingCall = $derived(awaitingIdx >= 0 ? (steps[awaitingIdx] as Extract<Step, { kind: "tool" }>) : null);
	/** The question the waiting call asks the user (ctx.ask); it is answered right here. */
	const question = $derived(awaitingIdx >= 0 ? runs[awaitingIdx]?.question : undefined);

</script>

<div class="work" class:live={active} class:warn={awaitingIdx >= 0}>
	{#if steps.length}
		<button class="sumrow" onclick={() => (open = !open)} aria-expanded={open} aria-controls={uid}>
			{@render row()}
		</button>
	{:else}
		<div class="sumrow">{@render row()}</div>
	{/if}

	{#if now && !open}
		<div class="now" aria-live="polite">
			{#key now.key}
				<span class="nowline" in:rollIn out:rollOut>
					<Icon name={now.icon} />
					<span class="nowtext" class:mono={now.mono}>{now.text}</span>
				</span>
			{/key}
		</div>
	{/if}

	{#if open}
		<div class="steps" id={uid} in:collapseIn out:collapseOut>
			{#each steps as s, i (i)}
				{#if s.kind === "think"}
					<div class="thought">
						<div class="thead"><Icon name="brain" /><span>{s.done ? t("생각 과정") : t("생각 중")}</span></div>
						{#if s.text}<div class="tbody">{s.text}</div>{/if}
					</div>
				{:else if s.id}
					<ToolCard id={s.id} name={s.name} args={s.args} />
				{:else}
					<div class="prep"><span class="dots" aria-hidden="true"><i></i><i></i><i></i></span> {t("도구 호출 준비 중…")}</div>
				{/if}
			{/each}
		</div>
	{:else if painting}
		<div class="canvas" in:collapseIn out:collapseOut><PaintingCanvas /></div>
	{:else if active && shownPeek.lines.length}
		<!-- A mouse shortcut to the same steps the summary line above opens (hidden from assistive tech on purpose). -->
		<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
		<div class="peek mono {shownPeek.kind}" onclick={() => (open = true)} aria-hidden="true" in:collapseIn out:collapseOut>
			<div class="pin" class:clip={peekH > PEEK_LINES * LINE_H} style:height="{peekWin}px">
				<div class="inner" bind:clientHeight={peekH}>
					{#each shownPeek.lines as l, i (i)}
						<div class="pl">{l}</div>
					{/each}
				</div>
			</div>
		</div>
	{/if}

	{#if drawn.length}
		<div class="drawn" in:collapseIn out:collapseOut>
			{#each drawn as img, i (i)}
				<button class="zoom" onclick={() => app.openImage(drawn.map((m) => ({ src: `data:${m.mimeType};base64,${m.data}`, mimeType: m.mimeType })), i)} aria-label={t("이미지 크게 보기")}>
					<img src={`data:${img.mimeType};base64,${img.data}`} alt={t("이미지")} />
					{#if drawnBy}<span class="by">{drawnBy}</span>{/if}
				</button>
			{/each}
		</div>
	{/if}

	{#if awaitingCall && question}
		<div class="ask" in:fadeIn out:fadeOut><QuestionReply id={awaitingCall.id} paneId={pane.id} question={question} /></div>
	{/if}
</div>

{#snippet row()}
	<span class="kind"><Icon name={icon} /></span>
	<span class="what" class:shimmer={active && awaitingIdx < 0}>{summary}</span>
	{#if single}<span class="single mono">{single}</span>{/if}
	{#if awaitingIdx >= 0}
		<span class="need">{t("답변 필요")}</span>
	{:else if active}
		<span class="dots" role="status" aria-label={t("작업 중")}><i></i><i></i><i></i></span>
		{#if tools.length > 1}<span class="count mono">{finished}/{tools.length}</span>{/if}
	{:else}
		{#if failed}
			<!-- no check for work that went fine; a failure is only a short word in red, how many when there were several -->
			<span class="fail">{tools.length > 1 ? t("{n}개 실패", { n: failed }) : t("실패")}</span>
		{/if}
		{#if total}
			{#if endedAt}<time class="dur" datetime={new Date(endedAt).toISOString()} title={endedTitle}>{duration(total)}</time>
			{:else}<span class="dur">{duration(total)}</span>{/if}
		{/if}
	{/if}
	{#if steps.length}<span class="chev" class:open><Icon name="chevron-right" /></span>{/if}
{/snippet}

<style>
	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}
	/* No card: the work sits in the text column as one quiet line, the way a footnote would */
	.work {
		margin: 8px 0;
	}
	/* as wide as its text (up to the column), starting on the column's left line like the paragraphs around it */
	.sumrow {
		display: flex;
		align-items: center;
		gap: 8px;
		max-width: 100%;
		padding: 4px 0;
		font-size: var(--fs-sm);
		line-height: 20px;
		color: var(--text-dim);
		text-align: left;
		transition: color var(--motion-fast) var(--ease-std);
	}
	@media (hover: hover) {
		button.sumrow:hover {
			color: var(--text);
		}
		button.sumrow:hover .chev {
			color: var(--text-dim);
		}
	}
	/* the row has no fill of its own, so the press tint of row buttons (app.css) would paint a bare block behind the text */
	button.sumrow:active:not(:disabled) {
		background-color: transparent;
	}
	/* the summary keeps its words; only when the column is too narrow for it alone does it shrink to an ellipsis */
	.what {
		flex: 0 1 auto;
		min-width: 0;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}
	/* basis 0: what one call touched takes only the room the summary leaves, so it is the part that gets cut */
	.single {
		flex: 1 1 0;
		min-width: 0;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
		font-size: var(--fs-xs);
		color: var(--text-faint);
	}
	.count,
	/* an even 16px box like the dot (8) and the arrow (16): the 11px text's own 17.05px height is odd */
	.dur {
		flex: none;
		font-size: var(--fs-2xs);
		line-height: 16px;
		font-variant-numeric: tabular-nums;
		color: var(--text-faint);
	}
	.kind,
	.chev {
		flex: none;
		display: grid;
		place-items: center;
		width: 16px;
		height: 16px;
		color: var(--text-faint);
	}
	.kind :global(svg),
	.chev :global(svg) {
		width: 16px;
		height: 16px;
		stroke-width: 2;
	}
	/* the same 16px glyph and stroke as the "now" line's icon right under it, so both sit on the guide line's centre */
	.kind :global(svg) {
		stroke-width: 1.8;
	}
	.chev {
		transition: transform var(--motion-fast) var(--ease);
	}
	.chev.open {
		transform: rotate(90deg);
	}
	/* the light notice on a folded box: a short word, the same size as the time next to it */
	.fail {
		flex: none;
		font-size: var(--fs-2xs);
		line-height: 16px;
		color: var(--danger);
	}
	.need {
		flex: none;
		font-size: var(--fs-xs);
		line-height: 16px;
		color: var(--warn);
	}
	.dots {
		color: var(--text-faint);
	}

	/* the step being worked on: its icon and one line of what it does, cut short rather than wrapped */
	.now {
		position: relative;
		height: 20px;
	}
	.nowline {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
		color: var(--text-dim);
	}
	.nowline :global(svg) {
		flex: none;
		width: 16px;
		height: 16px;
		stroke-width: 1.8;
		color: var(--text-faint);
	}
	.warn .nowline :global(svg) {
		color: var(--warn);
	}
	.nowtext {
		min-width: 0;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
		font-size: var(--fs-xs);
		line-height: 20px;
	}

	/* the live preview and the opened steps hang off one thin guide line under the 16px icon's centre (8 - 2/2 = 7) */
	.peek,
	.steps {
		margin-left: 7px; /* optical: puts the 2px guide line on the centre of the 16px icon above */
		padding-left: 15px; /* optical: 7 + 2 + 15 = 24, the "now" line's text start (16px icon + 8px gap) */
		border-left: 2px solid var(--border);
	}
	.peek {
		margin-top: 4px;
		cursor: pointer;
		font-size: var(--fs-xs);
		line-height: 18px;
		color: var(--text-dim);
		overflow: hidden;
	}
	/* as tall as its text, up to two lines, newest at the bottom: past that, older text scrolls off the top under a soft fade */
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
		mask-image: linear-gradient(to bottom, transparent 0, #000 12px);
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
	/* the rows carry their own 4px padding: 4 + 4 + 4 = 12 between the summary's text and the first row's */
	.steps {
		margin-top: 4px;
		margin-bottom: 8px;
	}
	.steps > :global(:first-child) {
		margin-top: 0;
	}
	.steps > :global(:last-child) {
		margin-bottom: 0;
	}

	/* a question waiting for the user keeps its warn-tinted frame: the one part of the box that asks for attention */
	.ask {
		margin-top: 8px;
		border: 1px solid var(--warn);
		border-radius: var(--radius);
		overflow: hidden;
	}
	.ask :global(.reply) {
		border-top: 0;
	}

	/* the canvas and the latest live picture sit under the summary line, so the box visibly grows to hold them */
	.canvas {
		padding: 8px 0 0;
	}
	.drawn {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		padding: 8px 0 0;
	}
	.drawn .zoom {
		position: relative;
		display: block;
		overflow: hidden;
		padding: 0;
		border-radius: var(--radius);
		cursor: zoom-in;
		animation: develop var(--motion-slow) var(--ease) both;
	}
	.drawn img {
		display: block;
		max-width: 100%;
		max-height: 320px;
		border-radius: var(--radius);
	}
	/* who drew it: a caption over the picture's lower edge, shown while the pointer is on it (always on touch screens, which cannot hover) */
	.drawn .by {
		position: absolute;
		left: 0;
		right: 0;
		bottom: 0;
		padding: 24px 8px 8px;
		background: linear-gradient(to top, rgb(0 0 0 / 0.62), transparent);
		color: #fff;
		font-size: var(--fs-xs);
		line-height: 1.3;
		text-align: left;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		opacity: 0;
		transform: translateY(4px);
		pointer-events: none;
		transition: opacity var(--motion-fast) var(--ease-std), transform var(--motion-fast) var(--ease-std);
	}
	.drawn .zoom:hover .by,
	.drawn .zoom:focus-visible .by {
		opacity: 1;
		transform: none;
	}
	@media (pointer: coarse) {
		.drawn .by {
			opacity: 1;
			transform: none;
		}
	}
	/* the picture develops: it comes in sharp from a soft, slightly zoomed-in state, like the canvas resolving */
	@keyframes develop {
		from {
			opacity: 0;
			filter: blur(14px);
			transform: scale(1.04);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.drawn .zoom {
			animation: none;
		}
	}

	/* a thought is a line like a call (icon, words), its text under it in the quiet colour instead of in a card */
	.thought {
		min-width: 0;
	}
	.thead {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 4px 0;
		font-size: var(--fs-xs);
		line-height: 20px;
		color: var(--text-dim);
	}
	.thead :global(svg) {
		flex: none;
		width: 16px;
		height: 16px;
		stroke-width: 1.8;
		color: var(--text-faint);
	}
	.tbody {
		padding: 0 0 8px 24px; /* 24: under the words, past the 16px icon and its 8px gap */
		color: var(--text-dim);
		font-size: var(--fs-xs);
		line-height: 20px;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		max-height: 300px;
		overflow: auto;
	}
	/* a call still being written: the same line, three dots in the icon's 16px place */
	.prep {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 4px 0;
		color: var(--text-dim);
		font-size: var(--fs-xs);
		line-height: 20px;
	}
	.prep .dots {
		width: 16px;
		justify-content: center;
	}
</style>
