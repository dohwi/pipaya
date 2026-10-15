<script lang="ts">
	import { msg, t } from "../lib/i18n";
	import { surfaceIn, surfaceOut } from "../lib/motion";
	let {
		items,
		index,
		label = msg("명령"),
		empty = msg("일치하는 명령이 없습니다"),
		onpick,
		onhover,
	}: {
		items: { id: string; text: string; args?: string; desc: string; current?: boolean; tag?: string }[];
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
			<span class="n mono" class:skill={!!item.tag}>{item.text}{#if item.args}{" "}<span class="a">{item.args}</span>{/if}</span>
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
