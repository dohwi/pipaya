<script lang="ts">
	import { msg, t } from "../lib/i18n";
	import { surfaceIn, surfaceOut } from "../lib/motion";
	import { ACTIVITY_TONE, type Activity } from "../lib/activity";
	import StatusDot from "./StatusDot.svelte";
	let {
		items,
		index,
		label = msg("명령"),
		empty = msg("일치하는 명령이 없습니다"),
		onpick,
		onhover,
	}: {
		items: { id: string; text: string; args?: string; desc: string; current?: boolean; tag?: string; group?: string; state?: Activity }[];
		index: number;
		label?: string;
		empty?: string;
		onpick: (i: number) => void;
		onhover: (i: number) => void;
	} = $props();

	let listEl: HTMLDivElement | undefined = $state();
	$effect(() => {
		index;
		listEl?.querySelector<HTMLElement>(`[data-i="${index}"]`)?.scrollIntoView({ block: "nearest" });
	});
</script>

<div class="menu" in:surfaceIn={{ y: 8 }} out:surfaceOut={{ y: 8 }} role="listbox" aria-label={t(label)} bind:this={listEl}>
	{#each items as item, i (item.id)}
		{#if item.group && item.group !== items[i - 1]?.group}
			<div class="head" class:first={i === 0} role="presentation">{t(item.group)}</div>
		{/if}
		<!-- Prevent mouse focus transfer; click also supports touch and keyboard activation. -->
		<button
			class="cmd"
			class:on={i === index}
			role="option"
			aria-selected={i === index}
			data-i={i}
			onmousedown={(e) => e.preventDefault()}
			onclick={() => onpick(i)}
			onmousemove={() => onhover(i)}
		>
			{#if item.state && item.state !== "idle"}<StatusDot tone={ACTIVITY_TONE[item.state]} pulse={item.state === "working"} />{/if}
			<span class="n mono {item.state && item.state !== 'idle' ? `act-${ACTIVITY_TONE[item.state]}` : ''}" class:skill={!!item.tag}>{item.text}{#if item.args}{" "}<span class="a">{item.args}</span>{/if}</span>
			<span class="d">{t(item.desc)}</span>
			{#if item.tag}<span class="tag">{t(item.tag)}</span>{/if}
			{#if item.current}<span class="current">{t("현재")}</span>{/if}
		</button>
	{:else}
		<div class="none">{t(empty)}</div>
	{/each}
</div>

<style>
	.menu {
		position: absolute;
		left: 0;
		right: 0;
		bottom: calc(100% + 6px);
		max-height: min(300px, 40vh);
		overflow-y: auto;
		background: var(--bg-elev);
		border: 1px solid var(--border-strong);
		border-radius: var(--radius);
		box-shadow: var(--shadow);
		padding: 4px 0;
		z-index: 20;
	}
	/* a divider and a small heading wherever the kind of rows changes: commands, skills, sub-agents, files ... */
	.head {
		margin-top: 4px;
		padding: 8px 14px 3px;
		border-top: 1px solid var(--border);
		font-size: var(--fs-2xs);
		font-weight: 600;
		letter-spacing: 0.04em;
		color: var(--text-faint);
	}
	.head.first {
		margin-top: 0;
		padding-top: 4px;
		border-top: 0;
	}
	.cmd {
		display: flex;
		align-items: baseline;
		gap: 12px;
		width: 100%;
		min-height: 36px;
		padding: 6px 14px;
		text-align: left;
		align-items: center;
	}
	.cmd.on {
		background: var(--bg-active);
	}
	.n {
		flex: none;
		min-width: 128px;
		font-size: var(--fs-sm);
		font-weight: 600;
		color: var(--text);
	}
	.n.skill {
		color: var(--accent);
	}
	/* a session that is working / asking / done / failed: its name takes the same colour as its status elsewhere */
	.n.act-info { color: var(--info); }
	.n.act-warn { color: var(--warn); }
	.n.act-ok { color: var(--ok); }
	.n.act-danger { color: var(--danger); }
	.tag {
		margin-left: auto;
		flex: none;
		padding: 0 6px;
		font-size: var(--fs-2xs);
		line-height: 18px;
		border-radius: var(--radius-xs);
		color: var(--accent);
		border: 1px solid color-mix(in srgb, var(--accent) 45%, transparent);
	}
	.tag + .current {
		margin-left: 0;
	}
	.a {
		font-weight: 400;
		color: var(--text-faint);
	}
	.d {
		min-width: 0;
		font-size: var(--fs-sm);
		color: var(--text-dim);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.current {
		margin-left: auto;
		flex: none;
		font-size: var(--fs-2xs);
		color: var(--text-faint);
	}
	.none {
		padding: 12px 14px;
		font-size: var(--fs-sm);
		color: var(--text-faint);
	}
	@media (max-width: 560px) {
		.n {
			min-width: 0;
		}
		.d {
			font-size: var(--fs-xs);
		}
	}
</style>
