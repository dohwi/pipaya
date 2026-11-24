<script lang="ts">
	import EmptyState from "../ui/EmptyState.svelte";
	import Notice from "../ui/Notice.svelte";
	import SettingRow from "../ui/SettingRow.svelte";
	import Switch from "../ui/Switch.svelte";
	import { Api, errorText } from "../../lib/api";
	import { t } from "../../lib/i18n";
	import { app } from "../../lib/store.svelte";
	import type { GuardInfo, GuardSettings } from "../../lib/types";

	/**
	 * Built-in bash command guard settings for one server: blocks destructive or high-risk commands before `bash` runs
	 * (main agent and subagents alike). Safe core safeguards default to on; `remoteExec` defaults to off.
	 */
	let { serverId }: { serverId: string } = $props();

	const FALLBACK_SETTINGS: GuardSettings = {
		wipe: true,
		disk: true,
		fork: true,
		permissions: true,
		remoteExec: false,
		systemPower: true,
		forcePush: true,
	};

	const normalize = (data: GuardInfo): GuardInfo => ({
		settings: { ...FALLBACK_SETTINGS, ...data.settings },
		defaults: { ...FALLBACK_SETTINGS, ...data.defaults },
	});

	let info = $state<{ id: string; data: GuardInfo } | null>(null);
	let error = $state("");
	let busy = $state(false);
	let seq = 0;

	const apiOf = (id: string) => {
		const s = app.servers.find((x) => x.id === id);
		return s ? new Api({ baseUrl: s.baseUrl, token: s.token }) : null;
	};

	$effect(() => {
		void app.configTick;
		const id = serverId;
		const mine = ++seq;
		error = "";
		apiOf(id)
			?.guard()
			.then((data) => {
				if (mine === seq) info = { id, data: normalize(data) };
			})
			.catch((e) => {
				if (mine === seq) error = errorText(e);
			});
	});

	const shown = $derived(info && info.id === serverId ? info.data : null);

	async function save(key: keyof GuardSettings, on: boolean) {
		const a = apiOf(serverId);
		if (!a || !shown || busy) return;
		const before = info!;
		const next: GuardSettings = { ...shown.settings, [key]: on };
		info = { id: serverId, data: { ...shown, settings: next } };
		busy = true;
		error = "";
		try {
			info = { id: serverId, data: normalize(await a.setGuard(next)) };
		} catch (e) {
			info = before;
			error = errorText(e);
		} finally {
			busy = false;
		}
	}
</script>

<section class="set-group" data-focus="guard">
	<div class="section-label">{t("위험 명령 차단")}</div>
	{#if shown}
		{@const s = shown.settings}
		<SettingRow label={t("대규모 삭제 차단")} hint={t("루트(/), 홈(~, $HOME), 최상위 시스템 폴더(/etc, /usr, /var 등)에 대한 rm -rf, find -delete, --no-preserve-root를 막습니다.")}>
			<Switch checked={s.wipe} disabled={busy} label={t("대규모 삭제 차단")} onchange={(on) => void save("wipe", on)} />
		</SettingRow>
		<SettingRow label={t("디스크 덮어쓰기 차단")} hint={t("mkfs, wipefs, blkdiscard, sgdisk --zap-all 및 블록 장치(/dev/sd…, nvme…, md…, dm-…)로 향하는 dd, 리디렉션, tee를 막습니다.")}>
			<Switch checked={s.disk} disabled={busy} label={t("디스크 덮어쓰기 차단")} onchange={(on) => void save("disk", on)} />
		</SettingRow>
		<SettingRow label={t("포크 폭탄 차단")} hint={t("시스템 프로세스를 고갈시키는 자기재귀 셸 포크 폭탄 구문을 막습니다.")}>
			<Switch checked={s.fork} disabled={busy} label={t("포크 폭탄 차단")} onchange={(on) => void save("fork", on)} />
		</SettingRow>
		<SettingRow label={t("루트 권한 변경 차단")} hint={t("루트(/), 홈(~, $HOME), 최상위 시스템 폴더 자체에 대한 재귀적 chmod, chown, chgrp 명령을 막습니다.")}>
			<Switch checked={s.permissions} disabled={busy} label={t("루트 권한 변경 차단")} onchange={(on) => void save("permissions", on)} />
		</SettingRow>
		<SettingRow label={t("시스템 종료·재부팅 차단")} hint={t("shutdown, reboot, poweroff, halt, systemctl poweroff/reboot/halt, init 0/6 명령을 막습니다.")}>
			<Switch checked={s.systemPower} disabled={busy} label={t("시스템 종료·재부팅 차단")} onchange={(on) => void save("systemPower", on)} />
		</SettingRow>
		<SettingRow label={t("강제 Git 푸시 차단")} hint={t("원격 히스토리를 덮어쓰는 git push --force(-f)를 막습니다. 안전한 --force-with-lease는 허용합니다.")}>
			<Switch checked={s.forcePush} disabled={busy} label={t("강제 Git 푸시 차단")} onchange={(on) => void save("forcePush", on)} />
		</SettingRow>
		<span class="hint">{t("에이전트와 서브에이전트가 bash 도구를 실행하기 전에 검사합니다. 바꾸면 바로 적용됩니다.")}</span>
	{:else if !error}
		<EmptyState loading />
	{/if}
	{#if error}<Notice tone="danger" size="sm" raised animated>{error}</Notice>{/if}
</section>

{#if shown}
	{@const s = shown.settings}
	<section class="set-group">
		<div class="section-label">{t("추가 명령 보호")}</div>
		<SettingRow label={t("원격 스크립트 즉시 실행 차단")} hint={t("curl이나 wget 출력을 sh, bash 등 셸로 바로 넘겨 실행하는 명령을 막습니다. jq 등 일반 파이프는 허용합니다.")}>
			<Switch checked={s.remoteExec} disabled={busy} label={t("원격 스크립트 즉시 실행 차단")} onchange={(on) => void save("remoteExec", on)} />
		</SettingRow>
		<span class="hint">{t("기본값은 꺼짐입니다. 공유 서버나 운영 환경처럼 더 엄격한 제한이 필요할 때 켜 두세요.")}</span>
	</section>
{/if}

<style>
	section {
		display: flex;
		flex-direction: column;
		gap: 12px; /* rows with a hint line no longer touch the next row */
	}
	section > .hint {
		line-height: 16px;
	}
</style>
