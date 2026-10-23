<script lang="ts">
	import { modalLayer } from "../lib/dialog";
	import Badge from "./Badge.svelte";
	import { t } from "../lib/i18n";
	import { fadeIn, fadeOut, surfaceIn, surfaceOut } from "../lib/motion";
	import Icon from "./Icon.svelte";
	import { app } from "../lib/store.svelte";

	const spec = $derived(app.palette);
	let query = $state("");
	let index = $state(0);
	let input: HTMLInputElement | undefined = $state();
	let listEl: HTMLDivElement | undefined = $state();

	const items = $derived.by(() => {
		const q = query.trim().toLowerCase();
		const all = spec?.items ?? [];
		return q ? all.filter((i) => `${i.title} ${i.sub ?? ""}`.toLowerCase().includes(q)) : all;
	});

	// Fresh state each time a palette opens; start on the current item when there is one.
	$effect(() => {
		if (!spec) return;
		query = "";
		const cur = spec.items.findIndex((i) => i.current);
		index = Math.max(0, cur);
		queueMicrotask(() => {
			input?.focus();
			scrollToIndex();
		});
	});
	$effect(() => {
		query;
		index = 0;
	});

	function scrollToIndex() {
		listEl?.querySelector<HTMLElement>(`[data-i="${index}"]`)?.scrollIntoView({ block: "nearest" });
	}
	function close() {
		app.palette = null;
	}
	function choose(i: number) {
		const it = items[i];
		const s = spec;
		if (!it || !s) return;
		close();
		void s.onpick(it);
	}
	function onKey(e: KeyboardEvent) {
		if (e.key === "ArrowDown") {
			e.preventDefault();
			index = Math.min(items.length - 1, index + 1);
			queueMicrotask(scrollToIndex);
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			index = Math.max(0, index - 1);
			queueMicrotask(scrollToIndex);
		} else if (e.key === "Enter" && !e.isComposing) {
			e.preventDefault();
			choose(index);
		} else if (e.key === "Delete" && e.shiftKey && spec?.ondelete && items[index]) {
			e.preventDefault();
			void spec.ondelete(items[index]!);
		}
	}
</script>

