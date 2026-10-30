<script lang="ts">
	import { untrack } from "svelte";
	import Badge from "./Badge.svelte";
	import Button from "./Button.svelte";
	import ConfirmButton from "./ConfirmButton.svelte";
	import EmptyState from "./EmptyState.svelte";
	import IconButton from "./IconButton.svelte";
	import Modal from "./Modal.svelte";
	import Notice from "./Notice.svelte";
	import Segmented from "./Segmented.svelte";
	import Switch from "./Switch.svelte";
	import { abortable } from "../lib/abortable";
	import { errorText, type Api } from "../lib/api";
	import { t } from "../lib/i18n";
	import { reflow, rowIn, rowOut } from "../lib/motion";
	import { app } from "../lib/store.svelte";
	import type { McpInfo, McpServer, McpServerInfo } from "../lib/types";

	let { api, onclose }: { api: Api; onclose: () => void } = $props();

	let data = $state<McpInfo | null>(null);
	let loading = $state(true);
	let error = $state("");
	let refresh = $state(0);
	let busy = $state(false);

	// Re-read on manual refresh and whenever a server connects, fails or is edited (mcp_updated).
	$effect(() => {
		refresh;
		app.mcpTick;
		untrack(() => { if (!data) loading = true; });
		return abortable((signal) => api.mcp(signal), {
			ok: (r) => { data = r; error = ""; },
			fail: (e) => (error = errorText(e)),
			done: () => (loading = false),
		});
	});

	/** Saving sends the whole list; the server answers with the new state and starts connecting. */
	async function save(servers: McpServer[]): Promise<boolean> {
		if (busy) return false;
		busy = true;
		error = "";
		try {
			data = await api.setMcp(servers);
			app.mcpTick++;
			return true;
		} catch (e) {
			error = errorText(e);
			return false;
		} finally {
			busy = false;
		}
	}
	const plain = (s: McpServerInfo): McpServer => {
		const { status: _s, error: _e, tools: _t, ...rest } = s;
		return rest;
	};
	const all = () => (data?.servers ?? []).map(plain);
	const toggle = (s: McpServerInfo, enabled: boolean) => save(all().map(x => (x.name === s.name ? { ...x, enabled } : x)));
	const remove = (s: McpServerInfo) => save(all().filter(x => x.name !== s.name));
	async function reconnect(s: McpServerInfo) {
		try {
			data = await api.reloadMcp(s.name);
		} catch (e) {
			error = errorText(e);
		}
	}

	/* ---------- form ---------- */
	type Form = { original: string | null; name: string; transport: "stdio" | "http"; command: string; args: string; env: string; url: string; headers: string };
	let form = $state<Form | null>(null);

	const lines = (s: string) => s.split("\n").map(l => l.trim()).filter(Boolean);
	const pairs = (s: string, sep: string): Record<string, string> => {
		const out: Record<string, string> = {};
		for (const l of lines(s)) {
			const i = l.indexOf(sep);
			if (i > 0) out[l.slice(0, i).trim()] = l.slice(i + 1).trim();
		}
		return out;
	};
	const show = (r: Record<string, string> | undefined, sep: string) => Object.entries(r ?? {}).map(([k, v]) => `${k}${sep}${v}`).join("\n");

	function add() {
		form = { original: null, name: "", transport: "stdio", command: "", args: "", env: "", url: "", headers: "" };
	}
	function edit(s: McpServerInfo) {
		form = { original: s.name, name: s.name, transport: s.transport, command: s.command ?? "", args: (s.args ?? []).join("\n"), env: show(s.env, "="), url: s.url ?? "", headers: show(s.headers, ": ") };
	}
	async function submit(e: Event) {
		e.preventDefault();
		const f = form;
		if (!f) return;
		const old = all().find(x => x.name === f.original);
		const next: McpServer = {
			name: f.name.trim(),
			enabled: old?.enabled ?? true,
			transport: f.transport,
			...(f.transport === "stdio"
				? { command: f.command.trim(), args: lines(f.args), env: pairs(f.env, "=") }
				: { url: f.url.trim(), headers: pairs(f.headers, ":") }),
		};
		const rest = all().filter(x => x.name !== f.original);
		const list = f.original ? all().map(x => (x.name === f.original ? next : x)) : [...rest, next];
		if (await save(list)) form = null;
	}

	const statusTone = (s: McpServerInfo["status"]) => (s === "ready" ? "ok" : s === "error" ? "danger" : "neutral");
	const statusText = (s: McpServerInfo["status"]) =>
		s === "ready" ? t("연결됨") : s === "error" ? t("오류") : s === "connecting" ? t("연결하는 중…") : t("꺼져 있음");
	const target = (s: McpServerInfo) => (s.transport === "stdio" ? [s.command, ...(s.args ?? [])].join(" ") : s.url);
