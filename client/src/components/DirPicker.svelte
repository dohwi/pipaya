<script lang="ts">
	import FilterChip from "./FilterChip.svelte";
	import { msg, t, tc } from "../lib/i18n";
	import { onDestroy } from "svelte";
	import Icon from "./Icon.svelte";
	import Modal from "./Modal.svelte";
	import { app } from "../lib/store.svelte";
	import { Api, errorText } from "../lib/api";
	import type { DirListing, WorkdirInfo } from "../lib/types";

	/**
	 * Pick the directory a chat works in. Browses the server's folders; the choice is an absolute path.
	 * `mode: "chat"` starts a new chat there, `mode: "default"` saves it as the server's default directory.
	 */
	let {
		mode = "chat",
		onclose,
		serverId,
		info,
		onsaved,
	}: {
		mode?: "chat" | "default";
		onclose: () => void;
		/** `default` mode only: the server whose default is edited (falls back to the open one) */
		serverId?: string;
		/** Current default of that server, when it is not the open one */
		info?: WorkdirInfo | null;
		onsaved?: (info: WorkdirInfo) => void;
	} = $props();

	/** The server being browsed: the open one, or another saved server when editing its default */
	const remote = $derived(mode === "default" && !!serverId && serverId !== app.serverId);
	const current = $derived(remote ? (info ?? null) : app.workdirInfo);
	const client = () => {
		if (!remote) return app.api;
		const s = app.servers.find((x) => x.id === serverId);
		return s ? new Api({ baseUrl: s.baseUrl, token: s.token }) : null;
	};

	let listing = $state<DirListing | null>(null);
	let error = $state("");
	let loading = $state(false);
	let hidden = $state(false);
	let typed = $state("");
	let creating = $state(false);
	let newName = $state("");
	let saving = $state(false);
	/** Row highlighted with the arrow keys (-1: none) */
	let active = $state(-1);
	let input = $state<HTMLInputElement>();
	let fallback = false;
	/** The folder part of what is typed does not exist (yet) */
	let missing = $state(false);
	/** Last directory whose listing is on screen (typing re-lists only when this changes) */
	let seq = 0;

	const asDir = (p: string) => (p.endsWith("/") ? p : `${p}/`);
	const base = (p: string) => p.split("/").filter(Boolean).slice(-2).join("/") || "/";

	/** Shortcuts: the server's workspace first, then its home, then the folders used lately */
	const places = $derived.by(() => {
		const out: { path: string; label: string; title: string }[] = [];
		const root = app.workspace?.root;
		if (root) out.push({ path: root, label: msg("워크스페이스"), title: root });
		const home = app.workspace?.home ?? listing?.home;
		if (home && home !== root) out.push({ path: home, label: msg("홈"), title: home });
		return out;
	});

	const recents = $derived.by(() => {
		const seen = new Set<string>();
		const out: { path: string; sub: string }[] = [];
		for (const w of app.workspace?.workdirs ?? []) {
			const abs = w.path.startsWith("/") ? w.path : w.path === "." ? (app.workspace?.root ?? "") : `${app.workspace?.root}/${w.path}`;
			if (!abs || seen.has(abs)) continue;
			seen.add(abs);
			out.push({ path: abs, sub: t("활성 {active} · 닫힘 {closed}", { active: w.active, closed: w.closed }) });
			if (out.length >= 6) break;
		}
		return out;
	});

	const crumbs = $derived.by(() => {
		const p = listing?.path ?? "";
		const parts = p.split("/").filter(Boolean);
		return [{ name: "/", path: "/" }, ...parts.map((name, i) => ({ name, path: `/${parts.slice(0, i + 1).join("/")}` }))];
	});

	async function go(path?: string, live = false) {
		const api = client();
		if (!api) return;
		const mine = ++seq;
		loading = true;
		error = "";
		try {
			const res = await api.listDirs(path, hidden);
			if (mine !== seq) return; // a newer request superseded this one
			listing = res;
			active = -1;
			// "/a/b/" rather than "/a/b": the text after the last slash is a filter, and a folder's own name must not be one
			if (!live) typed = asDir(res.path);
		} catch (e) {
			if (mine !== seq) return;
			if (live) {
				// while typing, a half-written path is not an error: keep the last list and say so quietly
				error = "";
				missing = true;
				return;
			}
			// the starting folder may be gone: open the server's home instead of a dead end
			if (!fallback && path) {
				fallback = true;
				return go();
			}
			error = errorText(e);
		} finally {
			if (mine === seq) loading = false;
		}
	}

	async function mkdir() {
		const api = client();
		const name = newName.trim();
		if (!api || !listing || !name) return;
		try {
			const made = await api.makeDir(listing.path, name);
			creating = false;
			newName = "";
			await go(made.path);
		} catch (e) {
			error = errorText(e);
		}
	}

	/** Save (or clear, with null) the default directory on the browsed server */
	async function saveDefault(path: string | null): Promise<boolean> {
		if (!remote) {
			const ok = await app.setDefaultWorkdir(path);
			if (ok && app.workdirInfo) onsaved?.(app.workdirInfo);
			return ok;
		}
		try {
			const saved = await client()!.setDefaultWorkdir(path);
			onsaved?.(saved);
			app.toast(path ? t("기본 작업 디렉터리를 저장했습니다") : t("기본 작업 디렉터리를 처음 설정으로 되돌렸습니다"), "ok");
			return true;
		} catch (e) {
			app.toast(errorText(e), "error");
			return false;
		}
	}

	async function choose(path: string) {
		if (mode === "default") {
			saving = true;
			if (await saveDefault(path)) onclose();
			saving = false;
			return;
		}
		if (app.changeWorkdir(path)) onclose();
	}

	/** `/a/b/par` -> list `/a/b`, filter by `par`. `/a/b/` lists `/a/b`. */
	const split = (v: string) => {
		const i = v.lastIndexOf("/");
		return i < 0 ? { dir: "", part: v } : { dir: v.slice(0, i) || "/", part: v.slice(i + 1) };
	};
	const part = $derived(split(typed.trim()).part);
	const shown = $derived.by(() => {
		const all = listing?.entries ?? [];
		// filter only once the list belongs to the folder being typed (a re-list is on its way otherwise)
		if (!part || split(typed.trim()).dir !== listing?.path) return all;
		const q = part.toLowerCase();
		return all.filter((d) => d.name.toLowerCase().startsWith(q));
	});

	let timer: ReturnType<typeof setTimeout> | undefined;
	function oninput() {
		clearTimeout(timer);
		const v = typed.trim();
		if (!v.startsWith("/")) return; // only absolute paths are listed live
		const { dir } = split(v);
		timer = setTimeout(() => {
			missing = false;
			if (dir !== listing?.path) void go(dir, true);
		}, 140);
	}
	onDestroy(() => clearTimeout(timer));

	/** Open a folder from the list or a shortcut, and keep the keyboard in the path box so typing/Tab continue from there */
	async function enter(path: string) {
		await go(path);
		input?.focus();
	}

	/**
	 * Tab completes to the only (or the longest common) match, like a shell, and the folder it lands on is
	 * listed at once so its sub-folders are already there for the next Tab. Arrows move through the list.
	 */
	function complete(e: KeyboardEvent) {
		if (e.key === "ArrowDown" || e.key === "ArrowUp") {
			if (!shown.length) return;
			e.preventDefault();
			active = (active + (e.key === "ArrowDown" ? 1 : -1) + shown.length) % shown.length;
			queueMicrotask(() => document.querySelector(".list .row.hl")?.scrollIntoView({ block: "nearest" }));
			return;
		}
		if (e.key === "Backspace" && typed.endsWith("/") && typed.length > 1 && e.currentTarget instanceof HTMLInputElement && e.currentTarget.selectionStart === typed.length) {
			active = -1;
		}
		if (e.key !== "Tab" || e.shiftKey || !listing || !shown.length) return;
		e.preventDefault();
		const pick = active >= 0 ? shown[active] : undefined;
		let pre = pick?.name ?? shown[0].name;
		if (!pick) for (const d of shown) while (!d.name.startsWith(pre)) pre = pre.slice(0, -1);
		const dir = split(typed.trim()).dir;
		const whole = !!pick || shown.length === 1;
		typed = `${dir === "/" ? "" : dir}/${pre}${whole ? "/" : ""}`;
		if (whole) {
			clearTimeout(timer);
			missing = false;
			void go(typed.trim(), true);
		} else oninput();
	}

	/** Enter: open the highlighted folder, else the exact or only match; on an already-listed "/path/" it confirms; else go to the typed path */
	function submit() {
		const v = typed.trim();
		if (active >= 0 && shown[active]) return void go(shown[active].path);
		if (part) {
			const hit = shown.find((d) => d.name === part) ?? (shown.length === 1 ? shown[0] : undefined);
			if (hit) return void go(hit.path);
		}
		// "/path/" already listed: a second Enter confirms it
		if (v.startsWith("/") && v.endsWith("/") && !missing && listing && split(v).dir === listing.path && !saving) return void choose(listing.path);
		void go(v);
	}

	function focus(node: HTMLInputElement) {
		node.focus();
		node.select();
	}

	$effect(() => {
		// start in the directory the next chat would use, falling back to the server default
		void go(mode === "default" ? current?.effective : app.workdirAbs || undefined);
	});
