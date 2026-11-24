<script lang="ts">
	import { t } from "../../lib/i18n";
	import { collapseIn, collapseOut } from "../../lib/motion";
	import Icon from "../ui/Icon.svelte";
	import QuestionReply from "./QuestionReply.svelte";
	import { app } from "../../lib/store.svelte";
	import { getPane } from "../../lib/pane";
	import { clip, duration, fullTime } from "../../lib/format";
	import { baseName, formatFileLine, splitFilePath } from "../../lib/files";
	import { peerTargetsOf, scheduleIdOf, skillOf, splitCd, toolArgStr as str, toolIcon, toolLabel, toolSummary } from "../../lib/tools";
	import type { ToolRun } from "../../lib/types";
	import { extensions } from "../../lib/extensions/host.svelte";
	import ExtensionView from "../extensions/ExtensionView.svelte";
	import type { UINode } from "../../lib/extensions/ui";

	let { id, name, args }: { id: string; name: string; args: Record<string, unknown> } = $props();

	const pane = getPane();
	const run = $derived<ToolRun>(app.chatOf(pane.id)?.tools[id] ?? { state: "pending", output: "" });
	let open = $state(false);

	const summary = $derived(toolSummary(name, args));
	/** A shell summary drops its leading `cd <folder> &&`; hovering it still says the whole line, folder included */
	const fullLine = $derived(name === "bash" && splitCd(str(args.command)).dir ? str(args.command).split("\n", 1)[0] : undefined);

	// An extension may draw the finished call (`sdk.tools.registerRenderer`). Whatever it returns is validated data shown
	// in a read-only view; on any failure the card keeps its usual look.
	const renderer = $derived(extensions.rendererFor(name));
	let custom = $state<UINode | null>(null);
	$effect(() => {
		const r = renderer;
		const done = run.state === "done" || run.state === "error";
		if (!r || !done) { custom = null; return; }
		let live = true;
		r.render({ toolName: name, state: run.state, args, output: run.output, details: run.details ?? null })
			.then((view) => { if (live) custom = view; })
			.catch(() => { if (live) custom = null; });
		return () => { live = false; };
	});
	const noop = () => {};
	const none = async () => {};

	/** A call that waits for the user's answer (any tool/extension using ctx.ask). */
	const awaiting = $derived(run.state === "awaiting_input");
	const answer = $derived(typeof run.details?.answer === "string" ? run.details.answer : "");
	const asked = $derived(!!run.question || !!answer);
	const exitCode = $derived(typeof run.details?.exitCode === "number" ? (run.details.exitCode as number) : null);
	/** A failed call (error, or a non-zero exit code): said in a quiet word by the time ("종료 코드 2", "실패"), never in red here */
	const failed = $derived(run.state === "error" || (run.state === "done" && !!exitCode));
	const label = $derived(
		{
			pending: t("준비 중"),
			awaiting_input: t("답변 필요"),
			running: t("실행 중"),
			done: exitCode ? t("종료 코드 {code}", { code: exitCode }) : t("완료"),
			error: t("실패"),
			skipped: t("실행 안 됨"),
		}[run.state],
	);
	const working = $derived(run.state === "running" || run.state === "pending");

	/** A question tool that is still waiting has nothing else to show: the reply block under the card asks it (no empty body) */
	const questionOnly = $derived(awaiting && asked && name !== "bash" && name !== "write" && name !== "edit");

	// A question opens the card so what is asked is visible.
	$effect(() => {
		if (awaiting) open = true;
	});

	const body = $derived.by(() => {
		if (name === "write") return str(args.content);
		if (name === "edit") return null;
		return str(args.command ?? "");
	});

	/** For `peer` calls, link straight to the session or group it acted on when still open (falls back to old name on rename). */
	const peerResolved = $derived.by(() => {
		if (name !== "peer") return null;
		for (const handle of peerTargetsOf(args, run.output)) {
			const target = app.mentionIndex.resolve(handle);
			if (target) return { handle, target };
		}
		return null;
	});
	const skillName = $derived(skillOf(name, args));
	const fileTarget = $derived.by(() => {
		if (skillName || !pane.id || (name !== "read" && name !== "write" && name !== "edit")) return null;
		const path = str(args.path).trim();
		if (!path) return null;
		const offset = typeof args.offset === "number" && Number.isSafeInteger(args.offset) && args.offset >= 1 ? args.offset : undefined;
		return { path, line: name === "read" ? offset : undefined };
	});
	const delegateRole = $derived(name === "delegate" && pane.id ? str(args.role).trim() || null : null);
	const scheduleId = $derived(name === "schedule" ? scheduleIdOf(args, run.details ?? null) : null);