</script>

<Modal {onclose} title={t("MCP 서버")} sub={data ? t("연결된 서버 {n}개 · 도구 {tools}개", { n: data.ready, tools: data.tools }) : null} width="xl" maxHeight="760px" safeArea>
	{#snippet headerActions()}
		<IconButton icon="retry" label={t("새로고침")} tip onclick={() => refresh++} disabled={loading} />
	{/snippet}

	<div class="body" aria-busy={loading}>
		{#if error}
			<div class="gap"><Notice tone="warn">{error}</Notice></div>
		{/if}
		<p class="hint">{t("MCP 서버의 도구는 연결되어 있는 동안 이 서버의 모든 대화에서 mcp_서버이름_도구이름 으로 쓸 수 있습니다. stdio 서버는 이 서버 컴퓨터에서 명령을 실행하니 믿을 수 있는 것만 추가하세요.")}</p>

		{#if form}
			<form class="form" onsubmit={submit}>
				<label class="f">
					<span>{t("이름")}</span>
					<input class="field mono" bind:value={form.name} placeholder="github" maxlength="32" autocomplete="off" required />
				</label>
				<div class="f">
					<span>{t("연결 방식")}</span>
					<Segmented
						label={t("연결 방식")}
						value={form.transport}
						options={[{ id: "stdio", label: t("로컬 명령 (stdio)") }, { id: "http", label: "HTTP" }]}
						onchange={(id) => { if (form) form.transport = id; }}
					/>
				</div>
				{#if form.transport === "stdio"}
					<label class="f">
						<span>{t("실행할 명령")}</span>
						<input class="field mono" bind:value={form.command} placeholder="npx" autocomplete="off" autocapitalize="off" spellcheck="false" required />
					</label>
					<label class="f">
						<span>{t("인자 (한 줄에 하나)")}</span>
						<textarea class="field mono area" bind:value={form.args} rows="3" placeholder={"-y\n@modelcontextprotocol/server-filesystem\n/home"} spellcheck="false"></textarea>
					</label>
					<label class="f">
						<span>{t("환경 변수 (KEY=값, 한 줄에 하나)")}</span>
						<textarea class="field mono area" bind:value={form.env} rows="2" placeholder="API_TOKEN=..." spellcheck="false"></textarea>
					</label>
				{:else}
					<label class="f">
						<span>URL</span>
						<input class="field mono" bind:value={form.url} placeholder="https://example.com/mcp" autocomplete="off" autocapitalize="off" spellcheck="false" required />
					</label>
					<label class="f">
						<span>{t("헤더 (이름: 값, 한 줄에 하나)")}</span>
						<textarea class="field mono area" bind:value={form.headers} rows="2" placeholder="Authorization: Bearer ..." spellcheck="false"></textarea>
					</label>
				{/if}
				<p class="hint">{t("저장된 비밀 값은 ••••••••로 가려 보입니다. 그대로 두면 기존 값이 유지됩니다.")}</p>
				<div class="actions">
					<Button onclick={() => (form = null)} disabled={busy}>{t("취소")}</Button>
					<Button variant="primary" type="submit" disabled={busy}>{t("저장")}</Button>
				</div>
			</form>
		{:else}
			{#if !data && loading}
				<EmptyState loading />
			{:else if data}
				<ul class="list">
					{#each data.servers as s (s.name)}
						<li class="item" class:off={!s.enabled} animate:reflow in:rowIn out:rowOut>
							<span class="switch">
								<Switch checked={s.enabled} disabled={busy} onchange={on => toggle(s, on)} label={s.name} />
							</span>
							<div class="info">
								<div class="line">
									<span class="name mono">{s.name}</span>
									<Badge size="sm" tone={statusTone(s.status)}>{statusText(s.status)}</Badge>
									{#if s.status === "ready"}<Badge size="sm" variant="outline">{t("도구 {n}개", { n: s.tools.length })}</Badge>{/if}
									<Badge size="sm" variant="outline">{s.transport === "stdio" ? "stdio" : "HTTP"}</Badge>
								</div>
								<p class="path mono">{target(s)}</p>
								{#if s.error}<p class="err">{s.error}</p>{/if}
								{#if s.tools.length}<p class="tools mono">{s.tools.map(x => x.tool).join(", ")}</p>{/if}
							</div>
							<div class="side">
								{#if s.enabled}<IconButton icon="retry" size="sm" label={t("다시 연결")} tip onclick={() => reconnect(s)} />{/if}
								<Button size="sm" onclick={() => edit(s)}>{t("수정")}</Button>
								<ConfirmButton size="sm" danger confirmLabel={t("정말 삭제")} onconfirm={() => remove(s)} disabled={busy}>{t("삭제")}</ConfirmButton>
							</div>
						</li>
					{:else}
						<EmptyState as="li">{t("등록된 MCP 서버가 없습니다.")}</EmptyState>
					{/each}
				</ul>
				<Button variant="dashed" onclick={add}>{t("MCP 서버 추가")}</Button>
			{/if}
		{/if}
	</div>
</Modal>

<style>
	.body { overflow-y: auto; padding: var(--dlg-body-t) var(--dlg-px) var(--dlg-body-b); min-height: 80px; border-top: 1px solid var(--border); display: flex; flex-direction: column; gap: var(--dlg-gap); }
	.gap { margin: 0; }
	.hint { margin: 0; font-size: var(--fs-xs); line-height: 1.5; color: var(--text-dim); }
	.list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
	.item { display: flex; gap: 12px; align-items: flex-start; padding: 12px; border: 1px solid var(--border); border-radius: var(--radius); }
	.item.off .info { opacity: 0.55; }
	.info { min-width: 0; flex: 1; transition: opacity var(--motion-fast) var(--ease); }
	.line { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; }
	.name { font-size: var(--fs-sm); font-weight: 600; }
	.path, .tools, .err { margin: 4px 0 0; font-size: var(--fs-2xs); overflow-wrap: anywhere; }
	.path, .tools { color: var(--text-faint); }
	.tools { display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
	.err { color: var(--danger); }
	.side { display: flex; align-items: center; gap: 4px; flex: none; flex-wrap: wrap; justify-content: flex-end; }
	.form { display: flex; flex-direction: column; gap: var(--dlg-gap); }
	.f { display: flex; flex-direction: column; gap: var(--dlg-gap-sm); }
	.f > span { line-height: 20px; font-size: var(--fs-sm); }
	.area { height: auto; padding: 8px 12px; resize: vertical; font-size: var(--fs-sm); line-height: 1.5; }
	.actions { display: flex; justify-content: flex-end; gap: 8px; }
	@media (max-width: 640px) {
		.item { flex-wrap: wrap; }
		.side { width: 100%; justify-content: flex-start; }
	}
</style>
