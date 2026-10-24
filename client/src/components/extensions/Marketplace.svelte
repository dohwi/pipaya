<script lang="ts">
	import Button from "../Button.svelte";
	import { getLang, t } from "../../lib/i18n";
	import Icon from "../Icon.svelte";
	import Notice from "../Notice.svelte";
	import Modal from "../Modal.svelte";
	import { extensions } from "../../lib/extensions/host.svelte";
	import { app } from "../../lib/store.svelte";
	import { DEFAULT_MARKETPLACE_URL, compareVersions, fetchCatalog, fetchPackage, fetchStars, formatStars, isOfficial, localizedDescription, repoLoc, type MarketCatalog, type MarketEntry } from "../../lib/extensions/marketplace";
	import type { ExtensionPackage } from "../../lib/extensions/schema";

	let { scope, onclose, onpick }: { scope: "server" | "device"; onclose: () => void; onpick: (pkg: ExtensionPackage, entry: MarketEntry) => void } = $props();

	const KEY = "pipaya.marketplace.url";
	const saved = (() => { try { return localStorage.getItem(KEY) || DEFAULT_MARKETPLACE_URL; } catch { return DEFAULT_MARKETPLACE_URL; } })();
	let url = $state(saved);
	let catalog = $state<MarketCatalog | null>(null);
	let query = $state("");
	let loading = $state(false);
	let error = $state("");
	let working = $state("");
	let serverHave = $state<Record<string, true>>({});
	let ctrl: AbortController | null = null;

	const installed = (id: string) => extensions.installed.find((e) => e.package.manifest.id === id);
	/** A server tab lists server extensions only, a device tab client ones only. */
	const kind = $derived(scope === "server" ? "server" : "client");
	const shown = $derived((catalog?.extensions ?? []).filter((e) => {
		if (e.kind !== kind) return false;
		const q = query.trim().toLowerCase();
		return !q || `${e.id} ${e.name} ${e.description} ${Object.values(e.descriptions ?? {}).join(" ")} ${e.author ?? ""}`.toLowerCase().includes(q);
	}));

	let stars = $state<Record<string, number>>({});

	$effect(() => {
		const list = (catalog?.extensions ?? []).filter((e) => e.kind === kind);
		let live = true;
		for (const e of list) {
			const repo = repoLoc(e)?.repo;
			if (repo && stars[repo] === undefined) void fetchStars(repo).then((n) => { if (live && n !== undefined) stars[repo] = n; });
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

	async function refreshServer() {
		const api = app.api;
		if (!api) return;
		try { serverHave = Object.fromEntries((await api.serverExtensions()).extensions.map((e) => [e.name, true as const])); } catch { /* unreachable: nothing marked as installed */ }
	}

	/** The server entry that asked "install the client one too?" (only when its client half is not on this device yet). */
	let asking = $state("");
	const companionOf = (entry: MarketEntry) => (entry.companion ? catalog?.extensions.find((e) => e.id === entry.companion && e.kind === "client") : undefined);

	function startServer(entry: MarketEntry) {
		const c = companionOf(entry);
		if (c && !installed(c.id)) asking = entry.id;
		else void installServer(entry, false);
	}

	/** With `both`, the client half goes through the usual preview (permissions) right after the server half is in. */
	async function installServer(entry: MarketEntry, both: boolean) {
		const api = app.api;
		if (!api || entry.source.type !== "git") return;
		asking = "";
		working = entry.id;
		error = "";
		try {
			const { repo, dir, ref, commit } = entry.source;
			await api.installServerExtension({ id: entry.id, repo, ...(dir ? { dir } : {}), ref, commit });
			await Promise.all([refreshServer(), app.refreshServerExtensions()]);
			const c = both ? companionOf(entry) : undefined;
			if (c) onpick(await fetchPackage(c), c);
		} catch (cause) {
			error = cause instanceof Error ? cause.message : String(cause);
		} finally {
			working = "";
		}
	}

	$effect(() => { void load(); if (scope === "server") void refreshServer(); return () => ctrl?.abort(); });
</script>

<Modal {onclose} labelledby="market-title" width="1120px" maxHeight="var(--dvh)" layer={3} sheet={false} portal>
	<div class="market">
		<div class="mhead">
			<h2 id="market-title">{t("마켓플레이스")}</h2>
			<Button size="sm" onclick={onclose}>{t("닫기")}</Button>
		</div>
		<p class="hint">{catalog?.description || t("공개 카탈로그에서 확장을 찾아 설치합니다. 설치 전에 권한을 다시 확인합니다.")}</p>
		<label class="search">
			<Icon name="search" />
			<input type="search" placeholder={t("확장 검색")} aria-label={t("확장 검색")} bind:value={query} />
		</label>
		{#if error}<Notice tone="danger" size="sm" role="alert">{error}</Notice>{/if}
		{#if loading && !catalog}<p class="hint" role="status">{t("목록을 불러오는 중…")}</p>{/if}
		<ul class="list">
			{#each shown as entry (entry.id)}
				{@const have = installed(entry.id)}
				{@const repo = repoLoc(entry)?.repo}
				{@const star = repo ? stars[repo] : undefined}
				{@const desc = localizedDescription(entry, getLang())}
				{@const newer = have ? compareVersions(entry.version, have.package.manifest.version) > 0 : false}
				<li class="item">
					<div class="top">
						<strong class="name">{entry.name}</strong>
						{#if isOfficial(entry)}<span class="official" title={t("pipaya 공식 확장")}><Icon name="check" />{t("공식")}</span>{/if}
						{#if newer}<span class="chip accent">{t("업데이트")}</span>{/if}
						<span class="ver">v{entry.version}</span>
					</div>
					{#if desc}<p class="desc">{desc}</p>{/if}
					<div class="foot">
						<p class="meta">
							{#if entry.author}<span>{entry.author}</span>{/if}
							{#if entry.license}<span>{entry.license}</span>{/if}
							{#if star !== undefined}<span class="star" title={t("GitHub 스타")}><Icon name="star" />{formatStars(star)}</span>{/if}
						</p>
						{#if entry.kind === "client"}
							<Button variant="primary" size="sm" disabled={!!working || (!!have && !newer)} onclick={() => pick(entry)}>
								{working === entry.id ? t("받는 중…") : newer ? t("업데이트") : have ? t("설치됨") : t("설치")}
							</Button>
						{:else}
							{@const sHave = !!serverHave[entry.id]}
							<Button variant="primary" size="sm" disabled={!!working || entry.source.type !== "git" || sHave} onclick={() => startServer(entry)}>
								{working === entry.id ? t("설치하는 중…") : sHave ? t("설치됨") : t("설치하기")}
							</Button>
						{/if}
					</div>
					{#if asking === entry.id}
						{@const c = companionOf(entry)}
						<Notice tone="warn" size="sm">
							<div class="ask" role="group" aria-label={t("클라이언트 확장도 설치")}>
								<p>{t("클라이언트 확장 ‘{name}’도 함께 설치할까요? 사용하려면 필요합니다.", { name: c?.name ?? entry.companion ?? "" })}</p>
								<div class="askbtns">
									<Button variant="primary" size="sm" onclick={() => installServer(entry, true)}>{t("함께 설치")}</Button>
									<Button size="sm" onclick={() => installServer(entry, false)}>{t("서버만 설치")}</Button>
									<Button size="sm" onclick={() => (asking = "")}>{t("취소")}</Button>
								</div>
							</div>
						</Notice>
					{/if}
				</li>
			{:else}
				{#if catalog && !loading}<li class="none">{t("일치하는 확장이 없습니다")}</li>{/if}
			{/each}
		</ul>
		{#if scope === "server"}
			<Notice tone="warn" size="sm">{t("서버 확장은 서버의 모든 권한으로 실행됩니다. 코드를 읽어 본 뒤 설치하세요.")}</Notice>
		{/if}
		<details class="adv">
			<summary>{t("카탈로그 주소")}</summary>
			<div class="urlrow">
				<input type="url" spellcheck="false" aria-label={t("카탈로그 주소")} bind:value={url} onkeydown={(e) => { if (e.key === "Enter") void load(); }} />
				<Button size="sm" disabled={loading} onclick={load}>{t("불러오기")}</Button>
				<Button size="sm" onclick={() => { url = DEFAULT_MARKETPLACE_URL; void load(); }}>{t("기본값")}</Button>
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
	.search :global(svg) { width: 16px; height: 16px; flex: none; stroke: var(--text-faint); stroke-width: 2; }
	.search input { flex: 1; min-width: 0; border: 0; background: transparent; padding: 9px 0; color: inherit; outline: none; }
	.list { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 10px; }
	.item { display: flex; flex-direction: column; gap: 8px; padding: 14px 16px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--bg-elev); }
	.top { display: flex; align-items: center; gap: 8px; min-width: 0; }
	.name { font-size: var(--fs-md); font-weight: 600; min-width: 0; overflow-wrap: anywhere; }
	.ver { margin-left: auto; flex: none; font-family: var(--mono); font-size: var(--fs-2xs); color: var(--text-faint); }
	.foot { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: auto; padding-top: 4px; }
	.foot .meta { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 10px; margin: 0; min-width: 0; }
	.star { display: inline-flex; align-items: center; gap: 3px; }
	.star :global(svg) { width: 12px; height: 12px; fill: currentColor; stroke: none; }
	.market :global(.btn svg) { width: 13px; height: 13px; flex: none; margin-right: 5px; vertical-align: -2px; stroke-width: 2; }
	.desc { margin: 0; flex: 1; color: var(--text-dim); overflow-wrap: anywhere; }
	.chip { flex: none; font-size: var(--fs-2xs); padding: 0 7px; border-radius: 999px; background: var(--bg-active); line-height: 1.6; border: 1px solid transparent; }
	.chip.accent { background: var(--accent-soft); color: var(--text); }
	.foot :global(.btn) { flex: none; }
	.official { display: inline-flex; align-items: center; gap: 3px; flex: none; padding: 0 7px 0 5px; border-radius: 999px; background: var(--ok-soft); border: 1px solid color-mix(in srgb, var(--ok) 40%, transparent); color: color-mix(in srgb, var(--ok) 70%, var(--text)); font-size: var(--fs-2xs); font-weight: 600; line-height: 1.6; }
	.official :global(svg) { width: 10px; height: 10px; stroke-width: 3; }
	.none { grid-column: 1 / -1; color: var(--text-faint); padding: 16px 0; text-align: center; }
	.ask p { margin: 0 0 8px; }
	.askbtns { display: flex; flex-wrap: wrap; gap: 6px; }
	.adv summary { cursor: pointer; font-size: var(--fs-xs); color: var(--text-faint); }
	.urlrow { display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
	.urlrow input { flex: 1; min-width: 200px; padding: 7px 10px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg-elev); color: inherit; }
</style>
