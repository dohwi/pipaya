<script lang="ts">
	import { getLang, t } from "../../lib/i18n";
	import Icon from "../Icon.svelte";
	import Modal from "../Modal.svelte";
	import { extensions } from "../../lib/extensions/host.svelte";
	import { DEFAULT_MARKETPLACE_URL, cliCommand, compareVersions, fetchCatalog, fetchDoc, fetchPackage, fetchStars, formatStars, isOfficial, repoLoc, type MarketCatalog, type MarketEntry } from "../../lib/extensions/marketplace";
	import type { ExtensionPackage } from "../../lib/extensions/schema";

	let { onclose, onpick }: { onclose: () => void; onpick: (pkg: ExtensionPackage, entry: MarketEntry) => void } = $props();

	const KEY = "pipaya.marketplace.url";
	const saved = (() => { try { return localStorage.getItem(KEY) || DEFAULT_MARKETPLACE_URL; } catch { return DEFAULT_MARKETPLACE_URL; } })();
	let url = $state(saved);
	let catalog = $state<MarketCatalog | null>(null);
	let query = $state("");
	let loading = $state(false);
	let error = $state("");
	let working = $state("");
	let copied = $state("");
	let ctrl: AbortController | null = null;

	const installed = (id: string) => extensions.installed.find((e) => e.package.manifest.id === id);
	const shown = $derived((catalog?.extensions ?? []).filter((e) => {
		const q = query.trim().toLowerCase();
		return !q || `${e.id} ${e.name} ${e.description} ${e.author ?? ""}`.toLowerCase().includes(q);
	}));

	let stars = $state<Record<string, number>>({});
	let docs = $state<Record<string, string>>({});

	$effect(() => {
		const lang = getLang();
		const list = catalog?.extensions ?? [];
		let live = true;
		for (const e of list) {
			const repo = repoLoc(e)?.repo;
			if (repo && stars[repo] === undefined) void fetchStars(repo).then((n) => { if (live && n !== undefined) stars[repo] = n; });
			void fetchDoc(e, lang).then((d) => { if (live) docs[`${e.id}:${lang}`] = d; });
		}
		return () => { live = false; };
	});

	async function load() {
		ctrl?.abort();
		ctrl = new AbortController();
		loading = true;
		error = "";
		try {
			catalog = await fetchCatalog(url.trim(), ctrl.signal);
			try { if (url.trim() === DEFAULT_MARKETPLACE_URL) localStorage.removeItem(KEY); else localStorage.setItem(KEY, url.trim()); } catch { /* storage unavailable */ }
		} catch (cause) {
			if ((cause as Error)?.name === "AbortError") return;
			catalog = null;
			error = cause instanceof Error ? cause.message : String(cause);
		} finally {
			loading = false;
		}
	}

	async function pick(entry: MarketEntry) {
		working = entry.id;
		error = "";
		try {
			onpick(await fetchPackage(entry), entry);
		} catch (cause) {
			error = cause instanceof Error ? cause.message : String(cause);
		} finally {
			working = "";
		}
	}

	async function copy(entry: MarketEntry) {
		try { await navigator.clipboard.writeText(cliCommand(entry)); copied = entry.id; setTimeout(() => { if (copied === entry.id) copied = ""; }, 1500); } catch { /* clipboard blocked */ }
	}

	$effect(() => { void load(); return () => ctrl?.abort(); });
</script>

