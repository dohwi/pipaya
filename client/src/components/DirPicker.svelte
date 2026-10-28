<script lang="ts">
	import Button from "./Button.svelte";
	import FilterChip from "./FilterChip.svelte";
	import { splitTyped } from "../lib/workdir-path";
	import { DirBrowser } from "../lib/dir-browser.svelte";
	import { msg, t, tc } from "../lib/i18n";
	import { onDestroy } from "svelte";
	import Icon from "./Icon.svelte";
	import Modal from "./Modal.svelte";
	import { app } from "../lib/store.svelte";
	import { Api, errorText } from "../lib/api";
	import type { WorkdirInfo } from "../lib/types";

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

	const browser = new DirBrowser(() => {
		const api = client();
		return api ? { list: (path, hidden) => api.listDirs(path, hidden), mkdir: (parent, name) => api.makeDir(parent, name), errorText } : null;
	});
	let saving = $state(false);
	let input = $state<HTMLInputElement>();

	const base = (p: string) => p.split(/[\\/]/).filter(Boolean).slice(-2).join("/") || "/";

	/** Shortcuts: the server's workspace first, then its home, then the folders used lately */
	const places = $derived.by(() => {
		const out: { path: string; label: string; title: string }[] = [];
		const root = app.workspace?.root;
		if (root) out.push({ path: root, label: msg("워크스페이스"), title: root });
		const home = app.workspace?.home ?? browser.listing?.home;
		if (home && home !== root) out.push({ path: home, label: msg("홈"), title: home });
		return out;
	});

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

	/** Open a folder from the list or a shortcut, and keep the keyboard in the path box so typing/Tab continue from there */
	async function enter(path: string) {
		await browser.go(path);
		input?.focus();
	}

	/** Arrows move through the list; Tab completes like a shell (the browser lists where it lands). */
	function onkey(e: KeyboardEvent) {
		if (e.key === "ArrowDown" || e.key === "ArrowUp") {
			if (!browser.arrow(e.key)) return;
			e.preventDefault();
			queueMicrotask(() => document.querySelector(".list .row.hl")?.scrollIntoView({ block: "nearest" }));
			return;
		}
		if (e.key === "Backspace") browser.backspaced(e.currentTarget instanceof HTMLInputElement && e.currentTarget.selectionStart === browser.typed.length);
		if (e.key !== "Tab" || e.shiftKey) return;
		if (browser.tab()) e.preventDefault();
	}

	/** Enter: the browser opens a folder, or says the listed path should be confirmed. */
	function submit() {
		const r = browser.submit(saving);
		if (r) void choose(r.confirm);
	}

	function focus(node: HTMLInputElement) {
		node.focus();
		node.select();
	}

	$effect(() => {
		// start in the directory the next chat would use, falling back to the server default
		void browser.go(mode === "default" ? current?.effective : app.workdirAbs || undefined);
	});
	onDestroy(() => browser.dispose());
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
		<input class="mono" bind:this={input} bind:value={browser.typed} oninput={() => browser.typedChanged()} onkeydown={onkey} spellcheck="false" autocomplete="off" aria-label={t("경로")} placeholder="/home/user/project" use:focus />
		{#if !remote && browser.listing}
			{@const fav = app.isFavDir(browser.listing.path)}
			<button type="button" class="favbtn" class:on={fav} aria-pressed={fav} onclick={() => app.toggleFavDir(browser.listing!.path)} aria-label={fav ? t("즐겨찾기 해제") : t("즐겨찾기")} title={fav ? t("즐겨찾기 해제") : t("즐겨찾기")}>
				<Icon name="star" />
			</button>
		{/if}
		<Button size="sm" type="submit">{tc("go", "이동")}</Button>
	</form>

	{#if places.length}
		<div class="recent">
			<span class="label">{t("바로가기")}</span>
			<div class="chips">
				{#each places as p (p.path)}
					<FilterChip size="sm" on={browser.listing?.path === p.path} onclick={() => void enter(p.path)} title={p.title}>{t(p.label)}</FilterChip>
				{/each}
			</div>
		</div>
	{/if}
	{#if !remote}
		<div class="recent">
			<span class="label">{t("즐겨찾기")}</span>
			{#if app.favDirs.length}
				<div class="chips">
					{#each app.favDirs as p (p)}
						<FilterChip size="sm" mono on={browser.listing?.path === p} onclick={() => void enter(p)} title={p}>{base(p)}</FilterChip>
					{/each}
				</div>
			{:else}
				<span class="hint">{t("경로 옆 ☆를 누르면 여기에 추가됩니다")}</span>
			{/if}
		</div>
	{/if}

	<div class="list" class:loading={browser.loading}>
		{#if browser.error}
			<p class="err">{browser.error}</p>
		{:else if browser.missing}
			<p class="empty">{t('"{path}" 폴더를 찾을 수 없습니다', { path: splitTyped(browser.typed.trim()).dir })}</p>
		{:else if browser.listing}
			{#if browser.listing.parent && !browser.part}
				<button class="row wide up" onclick={() => void enter(browser.listing!.parent!)}><Icon name="chevron-down" /><span class="mono">..</span><span class="grow"></span><span class="hint">{t("상위 폴더")}</span></button>
			{/if}
			{#each browser.shown as d, i (d.path)}
				<button class="row wide" class:hl={i === browser.active} ondblclick={() => void choose(d.path)} onclick={() => void enter(d.path)} title={t("한 번 누르면 열고, 두 번 누르면 바로 선택합니다")}>
					<Icon name="folder" /><span class="mono name">{d.name}</span>
				</button>
			{:else}
				<p class="empty">{browser.part ? t('"{name}"(으)로 시작하는 폴더가 없습니다', { name: browser.part }) : t("하위 폴더가 없습니다")}</p>
			{/each}
			{#if browser.listing.truncated}<p class="empty">{t("폴더가 너무 많아 일부만 보입니다. 위 경로 입력칸을 이용하세요.")}</p>{/if}
		{/if}
	</div>

	{#if browser.creating}
		<form
			class="mk"
			onsubmit={(e) => {
				e.preventDefault();
				void browser.mkdir();
			}}
		>
			<input class="mono" bind:value={browser.newName} placeholder={t("새 폴더 이름")} spellcheck="false" use:focus aria-label={t("새 폴더 이름")} />
			<Button size="sm" type="submit" disabled={!browser.newName.trim()}>{t("만들기")}</Button>
			<Button variant="ghost" size="sm" onclick={() => browser.cancelCreating()}>{t("취소")}</Button>
		</form>
	{/if}

	<footer>
		<label class="check"><input type="checkbox" bind:checked={browser.hidden} onchange={() => void browser.go(browser.listing?.path)} /> {t("숨김 폴더")}</label>
		<Button variant="ghost" size="sm" onclick={() => browser.startCreating()} disabled={!browser.listing || browser.creating}><Icon name="plus" /> {t("새 폴더")}</Button>
		<span class="grow"></span>
		{#if mode === "default" && current?.saved}
			<Button variant="ghost" disabled={saving} onclick={async () => (await saveDefault(null)) && onclose()}>{t("처음 설정으로")}</Button>
		{/if}
		<Button variant="primary" disabled={!browser.listing || saving} onclick={() => browser.listing && void choose(browser.listing.path)}>
			{mode === "default" ? t("기본값으로 저장") : t("여기서 시작")}
		</Button>
	</footer>
</Modal>

<style>
	.path,
	.mk {
		display: flex;
		gap: 8px;
	}
	.mk {
		padding: var(--dlg-gap-sm) var(--dlg-px);
		border-top: 1px solid var(--border);
	}
	.path {
		padding: 0 var(--dlg-px) var(--dlg-gap-sm);
	}
	input.mono,
	.mk input {
		flex: 1;
		min-width: 0;
		height: 34px;
		padding: 0 12px;
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
		gap: var(--dlg-gap-sm);
		min-height: 36px; /* a chip row (28px) + 8px below: the empty hint keeps the same height */
		padding: 0 var(--dlg-px) var(--dlg-gap-sm);
	}
	.hint {
		font-size: var(--fs-xs);
		color: var(--text-faint);
	}
	.label {
		font-family: var(--mono);
		font-size: var(--fs-2xs);
		letter-spacing: 0.04em;
		color: var(--text-faint);
		flex: none;
	}
	/* the scroller clips on both axes: 4px of room (taken back by the margin) keeps the chips' focus ring whole */
	.chips {
		display: flex;
		gap: var(--dlg-gap-sm);
		margin: -4px;
		padding: 4px;
		min-width: 0;
		overflow-x: auto;
		scrollbar-width: none;
	}
	.favbtn {
		flex: none;
		display: grid;
		place-items: center;
		width: 34px;
		height: 34px;
		border-radius: var(--radius);
		color: var(--text-dim);
	}
	.favbtn:hover {
		background: var(--bg-hover);
		color: var(--text);
	}
	.favbtn :global(svg) {
		width: 16px;
		height: 16px;
		fill: none;
	}
	.favbtn.on {
		color: var(--warn, #e5b53b);
	}
	.favbtn.on :global(svg) {
		fill: currentColor;
	}
	.list {
		flex: 1;
		min-height: 180px;
		overflow-y: auto;
		padding: 4px var(--dlg-px) 4px calc(var(--dlg-px) - 12px); /* rows carry their own 12px, so row text starts on the dialog edge */
		border-top: 1px solid var(--border);
		transition: opacity var(--motion-fast) var(--ease-std);
	}
	.list.loading {
		opacity: 0.5;
	}
	.row {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		height: 36px;
		padding: 0 12px;
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
		stroke-width: 1.8;
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
	.empty,
	.err {
		margin: 16px 12px;
		font-size: var(--fs-sm);
		color: var(--text-faint);
	}
	.err {
		color: var(--danger);
	}
	.check {
		font-size: var(--fs-xs);
		color: var(--text-dim);
		display: flex;
		align-items: center;
		gap: 8px;
		cursor: pointer;
	}
	footer {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: var(--dlg-gap-sm);
		padding: var(--dlg-foot-t) var(--dlg-px) var(--dlg-foot-b);
		border-top: 1px solid var(--border);
	}
</style>
