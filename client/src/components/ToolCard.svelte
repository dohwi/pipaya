<script lang="ts">
	import { t } from "../lib/i18n";
	import { collapseIn, collapseOut } from "../lib/motion";
	import Icon from "./Icon.svelte";
	import QuestionReply from "./QuestionReply.svelte";
	import { app } from "../lib/store.svelte";
	import { getPane } from "../lib/pane";
	import { clip, duration } from "../lib/format";
	import { badgeStyle, toolIcon, toolKind, toolLabel, toolSummary } from "../lib/tools";
	import type { ToolRun } from "../lib/types";
	import { extensions } from "../lib/extensions/host.svelte";
	import ExtensionView from "./extensions/ExtensionView.svelte";
	import type { UINode } from "../lib/extensions/ui";

	let { id, name, args }: { id: string; name: string; args: Record<string, unknown> } = $props();

	const pane = getPane();
	const run = $derived<ToolRun>(app.chatOf(pane.id)?.tools[id] ?? { state: "pending", output: "" });
	let open = $state(false);
	/** The kind of work (read, bash, edit …) tints the icon and the name, so a list of calls reads at a glance */
	const kind = $derived(toolKind(name, args));

	const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : JSON.stringify(v));
	const summary = $derived(toolSummary(name, args));

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
	/** A call that simply succeeded shows no "완료" pill: the tinted icon and name carry it; only what needs attention gets a pill */
	const quiet = $derived(run.state === "done" && !exitCode);
	/** A failed call (error, or a non-zero exit code): red outline and red icon, texts and arrow instead of a pill */
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
	const tone = $derived(
		run.state === "done" && !exitCode ? "ok" : run.state === "awaiting_input" ? "warn" : run.state === "running" || run.state === "pending" ? "accent" : run.state === "skipped" ? "" : "danger",
	);

	// A question opens the card so what is asked is visible.
	$effect(() => {
		if (awaiting) open = true;
	});

	const body = $derived.by(() => {
		if (name === "write") return str(args.content);
		if (name === "edit") return null;
		return str(args.command ?? "");
	});

</script>

