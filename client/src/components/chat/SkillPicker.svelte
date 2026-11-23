<script lang="ts">
	import { t } from "../../lib/i18n";
	import { surfaceIn, surfaceOut } from "../../lib/motion";
	import Badge from "../ui/Badge.svelte";
	import Button from "../ui/Button.svelte";
	import Icon from "../ui/Icon.svelte";
	import SearchField from "../ui/SearchField.svelte";

	export interface PickerSkill {
		name: string;
		description: string;
		modelInvocable?: boolean;
	}

	let {
		skills,
		selected,
		loading = false,
		ontoggle,
		onclear,
		onmanage,
		onclose,
	}: {
		skills: readonly PickerSkill[];
		selected: ReadonlySet<string>;
		loading?: boolean;
		ontoggle: (name: string) => void;
		onclear: () => void;
		onmanage: () => void;
		onclose: () => void;
	} = $props();

	let query = $state("");
	let activeIndex = $state(0);
	let listEl: HTMLDivElement | undefined = $state();

	const filtered = $derived.by(() => {
		const q = query.trim().toLowerCase();
		if (!q) return skills;
		return skills.filter((s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q));
	});

	$effect(() => {
		query;
		activeIndex = 0;
	});

	$effect(() => {
		if (activeIndex >= filtered.length) activeIndex = Math.max(0, filtered.length - 1);
	});

	$effect(() => {
		activeIndex;
		listEl?.querySelector<HTMLElement>(`[data-i="${activeIndex}"]`)?.scrollIntoView({ block: "nearest" });
	});

	function onKey(e: KeyboardEvent) {
		if (e.key === "Escape") {
			e.preventDefault();
			e.stopPropagation();
			onclose();
			return;
		}
		if (!filtered.length) return;
		if (e.key === "ArrowDown") {
			e.preventDefault();
			activeIndex = (activeIndex + 1) % filtered.length;
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			activeIndex = (activeIndex - 1 + filtered.length) % filtered.length;
		} else if (e.key === "Enter") {
			e.preventDefault();
			const hit = filtered[activeIndex];
			if (hit) ontoggle(hit.name);
		}
	}
</script>

<svelte:window
	onkeydown={(e) => {
		if (e.key === "Escape") {
			e.preventDefault();
			e.stopPropagation();
			onclose();
		}
	}}
/>