</script>

<!-- opened over the server dialog (layer 2) when it picks the default folder -->
<Modal {onclose} title={mode === "default" ? t("기본 작업 디렉터리") : t("작업 디렉터리 선택")} width="l" layer={3} safeArea>

	<form
		class="path"
		onsubmit={(e) => {
			e.preventDefault();
			submit();
		}}
	>
		<input class="mono" bind:this={input} bind:value={typed} oninput={() => ((active = -1), oninput())} onkeydown={complete} spellcheck="false" autocomplete="off" aria-label={t("경로")} placeholder="/home/user/project" use:focus />
		<button class="btn sm" type="submit">{tc("go", "이동")}</button>
	</form>

	{#if places.length}
		<div class="recent">
			<span class="label">{t("바로가기")}</span>
			<div class="chips">
				{#each places as p (p.path)}
					<FilterChip size="sm" on={listing?.path === p.path} onclick={() => void enter(p.path)} title={p.title}>{t(p.label)}</FilterChip>
				{/each}
			</div>
		</div>
	{/if}
	{#if recents.length && mode === "chat"}
		<div class="recent">
			<span class="label">{t("최근")}</span>
			<div class="chips">
				{#each recents as r (r.path)}
					<FilterChip size="sm" mono onclick={() => void enter(r.path)} title="{r.path} · {r.sub}">{base(r.path)}</FilterChip>
				{/each}
			</div>
		</div>
	{/if}

	<nav class="crumbs mono" aria-label={t("현재 위치")}>
		{#each crumbs as c, i (c.path)}
			{#if i > 1}<span class="sep">/</span>{/if}
			<button class:last={i === crumbs.length - 1} onclick={() => void enter(c.path)}>{c.name}</button>
		{/each}
	</nav>

	<div class="list" class:loading>
		{#if error}
			<p class="err">{error}</p>
		{:else if missing}
			<p class="empty">{t('"{path}" 폴더를 찾을 수 없습니다', { path: split(typed.trim()).dir })}</p>
		{:else if listing}
			{#if listing.parent && !part}
				<button class="row wide up" onclick={() => void enter(listing!.parent!)}><Icon name="chevron-down" /><span class="mono">..</span><span class="grow"></span><span class="hint">{t("상위 폴더")}</span></button>
			{/if}
			{#each shown as d, i (d.path)}
				<button class="row wide" class:hl={i === active} ondblclick={() => void choose(d.path)} onclick={() => void enter(d.path)} title={t("한 번 누르면 열고, 두 번 누르면 바로 선택합니다")}>
					<Icon name="folder" /><span class="mono name">{d.name}</span>
				</button>
			{:else}
				<p class="empty">{part ? t('"{name}"(으)로 시작하는 폴더가 없습니다', { name: part }) : t("하위 폴더가 없습니다")}</p>
			{/each}
			{#if listing.truncated}<p class="empty">{t("폴더가 너무 많아 일부만 보입니다. 위 경로 입력칸을 이용하세요.")}</p>{/if}
		{/if}
	</div>

	<div class="tools">
		<label class="check"><input type="checkbox" bind:checked={hidden} onchange={() => void go(listing?.path)} /> {t("숨김 폴더")}</label>
		<span class="grow"></span>
		{#if creating}
			<form
				class="mk"
				onsubmit={(e) => {
					e.preventDefault();
					void mkdir();
				}}
			>
				<input class="mono" bind:value={newName} placeholder={t("새 폴더 이름")} spellcheck="false" use:focus aria-label={t("새 폴더 이름")} />
				<button class="btn sm" type="submit" disabled={!newName.trim()}>{t("만들기")}</button>
				<button class="btn ghost sm" type="button" onclick={() => ((creating = false), (newName = ""))}>{t("취소")}</button>
			</form>
		{:else}
			<button class="btn ghost sm" onclick={() => (creating = true)} disabled={!listing}><Icon name="plus" /> {t("새 폴더")}</button>
		{/if}
	</div>

	<footer>
		<div class="picked">
			<span class="label">{mode === "default" ? t("저장할 위치") : t("새 대화를 시작할 위치")}</span>
			<span class="mono cur" title={listing?.path}>{listing?.path ?? "…"}</span>
		</div>
		{#if mode === "default" && current?.saved}
			<button class="btn ghost" disabled={saving} onclick={async () => (await saveDefault(null)) && onclose()}>{t("처음 설정으로")}</button>
		{/if}
		<button class="btn primary" disabled={!listing || saving} onclick={() => listing && void choose(listing.path)}>
			{mode === "default" ? t("기본값으로 저장") : t("여기서 시작")}
		</button>
	</footer>
</Modal>

<style>
	.path,
	.mk {
		display: flex;
		gap: 8px;
	}
	.path {
		padding: 0 22px 10px;
	}
	input.mono,
	.mk input {
		flex: 1;
		min-width: 0;
		height: 34px;
		padding: 0 10px;
		font-size: var(--fs-sm);
		color: var(--text);
		background: var(--bg-elev);
		border: 1px solid var(--border-strong);
		border-radius: var(--radius);
	}
	input.mono:focus,
	.mk input:focus {
		outline: none;
		border-color: var(--text-faint);
	}
	.recent {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 0 22px 10px;
	}
	.label {
		font-family: var(--mono);
		font-size: var(--fs-2xs);
		letter-spacing: 0.04em;
		color: var(--text-faint);
		flex: none;
	}
	.chips {
		display: flex;
		gap: 6px;
		overflow-x: auto;
		scrollbar-width: none;
	}
	.crumbs {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 2px;
		padding: 6px 22px;
		font-size: var(--fs-xs);
		color: var(--text-faint);
		border-top: 1px solid var(--border);
	}
	.crumbs button {
		padding: 2px 4px;
		border-radius: var(--radius-xs);
		color: var(--text-dim);
	}
	.crumbs button:hover {
		background: var(--bg-hover);
		color: var(--text);
	}
	.crumbs button.last {
		color: var(--text);
		font-weight: 600;
	}
	.list {
		flex: 1;
		min-height: 180px;
		overflow-y: auto;
		padding: 4px 12px;
		border-top: 1px solid var(--border);
		border-bottom: 1px solid var(--border);
		transition: opacity var(--motion-fast) var(--ease-std);
	}
	.list.loading {
		opacity: 0.5;
	}
	.row {
		display: flex;
		align-items: center;
		gap: 10px;
		width: 100%;
		height: 34px;
		padding: 0 10px;
		border-radius: var(--radius);
		text-align: left;
		font-size: var(--fs-sm);
	}
	.row:hover,
	.row.hl {
		background: var(--bg-hover);
	}
	.row.hl {
		box-shadow: inset 0 0 0 1.5px var(--border-strong);
	}
	.row :global(svg) {
		width: 16px;
		height: 16px;
		flex: none;
		stroke: currentColor;
		fill: none;
		stroke-width: 1.8;
		stroke-linecap: round;
		stroke-linejoin: round;
		color: var(--text-faint);
	}
	.row.up :global(svg) {
		rotate: 90deg;
	}
	.name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.grow {
		flex: 1;
	}
	.hint {
		font-size: var(--fs-xs);
		color: var(--text-faint);
	}
	.empty,
	.err {
		margin: 18px 10px;
		font-size: var(--fs-sm);
		color: var(--text-faint);
	}
	.err {
		color: var(--danger);
	}
	.tools {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 8px 22px;
		font-size: var(--fs-xs);
		color: var(--text-dim);
	}
	.check {
		display: flex;
		align-items: center;
		gap: 6px;
		cursor: pointer;
	}
	footer {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 12px 22px 16px;
		border-top: 1px solid var(--border);
	}
	.picked {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.cur {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: var(--fs-sm);
		text-align: left;
	}
</style>
