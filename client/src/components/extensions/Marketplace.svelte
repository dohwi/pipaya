<script lang="ts">
	import { errorText, type Api } from "../../lib/api";
	import SearchField from "../SearchField.svelte";
	import Button from "../Button.svelte";
	import { getLang, t } from "../../lib/i18n";
	import Icon from "../Icon.svelte";
	import Notice from "../Notice.svelte";
	import Modal from "../Modal.svelte";
	import RemoveExtensionConfirm from "./RemoveExtensionConfirm.svelte";
	import PairInstallConfirm from "./PairInstallConfirm.svelte";
	import StatusChip from "../StatusChip.svelte";
	import VersionBump from "../VersionBump.svelte";
	import { DEFAULT_MARKETPLACE_URL, compareVersions, fetchCatalog, fetchPackage, fetchStars, formatStars, localizedDescription, repoLoc, type MarketCatalog, type MarketEntry } from "../../lib/extensions/marketplace";
	import type { ExtensionPackage } from "../../lib/extensions/schema";
	import type { ExtensionSource } from "../../lib/extensions/source";
	import { app } from "../../lib/store.svelte";

	let { scope, api, serverId = null, src, onchanged, onclose, onpick, initialQuery = "" }: { scope: "server" | "device"; /** Connection of the server being listed (the one picked in settings), not necessarily the open one */ api: Api | null; /** Id of that server; the open one when unset */ serverId?: string | null; /** Where client extensions are removed from: the host, or that server's idle list */ src: ExtensionSource; /** A server extension was installed or removed there: the caller reads its own lists again */ onchanged: () => void | Promise<void>; onclose: () => void; onpick: (pkg: ExtensionPackage, entry: MarketEntry) => void; initialQuery?: string } = $props();

	let catalog = $state<MarketCatalog | null>(null);
	// svelte-ignore state_referenced_locally
	let query = $state(initialQuery);
	let loading = $state(false);
	let error = $state("");
	let working = $state("");
	let serverHave = $state<Record<string, true>>({});
	let ctrl: AbortController | null = null;

	/** Whether a client extension is installed where it would go: this device's own, or the listed server's */
	const installed = (id: string) => (void app.extensionStoreTick, app.clientExtensionsOf(serverId ?? app.serverId)).find((e) => e.id === id);
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
			catalog = await fetchCatalog(DEFAULT_MARKETPLACE_URL, ctrl.signal);
		} catch (cause) {
			if ((cause as Error)?.name === "AbortError") return;
			catalog = null;
			error = errorText(cause);
		} finally {
			loading = false;
		}
	}

	/** The server entry paired with a client entry (it names the client one as its companion). */
	const serverOf = (entry: MarketEntry) => catalog?.extensions.find((e) => e.kind === "server" && e.companion === entry.id && e.source.type === "git");
	/** The client entry that asked "install the server one too?" (only when its server half is not on the server yet). */
	let askingServer = $state("");

	function startClient(entry: MarketEntry) {
		const s = serverOf(entry);
		if (s && !serverHave[s.id] && api) askingServer = entry.id;
		else void pick(entry);
	}

	/** With `both`, the server half goes in first; the client half then goes through the usual preview. */
	async function installClientWith(entry: MarketEntry, both: boolean) {
		askingServer = "";
		const s = both ? serverOf(entry) : undefined;
		if (s) {
			if (!api || s.source.type !== "git") return;
			working = entry.id;
			error = "";
			try {
				const { repo, dir, ref, commit } = s.source;
				await api.installServerExtension({ id: s.id, repo, ...(dir ? { dir } : {}), ref, commit });
				await Promise.all([refreshServer(), onchanged()]);
			} catch (cause) {
				error = errorText(cause);
				working = "";
				return;
			}
		}
		await pick(entry);
	}

	async function pick(entry: MarketEntry) {
		working = entry.id;
		error = "";
		try {
			onpick(await fetchPackage(entry), entry);
		} catch (cause) {
			error = errorText(cause);
		} finally {
			working = "";
		}
	}

	async function refreshServer() {
		if (!api) { serverHave = {}; return; }
		try { serverHave = Object.fromEntries((await api.serverExtensions()).extensions.map((e) => [e.name, true as const])); } catch { /* unreachable: nothing marked as installed */ }
	}

	/** The server entry that asked "install the client one too?" (only when its client half is not on this device yet). */
	let asking = $state("");
	const companionOf = (entry: MarketEntry) => (entry.companion ? catalog?.extensions.find((e) => e.id === entry.companion && e.kind === "client") : undefined);

	/** The other half of a pair, whichever side this entry is. */
	const pairOf = (entry: MarketEntry) => (entry.kind === "server" ? companionOf(entry) : serverOf(entry));
	const confirming = $derived(catalog?.extensions.find((e) => e.id === (asking || askingServer)));

	async function installClient(c: MarketEntry) {
		error = "";
		try { onpick(await fetchPackage(c), c); } catch (cause) { error = errorText(cause); }
	}

	function startServer(entry: MarketEntry) {
		const c = companionOf(entry);
		if (c && !installed(c.id)) asking = entry.id;
		else void installServer(entry, false);
	}

	/** With `both`, the client half goes through the usual preview (permissions) right after the server half is in. */
	async function installServer(entry: MarketEntry, both: boolean) {
		if (!api || entry.source.type !== "git") return;
		asking = "";
		working = entry.id;
		error = "";
		try {
			const { repo, dir, ref, commit } = entry.source;
			await api.installServerExtension({ id: entry.id, repo, ...(dir ? { dir } : {}), ref, commit });
			await Promise.all([refreshServer(), onchanged()]);
			const c = both ? companionOf(entry) : undefined;
			if (c) onpick(await fetchPackage(c), c);
		} catch (cause) {
			error = errorText(cause);
		} finally {
			working = "";
		}
	}

	/** The entry whose removal is being confirmed (the settings choice is made there). */
	let removing = $state("");

	async function remove(entry: MarketEntry, keepSettings: boolean) {
		working = entry.id;
		error = "";
		try {
			if (entry.kind === "server") {
				if (!api) throw new Error(t("서버에 연결되어 있지 않습니다."));
				await api.removeServerExtension(entry.id, keepSettings);
				await Promise.all([refreshServer(), onchanged()]);
			} else {
				await src.remove(entry.id, { keepSettings });
			}
			removing = "";
		} catch (cause) {
			error = errorText(cause);
		} finally {
			working = "";
		}
	}

	$effect(() => { void load(); return () => ctrl?.abort(); });
	$effect(() => { void api; void refreshServer(); });