<div class="card" data-part="tool" class:awaiting class:failed data-state={run.state} style={badgeStyle(kind)}>
	<button class="head" onclick={() => (open = !open)} aria-expanded={open}>
		<span class="ico"><Icon name={toolIcon(name, args)} /></span>
		<span class="what"><span class="name">{toolLabel(name, args)}</span>{#if summary}<span class="sum mono">{summary}</span>{/if}</span>
		<span class="meta">
			{#if run.state === "running" || run.state === "pending"}<span class="spinner"></span>{/if}
			{#if !quiet && !failed}<span class="chip {tone}">{label}</span>{/if}
			{#if run.durationMs != null && run.state !== "running"}<span class="dur">{duration(run.durationMs)}</span>{/if}
			<span class="chev" class:open><Icon name="chevron-right" /></span>
		</span>
	</button>

	{#if open}
		<div class="body" in:collapseIn out:collapseOut>
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
				<div class="q">{run.question?.question ?? str(args.question)}</div>
				{#if answer}<div class="a"><span class="label">{t("답변")}</span> {answer}</div>{/if}
			{:else if name !== "read" && name !== "ls"}
				<pre class="mono">{JSON.stringify(args, null, 2)}</pre>
			{/if}

			{#if custom}
				<div class="custom"><ExtensionView node={custom} namespace={`tool-${renderer?.owner ?? ""}-${id}`} values={{}} onchange={noop} ondispatch={none} /></div>
			{:else if (run.output || run.images?.length) && !asked}
				<div class="label">{t("출력")}{#if failed && exitCode}<span class="why">{label}</span>{/if}</div>
				{#if run.output}<pre class="mono out" class:err={run.state === "error"}>{clip(run.output, 12000)}</pre>{/if}
				{#if run.images?.length}
					<div class="pics">
						{#each run.images as img, i}
							<button class="zoom" onclick={() => app.openImage((run.images ?? []).map((m) => ({ src: `data:${m.mimeType};base64,${m.data}`, mimeType: m.mimeType })), i)} aria-label={t("이미지 크게 보기")}>
								<img src={`data:${img.mimeType};base64,${img.data}`} alt={t("이미지")} />
							</button>
						{/each}
					</div>
				{/if}
			{/if}
		</div>
	{/if}

	{#if awaiting && run.question}
		<div in:collapseIn out:collapseOut><QuestionReply {id} paneId={pane.id} question={run.question} /></div>
	{/if}
</div>

<style>
	.custom { margin-top: 8px; min-width: 0; }
	.card {
		margin: 8px 0;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--bg-elev);
		overflow: hidden;
		transition: border-color var(--motion-fast) var(--ease-std);
	}
	.card.failed {
		border-color: color-mix(in srgb, var(--danger) 60%, var(--border));
	}
	/* everything in a failed header turns red: the icon, the name, what it was doing, the time and the arrow */
	.card.failed,
	:global(:root[data-theme="light"]) .card.failed {
		--tc: var(--danger); /* the light theme sets its own --tc above, with the same weight as the plain rule, so it needs naming too */
	}
	.card.failed .sum,
	.card.failed .dur,
	.card.failed .chev {
		color: color-mix(in srgb, var(--danger) 75%, var(--text-dim));
	}
	.card.awaiting {
		border-color: var(--warn);
		box-shadow: 0 0 0 3px var(--warn-soft);
	}
	.head {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		padding: 8px 12px;
		text-align: left;
		min-height: 44px;
	}
	/* the card clips (overflow: hidden) and the header fills it, so an outer ring would be cut away entirely */
	.head:focus-visible {
		outline-offset: -2px;
		border-radius: var(--radius);
	}
	/* same hue as the badges in the work box (--th from badgeStyle), brighter on dark and deeper on light */
	.card {
		--tc: oklch(0.8 0.12 var(--th, 265));
	}
	:global(:root[data-theme="light"]) .card {
		--tc: oklch(0.5 0.15 var(--th, 265));
	}
	.ico {
		display: grid;
		color: var(--tc);
	}
	.ico :global(svg) {
		width: 16px;
		height: 16px;
		stroke-width: 1.8;
	}
	/* name and summary share one baseline: the 13px name and the 12px summary have different ascents, so centring them
	   separately left the summary 1px high. Both lines are 20px, the pair is centred on the row like the icon and the meta. */
	.what {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: baseline;
		gap: 8px;
		height: 20px; /* the same line box with or without a summary (a skill has none), so the name never moves between cards */
	}
	.name {
		flex: none;
		max-width: 60%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-weight: 600;
		font-size: var(--fs-sm);
		line-height: 20px;
		color: var(--tc);
	}
	.sum {
		flex: 1;
		min-width: 0;
		font-size: var(--fs-xs);
		line-height: 20px;
		color: var(--text-dim);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.meta {
		display: flex;
		align-items: center;
		gap: 8px;
		color: var(--text-dim);
	}
	/* an even 16px box: the 11px text's own 17.05px height was odd, so the row's centring rounded it half a pixel up or down from row to row */
	.dur {
		font-size: var(--fs-2xs);
		line-height: 16px;
		color: var(--text-faint);
	}
	.chev {
		display: grid;
		width: 16px;
		height: 16px;
		place-items: center;
		color: var(--text-faint);
		transition: transform var(--motion-fast) var(--ease);
	}
	.chev.open {
		transform: rotate(90deg);
	}
	.chev :global(svg) {
		width: 16px; /* the same 16px box as the tool icon on the left, so both ends of the row are built alike */
		height: 16px;
		stroke-width: 2;
	}
	.body {
		padding: 0 12px 12px;
	}
	/* why it failed, next to "출력", in the failure colour (the pill that used to say it is gone) */
	.label .why {
		margin-left: 8px;
		color: var(--danger);
	}
	.label {
		margin: 8px 0 4px;
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
		overflow: auto;
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
	.pics { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
	.pics .zoom { display: block; padding: 0; border-radius: var(--radius); cursor: zoom-in; }
	.pics img { max-width: 100%; max-height: 220px; border-radius: var(--radius); display: block; }
	.out.err {
		color: var(--danger);
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
		overflow: auto;
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
