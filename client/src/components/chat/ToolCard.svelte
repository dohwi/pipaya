<script lang="ts">
	import { t } from "../../lib/i18n";
	import { collapseIn, collapseOut } from "../../lib/motion";
	import Icon from "../ui/Icon.svelte";
	import Markdown from "./Markdown.svelte";
	import QuestionReply from "./QuestionReply.svelte";
	import { app } from "../../lib/store.svelte";
	import { hideMentionHover, scheduleMentionHoverHide, showMentionHover } from "../../lib/mention-hover.svelte";
	import { openMentionMenu } from "../../lib/mention-menu";
	import { getPane } from "../../lib/pane";
	import { clip, duration, fullTime } from "../../lib/format";
	import { modelRefName } from "../../lib/model-name";
	import { baseName, formatFileLine, splitFilePath } from "../../lib/files";
	import { highlightCode, highlightLines, languageFromPath, onHighlightReady } from "../../lib/code-highlight";
	import { computeLineDiff, lineCount } from "../../lib/line-diff";
	import { formatKvArgs, parseGrepOutput, parseLsOutput, parseReadOutput, tryPrettyJson } from "../../lib/tool-view";
	import { peerTargetsOf, scheduleIdOf, skillOf, splitCd, toolArgStr as str, toolIcon, toolLabel, toolSummary } from "../../lib/tools";
	import type { ToolRun } from "../../lib/types";
	import { extensions } from "../../lib/extensions/host.svelte";
	import ExtensionView from "../extensions/ExtensionView.svelte";
	import type { UINode } from "../../lib/extensions/ui";

	let { id, name, args }: { id: string; name: string; args: Record<string, unknown> } = $props();

	const pane = getPane();
	const run = $derived<ToolRun>((pane.chat ?? app.chatOf(pane.id))?.tools[id] ?? { state: "pending", output: "" });
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

	const editItems = $derived.by(() => {
		if (name !== "edit") return [];
		if (Array.isArray(args.edits)) {
			return args.edits
				.filter((e): e is Record<string, unknown> => !!e && typeof e === "object")
				.map((e) => ({ oldText: str(e.oldText), newText: str(e.newText) }));
		}
		return [{ oldText: str(args.oldText), newText: str(args.newText) }];
	});

	const paneServer = $derived(pane.server ?? app.serverId);
	/** Only sessions on the currently open server can open local file/skill/schedule/goal/subagent dialogs. */
	const localPaneId = $derived(!paneServer || paneServer === app.serverId ? pane.id : null);
	const mentionIdx = $derived(app.mentionIndexOf(paneServer));
	/** For `peer` calls, link straight to the session or group it acted on (including closed ones). */
	const peerResolved = $derived.by(() => {
		if (name !== "peer") return null;
		for (const handle of peerTargetsOf(args, run.output)) {
			const target = mentionIdx.resolve(handle);
			if (target) {
				const scoped =
					target.kind === "session" && !target.server && paneServer && paneServer !== app.serverId
						? { ...target, server: paneServer }
						: target;
				return { handle, target: scoped };
			}
		}
		return null;
	});
	const peerIsSelf = $derived(
		!!peerResolved &&
			peerResolved.target.kind === "session" &&
			!!pane.id &&
			peerResolved.target.id === pane.id &&
			(!peerResolved.target.server || !paneServer || peerResolved.target.server === paneServer),
	);
	const peerActivity = $derived(peerResolved && !peerIsSelf ? app.mentionActivity(peerResolved.target) : "idle");
	const skillName = $derived(localPaneId ? skillOf(name, args) : null);
	const fileTarget = $derived.by(() => {
		if (skillName || !localPaneId || (name !== "read" && name !== "write" && name !== "edit")) return null;
		const path = str(args.path).trim();
		if (!path) return null;
		const offset = typeof args.offset === "number" && Number.isSafeInteger(args.offset) && args.offset >= 1 ? args.offset : undefined;
		return { path, line: name === "read" ? offset : undefined };
	});
	const delegateRole = $derived(name === "delegate" && localPaneId ? str(args.role).trim() || null : null);
	const scheduleId = $derived(name === "schedule" && localPaneId ? scheduleIdOf(args, run.details ?? null) : null);

	/** Re-render highlighted lines once lazy highlight.js grammars finish loading. */
	let hlTick = $state(0);
	$effect(() => onHighlightReady(() => { hlTick++; }));

	const fileLang = $derived(languageFromPath(str(args.path)));
	const editDiffs = $derived(
		name === "edit" ? editItems.map((item) => ({ item, diff: computeLineDiff(item.oldText, item.newText) })) : [],
	);
	const editTotals = $derived.by(() => {
		let added = 0;
		let removed = 0;
		for (const e of editDiffs) {
			added += e.diff.added;
			removed += e.diff.removed;
		}
		return { added, removed };
	});
	const editHls = $derived.by(() => {
		void hlTick;
		if (!open || name !== "edit") return [];
		return editItems.map((item) => ({
			oldHl: highlightLines(item.oldText, fileLang),
			newHl: highlightLines(item.newText, fileLang),
		}));
	});

	const writeText = $derived(name === "write" ? clip(body ?? "", 6000) : "");
	const writeLinesCount = $derived(name === "write" ? lineCount(body ?? "") : 0);
	const writeLines = $derived(open && name === "write" && writeText ? writeText.replace(/\r\n?/g, "\n").split("\n") : []);
	const writeHl = $derived.by(() => {
		void hlTick;
		return open && name === "write" && writeText ? highlightLines(writeText, fileLang) : null;
	});

	const isImageRead = $derived(name === "read" && !!run.details?.image);
	const readFrom = $derived(
		typeof run.details?.from === "number"
			? (run.details.from as number)
			: typeof args.offset === "number" && Number.isSafeInteger(args.offset) && args.offset >= 1
				? (args.offset as number)
				: 1,
	);
	const readTo = $derived(typeof run.details?.to === "number" ? (run.details.to as number) : null);
	const readTotal = $derived(typeof run.details?.totalLines === "number" ? (run.details.totalLines as number) : null);
	const readRangeLabel = $derived.by(() => {
		if (name !== "read" || skillName || isImageRead) return "";
		if (readTo != null) return readFrom === readTo ? `L${readFrom}` : `L${readFrom}–${readTo}`;
		if (typeof args.offset === "number" && args.offset >= 1) {
			return typeof args.limit === "number" && args.limit >= 1 ? `L${args.offset}–${args.offset + args.limit - 1}` : `L${args.offset}+`;
		}
		return "";
	});
	const readParsed = $derived.by(() => {
		if (name !== "read" || isImageRead || failed || !run.output) return null;
		const parsed = parseReadOutput(run.output, readFrom);
		if (!parsed) return null;
		if (parsed.code.length <= 12000) return parsed;
		const clipped = clip(parsed.code, 12000);
		const clippedLines = clipped.split("\n");
		return {
			code: clipped,
			lines: clippedLines.map((text, i) => ({ lineNo: parsed.lines[i]?.lineNo ?? readFrom + i, text })),
			moreNote: parsed.moreNote,
		};
	});
	const readHl = $derived.by(() => {
		void hlTick;
		return open && readParsed ? highlightLines(readParsed.code, fileLang) : null;
	});
	const readCodeView = $derived(!!readParsed && !custom);

	const bashCmdHl = $derived.by(() => {
		void hlTick;
		if (!open || name !== "bash") return null;
		const res = highlightCode(str(args.command), "bash");
		return res && res !== "wait" ? res : null;
	});

	const grepMatches = $derived(name === "grep" && typeof run.details?.matches === "number" ? (run.details.matches as number) : null);
	const grepParsed = $derived(open && name === "grep" && !failed && !custom && run.output ? parseGrepOutput(run.output) : null);
	const grepView = $derived(!!grepParsed);

	const lsCount = $derived(name === "ls" && typeof run.details?.count === "number" ? (run.details.count as number) : null);
	const lsParsed = $derived(open && name === "ls" && !failed && !custom && run.output ? parseLsOutput(run.output, str(args.path)) : null);
	const lsView = $derived(!!lsParsed);

	const delegateTurns = $derived(name === "delegate" && typeof run.details?.turns === "number" ? (run.details.turns as number) : null);
	const delegateModel = $derived(name === "delegate" && typeof run.details?.model === "string" ? modelRefName(app.models, run.details.model as string) : "");
	const delegateTask = $derived(name === "delegate" ? str(args.task).trim() : "");
	const delegateView = $derived(name === "delegate" && !asked && !custom);

	const genericView = $derived(!asked && !custom && name !== "edit" && name !== "write" && name !== "read" && name !== "bash" && !grepView && !lsView && !delegateView);
	const kvRows = $derived(open && genericView ? formatKvArgs(args) : []);
	const genericPrettyJson = $derived(open && genericView && run.output ? tryPrettyJson(run.output) : null);
	const genericJsonHl = $derived.by(() => {
		void hlTick;
		if (!genericPrettyJson) return null;
		const res = highlightCode(genericPrettyJson, "json");
		return res && res !== "wait" ? res : null;
	});

	/** Tools with their own unified frame fold output inside it unless a custom renderer or an error needs raw output. */
	const showStandaloneOutput = $derived.by(() => {
		if (!run.output || asked || custom) return false;
		if (name === "bash" || readCodeView || grepView || lsView || delegateView || genericView) return false;
		if ((name === "edit" || name === "write") && !failed) return false;
		return true;
	});

	const usesCodeFrame = $derived(name === "edit" || name === "write" || readCodeView);
