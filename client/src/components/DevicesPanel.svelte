<script lang="ts">
	import Button from "./Button.svelte";
	import Notice from "./Notice.svelte";
	import { reflow, rowIn, rowOut } from "../lib/motion";
	import Badge from "./Badge.svelte";
	import ConfirmButton from "./ConfirmButton.svelte";
	import { onDestroy, onMount } from "svelte";
	import { t } from "../lib/i18n";
	import { Api, errorText } from "../lib/api";
	import { app } from "../lib/store.svelte";
	import { notifications } from "../lib/notifications";
	import type { NotificationDevice } from "../lib/notification-contract";
	import Icon from "./Icon.svelte";
	import PairPanel from "./PairPanel.svelte";

	let { serverId }: { serverId: string } = $props();
	const server = $derived(app.servers.find((s) => s.id === serverId));
	/** Whether this very window is connected to the server being shown: its own row can be marked "this device". */
	const isOpen = $derived(serverId === app.serverId);

	let devices = $state<NotificationDevice[] | null>(null);
	/** Tokens issued by QR pairing. null = not shown: this window connects with a paired device's own token, which may not manage them. */
	let paired = $state<{ id: string; name: string; createdAt: number; lastUsedAt: number | null }[] | null>(null);
	let revoking = $state<string | null>(null);
	let error = $state("");
	let busy = $state<string | null>(null);
	/** The QR is a key to the server: its code is only made while this is open, and dropped when it closes. */
	let adding = $state(false);
	let now = $state(Date.now());

	const api = () => (server ? new Api({ baseUrl: server.baseUrl, token: server.token }) : null);

	async function load() {
		const a = api();
		if (!a) return;
		try {
			devices = (await a.notificationDevices()).devices;
			error = "";
		} catch (e) {
			error = errorText(e);
		}
		try {
			paired = (await a.deviceTokens()).tokens;
		} catch {
			paired = null; // a paired device's token cannot manage tokens: nothing to show here
		}
		now = Date.now();
	}

	const refresh = setInterval(() => void load(), 10_000);
	onMount(() => void load());
	onDestroy(() => {
		clearInterval(refresh);
	});

	/** Behind a ConfirmButton (two taps): removing a device cannot be undone from here. */
	async function remove(d: NotificationDevice) {
		if (busy) return;
		const a = api();
		if (!a) return;
		busy = d.id;
		try {
			await a.removeNotificationDevice(d.id);
			devices = (devices ?? []).filter((x) => x.id !== d.id);
			app.toast(t("기기를 해지했습니다"), "ok");
		} catch (e) {
			error = errorText(e);
		} finally {
			busy = null;
		}
	}

	/** Same two-tap ConfirmButton as removing a device: it cuts the phone off. */
	async function revoke(id: string) {
		if (revoking) return;
		const a = api();
		if (!a) return;
		revoking = id;
		try {
			await a.revokeDeviceToken(id);
			paired = (paired ?? []).filter((x) => x.id !== id);
			app.toast(t("기기의 접속 권한을 취소했습니다"), "ok");
		} catch (e) {
			error = errorText(e);
		} finally {
			revoking = null;
		}
	}

	const platformName = (p: NotificationDevice["platform"]) =>
		p === "android" ? "Android" : p === "ios" ? "iOS" : p === "web" ? t("웹 브라우저") : t("데스크톱 앱");
	const icon = (p: NotificationDevice["platform"]): "phone" | "monitor" => (p === "android" || p === "ios" ? "phone" : "monitor");

	function ago(at: number | null): string {
		if (!at) return t("기록 없음");
		const sec = Math.max(0, Math.round((now - at) / 1000));
		if (sec < 60) return t("{n}초 전", { n: sec });
		const min = Math.floor(sec / 60);
		if (min < 60) return t("{n}분 전", { n: min });
		const hour = Math.floor(min / 60);
		if (hour < 24) return t("{n}시간 전", { n: hour });
		return t("{n}일 전", { n: Math.floor(hour / 24) });
	}
	const mine = (d: NotificationDevice) => isOpen && d.id === notifications.id;

	/**
	 * A reinstall or app update registers the same phone again under a new id, so the old row lingers.
	 * Show one row per physical device (same platform + name + OS): this window's own, else the live one, else the most recently seen.
	 */
	const shown = $derived.by(() => {
		const best = new Map<string, NotificationDevice>();
		const rank = (d: NotificationDevice) => (mine(d) ? 2 : d.live ? 1 : 0);
		for (const d of devices ?? []) {
			const key = d.name ? `${d.platform}|${d.name}|${d.os ?? ""}` : d.id;
			const cur = best.get(key);
			if (!cur || rank(d) > rank(cur) || (rank(d) === rank(cur) && (d.lastSeen ?? 0) > (cur.lastSeen ?? 0))) best.set(key, d);
		}
		const keep = new Set([...best.values()].map((d) => d.id));
		return (devices ?? []).filter((d) => keep.has(d.id));
	});
