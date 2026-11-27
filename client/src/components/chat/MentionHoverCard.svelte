<script lang="ts">
	import { activityOf, ACTIVITY_LABEL, ACTIVITY_TONE } from "../../lib/activity";
	import { portal } from "../../lib/dialog";
	import { t } from "../../lib/i18n";
	import { panesOf } from "../../lib/layout";
	import { hideMentionHover, mentionHover } from "../../lib/mention-hover.svelte";
	import { modelDisplayName } from "../../lib/model-name";
	import { surfaceIn, surfaceOut } from "../../lib/motion";
	import { workDir } from "../../lib/nav";
	import { sessionTitle } from "../../lib/session-title";
	import { app } from "../../lib/store.svelte";
	import { isMac } from "../../lib/keys";
	import AgentBadge from "../shell/AgentBadge.svelte";
	import Icon from "../ui/Icon.svelte";

	const CARD_W = 320;
	const GAP = 8;

	const active = $derived(mentionHover.active);
	const snippet = $derived(mentionHover.snippet);

	const sessionInfo = $derived.by(() => {
		if (!active || active.target.kind !== "session") return null;
		const serverId = active.target.server ?? app.serverId;
		if (!serverId) return null;
		const link = app.links[serverId];
		const s = app.sessionAny(active.target.id, serverId);
		if (!s) return null;
		const activity = !s.closed && link ? activityOf(link.data, s.id) : "idle";
		const dir = workDir(s);
		const branch = link?.repos[dir]?.branch ?? null;
		const dirShort = dir.split(/[\\/]/).slice(-2).join("/");
		const model = link ? modelDisplayName(link.models, s.provider, s.model) : s.model;
		const isRemote = serverId !== app.serverId;
		const srv = isRemote ? app.servers.find((x) => x.id === serverId) : undefined;
		const serverName = srv ? app.serverLabel(srv) : isRemote ? serverId : "";
		return { s, serverId, activity, dirShort, branch, model, isRemote, serverName };
	});

	const groupInfo = $derived.by(() => {
		if (!active || active.target.kind !== "group") return null;
		const g = app.groups.find((x) => x.id === active.target.id);
		if (!g) return null;
		const link = app.link;
		const members = panesOf(g.layout)
			.map((id) => link?.sessionById.get(id))
			.filter((s): s is NonNullable<typeof s> => !!s)
			.map((s) => ({
				id: s.id,
				name: s.name ? `@${s.name}` : sessionTitle(s.title),
				activity: link ? activityOf(link.data, s.id) : "idle",
			}));
		return { g, members };
	});

	const mod = isMac ? "⌘" : "Ctrl";

	const pos = $derived.by(() => {
		if (!active || typeof window === "undefined") return { left: 0, top: 0, above: false };
		const r = active.rect;
		const vw = window.innerWidth;
		const vh = window.innerHeight;
		const left = Math.max(8, Math.min(r.left, vw - CARD_W - 8));
		const spaceBelow = vh - r.bottom - GAP;
		const above = spaceBelow < 164 && r.top > 164;
		const top = above ? Math.max(8, r.top - GAP) : Math.min(vh - 8, r.bottom + GAP);
		return { left, top, above };
	});

	const bodyText = $derived.by(() => {
		if (!sessionInfo) return "";
		return sessionInfo.s.purpose?.trim() || snippet;
	});

	$effect(() => {
		if (!active) return;
		const dismiss = () => hideMentionHover();
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Control" || e.key === "Meta" || e.key === "Alt" || e.key === "Shift") return;
			hideMentionHover();
		};
		window.addEventListener("scroll", dismiss, true);
		window.addEventListener("mousedown", dismiss, true);
		window.addEventListener("keydown", onKey, true);
		window.addEventListener("blur", dismiss);
		return () => {
			window.removeEventListener("scroll", dismiss, true);
			window.removeEventListener("mousedown", dismiss, true);
			window.removeEventListener("keydown", onKey, true);
			window.removeEventListener("blur", dismiss);
		};
	});
</script>