</script>

<div class="call" data-part="tool" data-fold class:awaiting class:failed data-state={run.state}>
	<!-- One quiet line, built like the work box's own summary line above it: icon, what, how it went, time, arrow -->
	<button class="head" data-fold-toggle onclick={() => (open = !open)} aria-expanded={open}>
		<span class="kind"><Icon name={toolIcon(name, args)} /></span>
		<span class="name mono" class:shimmer={working}>{toolLabel(name, args)}</span>
		{#if summary}<span class="sum mono" title={fullLine}>{summary}</span>{/if}
		<span class="meta">
			{#if editDiffs.length > 0 && (editTotals.added || editTotals.removed)}
				<span class="stat mono" aria-label={`+${editTotals.added} -${editTotals.removed}`}>
					{#if editTotals.added}<span class="stat-add">+{editTotals.added}</span>{/if}
					{#if editTotals.removed}<span class="stat-del">-{editTotals.removed}</span>{/if}
				</span>
			{:else if name === "write" && writeLinesCount > 0}
				<span class="stat mono"><span class="stat-add">+{writeLinesCount}</span></span>
			{:else if readRangeLabel}
				<span class="stat mono stat-range">{readRangeLabel}</span>
			{:else if grepMatches != null}
				<span class="stat mono stat-range">{t("{n}건", { n: grepMatches })}</span>
			{:else if lsCount != null}
				<span class="stat mono stat-range">{t("{n}개", { n: lsCount })}</span>
			{:else if delegateTurns != null}
				<span class="stat mono stat-range">{t("{n}턴", { n: delegateTurns })}</span>
			{/if}
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
			{#if skillName}
				<div class="jump">
					<button
						type="button"
						class="jump-tok skill"
						title={t("스킬 {name} 보기", { name: skillName })}
						onclick={() => app.openSkills(pane.id, skillName)}
					><Icon name="skill" /><span class="jlabel">/skill:{skillName}</span></button>
				</div>
			{:else if fileTarget && pane.id && !usesCodeFrame}
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
			{:else if peerResolved && !genericView}
				<div class="jump">
					{#if peerIsSelf}
						<span class="jump-tok mention self" title={t("현재 대화")}><span class="jlabel">@{peerResolved.handle}</span></span>
					{:else}
						<button
							type="button"
							class="jump-tok mention"
							class:closed={peerResolved.target.kind === "session" && peerResolved.target.closed}
							title={peerResolved.target.kind === "group" ? t("{name} 그룹 열기", { name: `@${peerResolved.handle}` }) : peerResolved.target.closed ? t("{name} 닫힌 대화 보기", { name: `@${peerResolved.handle}` }) : t("{name} 대화 미리 보기", { name: `@${peerResolved.handle}` })}
							onclick={(e) => { hideMentionHover(); app.openMention(peerResolved.target, { direct: e.ctrlKey || e.metaKey }); }}
							oncontextmenu={(e) => openMentionMenu(e, peerResolved.target, { label: `@${peerResolved.handle}`, currentSessionId: pane.id })}
							onpointerenter={(e) => { if (e.pointerType === "mouse") showMentionHover(e.currentTarget, peerResolved.target, `@${peerResolved.handle}`); }}
							onpointerleave={(e) => { if (e.pointerType === "mouse") scheduleMentionHoverHide(); }}
						>{#if peerActivity !== "idle"}<span class="mdot" data-activity={peerActivity}></span>{/if}<span class="jlabel">@{peerResolved.handle}</span></button>
					{/if}
				</div>
			{:else if delegateRole && !delegateView}
				<div class="jump">
					<button
						type="button"
						class="jump-tok file"
						title={t("서브에이전트 역할 보기")}
						onclick={() => app.openSubagents(pane.id)}
					><Icon name="bot" /><span class="jlabel">{delegateRole}</span></button>
				</div>
			{:else if name === "schedule" && localPaneId && !genericView}
				<div class="jump">
					<button
						type="button"
						class="jump-tok file"
						title={t("예약 작업 보기")}
						onclick={() => (scheduleId ? app.openScheduleEdit(scheduleId) : app.openScheduleFor(localPaneId!))}
					><Icon name="clock" /><span class="jlabel">{t("예약 작업")}</span></button>
				</div>
			{:else if name === "goal" && localPaneId && !genericView}
				<div class="jump">
					<button
						type="button"
						class="jump-tok file"
						title={t("목표 보기")}
						onclick={() => app.openGoal(localPaneId)}
					><Icon name="target" /><span class="jlabel">{t("목표")}</span></button>
				</div>
			{/if}
			{#if name === "edit" && editDiffs.length > 0}
				<div class="codeframe">
					{@render fileHeader(editTotals.added, editTotals.removed, "")}
					<div class="codescroll mono">
						{#each editDiffs as entry, ei (ei)}
							{#if ei > 0}
								<div class="diff-skip">⋯</div>
							{/if}
							{#each entry.diff.rows as r, i (`${ei}-${i}`)}
								{#if r.kind === "skip"}
									<div class="diff-skip">⋯ {r.count}</div>
								{:else}
									{@const hl = r.kind === "del" ? editHls[ei]?.oldHl?.[r.oldLine - 1] : editHls[ei]?.newHl?.[r.newLine - 1]}
									<div class="cline diff-{r.kind}">
										<span class="lno">{r.oldLine ?? ""}</span>
										<span class="lno">{r.newLine ?? ""}</span>
										<span class="sig" aria-hidden="true">{r.kind === "del" ? "−" : r.kind === "add" ? "+" : " "}</span>
										<span class="code">{#if hl != null}{@html hl}{:else}{r.text || " "}{/if}</span>
									</div>
								{/if}
							{/each}
						{/each}
					</div>
				</div>
			{:else if name === "write"}
				<div class="codeframe">
					{@render fileHeader(writeLinesCount, 0, "")}
					<div class="codescroll mono">
						{#each writeLines as line, i (i)}
							{@const hl = writeHl?.[i]}
							<div class="cline diff-add">
								<span class="lno">{i + 1}</span>
								<span class="sig" aria-hidden="true">+</span>
								<span class="code">{#if hl != null}{@html hl}{:else}{line || " "}{/if}</span>
							</div>
						{/each}
					</div>
				</div>
			{:else if readCodeView && readParsed}
				<div class="codeframe">
					{@render fileHeader(0, 0, readRangeLabel && readTotal ? `${readRangeLabel} / ${readTotal}` : readRangeLabel || (readTotal ? `${readTotal}` : ""))}
					<div class="codescroll mono">
						{#each readParsed.lines as line, i (i)}
							{@const hl = readHl?.[i]}
							<div class="cline">
								<span class="lno">{line.lineNo}</span>
								<span class="code">{#if hl != null}{@html hl}{:else}{line.text || " "}{/if}</span>
							</div>
						{/each}
					</div>
					{#if readParsed.moreNote}
						<div class="codefoot mono">{readParsed.moreNote}</div>
					{/if}
				</div>
			{:else if name === "bash"}
				<div class="codeframe term">
					<pre class="mono cmd"><span class="prompt">$</span> {#if bashCmdHl != null}{@html bashCmdHl}{:else}{str(args.command)}{/if}</pre>
					{#if run.output && !custom}
						<pre class="mono term-out">{clip(run.output, 12000)}</pre>
					{/if}
				</div>
			{:else if grepView && grepParsed}
				<div class="codeframe">
					<div class="codebar">
						<span class="codebar-title mono">
							<Icon name="search" />
							<span class="jlabel">{str(args.pattern)}</span>
							{#if args.path}<span class="codebar-sub">in {str(args.path)}</span>{/if}
							{#if args.glob}<span class="codebar-sub">({str(args.glob)})</span>{/if}
						</span>
						<span class="codebar-meta mono">
							<span class="stat-range">{grepMatches != null ? t("{n}건", { n: grepMatches }) : grepParsed.empty ? t("일치 없음") : ""}</span>
						</span>
					</div>
					{#if grepParsed.empty}
						<div class="codeempty">{t("일치 없음")}</div>
					{:else}
						<div class="grep-scroll mono">
							{#each grepParsed.groups as g, gi (gi)}
								{#if g.path}
									<div class="grep-file">
										{#if localPaneId}
											{@const fp = splitFilePath(g.path)}
											<button
												type="button"
												class="grep-path"
												title={t("{name} 미리 보기", { name: g.path })}
												onclick={() => app.openFile(localPaneId!, { path: g.path, name: baseName(g.path) })}
											>
												<Icon name="file" />
												{#if fp}
													<span class="jpath"><span class="jdir">{fp.dir}</span><span class="jbase">{fp.base}</span></span>
												{:else}
													<span class="jlabel">{g.path}</span>
												{/if}
											</button>
										{:else}
											<span class="grep-path"><Icon name="file" /><span class="jlabel">{g.path}</span></span>
										{/if}
									</div>
								{/if}
								{#each g.hits as hit, hi (hi)}
									{#if g.path && localPaneId && hit.line != null}
										<button
											type="button"
											class="grep-hit"
											onclick={() => app.openFile(localPaneId!, { path: g.path, name: baseName(g.path), line: hit.line! })}
										>
											<span class="lno">{hit.line}</span>
											<span class="hit-text">{hit.text || " "}</span>
										</button>
									{:else}
										<div class="grep-hit">
											{#if hit.line != null}<span class="lno">{hit.line}</span>{/if}
											<span class="hit-text">{hit.text || " "}</span>
										</div>
									{/if}
								{/each}
							{/each}
						</div>
						{#if grepParsed.moreNote}
							<div class="codefoot mono">{grepParsed.moreNote}</div>
						{/if}
					{/if}
				</div>
			{:else if lsView && lsParsed}
				<div class="codeframe">
					<div class="codebar">
						<span class="codebar-title mono">
							<Icon name="folder" />
							<span class="jlabel">{str(args.path) || "."}</span>
						</span>
						{#if lsCount != null}
							<span class="codebar-meta mono"><span class="stat-range">{t("{n}개", { n: lsCount })}</span></span>
						{/if}
					</div>
					{#if lsParsed.empty}
						<div class="codeempty">{t("비어 있음")}</div>
					{:else}
						<div class="ls-grid mono">
							{#each lsParsed.entries as e, i (i)}
								{#if e.isDir || !pane.id}
									<span class="ls-entry" class:dir={e.isDir}>
										<Icon name={e.isDir ? "folder" : "file"} />
										<span class="jlabel">{e.name}{e.isDir ? "/" : ""}</span>
									</span>
								{:else if localPaneId}
									<button
										type="button"
										class="ls-entry"
										title={t("{name} 미리 보기", { name: e.fullPath })}
										onclick={() => app.openFile(localPaneId!, { path: e.fullPath, name: e.name })}
									>
										<Icon name="file" />
										<span class="jlabel">{e.name}</span>
									</button>
								{:else}
									<span class="ls-entry"><Icon name="file" /><span class="jlabel">{e.name}</span></span>
								{/if}
							{/each}
						</div>
						{#if lsParsed.moreNote}
							<div class="codefoot mono">{lsParsed.moreNote}</div>
						{/if}
					{/if}
				</div>
			{:else if delegateView}
				<div class="codeframe">
					<div class="codebar">
						{#if delegateRole && pane.id}
							<button type="button" class="codebar-file mono" title={t("서브에이전트 역할 보기")} onclick={() => app.openSubagents(pane.id)}>
								<Icon name="bot" />
								<span class="jlabel">{delegateRole}</span>
							</button>
						{:else}
							<span class="codebar-title mono"><Icon name="bot" /><span class="jlabel">{str(args.role) || "subagent"}</span></span>
						{/if}
						{#if delegateModel || delegateTurns != null}
							<span class="codebar-meta mono">
								{#if delegateModel}<span class="stat-range">{delegateModel}</span>{/if}
								{#if delegateTurns != null}<span class="stat-range">{t("{n}턴", { n: delegateTurns })}</span>{/if}
							</span>
						{/if}
					</div>
					{#if delegateTask}
						<div class="sub-task">{delegateTask}</div>
					{/if}
					{#if run.output.trim()}
						<div class="sub-out"><Markdown text={run.output.trim()} /></div>
					{/if}
				</div>
			{:else if asked}
				<!-- while it waits, the reply block under the card asks the question itself; show it here only once answered -->
				{#if !awaiting}<div class="q">{run.question?.question ?? str(args.question)}</div>{/if}
				{#if answer}<div class="a"><span class="label">{t("답변")}</span> {answer}</div>{/if}
			{:else if genericView && (kvRows.length || run.output)}
				<div class="codeframe">
					{#if peerResolved}
						<div class="codebar">
							{#if peerIsSelf}
								<span class="codebar-file mention self mono" title={t("현재 대화")}><Icon name="chat" /><span class="jlabel">@{peerResolved.handle}</span></span>
							{:else}
								<button
									type="button"
									class="codebar-file mention mono"
									class:closed={peerResolved.target.kind === "session" && peerResolved.target.closed}
									title={peerResolved.target.kind === "group" ? t("{name} 그룹 열기", { name: `@${peerResolved.handle}` }) : peerResolved.target.closed ? t("{name} 닫힌 대화 보기", { name: `@${peerResolved.handle}` }) : t("{name} 대화 미리 보기", { name: `@${peerResolved.handle}` })}
									onclick={(e) => { hideMentionHover(); app.openMention(peerResolved.target, { direct: e.ctrlKey || e.metaKey }); }}
									oncontextmenu={(e) => openMentionMenu(e, peerResolved.target, { label: `@${peerResolved.handle}`, currentSessionId: pane.id })}
									onpointerenter={(e) => { if (e.pointerType === "mouse") showMentionHover(e.currentTarget, peerResolved.target, `@${peerResolved.handle}`); }}
									onpointerleave={(e) => { if (e.pointerType === "mouse") scheduleMentionHoverHide(); }}
								>{#if peerActivity !== "idle"}<span class="mdot" data-activity={peerActivity}></span>{:else}<Icon name="chat" />{/if}<span class="jlabel">@{peerResolved.handle}</span></button>
							{/if}
						</div>
					{:else if name === "schedule" && localPaneId}
						<div class="codebar">
							<button
								type="button"
								class="codebar-file mono"
								title={t("예약 작업 보기")}
								onclick={() => (scheduleId ? app.openScheduleEdit(scheduleId) : app.openScheduleFor(localPaneId!))}
							><Icon name="clock" /><span class="jlabel">{t("예약 작업")}</span></button>
						</div>
					{:else if name === "goal" && localPaneId}
						<div class="codebar">
							<button
								type="button"
								class="codebar-file mono"
								title={t("목표 보기")}
								onclick={() => app.openGoal(localPaneId)}
							><Icon name="target" /><span class="jlabel">{t("목표")}</span></button>
						</div>
					{/if}
					{#if kvRows.length}
						<div class="kv-list mono">
							{#each kvRows as row, i (i)}
								<div class="kv-row" class:multi={row.multiline}>
									<span class="kv-key">{row.key}</span>
									{#if row.multiline}
										<pre class="kv-pre">{clip(row.value, 6000)}</pre>
									{:else}
										<span class="kv-val">{row.value}</span>
									{/if}
								</div>
							{/each}
						</div>
					{/if}
					{#if run.output}
						{#if genericPrettyJson}
							<pre class="mono frame-out">{#if genericJsonHl != null}{@html genericJsonHl}{:else}{clip(genericPrettyJson, 12000)}{/if}</pre>
						{:else}
							<pre class="mono frame-out">{clip(run.output, 12000)}</pre>
						{/if}
					{/if}
				</div>
			{:else if name !== "read" && name !== "ls"}
				<pre class="mono">{JSON.stringify(args, null, 2)}</pre>
			{/if}

			{#if custom}
				<div class="custom"><ExtensionView node={custom} namespace={`tool-${renderer?.owner ?? ""}-${id}`} values={{}} onchange={noop} ondispatch={none} /></div>
			{:else if showStandaloneOutput}
				<div class="label">{t("출력")}</div>
				<pre class="mono out">{clip(run.output, 12000)}</pre>
			{/if}
		</div>
	{/if}

	{#if awaiting && run.question}
		<div class="ask" in:collapseIn out:collapseOut><QuestionReply {id} paneId={pane.id} question={run.question} /></div>
	{/if}
</div>

{#snippet fileHeader(added: number, removed: number, info: string)}
	{#if fileTarget && pane.id}
		{@const fp = splitFilePath(fileTarget.path)}
		{@const suffix = formatFileLine(fileTarget.line)}
		<div class="codebar">
			<button
				type="button"
				class="codebar-file mono"
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
			{#if added || removed || info}
				<span class="codebar-meta mono">
					{#if added}<span class="stat-add">+{added}</span>{/if}
					{#if removed}<span class="stat-del">-{removed}</span>{/if}
					{#if info}<span class="stat-range">{info}</span>{/if}
				</span>
			{/if}
		</div>
	{/if}
{/snippet}

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
		width: calc(100% + 16px);
		min-width: 0;
		margin-inline: -8px; /* optical: aligns the 16px icon to the step column while giving the row 8px hover padding */
		padding: 4px 8px;
		border-radius: var(--radius-sm);
		font-size: var(--fs-xs);
		line-height: 20px;
		color: var(--text-dim);
		text-align: left;
		transition: color var(--motion-fast) var(--ease-std), background-color var(--motion-fast) var(--ease-std);
	}
	.head[aria-expanded="true"] {
		background-color: var(--bg-group);
	}
	@media (hover: hover) {
		.head:hover,
		.head:hover .sum {
			color: var(--text);
		}
		.head:hover {
			background-color: var(--bg-hover);
		}
		.head:hover .chev {
			color: var(--text-dim);
		}
	}
	.head:active:not(:disabled) {
		background-color: var(--bg-active);
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
	/* the tool's name: clear anchor on the left of each call row */
	/* one column per work box (--name-w, set by WorkBox from its longest name, 4 to 8ch): every summary starts on one line.
	   A longer name only pushes its own row; outside a work box it falls back to bash / read / grep / edit's 4ch. */
	.name {
		flex: none;
		min-width: var(--name-w, 4ch);
		max-width: 40%;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
		font-weight: 500;
		color: var(--text);
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
		font-family: var(--mono);
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
		padding: 8px 0 8px 24px;
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
	.jump-tok.mention.self {
		--hue: var(--mark-mention-self);
		cursor: default;
	}
	.jump-tok.mention.closed {
		--hue: var(--mark-mention-closed);
		font-weight: 500;
		background: color-mix(in srgb, var(--hue) 8%, transparent);
		box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--hue) 26%, transparent);
	}
	.mdot {
		flex: none;
		width: 6px;
		height: 6px;
		border-radius: var(--radius-pill);
	}
	.mdot[data-activity="working"] {
		background: var(--info);
		animation: tc-dot-pulse var(--anim-working-duration) var(--anim-working-ease) infinite;
	}
	.mdot[data-activity="asking"] {
		background: var(--warn);
		animation: tc-dot-pulse var(--anim-working-duration) var(--anim-working-ease) infinite;
	}
	.mdot[data-activity="done"] {
		background: var(--ok);
	}
	.mdot[data-activity="failed"] {
		background: var(--danger);
	}
	@keyframes tc-dot-pulse {
		0%, 100% { opacity: 1; }
		50% { opacity: var(--anim-working-dim); }
	}
	@media (prefers-reduced-motion: reduce) {
		.mdot {
			animation: none;
		}
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
	.stat {
		flex: none;
		display: inline-flex;
		align-items: center;
		gap: 4px;
		font-size: var(--fs-2xs);
		line-height: 16px;
		font-variant-numeric: tabular-nums;
	}
	.stat-add {
		color: var(--ok);
	}
	.stat-del {
		color: var(--danger);
	}
	.stat-range {
		color: var(--text-faint);
	}
	.codeframe {
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: var(--bg-code);
		overflow: hidden;
	}
	.codebar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		padding: 4px 12px;
		border-bottom: 1px solid var(--border);
		background: var(--bg-group);
		font-size: var(--fs-2xs);
		line-height: 20px;
	}
	.codebar-file {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
		padding: 0;
		color: var(--text-dim);
		font-size: var(--fs-2xs);
		line-height: 20px;
		text-align: left;
		transition: color var(--motion-fast) var(--ease-std);
	}
	.codebar-file :global(svg) {
		flex: none;
		width: 12px;
		height: 12px;
		color: var(--text-faint);
	}
	@media (hover: hover) {
		.codebar-file:hover {
			color: var(--text);
		}
	}
	.codebar-meta {
		flex: none;
		display: inline-flex;
		align-items: center;
		gap: 8px;
		font-variant-numeric: tabular-nums;
	}
	.codescroll {
		max-height: 320px;
		overflow: auto;
		padding: 4px 0;
		font-size: var(--fs-xs);
		line-height: 20px;
	}
	.cline {
		display: flex;
		align-items: flex-start;
		min-width: max-content;
		padding-right: 12px;
	}
	.lno {
		flex: none;
		min-width: 4ch;
		padding: 0 8px;
		text-align: right;
		color: var(--text-faint);
		opacity: 0.6;
		user-select: none;
		font-variant-numeric: tabular-nums;
	}
	.sig {
		flex: none;
		width: 2ch;
		text-align: center;
		color: var(--text-faint);
		user-select: none;
	}
	.code {
		flex: 1 0 auto;
		padding-left: 4px;
		white-space: pre;
	}
	.diff-del {
		background: var(--danger-soft);
	}
	.diff-del .sig {
		color: var(--danger);
		font-weight: 600;
	}
	.diff-del .lno {
		color: var(--danger);
		opacity: 0.7;
	}
	.diff-add {
		background: var(--ok-soft);
	}
	.diff-add .sig {
		color: var(--ok);
		font-weight: 600;
	}
	.diff-add .lno {
		color: var(--ok);
		opacity: 0.7;
	}
	.diff-ctx .code {
		color: var(--text-dim);
	}
	.diff-skip {
		padding: 4px 12px;
		color: var(--text-faint);
		font-size: var(--fs-2xs);
		line-height: 16px;
		user-select: none;
	}
	.codefoot {
		padding: 4px 12px;
		border-top: 1px solid var(--border);
		color: var(--text-faint);
		font-size: var(--fs-2xs);
		line-height: 16px;
	}
	.codeframe.term pre {
		border-radius: 0;
		background: transparent;
	}
	.codeframe.term .term-out {
		border-top: 1px solid var(--border);
		color: var(--text-dim);
	}
	.codebar-title {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
		color: var(--text-dim);
		font-size: var(--fs-2xs);
		line-height: 20px;
	}
	.codebar-title :global(svg) {
		flex: none;
		width: 12px;
		height: 12px;
		color: var(--text-faint);
	}
	.codebar-sub {
		flex: none;
		color: var(--text-faint);
	}
	.codebar-file.mention {
		color: var(--mark-mention);
	}
	.codebar-file.mention :global(svg) {
		color: var(--mark-mention);
	}
	.codebar-file.mention.self {
		color: var(--mark-mention-self);
		cursor: default;
	}
	.codebar-file.mention.self :global(svg) {
		color: var(--mark-mention-self);
	}
	.codebar-file.mention.closed {
		color: var(--mark-mention-closed);
	}
	.codebar-file.mention.closed :global(svg) {
		color: var(--mark-mention-closed);
	}
	.codeempty {
		padding: 12px;
		color: var(--text-faint);
		font-size: var(--fs-xs);
		line-height: 20px;
	}
	.grep-scroll {
		max-height: 320px;
		overflow: auto;
		padding: 4px 0;
		font-size: var(--fs-xs);
		line-height: 20px;
	}
	.grep-file {
		padding: 4px 12px;
	}
	.grep-file:not(:first-child) {
		margin-top: 4px;
		padding-top: 8px;
		border-top: 1px solid var(--border);
	}
	.grep-path {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		max-width: 100%;
		padding: 0;
		color: var(--text);
		font-size: var(--fs-2xs);
		font-weight: 500;
		line-height: 20px;
		text-align: left;
	}
	.grep-path :global(svg) {
		flex: none;
		width: 12px;
		height: 12px;
		color: var(--text-faint);
	}
	.grep-hit {
		display: flex;
		align-items: flex-start;
		width: 100%;
		min-width: max-content;
		padding: 0 12px 0 0;
		color: var(--text-dim);
		font-size: var(--fs-xs);
		line-height: 20px;
		text-align: left;
		transition: background-color var(--motion-fast) var(--ease-std), color var(--motion-fast) var(--ease-std);
	}
	@media (hover: hover) {
		button.grep-hit:hover {
			background-color: var(--bg-hover);
			color: var(--text);
		}
	}
	.hit-text {
		flex: 1 0 auto;
		padding-left: 4px;
		white-space: pre;
	}
	.ls-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
		gap: 4px 8px;
		max-height: 280px;
		overflow: auto;
		padding: 8px 12px;
		font-size: var(--fs-xs);
		line-height: 20px;
	}
	.ls-entry {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
		padding: 4px 8px;
		border-radius: var(--radius-xs);
		color: var(--text-dim);
		font-size: var(--fs-xs);
		line-height: 20px;
		text-align: left;
		transition: background-color var(--motion-fast) var(--ease-std), color var(--motion-fast) var(--ease-std);
	}
	.ls-entry.dir {
		color: var(--text);
		font-weight: 500;
	}
	.ls-entry :global(svg) {
		flex: none;
		width: 14px;
		height: 14px;
		color: var(--text-faint);
	}
	@media (hover: hover) {
		button.ls-entry:hover {
			background-color: var(--bg-hover);
			color: var(--text);
		}
	}
	.sub-task {
		padding: 8px 12px;
		max-height: 120px;
		overflow-y: auto;
		color: var(--text-dim);
		font-size: var(--fs-xs);
		line-height: 20px;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	.sub-out {
		padding: 8px 12px;
		max-height: 320px;
		overflow-y: auto;
		border-top: 1px solid var(--border);
		color: var(--text);
		font-size: var(--fs-xs);
		line-height: 20px;
	}
	.sub-out :global(.md) {
		line-height: 20px;
	}
	.sub-out :global(.md p),
	.sub-out :global(.md ul),
	.sub-out :global(.md ol),
	.sub-out :global(.md blockquote) {
		margin: 0 0 8px;
	}
	.sub-out :global(.md > :last-child) {
		margin-bottom: 0;
	}
	.sub-out :global(.md :not(pre) > code) {
		font-size: var(--fs-2xs);
	}
	.kv-list {
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding: 8px 12px;
		font-size: var(--fs-xs);
		line-height: 20px;
	}
	.kv-row {
		display: grid;
		grid-template-columns: 12ch minmax(0, 1fr);
		gap: 12px;
		align-items: baseline;
	}
	.kv-row.multi {
		grid-template-columns: minmax(0, 1fr);
		gap: 4px;
	}
	.kv-key {
		color: var(--text-faint);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.kv-val {
		color: var(--text);
		overflow-wrap: anywhere;
	}
	.kv-pre {
		padding: 8px;
		max-height: 200px;
		border-radius: var(--radius-xs);
		background: var(--bg-group);
		color: var(--text-dim);
		font-size: var(--fs-xs);
		line-height: 20px;
	}
	.frame-out {
		border-radius: 0;
		background: transparent;
		color: var(--text-dim);
	}
	.kv-list + .frame-out {
		border-top: 1px solid var(--border);
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