</script>

<Modal {onclose} labelledby="market-title" width="1120px" maxHeight="var(--dvh)" layer={3} sheet={false} portal>
	<div class="market">
		<div class="mhead">
			<h2 id="market-title">{t("마켓플레이스")}</h2>
			<Button size="sm" onclick={onclose}>{t("닫기")}</Button>
		</div>
		<div class="hints">
			<p class="hint">{catalog?.description || t("공개 카탈로그에서 확장을 찾아 설치합니다. 설치 전에 권한을 다시 확인합니다.")}</p>
			{#if scope === "server"}<p class="hint">{t("서버 확장은 서버의 모든 권한으로 실행됩니다. 코드를 읽어 본 뒤 설치하세요.")}</p>{/if}
		</div>
		<SearchField label={t("확장 검색")} bind:value={query} />
		{#if error}<Notice tone="danger" size="sm" role="alert">{error}</Notice>{/if}
		{#if loading && !catalog}<p class="hint" role="status">{t("목록을 불러오는 중…")}</p>{/if}
		<ul class="list">
			{#each shown as entry (entry.id)}
				{@const have = installed(entry.id)}
				{@const repo = repoLoc(entry)?.repo}
				{@const star = repo ? stars[repo] : undefined}
				{@const desc = localizedDescription(entry, getLang())}
				{@const newer = have ? compareVersions(entry.version, have.version) > 0 : false}
				<li class="item">
					<div class="top">
						<strong class="name">{entry.name}</strong>
						{#if pairOf(entry)}{@const other = pairOf(entry)}
							<span class="pair" role="img" aria-label={t("{kind} ‘{name}’와 함께 작동합니다.", { kind: other?.kind === "server" ? t("서버 확장") : t("클라이언트 확장"), name: other?.name ?? "" })} title={t("{kind} ‘{name}’와 함께 작동합니다.", { kind: other?.kind === "server" ? t("서버 확장") : t("클라이언트 확장"), name: other?.name ?? "" })}><Icon name="clip" /></span>
						{/if}
						{#if newer}<StatusChip tone="ok">{t("새 버전")}</StatusChip>{:else if have || (entry.kind === "server" && serverHave[entry.id])}<StatusChip tone="ok">{t("설치됨")}</StatusChip>{/if}
						{#if newer && have}<span class="ver"><VersionBump from={have.version} to={entry.version} /></span>{:else}<span class="ver">v{entry.version}</span>{/if}
					</div>
					{#if desc}<p class="desc">{desc}</p>{/if}
					<div class="foot">
						<p class="meta">
							{#if entry.author}<span>{entry.author}</span>{/if}
							{#if entry.license}<span>{entry.license}</span>{/if}
							{#if star !== undefined}<span class="star" title={t("GitHub 스타")}><Icon name="star" />{formatStars(star)}</span>{/if}
						</p>
						{#if entry.kind === "client"}
							<div class="acts">
								{#if !have || newer}
									<Button variant={newer ? "update" : "primary"} size="sm" disabled={!!working} onclick={() => startClient(entry)}>
										{working === entry.id ? t("받는 중…") : newer ? t("업데이트") : t("설치")}
									</Button>
								{/if}
								{#if have}<Button size="sm" variant="danger" disabled={!!working} aria-expanded={removing === entry.id} onclick={() => (removing = entry.id)}>{t("삭제")}</Button>{/if}
							</div>
						{:else}
							{@const sHave = !!serverHave[entry.id]}
							<div class="acts">
								{#if !sHave}
									<Button variant="primary" size="sm" disabled={!!working || entry.source.type !== "git"} onclick={() => startServer(entry)}>
										{working === entry.id ? t("설치하는 중…") : t("설치하기")}
									</Button>
								{:else}
									<Button size="sm" variant="danger" disabled={!!working} aria-expanded={removing === entry.id} onclick={() => (removing = entry.id)}>{t("삭제")}</Button>
								{/if}
							</div>
						{/if}
					</div>
					{#if entry.kind === "client" && have && askingServer !== entry.id}
						{@const s = serverOf(entry)}
						{#if s && !serverHave[s.id] && api}
							<Notice tone="warn" size="sm" role="status">
								{t("서버 확장 ‘{name}’ 필요", { name: s.name })}
								{#snippet action()}<button type="button" disabled={!!working} onclick={() => installServer(s, false)}>{t("설치")}</button>{/snippet}
							</Notice>
						{/if}
					{/if}
					{#if entry.kind === "server" && serverHave[entry.id] && entry.companion && !installed(entry.companion) && asking !== entry.id}
						{@const c = companionOf(entry)}
						<Notice tone="warn" size="sm" role="status">
							{t("클라이언트 확장 ‘{name}’ 필요", { name: c?.name ?? entry.companion })}
							{#snippet action()}{#if c}<button type="button" disabled={!!working} onclick={() => installClient(c)}>{t("설치")}</button>{/if}{/snippet}
						</Notice>
					{/if}
				</li>
			{:else}
				{#if catalog && !loading}<li class="none">{t("일치하는 확장이 없습니다")}</li>{/if}
			{/each}
		</ul>
	</div>
</Modal>

{#if removing}
	{@const target = catalog?.extensions.find((e) => e.id === removing)}
	{#if target}
		<RemoveExtensionConfirm name={target.name} busy={!!working} onkeep={() => remove(target, true)} onwipe={() => remove(target, false)} oncancel={() => (removing = "")} />
	{/if}
{/if}

{#if confirming}
	{@const other = pairOf(confirming)}
	{#if other}
		<PairInstallConfirm
			picked={{ name: confirming.name, kind: confirming.kind }}
			{other}
			onboth={() => (asking ? installServer(confirming, true) : installClientWith(confirming, true))}
			onsolo={() => (asking ? installServer(confirming, false) : installClientWith(confirming, false))}
			oncancel={() => { asking = ""; askingServer = ""; }}
		/>
	{/if}
{/if}

<style>
	.market { display: flex; flex-direction: column; gap: 12px; padding: 20px 22px 18px; overflow-y: auto; font-size: var(--fs-md); line-height: 1.5; }
	.mhead { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
	.mhead h2 { margin: 0; font-size: var(--fs-lg); font-weight: 600; }
	.hints { display: flex; flex-direction: column; gap: 2px; }
	.hints .hint { margin: 0; }
	.hint, .meta { font-size: var(--fs-xs); color: var(--text-faint); overflow-wrap: anywhere; }
	.meta { font-family: var(--mono); font-size: var(--fs-2xs); }
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
	.foot :global(.btn) { flex: none; }
	.acts { display: flex; align-items: center; gap: 6px; flex: none; }
	.none { grid-column: 1 / -1; color: var(--text-faint); padding: 16px 0; text-align: center; }
	.pair { flex: none; display: inline-flex; color: var(--text-faint); }
	.pair :global(svg) { width: 14px; height: 14px; }
</style>
