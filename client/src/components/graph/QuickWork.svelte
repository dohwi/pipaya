<script lang="ts">
	import { t } from "../../lib/i18n";
	import { duration } from "../../lib/format";
	import { toolIcon, toolKind, toolLabel, toolSummary } from "../../lib/tools";
	import type { QuickStep } from "../../lib/graph-quick";
	import Icon from "../ui/Icon.svelte";
	import ToolChip from "../chat/ToolChip.svelte";

	/**
	 * The tool calls between two texts of a reply, in the graph view's side panel: the chat's work box in a lighter form
	 * (it reads stored messages, not a live ChatState). The header shows the newest call and the tally; it opens into
	 * the list of calls, and each call opens into its output. `live`: the agent is still on this box.
	 */
	let { steps, live = false }: { steps: QuickStep[]; live?: boolean } = $props();

	let open = $state(false);
	let shown = $state<Record<string, boolean>>({});

	const failed = (s: QuickStep) => s.state === "error" || (s.state === "done" && !!s.exitCode);
	const head = $derived(steps.find((s) => s.state === "pending") ?? steps.at(-1)!);
	const done = $derived(steps.filter((s) => s.state !== "pending").length);
	const fails = $derived(steps.filter(failed).length);
	const total = $derived(steps.reduce((n, s) => n + (s.durationMs ?? 0), 0));
	const working = $derived(live && steps.some((s) => s.state === "pending"));
	/** One call: its header is the call, so opening shows its output straight away. */
	const single = $derived(steps.length === 1);
	const tone = $derived(working ? "accent" : fails ? "danger" : "ok");
</script>

<div class="group {tone}" class:live={working}>
	<button class="box" onclick={() => (open = !open)} disabled={single && !head.output} aria-expanded={open} aria-label={t("작업 {n}단계 자세히 보기", { n: steps.length })}>
		<span class="line">
			<ToolChip kind={toolKind(head.name, head.args)} icon={toolIcon(head.name, head.args)} label={toolLabel(head.name, head.args)} shimmer={working} />
			<span class="sum mono">{toolSummary(head.name, head.args)}</span>
		</span>
		<span class="meta">
			{#if working}
				<span class="dots" role="status" aria-label={t("작업 중")}><i></i><i></i><i></i></span>
			{:else if fails}
				<span class="fail-dot" title={t("실패")}></span>
			{/if}
			{#if steps.length > 1}<span class="count mono">{working ? `${done}/${steps.length}` : steps.length}</span>{/if}
			{#if total && !working}<span class="count mono">{duration(total)}</span>{/if}
			<span class="chev" class:open><Icon name="chevron-right" /></span>
		</span>
	</button>
	{#if open && single}
		<pre class="out mono solo" class:bad={failed(head)}>{head.output}</pre>
	{:else if open}
		<ol class="steps">
			{#each steps as s (s.id)}
				<li>
					<button class="step" onclick={() => (shown = { ...shown, [s.id]: !shown[s.id] })} aria-expanded={!!shown[s.id]} disabled={!s.output}>
						<ToolChip kind={toolKind(s.name, s.args)} icon={toolIcon(s.name, s.args)} label={toolLabel(s.name, s.args)} shimmer={live && s.state === "pending"} />
						<span class="sum mono">{toolSummary(s.name, s.args)}</span>
						{#if failed(s)}<span class="fail-dot" title={s.exitCode ? t("종료 코드 {code}", { code: s.exitCode }) : t("실패")}></span>{/if}
						{#if s.durationMs}<span class="count mono">{duration(s.durationMs)}</span>{/if}
					</button>
					{#if shown[s.id] && s.output}<pre class="out mono" class:bad={failed(s)}>{s.output}</pre>{/if}
				</li>
			{/each}
		</ol>
	{/if}
</div>

<style>
	.group {
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--bg-elev);
		overflow: hidden;
	}
	.group.live {
		border-color: color-mix(in srgb, var(--accent) 50%, var(--border));
	}
	.box,
	.step {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		text-align: left;
	}
	.box {
		height: 40px;
		padding: 0 12px;
	}
	.box:focus-visible,
	.step:focus-visible {
		outline-offset: -2px;
	}
	@media (hover: hover) {
		.box:not(:disabled):hover,
		.step:not(:disabled):hover {
			background: var(--bg-hover);
		}
	}
	.line {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: 8px;
		white-space: nowrap;
	}
	.sum {
		min-width: 0;
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: var(--fs-xs);
		line-height: 16px;
		color: var(--text-dim);
	}
	.meta {
		flex: none;
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.count {
		flex: none;
		font-size: var(--fs-2xs);
		line-height: 16px;
		color: var(--text-faint);
	}
	.fail-dot {
		flex: none;
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--danger);
	}
	.chev {
		display: grid;
		color: var(--text-faint);
		font-size: 16px;
		transition: transform var(--motion-fast) var(--ease-std);
	}
	.chev.open {
		transform: rotate(90deg);
	}
	.dots {
		display: inline-flex;
		gap: 4px;
	}
	.dots i {
		width: 4px;
		height: 4px;
		border-radius: 50%;
		background: var(--accent);
		animation: blink 1.2s infinite var(--ease-std);
	}
	.dots i:nth-child(2) {
		animation-delay: 0.2s;
	}
	.dots i:nth-child(3) {
		animation-delay: 0.4s;
	}
	@keyframes blink {
		0%,
		100% {
			opacity: 0.25;
		}
		40% {
			opacity: 1;
		}
	}
	.steps {
		margin: 0;
		padding: 4px 0;
		list-style: none;
		border-top: 1px solid var(--border);
	}
	.step {
		min-height: 32px;
		padding: 4px 12px;
	}
	.step:disabled {
		cursor: default;
		opacity: 1;
	}
	.out {
		margin: 0 12px 8px;
		max-height: 280px;
		overflow: auto;
		padding: 8px 12px;
		border-radius: var(--radius-sm);
		background: var(--bg);
		font-size: var(--fs-2xs);
		line-height: 16px;
		color: var(--text-dim);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	.out.solo {
		margin: 0 12px 12px;
	}
	.box:disabled {
		cursor: default;
		opacity: 1;
	}
	.out.bad {
		color: var(--danger);
	}
	@media (prefers-reduced-motion: reduce) {
		.dots i {
			animation: none;
			opacity: 0.7;
		}
	}
</style>