<Modal {onclose} labelledby="market-title" width="1120px" maxHeight="100dvh" layer={3} sheet={false} portal>
	<div class="market">
		<div class="mhead">
			<h2 id="market-title">{t("마켓플레이스")}</h2>
			<button type="button" class="btn sm" onclick={onclose}>{t("닫기")}</button>
		</div>
		<p class="hint">{catalog?.description || t("공개 카탈로그에서 확장을 찾아 설치합니다. 설치 전에 권한을 다시 확인합니다.")}</p>
		<label class="search">
			<Icon name="search" />
			<input type="search" placeholder={t("확장 검색")} aria-label={t("확장 검색")} bind:value={query} />
		</label>
		{#if error}<p class="callout danger" role="alert"><Icon name="alert" /><span>{error}</span></p>{/if}
		{#if loading && !catalog}<p class="hint" role="status">{t("목록을 불러오는 중…")}</p>{/if}
		<ul class="list">
			{#each shown as entry (entry.id)}
				{@const have = installed(entry.id)}
				{@const repo = repoLoc(entry)?.repo}
				{@const star = repo ? stars[repo] : undefined}
				{@const desc = docs[`${entry.id}:${getLang()}`] || entry.description}
				{@const newer = have ? compareVersions(entry.version, have.package.manifest.version) > 0 : false}
				<li class="item">
					<div class="info">
						<div class="top">
							<strong>{entry.name}</strong>
							<span class="meta">v{entry.version}</span>
							<span class="chip">{entry.kind === "server" ? t("서버") : t("클라이언트")}</span>
							{#if isOfficial(entry)}<span class="chip official" title={t("pipaya 공식 확장")}><Icon name="check" />{t("공식")}</span>{/if}
							{#if have && !newer}<span class="chip ok">{t("설치됨")}</span>{/if}
							{#if newer}<span class="chip accent">{t("업데이트")}</span>{/if}
						</div>
						{#if desc}<p class="desc">{desc}</p>{/if}
						<p class="meta">{[entry.author, entry.license].filter(Boolean).join(" · ")}{#if star !== undefined}<span class="star" title={t("GitHub 스타")}> · ★ {formatStars(star)}</span>{/if}</p>
					</div>
					{#if entry.kind === "client"}
						<button type="button" class="btn sm primary" disabled={!!working || (!!have && !newer)} onclick={() => pick(entry)}>
							{working === entry.id ? t("받는 중…") : newer ? t("업데이트") : have ? t("설치됨") : t("설치")}
						</button>
					{:else}
						<button type="button" class="btn sm" onclick={() => copy(entry)} title={cliCommand(entry)}>{copied === entry.id ? t("복사됨") : t("설치 명령 복사")}</button>
					{/if}
				</li>
			{:else}
				{#if catalog && !loading}<li class="none">{t("일치하는 확장이 없습니다")}</li>{/if}
			{/each}
		</ul>
		<p class="callout warn"><Icon name="alert" /><span>{t("서버 확장은 서버의 모든 권한으로 실행되어 앱에서 설치할 수 없습니다. 코드를 읽어 본 뒤 복사한 명령을 서버에서 실행하세요.")}</span></p>
		<details class="adv">
			<summary>{t("카탈로그 주소")}</summary>
			<div class="urlrow">
				<input type="url" spellcheck="false" aria-label={t("카탈로그 주소")} bind:value={url} onkeydown={(e) => { if (e.key === "Enter") void load(); }} />
				<button type="button" class="btn sm" disabled={loading} onclick={load}>{t("불러오기")}</button>
				<button type="button" class="btn sm" onclick={() => { url = DEFAULT_MARKETPLACE_URL; void load(); }}>{t("기본값")}</button>
			</div>
		</details>
	</div>
</Modal>

<style>
	.market { display: flex; flex-direction: column; gap: 12px; padding: 20px 22px 18px; overflow-y: auto; font-size: var(--fs-md); line-height: 1.5; }
	.mhead { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
	.mhead h2 { margin: 0; font-size: var(--fs-lg); font-weight: 600; }
	.hint, .meta { font-size: var(--fs-xs); color: var(--text-faint); overflow-wrap: anywhere; }
	.meta { font-family: var(--mono); font-size: var(--fs-2xs); }
	.search { display: flex; align-items: center; gap: 8px; padding: 0 10px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg-elev); }
	.search :global(svg) { width: 16px; height: 16px; flex: none; stroke: var(--text-faint); fill: none; stroke-width: 2; }
	.search input { flex: 1; min-width: 0; border: 0; background: transparent; padding: 9px 0; color: inherit; outline: none; }
	.list { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 10px; }
	.item { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 12px 14px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--bg-elev); }
	.info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
	.top { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
	.desc { margin: 0; color: var(--text-dim); overflow-wrap: anywhere; }
	.chip { font-size: var(--fs-2xs); padding: 1px 8px; border-radius: 999px; background: var(--bg-active); }
	.chip.ok { background: var(--ok-soft); }
	.chip.accent { background: var(--accent-soft); color: var(--text); }
	.item .btn { flex: none; }
	.chip.official { display: inline-flex; align-items: center; gap: 3px; background: var(--accent-soft); color: var(--text); font-weight: 600; }
	.chip.official :global(svg) { width: 11px; height: 11px; stroke: currentColor; fill: none; stroke-width: 3; }
	.none { grid-column: 1 / -1; color: var(--text-faint); padding: 16px 0; text-align: center; }
	.callout { display: flex; align-items: flex-start; gap: 8px; padding: 9px 12px; border-radius: var(--radius-sm); font-size: var(--fs-xs); line-height: 1.5; overflow-wrap: anywhere; margin: 0; }
	.callout :global(svg) { width: 16px; height: 16px; flex: none; margin-top: 2px; }
	.callout.warn { background: var(--warn-soft); }
	.callout.danger { background: var(--danger-soft); }
	.adv summary { cursor: pointer; font-size: var(--fs-xs); color: var(--text-faint); }
	.urlrow { display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
	.urlrow input { flex: 1; min-width: 200px; padding: 7px 10px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg-elev); color: inherit; }
	@media (max-width: 400px) { .item { flex-direction: column; align-items: stretch; } }
</style>