<div class="picker" in:surfaceIn={{ y: 8 }} out:surfaceOut={{ y: 8 }} role="dialog" aria-label={t("스킬 선택")} onkeydown={onKey} tabindex="-1">
	<div class="head">
		<span class="title">
			{t("스킬 선택")}
			{#if selected.size > 0}<span class="count">{t("{n}개 선택됨", { n: selected.size })}</span>{/if}
		</span>
		<span class="actions">
			{#if selected.size > 0}
				<button type="button" class="link" onclick={onclear}>{t("모두 해제")}</button>
			{/if}
			<button type="button" class="link" onclick={() => { onclose(); onmanage(); }}>{t("관리")}</button>
			<button type="button" class="close" onclick={onclose} aria-label={t("닫기")} title={t("닫기")}><Icon name="x" /></button>
		</span>
	</div>

	{#if skills.length > 6}
		<div class="search">
			<SearchField bind:value={query} label={t("스킬 검색")} autofocus />
		</div>
	{/if}

	<div class="list" role="listbox" aria-multiselectable="true" aria-label={t("스킬")} bind:this={listEl}>
		{#if loading && !skills.length}
			<div class="empty">{t("스킬 목록을 불러오는 중…")}</div>
		{:else if filtered.length}
			{#each filtered as skill, i (skill.name)}
				{@const on = selected.has(skill.name)}
				<button
					type="button"
					class="row"
					class:focused={i === activeIndex}
					class:picked={on}
					role="option"
					aria-selected={on}
					data-i={i}
					onmousedown={(e) => e.preventDefault()}
					onclick={() => { activeIndex = i; ontoggle(skill.name); }}
					onmousemove={() => (activeIndex = i)}
				>
					<span class="check" class:on aria-hidden="true">{#if on}<Icon name="check" />{/if}</span>
					<span class="info">
						<span class="line">
							<span class="name mono" class:on>{skill.name}</span>
							{#if skill.modelInvocable === false}<Badge size="sm" variant="outline">{t("수동 전용")}</Badge>{/if}
						</span>
						{#if skill.description}<span class="desc">{skill.description}</span>{/if}
					</span>
				</button>
			{/each}
		{:else if skills.length}
			<div class="empty">{t("일치하는 스킬이 없습니다")}</div>
		{:else}
			<div class="empty-box">
				<span>{t("사용 가능한 스킬이 없습니다")}</span>
				<Button size="sm" variant="ghost" onclick={() => { onclose(); onmanage(); }}>{t("스킬 설정")}</Button>
			</div>
		{/if}
	</div>
</div>

<style>
	.picker {
		position: absolute;
		left: 0;
		right: 0;
		bottom: calc(100% + 8px);
		background: var(--bg-elev);
		border: 1px solid var(--border-strong);
		border-radius: var(--radius);
		box-shadow: var(--shadow-overlay);
		z-index: var(--z-popover);
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}
	.head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		padding: 8px 8px 8px 15px; /* 1px border + 15 = 16px composer text line; right 8px aligns the 28px close button */
		border-bottom: 1px solid var(--border);
	}
	.title {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		font-size: var(--fs-xs);
		font-weight: 600;
		line-height: 20px;
		color: var(--text);
		min-width: 0;
	}
	.count {
		color: var(--accent);
		font-weight: 600;
		line-height: 20px;
	}
	.actions {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		flex: none;
	}
	.link {
		height: 28px;
		padding: 0 8px;
		border-radius: var(--radius-sm);
		font-size: var(--fs-xs);
		line-height: 20px;
		color: var(--text-dim);
	}
	.close {
		display: grid;
		place-items: center;
		width: 28px;
		height: 28px;
		padding: 0;
		border-radius: var(--radius-sm);
		color: var(--text-dim);
	}
	.close :global(svg) {
		width: 16px;
		height: 16px;
		stroke-width: 2;
	}
	@media (hover: hover) {
		.link:hover,
		.close:hover {
			background: var(--bg-hover);
			color: var(--text);
		}
	}
	.search {
		padding: 8px 15px; /* 1px border + 15 = 16px composer text line */
		border-bottom: 1px solid var(--border);
	}
	.list {
		max-height: min(280px, calc(var(--dvh) * 0.36));
		overflow-y: auto;
		padding: 4px 0;
	}
	.row {
		display: flex;
		align-items: flex-start;
		gap: 12px;
		width: 100%;
		padding: 8px 15px; /* 1px border + 15 = 16px composer text line */
		text-align: left;
		border: 0;
		background: transparent;
		color: var(--text);
	}
	.row.focused {
		background: var(--bg-active);
	}
	.row.picked:not(.focused) {
		background: color-mix(in srgb, var(--accent-soft) 55%, transparent);
	}
	.check {
		display: grid;
		place-items: center;
		flex: none;
		width: 16px;
		height: 16px;
		margin-top: 2px; /* optical: aligns 16px checkbox to 20px first text line */
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-sm);
		background: var(--bg);
		color: var(--accent-fg);
	}
	.check.on {
		border-color: var(--accent);
		background: var(--accent);
	}
	.check :global(svg) {
		width: 12px;
		height: 12px;
		stroke-width: 2.4;
	}
	.info {
		display: flex;
		flex-direction: column;
		gap: 4px;
		min-width: 0;
		flex: 1;
	}
	.line {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
	}
	.name {
		font-size: var(--fs-sm);
		font-weight: 600;
		line-height: 20px;
		color: var(--text);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.name.on {
		color: var(--accent);
	}
	.desc {
		font-size: var(--fs-xs);
		line-height: 16px;
		color: var(--text-dim);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.empty {
		padding: 16px 15px; /* 1px border + 15 = 16px composer text line */
		font-size: var(--fs-xs);
		line-height: 20px;
		color: var(--text-faint);
	}
	.empty-box {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		padding: 12px 15px; /* 1px border + 15 = 16px composer text line */
		font-size: var(--fs-xs);
		line-height: 20px;
		color: var(--text-dim);
	}
</style>