</script>

<div class="devices">
	<p class="lead">{t("이 서버에 접속한 기기입니다. 해지해도 다시 접속할 수 있으니, 완전히 막으려면 서버 토큰을 바꾸세요.")}</p>
	{#if error}<Notice tone="danger">{error}</Notice>{/if}
	{#if devices === null && !error}
		<p class="hint">{t("불러오는 중…")}</p>
	{:else if devices && devices.length === 0}
		<p class="hint">{t("연결된 기기가 없습니다")}</p>
	{:else if devices}
		<ul>
			{#each shown as d (d.id)}
				<li class:live={d.live} animate:reflow in:rowIn out:rowOut>
					<span class="kind" class:on={d.live} title={d.live ? t("연결됨") : t("연결 끊김")}><Icon name={icon(d.platform)} /></span>
					<div class="meta">
						<span class="name">
							{d.name ?? platformName(d.platform)}
							{#if mine(d)}<Badge variant="outline" size="sm">{t("이 기기")}</Badge>{/if}
						</span>
						<span class="sub">{[d.os ?? platformName(d.platform), d.app].filter(Boolean).join(" · ")}</span>
						<span class="sub">
							{d.live ? t("접속 중") : t("마지막 접속 {ago}", { ago: ago(d.lastSeen) })}{d.push ? ` · ${t("모바일 푸시")}` : ""}{d.enabled ? "" : ` · ${t("알림 꺼짐")}`}
						</span>
					</div>
					<ConfirmButton size="sm" confirmLabel={t("정말 해지")} disabled={busy === d.id} onconfirm={() => remove(d)}>{t("해지")}</ConfirmButton>
				</li>
			{/each}
		</ul>
	{/if}

	{#if paired && paired.length}
		<div class="paired">
			<h4 class="section-label">{t("QR로 연결한 기기")}</h4>
			<p class="hint">{t("기기마다 따로 발급된 접속 권한입니다. 취소하면 그 기기만 즉시 접속이 끊기고, 다른 기기와 서버 토큰은 그대로입니다.")}</p>
			<ul>
				{#each paired as p (p.id)}
					<li animate:reflow in:rowIn out:rowOut>
						<span class="kind"><Icon name="phone" /></span>
						<div class="meta">
							<span class="name">{p.name}</span>
							<span class="sub">{p.lastUsedAt ? t("마지막 사용 {ago}", { ago: ago(p.lastUsedAt) }) : t("아직 사용하지 않음")}</span>
						</div>
						<ConfirmButton size="sm" confirmLabel={t("정말 취소")} disabled={revoking === p.id} onconfirm={() => revoke(p.id)}>{t("접속 취소")}</ConfirmButton>
					</li>
				{/each}
			</ul>
		</div>
	{/if}

	<div class="add">
		<Button aria-expanded={adding} onclick={() => (adding = !adding)}>
			<Icon name={adding ? "x" : "plus"} /> {adding ? t("닫기") : t("폰 추가")}
		</Button>
		{#if adding}
			<div class="addbody">{#key serverId}<PairPanel {serverId} />{/key}</div>
		{/if}
	</div>
</div>

<style>
	.paired {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.paired h4 {
		margin: 0;
	}
	.add {
		display: flex;
		flex-direction: column;
		gap: 12px;
		padding-top: 4px;
	}
	.add > :global(.btn) {
		align-self: flex-start;
	}
	.addbody {
		padding-top: 4px;
		border-top: 1px solid var(--border);
	}
	.devices {
		display: flex;
		flex-direction: column;
		gap: 14px;
	}
	.lead {
		margin: 0;
		font-size: var(--fs-sm);
		line-height: 1.55;
		color: var(--text-dim);
		word-break: keep-all;
	}
	.hint {
		margin: 0;
	}
	ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		border: 1px solid var(--border);
		border-radius: var(--radius-panel);
		overflow: hidden;
	}
	li {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 12px 14px;
	}
	li + li {
		border-top: 1px solid var(--border);
	}
	.kind {
		flex: none;
		display: inline-flex;
		color: var(--text-faint);
		opacity: 0.6;
	}
	.kind.on {
		color: var(--ok);
		opacity: 1;
	}
	.kind :global(svg) {
		width: 20px;
		height: 20px;
		stroke-width: 1.8;
	}
	.meta {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 3px;
	}
	.name {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: var(--fs-md);
		font-weight: 600;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.sub {
		font-size: var(--fs-xs);
		color: var(--text-faint);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
