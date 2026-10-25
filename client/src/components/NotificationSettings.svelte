<script lang="ts">
	import Button from "./Button.svelte";
  import { t } from "../lib/i18n";
  import { onMount } from "svelte";
  import { collapseIn, collapseOut } from "../lib/motion";
  import { ESCALATE_CHOICES, notifications, type TestOutcome } from "../lib/notifications";
  import { app } from "../lib/store.svelte";
  import Switch from "./Switch.svelte";
  import Select from "./Select.svelte";
  import SettingRow from "./SettingRow.svelte";
  let enabled = $state(notifications.enabled);
  let busy = $state(false);
  let error = $state("");
  let background = $state(false);
  onMount(() => { void notifications.status().then(s => { background = s.pushConfigured; }); });
  async function toggle(on: boolean) {
    if (busy) return;
    busy = true; error = "";
    try { await notifications.setEnabled(on); enabled = notifications.enabled; background = (await notifications.status()).pushConfigured; }
    catch (e) { error = e instanceof Error ? e.message : t("알림 설정을 변경하지 못했습니다"); }
    finally { busy = false; }
  }
  let testing = $state(false);
  let outcome = $state<TestOutcome | null>(null);
  async function runTest() {
    if (testing) return;
    testing = true; outcome = null;
    try { outcome = await notifications.test(); } finally { testing = false; }
  }
  /** One line saying what happened and what to do about it. The last step cannot be seen from here: see "shown". */
  const verdict = (o: TestOutcome) => {
    switch (o.step) {
      case "no_server": return t("서버에 연결되어 있지 않습니다");
      case "not_enabled": return t("위의 시스템 알림 스위치가 꺼져 있습니다. 켠 뒤 다시 시험하세요");
      case "no_permission": return t("운영체제가 이 앱의 알림을 허용하지 않았습니다. 운영체제 알림 설정에서 허용하세요");
      case "server_unknown": return t("서버가 이 기기를 알림 수신 기기로 알지 못합니다. 서버를 다시 연결하거나 스위치를 껐다 켜세요");
      case "server_refused": return t("서버가 시험 요청을 받지 않았습니다. 서버가 이전 버전일 수 있습니다") + (o.detail ? ` (${o.detail})` : "");
      case "not_received": return t("서버는 보냈지만 이 앱이 6초 안에 받지 못했습니다. 실시간 연결이 끊겨 있을 수 있습니다");
      case "os_error": return t("앱이 운영체제에 알림을 넘기다 실패했습니다") + (o.detail ? `: ${o.detail}` : "");
      case "shown": return t("앱이 운영체제에 알림을 넘겼습니다. 알림이 보이지 않으면 운영체제가 막은 것입니다: 방해 금지 모드와 이 앱의 알림 허용을 확인하세요");
    }
  };
  const label = (m: number) => (m === 0 ? t("보내지 않음") : m < 60 ? t("{n}분", { n: m }) : t("{n}시간", { n: m / 60 }));
</script>
<div class="section-label">{t("시스템 알림")}</div>
<SettingRow label={t("알림 보내기")} hint={background ? t("작업 완료 · 실패 · 승인 필요 때. 앱이 닫혀 있어도 받습니다") : t("작업 완료 · 실패 · 승인 필요 때. 앱을 보고 있으면 보내지 않습니다")}><Switch checked={enabled} label={t("시스템 알림")} onchange={toggle} /></SettingRow>
{#if busy}<p class="hint" in:collapseIn out:collapseOut>{t("알림 권한을 확인하는 중…")}</p>{/if}
{#if error}<p class="hint danger" role="alert" in:collapseIn out:collapseOut>{error}</p>{/if}

<div class="test">
<SettingRow label={t("시험 알림")}>
  <Button size="sm" onclick={runTest} disabled={testing || !app.api}>{testing ? t("보내는 중…") : t("시험")}</Button>
</SettingRow>
</div>
{#if outcome}
  <p class="result" class:ok={outcome.step === "shown"} role="status" in:collapseIn out:collapseOut>{verdict(outcome)}</p>
  {#if outcome.server}
    <p class="hint">{t("모바일 푸시: 서버 {server} · 이 기기 토큰 {token}", { server: outcome.server.pushConfigured ? t("준비됨") : t("꺼짐"), token: outcome.server.hasToken ? t("있음") : t("없음") })}</p>
  {/if}
{/if}

<SettingRow label={t("폰으로 다시 알림")} hint={t("어느 기기에서도 확인하지 않으면 이 시간 뒤 폰으로 보냅니다 · 모든 기기 공통")} for="escalate">
  <Select id="escalate" size="sm" width="auto" value={app.escalateMinutes} disabled={!app.api} onchange={(m) => app.setEscalateMinutes(m)} options={ESCALATE_CHOICES.map((m) => ({ value: m, label: label(m) }))} />
</SettingRow>
<style>
  .section-label { margin-bottom: 12px; }
  .hint { line-height: 1.6; margin: 10px 0 0; word-break: keep-all; }
  .test { margin-top: 12px; }
  .test + :global(*) { margin-top: 12px; }
  .result { font-size: var(--fs-xs); line-height: 1.6; margin: 10px 0 0; color: var(--danger); word-break: keep-all; }
  .result.ok { color: var(--text-dim); }
</style>
