<script lang="ts">
	import { onMount } from "svelte";
	import Button from "./Button.svelte";
	import ConfirmButton from "./ConfirmButton.svelte";
	import SettingRow from "./SettingRow.svelte";
	import Switch from "./Switch.svelte";
	import { t } from "../lib/i18n";
	import { errorText } from "../lib/api";
	import { app } from "../lib/store.svelte";
	import { DEFAULT_BROWSER_PROFILE, MAX_PROFILE_FILE_BYTES, parseProfileState, type BrowserProfile } from "../lib/browser";
	import { download } from "../lib/download";
	import { fileStamp } from "../lib/format";

	/**
	 * Browser profiles of the open server: each keeps its own logins and cookies. A profile can be reserved for people
	 * (agents then neither see nor use its tabs), cleared of what it stored, renamed and deleted. The throw-away `temp`
	 * profile is not listed here: agents and the "new browser" menu make it on demand.
	 */
	let profiles = $state<BrowserProfile[]>([]);
	let loaded = $state(false);
	let error = $state("");
	let name = $state("");
	let busy = $state(false);

	const unsupported = $derived(app.browserSupport !== null && (!app.browserSupport.enabled || !app.browserSupport.available));

	async function load() {
		const api = app.api;
		if (!api) return;
		try {
			profiles = (await api.browserProfiles()).profiles.filter((p) => !p.temporary);
			error = "";
		} catch (e) {
			error = errorText(e);
		}
		loaded = true;
	}
	onMount(load);
	// A tab opening or closing changes which profiles are in use.
	$effect(() => {
		app.browsers.length;
		void load();
	});

	async function run(f: () => Promise<unknown>) {
		busy = true;
		try {
			await f();
			error = "";
		} catch (e) {
			error = errorText(e);
		} finally {
			busy = false;
			await load();
		}
	}
	/** Logins out as a file. It signs whoever holds it in as you: say so before saving. */
	const exportLogins = (p: BrowserProfile) =>
		run(async () => {
			if (!window.confirm(t("이 파일에는 {name} 프로필의 로그인(쿠키)이 들어 있습니다. 가진 사람은 같은 계정으로 로그인할 수 있으니 안전하게 보관하세요. 저장할까요?", { name: p.id }))) return;
			const state = await app.api!.exportBrowserProfile(p.id);
			await download(state, `pipaya-browser-${p.id}-${fileStamp()}.json`);
		});
	let importTarget = $state<string | null>(null);
	let picker: HTMLInputElement | undefined = $state();
	const pickFor = (id: string) => {
		importTarget = id;
		picker?.click();
	};
	async function onPicked(e: Event) {
		const input = e.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		const id = importTarget;
		input.value = "";
		if (!file || !id) return;
		if (file.size > MAX_PROFILE_FILE_BYTES) return void (error = t("파일이 너무 큽니다 (최대 4MB)"));
		const state = parseProfileState(await file.text());
		if (!state) return void (error = t("프로필 파일이 아닙니다 (cookies가 있는 JSON이어야 합니다)"));
		await run(() => app.api!.importBrowserProfile(id, state));
	}
	const create = () =>
		run(async () => {
			const id = name.trim();
			if (!id) return;
			await app.api!.createBrowserProfile({ id });
			name = "";
		});
	/** The profile being renamed in place, and the name typed so far */
	let renaming = $state<string | null>(null);
	let draft = $state("");
	const startRename = (p: BrowserProfile) => {
		renaming = p.id;
		draft = p.id;
	};
	const commitRename = () => {
		const from = renaming;
		const next = draft.trim();
		renaming = null;
		if (from && next && next !== from) void run(() => app.api!.updateBrowserProfile(from, { id: next }));
	};
	const focusSelect = (node: HTMLInputElement) => {
		node.focus();
		node.select();
	};
</script>

<div class="head">
	<div class="section-label">{t("브라우저 프로필")}</div>
</div>
<p class="hint">{t("프로필마다 로그인과 쿠키가 따로 저장됩니다. 사람 전용으로 두면 에이전트는 그 프로필의 탭을 보거나 조작할 수 없습니다.")}</p>