{#if spec}
	<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
	<div class="scrim" onclick={close} in:fadeIn out:fadeOut></div>
	<!-- Esc, Tab kept inside, focus back to the opener, app shortcuts muted: the same layer every modal uses -->
	<div class="pal" role="dialog" aria-modal="true" aria-label={spec.title} use:modalLayer={{ onclose: close }} in:surfaceIn={{ y: -12 }} out:surfaceOut={{ y: -12 }}>
		<div class="head">
			<span class="ttl">{spec.title}</span>
			<button class="x" onclick={close} aria-label={t("닫기")}><Icon name="x" /></button>
		</div>
		<div class="sw">
			<Icon name="search" />
			<input bind:this={input} bind:value={query} onkeydown={onKey} placeholder={t("검색…")} spellcheck="false" autocomplete="off" />
		</div>
		<div class="list" bind:this={listEl} role="listbox">
			{#each items as it, i (it.id)}
				<div
					class="it"
					class:on={i === index}
					class:dim={it.dim}
					role="option"
					tabindex={i === index ? 0 : -1}
					aria-selected={i === index}
					data-i={i}
					style="padding-left:{14 + (it.depth ?? 0) * 18}px"
					onmousemove={() => (index = i)}
				>
					<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
					<div class="hit" onclick={() => choose(i)}>
						{#if it.depth}<span class="branch" aria-hidden="true"></span>{/if}
						<span class="main">
							<span class="t">{it.title}</span>
							{#if it.sub}<span class="s mono">{it.sub}</span>{/if}
						</span>
						{#if it.tag}<Badge variant="outline" size="sm" square>{it.tag}</Badge>{/if}
						{#if it.current}<span class="cur"><Icon name="check" /></span>{/if}
					</div>
					{#if spec.ondelete}
						<button
							class="del"
							type="button"
							onclick={(e) => {
								e.stopPropagation();
								void spec?.ondelete?.(it);
							}}
							aria-label={t("영구 삭제")}
							title={t("영구 삭제")}
						>
							<Icon name="x" />
						</button>
					{/if}
				</div>
			{:else}
				<div class="empty">{query ? t("일치하는 항목이 없습니다") : t(spec.empty)}</div>
			{/each}
		</div>
		<div class="foot mono"><span>↑↓ {t("이동")}</span><span>Enter {t("선택")}</span><span>Esc {t("닫기")}</span></div>
	</div>
{/if}

<style>
	.scrim {
		position: fixed;
		inset: 0;
		z-index: var(--z-scrim-1);
		background: var(--scrim);
	}
	.pal {
		position: fixed;
		z-index: var(--z-modal-1);
		top: min(14vh, 120px);
		left: 50%;
		translate: -50% 0;
		width: min(var(--modal-w-l), calc(var(--vw) - var(--modal-gutter)));
		max-height: min(560px, 76vh);
		display: flex;
		flex-direction: column;
		background: var(--bg-elev);
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-panel);
		box-shadow: var(--shadow);
		overflow: hidden;
	}
	.head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 12px 8px 4px 14px;
	}
	.ttl {
		font-size: var(--fs-sm);
		font-weight: 600;
	}
	.x {
		display: grid;
		place-items: center;
		width: 30px;
		height: 30px;
		border-radius: var(--radius-sm);
		color: var(--text-faint);
	}
	.x:hover {
		background: var(--bg-active);
		color: var(--text);
	}
	.x :global(svg),
	.sw :global(svg),
	.cur :global(svg),
	.del :global(svg) {
		width: 15px;
		height: 15px;
		stroke: currentColor;
		fill: none;
		stroke-width: 2;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	.sw {
		display: flex;
		align-items: center;
		gap: 8px;
		margin: 6px 12px 8px;
		padding: 0 10px;
		height: 36px;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		color: var(--text-faint);
	}
	.sw input {
		flex: 1;
		min-width: 0;
		border: 0;
		outline: 0;
		background: transparent;
		font-size: var(--fs-md);
		color: var(--text);
	}
	.list {
		overflow-y: auto;
		padding: 0 0 6px;
		border-top: 1px solid var(--border);
		min-height: 60px;
	}
	.it {
		display: flex;
		align-items: center;
		width: 100%;
		min-height: 44px;
		padding: 4px 10px 4px 14px;
		text-align: left;
		color: var(--text);
		border-radius: var(--radius-sm);
	}
	.it.on {
		background: var(--bg-active);
	}
	.it.dim .t {
		color: var(--text-dim);
	}
	.hit {
		display: flex;
		align-items: center;
		gap: 8px;
		flex: 1;
		min-width: 0;
		cursor: pointer;
		padding: 4px 0;
	}
	.del {
		display: grid;
		place-items: center;
		flex: none;
		width: 28px;
		height: 28px;
		margin-left: 6px;
		border-radius: var(--radius-sm);
		color: var(--text-faint);
		cursor: pointer;
		opacity: 0.6;
		transition: opacity var(--motion-fast) var(--ease-std), color var(--motion-fast) var(--ease-std), background-color var(--motion-fast) var(--ease-std);
	}
	.del:hover {
		opacity: 1;
		background: var(--bg-hover, rgba(255, 255, 255, 0.08));
		color: var(--danger);
	}
	.branch {
		flex: none;
		width: 9px;
		height: 9px;
		margin: -6px 2px 0 0;
		border-left: 1px solid var(--text-faint);
		border-bottom: 1px solid var(--text-faint);
	}
	.main {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 1px;
	}
	.t {
		font-size: var(--fs-md);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.s {
		font-size: var(--fs-2xs);
		color: var(--text-faint);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.cur {
		flex: none;
		display: grid;
		color: var(--text-dim);
	}
	.empty {
		padding: 22px 14px;
		text-align: center;
		color: var(--text-faint);
		font-size: var(--fs-sm);
	}
	.foot {
		display: flex;
		gap: 14px;
		padding: 8px 14px;
		border-top: 1px solid var(--border);
		font-size: var(--fs-2xs);
		color: var(--text-faint);
	}
	@media (pointer: coarse) {
		.foot {
			display: none;
		}
	}
</style>