{#if active && (sessionInfo || groupInfo)}
	<div
		class="mhover"
		class:above={pos.above}
		use:portal
		style:left="{pos.left}px"
		style:top="{pos.top}px"
		in:surfaceIn
		out:surfaceOut
		role="tooltip"
	>
		{#if sessionInfo}
			{@const { s, serverId, activity, dirShort, branch, model, isRemote, serverName } = sessionInfo}
			<div class="head">
				<span class="badge"><AgentBadge id={s.id} server={serverId} state={activity} size={18} /></span>
				<span class="title">{sessionTitle(s.title)}</span>
				{#if s.closed}
					<span class="pill closed">{t("닫힘")}</span>
				{:else if activity !== "idle"}
					<span class="pill {ACTIVITY_TONE[activity]}">{ACTIVITY_LABEL[activity]}</span>
				{/if}
			</div>
			{@const metaParts = [s.name ? `@${s.name}` : "", dirShort ? `${dirShort}${branch ? ` (${branch})` : ""}` : "", model].filter(Boolean)}
			<div class="meta mono">
				{#if isRemote}<span class="srv"><Icon name="server" />{serverName}</span>{#if metaParts.length}<span class="sep" aria-hidden="true">·</span>{/if}{/if}
				<span>{metaParts.join(" · ")}</span>
			</div>
			{#if bodyText}
				<p class="body">{bodyText}</p>
			{/if}
			<div class="hint">
				{#if s.closed}
					{t("클릭: 기록 보기 · {mod}+클릭: 다시 열기 · 우클릭: 메뉴", { mod })}
				{:else}
					{t("클릭: 미리 보기 · {mod}+클릭: 이동 · 우클릭: 메뉴", { mod })}
				{/if}
			</div>
		{:else if groupInfo}
			<div class="head">
				<span class="badge"><Icon name="group" /></span>
				<span class="title">{groupInfo.g.name}</span>
				<span class="pill closed">{t("대화 {n}개", { n: groupInfo.members.length })}</span>
			</div>
			{#if groupInfo.members.length}
				<div class="members">
					{#each groupInfo.members.slice(0, 6) as m (m.id)}
						<span class="member">
							{#if m.activity !== "idle"}<span class="dot {ACTIVITY_TONE[m.activity]}"></span>{/if}
							<span>{m.name}</span>
						</span>
					{/each}
				</div>
			{/if}
			<div class="hint">{t("클릭: 그룹 열기 · 우클릭: 메뉴")}</div>
		{/if}
	</div>
{/if}

<style>
	.mhover {
		position: fixed;
		z-index: var(--z-tooltip);
		width: 320px;
		max-width: calc(var(--vw) - 16px);
		padding: 12px;
		border-radius: var(--radius);
		background: var(--bg-elev);
		border: 1px solid var(--border);
		box-shadow: var(--shadow-overlay);
		pointer-events: none;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.mhover.above {
		transform: translateY(-100%);
	}
	.head {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
	}
	.badge {
		flex: none;
		display: inline-grid;
		place-items: center;
		width: 20px;
		height: 20px;
		color: var(--text-dim);
	}
	.title {
		flex: 1;
		min-width: 0;
		font-size: var(--fs-sm);
		font-weight: 600;
		line-height: 20px;
		color: var(--text);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.pill {
		flex: none;
		padding: 0 8px;
		border-radius: var(--radius-pill);
		font-size: var(--fs-2xs);
		font-weight: 600;
		line-height: 18px;
	}
	.pill.info {
		color: var(--info);
		background: var(--info-soft);
	}
	.pill.warn {
		color: var(--warn);
		background: var(--warn-soft);
	}
	.pill.ok {
		color: var(--ok);
		background: var(--ok-soft);
	}
	.pill.danger {
		color: var(--danger);
		background: var(--danger-soft);
	}
	.pill.closed {
		color: var(--text-dim);
		background: var(--bg-hover);
	}
	.meta {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px;
		font-size: var(--fs-2xs);
		line-height: 16px;
		color: var(--text-faint);
		overflow-wrap: anywhere;
	}
	.sep {
		opacity: 0.6;
	}
	.srv {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		color: var(--text-dim);
	}
	.srv :global(.ic) {
		font-size: 12px;
	}
	.body {
		margin: 0;
		font-size: var(--fs-xs);
		line-height: 18px;
		color: var(--text-dim);
		display: -webkit-box;
		line-clamp: 2;
		-webkit-line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
		word-break: break-word;
	}
	.members {
		display: flex;
		flex-wrap: wrap;
		gap: 4px 8px;
		font-size: var(--fs-xs);
		line-height: 18px;
		color: var(--text-dim);
	}
	.member {
		display: inline-flex;
		align-items: center;
		gap: 4px;
	}
	.dot {
		width: 6px;
		height: 6px;
		border-radius: var(--radius-pill);
		flex: none;
	}
	.dot.info { background: var(--info); }
	.dot.warn { background: var(--warn); }
	.dot.ok { background: var(--ok); }
	.dot.danger { background: var(--danger); }
	.hint {
		font-size: var(--fs-2xs);
		line-height: 16px;
		color: var(--text-faint);
		border-top: 1px solid var(--border);
		padding-top: 8px;
	}
</style>