{#if unsupported}
	<p class="hint warn">{app.browserSupport?.enabled === false ? t("이 서버는 브라우저가 꺼져 있습니다 (PIPAYA_BROWSER=0)") : t("이 서버에 Chrome 또는 Chromium이 없습니다")}</p>
{:else}
	{#each profiles as p (p.id)}
		<div class="profile">
			<SettingRow label={p.id === DEFAULT_BROWSER_PROFILE ? t("{name} (기본)", { name: p.id }) : p.id} hint={p.tabs ? t("열린 탭 {n}개", { n: p.tabs }) : ""}>
				<div class="controls">
					<span class="who">{t("에이전트 허용")}</span>
					<Switch checked={p.agent} label={t("{name}: 에이전트 허용", { name: p.id })} onchange={(on) => run(() => app.api!.updateBrowserProfile(p.id, { agent: on }))} />
				</div>
			</SettingRow>
			<div class="actions">
				<Button size="sm" disabled={busy} onclick={() => app.openBrowser(undefined, undefined, undefined, p.id)}>{t("이 프로필로 열기")}</Button>
				<Button size="sm" disabled={busy} onclick={() => exportLogins(p)}>{t("내보내기")}</Button>
				<Button size="sm" disabled={busy} onclick={() => pickFor(p.id)}>{t("가져오기")}</Button>
				<ConfirmButton size="sm" confirmLabel={t("지울까요?")} disabled={busy} onconfirm={() => run(() => app.api!.clearBrowserProfile(p.id))}>{t("로그인 지우기")}</ConfirmButton>
				{#if p.id !== DEFAULT_BROWSER_PROFILE}
					{#if renaming === p.id}
						<input class="rename" bind:value={draft} use:focusSelect maxlength="39" aria-label={t("새 이름")} spellcheck="false" autocapitalize="off" onblur={commitRename} onkeydown={(e) => (e.key === "Enter" ? commitRename() : e.key === "Escape" && ((renaming = null), e.stopPropagation()))} />
					{:else}
						<Button size="sm" disabled={busy || p.tabs > 0} onclick={() => startRename(p)}>{t("이름 바꾸기")}</Button>
					{/if}
					<ConfirmButton size="sm" danger confirmLabel={t("삭제할까요?")} disabled={busy || p.tabs > 0} onconfirm={() => run(() => app.api!.deleteBrowserProfile(p.id))}>{t("삭제")}</ConfirmButton>
				{/if}
			</div>
		</div>
	{/each}
	<input bind:this={picker} type="file" accept="application/json,.json" hidden onchange={onPicked} />
	<form class="add" onsubmit={(e) => { e.preventDefault(); void create(); }}>
		<input bind:value={name} placeholder={t("새 프로필 이름 (영문 소문자, 숫자, -, _)")} aria-label={t("새 프로필 이름")} maxlength="39" spellcheck="false" autocapitalize="off" autocomplete="off" />
		<Button size="sm" type="submit" disabled={busy || !name.trim()}>{t("프로필 만들기")}</Button>
	</form>
{/if}
{#if error}<p class="hint warn">{error}</p>{/if}
{#if !loaded && !unsupported}<p class="hint">{t("불러오는 중…")}</p>{/if}

<style>
	.head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
	}
	.hint {
		margin: 0;
		font-size: var(--fs-xs);
		color: var(--text-faint);
		line-height: 1.6;
	}
	.hint.warn {
		color: var(--warn, #b5651d);
	}
	.profile {
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 4px 12px 10px;
	}
	.controls {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.who {
		font-size: var(--fs-xs);
		color: var(--text-dim);
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		padding-top: 4px;
	}
	.add {
		display: flex;
		gap: 8px;
		align-items: center;
	}
	.rename,
	.add input {
		flex: 1;
		min-width: 0;
		height: var(--control-h-sm);
		padding: 0 10px;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-control);
		background: var(--bg);
		color: var(--text);
		font-size: var(--fs-sm);
	}
	.rename:focus-visible,
	.add input:focus-visible {
		outline: none;
		border-color: var(--accent);
		box-shadow: 0 0 0 3px var(--accent-soft);
	}
</style>