</script>

<div class="call" data-part="tool" data-fold class:awaiting class:failed data-state={run.state}>
	<!-- One quiet line, built like the work box's own summary line above it: icon, what, how it went, time, arrow -->
	<button class="head" data-fold-toggle onclick={() => (open = !open)} aria-expanded={open}>
		<span class="kind"><Icon name={toolIcon(name, args)} /></span>
		<span class="name mono" class:shimmer={working}>{toolLabel(name, args)}</span>
		{#if summary}<span class="sum mono" title={fullLine}>{summary}</span>{/if}
		<span class="meta">
			{#if working}<span class="dots" role="status" aria-label={label}><i></i><i></i><i></i></span>
			{:else if awaiting}<span class="need">{label}</span>
			{:else if failed || run.state === "skipped"}<span class="note">{label}</span>{/if}
			{#if run.durationMs != null && !working}
				{#if run.endedAt}<time class="dur" datetime={new Date(run.endedAt).toISOString()} title={t("{when} 완료", { when: fullTime(run.endedAt) })}>{duration(run.durationMs)}</time>
				{:else}<span class="dur">{duration(run.durationMs)}</span>{/if}
			{/if}
			<span class="chev" class:open><Icon name="chevron-right" /></span>
		</span>
	</button>

	{#if open && !questionOnly}
		<div class="body" in:collapseIn out:collapseOut>
			{#if peerResolved}
				<div class="jump">
					<button
						type="button"
						class="jump-tok mention"
						title={peerResolved.target.kind === "group" ? t("{name} 그룹 열기", { name: `@${peerResolved.handle}` }) : t("{name} 대화 열기", { name: `@${peerResolved.handle}` })}
						onclick={() => app.openMention(peerResolved.target)}
					><span class="jlabel">@{peerResolved.handle}</span></button>
				</div>
			{:else if skillName}
				<div class="jump">
					<button
						type="button"
						class="jump-tok skill"
						title={t("스킬 {name} 보기", { name: skillName })}
						onclick={() => app.openSkills(pane.id, skillName)}
					><Icon name="skill" /><span class="jlabel">/skill:{skillName}</span></button>
				</div>
			{:else if fileTarget && pane.id}
				{@const fp = splitFilePath(fileTarget.path)}
				{@const suffix = formatFileLine(fileTarget.line)}
				<div class="jump">
					<button
						type="button"
						class="jump-tok file"
						title={t("{name} 미리 보기", { name: `${fileTarget.path}${suffix}` })}
						onclick={() => app.openFile(pane.id!, { path: fileTarget.path, name: baseName(fileTarget.path), ...(fileTarget.line ? { line: fileTarget.line } : {}) })}
					>
						<Icon name="file" />
						{#if fp}
							<span class="jpath"><span class="jdir">{fp.dir}</span><span class="jbase">{fp.base}{suffix}</span></span>
						{:else}
							<span class="jlabel">{fileTarget.path}{suffix}</span>
						{/if}
					</button>
				</div>
			{:else if delegateRole}
				<div class="jump">
					<button
						type="button"
						class="jump-tok file"
						title={t("서브에이전트 역할 보기")}
						onclick={() => app.openSubagents(pane.id)}
					><Icon name="bot" /><span class="jlabel">{delegateRole}</span></button>
				</div>
			{:else if name === "schedule" && pane.id}
				<div class="jump">
					<button
						type="button"
						class="jump-tok file"
						title={t("예약 작업 보기")}
						onclick={() => (scheduleId ? app.openScheduleEdit(scheduleId) : app.openScheduleFor(pane.id!))}
					><Icon name="clock" /><span class="jlabel">{t("예약 작업")}</span></button>
				</div>
			{:else if name === "goal" && pane.id}
				<div class="jump">
					<button
						type="button"
						class="jump-tok file"
						title={t("목표 보기")}
						onclick={() => app.openGoal(pane.id)}
					><Icon name="target" /><span class="jlabel">{t("목표")}</span></button>
				</div>
			{/if}
			{#if name === "edit"}
				<div class="diff mono">
					<div class="del">{str(args.oldText)}</div>
					<div class="add">{str(args.newText)}</div>
				</div>
			{:else if name === "bash"}
				<pre class="mono cmd"><span class="prompt">$</span> {str(args.command)}</pre>
			{:else if name === "write"}
				<pre class="mono">{clip(body ?? "", 6000)}</pre>
			{:else if asked}
				<!-- while it waits, the reply block under the card asks the question itself; show it here only once answered -->
				{#if !awaiting}<div class="q">{run.question?.question ?? str(args.question)}</div>{/if}
				{#if answer}<div class="a"><span class="label">{t("답변")}</span> {answer}</div>{/if}
			{:else if name !== "read" && name !== "ls"}
				<pre class="mono">{JSON.stringify(args, null, 2)}</pre>
			{/if}

			{#if custom}
				<div class="custom"><ExtensionView node={custom} namespace={`tool-${renderer?.owner ?? ""}-${id}`} values={{}} onchange={noop} ondispatch={none} /></div>
			{:else if run.output && !asked}
				<div class="label">{t("출력")}</div>
				{#if run.output}<pre class="mono out">{clip(run.output, 12000)}</pre>{/if}
			{/if}
		</div>
	{/if}

	{#if awaiting && run.question}
		<div class="ask" in:collapseIn out:collapseOut><QuestionReply {id} paneId={pane.id} question={run.question} /></div>
	{/if}
</div>

<style>
	.custom { margin-top: 8px; min-width: 0; }
	/* No card: each call is one line under the work box's guide line, the way the summary line above it is drawn */
	.call {
		min-width: 0;
	}
	.head {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		min-width: 0;
		padding: 4px 0;
		font-size: var(--fs-xs);
		line-height: 20px;
		color: var(--text-dim);
		text-align: left;
		transition: color var(--motion-fast) var(--ease-std);
	}
	@media (hover: hover) {
		.head:hover,
		.head:hover .sum {
			color: var(--text);
		}
		.head:hover .chev {
			color: var(--text-dim);
		}
	}
	/* the row has no fill of its own, so the press tint of row buttons (app.css) would paint a bare block behind the text */
	.head:active:not(:disabled) {
		background-color: transparent;
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
	/* the same 16px glyph and stroke as the summary line's icon, so the two read as one family */
	.kind :global(svg) {
		stroke-width: 1.8;
	}
	/* the tool's name: what kind of work, in the quiet colour */
	/* one column per work box (--name-w, set by WorkBox from its longest name, 4 to 8ch): every summary starts on one line.
	   A longer name only pushes its own row; outside a work box it falls back to bash / read / grep / edit's 4ch. */
	.name {
		flex: none;
		min-width: var(--name-w, 4ch);
		max-width: 40%;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
		color: var(--text-faint);
	}
	/* what it did: the part to read, so it takes the room and is the part that gets cut */
	.sum {
		flex: 1 1 0;
		min-width: 0;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
		color: var(--text-dim);
		transition: color var(--motion-fast) var(--ease-std);
	}
	.meta {
		flex: none;
		display: flex;
		align-items: center;
		gap: 8px;
		margin-left: auto;
	}
	/* an even 16px box like the icons: the 11px text's own 17.05px height is odd */
	/* right-aligned in a 5-digit box ("940ms", "12.8s"), so the word before it ("종료 코드 2", "실패") ends on one line too */
	.dur {
		min-width: 5ch;
		text-align: right;
		font-size: var(--fs-2xs);
		line-height: 16px;
		font-variant-numeric: tabular-nums; /* 940ms over 212ms: every digit as wide, so the times line up row to row */
		color: var(--text-faint);
	}
	/* how it ended when that is not plain success: a short word in the time's size. A failure says it in red ("종료 코드 2",
	   "실패", like the folded box's "N개 실패"); the rest of the row keeps its colours, so the list stays calm */
	.note {
		flex: none;
		font-size: var(--fs-2xs);
		line-height: 16px;
		color: var(--text-faint);
	}
	.failed .note {
		color: var(--danger);
	}
	.need {
		font-size: var(--fs-xs);
		line-height: 16px;
		color: var(--warn);
	}
	.dots {
		color: var(--text-faint);
	}
	.awaiting .kind,
	.awaiting .name {
		color: var(--warn);
	}
	.chev {
		transition: transform var(--motion-fast) var(--ease), color var(--motion-fast) var(--ease-std);
	}
	.chev.open {
		transform: rotate(90deg);
	}
	/* the question a waiting call asks: the one framed block, in the warn colour */
	.ask {
		margin: 4px 0 8px 24px; /* 24: under the name, past the 16px icon and its 8px gap */
		border: 1px solid var(--warn);
		border-radius: var(--radius);
		overflow: hidden;
	}
	.ask :global(.reply) {
		border-top: 0;
	}
	/* what the call carried and gave back, under its name (16px icon + 8px gap = 24 in), 8 below its line */
	.body {
		padding: 4px 0 8px 24px;
	}
	.jump {
		display: flex;
		margin-bottom: 8px;
	}
	.jump-tok {
		--hue: var(--mark-mention);
		display: inline-flex;
		align-items: center;
		gap: 4px;
		max-width: 100%;
		padding: 1px 8px;
		border-radius: var(--radius-xs);
		background: color-mix(in srgb, var(--hue) 12%, transparent);
		box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--hue) 22%, transparent);
		color: inherit;
		font-size: var(--fs-xs);
		font-weight: 600;
		line-height: 18px; /* whole-pixel 20px chip (18 + 2 padding), matching TokenText */
		transition: background var(--motion-fast) var(--ease-std);
	}
	.jump-tok.mention {
		color: var(--hue);
	}
	.jump-tok.skill {
		--hue: var(--accent);
	}
	.jump-tok.file {
		--hue: var(--mark-file);
		font-weight: 500;
	}
	.jump-tok :global(svg) {
		flex: none;
		width: 12px;
		height: 12px;
		opacity: 0.7;
	}
	.jlabel {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.jpath {
		display: inline-flex;
		min-width: 0;
	}
	.jdir {
		flex: 0 999999 auto;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		opacity: 0.68;
	}
	.jbase {
		flex: 0 1 auto;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	@media (hover: hover) {
		.jump-tok:hover {
			background: color-mix(in srgb, var(--hue) 22%, transparent);
		}
	}
	.label {
		margin: 8px 0 4px;
	}
	/* read / ls show only the output: its label opens the body, so no extra gap above it */
	.label:first-child {
		margin-top: 0;
	}
	.label {
		font-family: var(--mono);
		font-size: var(--fs-2xs);
		letter-spacing: 0.04em;
		text-transform: lowercase;
		color: var(--text-faint);
		font-weight: 500;
	}
	pre {
		margin: 0;
		padding: 8px 12px;
		max-height: 320px;
		overflow-x: hidden;
		overflow-y: auto;
		border-radius: var(--radius-sm);
		background: var(--bg-code);
		font-size: var(--fs-xs);
		line-height: 1.5;
		white-space: pre-wrap;
		word-break: break-all;
	}
	.cmd .prompt {
		color: var(--text-faint);
		user-select: none;
	}
	.diff {
		border-radius: var(--radius-sm);
		overflow: hidden;
		font-size: var(--fs-xs);
	}
	.diff div {
		padding: 8px 12px;
		white-space: pre-wrap;
		word-break: break-all;
		max-height: 200px;
		overflow-x: hidden;
		overflow-y: auto;
	}
	.del {
		background: var(--danger-soft);
		color: var(--danger);
	}
	.add {
		background: var(--ok-soft);
		color: var(--ok);
	}
	.q {
		font-size: var(--fs-sm);
		line-height: 1.5;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	.a {
		margin-top: 8px;
		font-size: var(--fs-sm);
		color: var(--text-dim);
	}
</style>
