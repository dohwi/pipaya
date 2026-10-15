import { parsePackage, type ExtensionPackage, type SettingField } from "./schema";
import { LocalizedError, msg, t } from "../i18n";
import { ACTIONS, isActionId } from "../keys";

export const CONFIGURATION_BACKUP = "pipaya.extensions.configuration-backup";
export const SETTINGS_SOURCE = "pipaya.extensions.settings-source";
export const CONFIGURATION_MAX_BYTES = 4 * 1024 * 1024;
/** When the last pre-import backup was taken (ms since epoch), kept next to the backup itself. */
export const CONFIGURATION_BACKUP_AT = "pipaya.extensions.configuration-backup-at";
export const CONFIGURATION_MAX_EXTENSIONS = 50;
export interface ConfigurationDocument {
  schemaVersion: 1;
  servers: { name: string; baseUrl: string }[];
  extensions: { package: ExtensionPackage; enabled: boolean; settings: Record<string, unknown> }[];
  preferences: { theme?: "system" | "light" | "dark"; sound?: boolean; volume?: number };
  /** Shortcuts the user changed from the default (action id -> combo, "" = unbound). Absent in older files. */
  keybindings?: Record<string, string>;
}
export interface ConfigurationJob {
  id: string;
  state: "pending" | "done" | "cancelled" | "error";
  document?: ConfigurationDocument;
  error?: string;
}
export const CONFIGURATION_GRANT = "pipaya.extensions.background-grant.";
/** Keep `backup` as the state to go back to, and remember when it was taken. */
export function saveBackup(backup: unknown, now = Date.now()) {
  localStorage.setItem(CONFIGURATION_BACKUP, JSON.stringify(backup));
  localStorage.setItem(CONFIGURATION_BACKUP_AT, String(now));
}
/** When the saved backup was taken; null when there is none (or it predates the timestamp). */
export function backupSavedAt(): number | null {
  if (!localStorage.getItem(CONFIGURATION_BACKUP)) return null;
  const at = Number(localStorage.getItem(CONFIGURATION_BACKUP_AT));
  return Number.isFinite(at) && at > 0 ? at : null;
}
export function hasBackup(): boolean {
  return localStorage.getItem(CONFIGURATION_BACKUP) !== null;
}

export function publicSettings(settings: Record<string, unknown>, fields: readonly SettingField[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const key = field.key;
    if (field.secret || /token|secret|password|credential|authorization|api.?key|cookie|private|constructor|prototype|__proto__/i.test(key)) continue;
    const value = settings[key];
    if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) out[key] = value;
    else if (typeof value === "string" && value.length <= 2000) {
      if (/https?:\/\//i.test(value)) { try { const u = new URL(value); if (u.username || u.password || u.search || u.hash) continue; } catch { continue; } }
      out[key] = value;
    }
  }
  return out;
}
function record(v: unknown): Record<string, unknown> { if (!v || typeof v !== "object" || Array.isArray(v)) throw new LocalizedError(t("잘못된 설정 객체")); return v as Record<string, unknown>; }
function safeUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048) throw new LocalizedError(t("잘못된 서버 주소"));
  const url = new URL(value);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) throw new LocalizedError(t("서버 주소에는 자격 증명·query를 넣을 수 없습니다"));
  return url.href.replace(/\/+$/, "");
}
export function parseConfiguration(input: unknown, owner = ""): ConfigurationDocument {
  if (new TextEncoder().encode(JSON.stringify(input)).length > CONFIGURATION_MAX_BYTES) throw new LocalizedError(t("설정 데이터는 최대 4MiB입니다"));
  const raw = record(input);
  if (raw.schemaVersion !== 1 || !Array.isArray(raw.servers) || raw.servers.length > 50 || !Array.isArray(raw.extensions) || raw.extensions.length > (owner ? CONFIGURATION_MAX_EXTENSIONS - 1 : CONFIGURATION_MAX_EXTENSIONS)) throw new LocalizedError(t("지원하지 않는 설정 형식"));
  const urls = new Set<string>(), ids = new Set<string>();
  const servers = raw.servers.map(s => {
    const entry = record(s), baseUrl = safeUrl(entry.baseUrl);
    if (typeof entry.name !== "string" || entry.name.length > 80 || urls.has(baseUrl)) throw new LocalizedError(t("중복 또는 잘못된 서버"));
    urls.add(baseUrl); return { name: entry.name, baseUrl };
  });
  const extensions = raw.extensions.map(e => {
    const entry = record(e), pkg = parsePackage(entry.package), id = pkg.manifest.id;
    if (id === owner || ids.has(id) || typeof entry.enabled !== "boolean") throw new LocalizedError(t("중복 또는 잘못된 확장"));
    ids.add(id);
    const settings = record(entry.settings);
    if (JSON.stringify(settings).length > 16000) throw new LocalizedError(t("확장 설정은 최대 16KB입니다"));
    return { package: pkg, enabled: entry.enabled, settings: publicSettings(settings, pkg.manifest.settings ?? []) };
  });
  const p = record(raw.preferences), preferences: ConfigurationDocument["preferences"] = {};
  if (p.theme !== undefined) { if (!["system", "light", "dark"].includes(String(p.theme))) throw new LocalizedError(t("잘못된 테마")); preferences.theme = p.theme as "system" | "light" | "dark"; }
  if (p.sound !== undefined) { if (typeof p.sound !== "boolean") throw new LocalizedError(t("잘못된 알림 설정")); preferences.sound = p.sound; }
  if (p.volume !== undefined) { if (typeof p.volume !== "number" || !Number.isFinite(p.volume) || p.volume < 0 || p.volume > 200) throw new LocalizedError(t("잘못된 볼륨")); preferences.volume = p.volume; }
  const keybindings = raw.keybindings === undefined ? undefined : parseKeybindings(raw.keybindings);
  return { schemaVersion: 1, servers, extensions, preferences, ...(keybindings ? { keybindings } : {}) };
}
/** At most this many bytes of text per combo: "Mod+Alt+Shift" plus three keys is well below it. */
const COMBO_MAX = 80;
/**
 * Shortcuts from a file. Only known, rebindable actions are kept; an unknown id is ignored (a file from a newer
 * version may have more), but a value that is not a combo string is an error so a damaged file is not half applied.
 */
export function parseKeybindings(input: unknown): Record<string, string> {
  const raw = record(input), out: Record<string, string> = {};
  for (const [id, combo] of Object.entries(raw)) {
    if (typeof combo !== "string" || combo.length > COMBO_MAX) throw new LocalizedError(t("잘못된 단축키"));
    if (!isActionId(id) || ACTIONS.find(a => a.id === id)?.fixed) continue;
    out[id] = combo;
  }
  return out;
}
/** Back up the current state, then apply; if applying fails, put the backup back and rethrow. */
export function applyWithBackup(
  a: { backup(): unknown; apply(document: ConfigurationDocument): void; restore(value: unknown): void },
  document: ConfigurationDocument,
) {
  const backup = a.backup();
  saveBackup(backup);
  try { a.apply(document); } catch (error) { a.restore(backup); throw error; }
}
/** Go back to the state saved before the last import. */
export function restoreBackup(a: { restore(value: unknown): void }) {
  const backup = localStorage.getItem(CONFIGURATION_BACKUP);
  if (!backup) throw new LocalizedError(t("백업이 없습니다"));
  a.restore(JSON.parse(backup));
}

/** One short line per kind of change, for the result of an import. */
export function planSummary(plan: ConfigurationPlan): string[] {
  const out: string[] = [], s = plan.servers, e = plan.extensions;
  if (s.add.length) out.push(t("서버 {n}개 추가", { n: s.add.length }));
  if (s.rename.length) out.push(t("서버 {n}개 이름 변경", { n: s.rename.length }));
  if (e.install.length) out.push(t("확장 {n}개 설치", { n: e.install.length }));
  if (e.replace.length) out.push(t("확장 {n}개 교체", { n: e.replace.length }));
  if (plan.preferences.length) out.push(t("앱 설정 {n}개 변경", { n: plan.preferences.length }));
  if (plan.keybindings.length) out.push(t("단축키 {n}개 변경", { n: plan.keybindings.length }));
  return out;
}

/** What importing a document would change, worked out before anything is touched. */
export interface ConfigurationPlan {
  servers: { add: { name: string; baseUrl: string }[]; rename: { baseUrl: string; from: string; to: string }[]; keep: number };
  extensions: { install: { id: string; name: string; version: string }[]; replace: { id: string; name: string; from: string; to: string }[] };
  /** Human-readable app settings that would change ("테마: 다크"). */
  preferences: string[];
  /** Shortcuts the document would change. */
  keybindings: { id: string; from: string; to: string }[];
  /** Why the import cannot go ahead, or null. */
  blocked: string | null;
  /** Nothing in the document would change anything. */
  empty: boolean;
}
const THEME_LABEL: Record<string, string> = { system: msg("시스템"), light: msg("라이트"), dark: msg("다크") };
export interface ConfigurationCurrent {
  /** `baseUrl` normalised the same way the document's are. */
  servers: { name: string; baseUrl: string }[];
  extensions: { id: string; name: string; version: string }[];
  unreadable: { id?: string }[];
  preferences?: ConfigurationDocument["preferences"];
  keybindings?: Record<string, string>;
}
/** Mirrors what `apply` does: servers merge by URL, extensions install by id (always disabled), preferences overwrite. */
export function planConfiguration(doc: ConfigurationDocument, current: ConfigurationCurrent): ConfigurationPlan {
  const add: ConfigurationPlan["servers"]["add"] = [], rename: ConfigurationPlan["servers"]["rename"] = [];
  let keep = 0;
  for (const s of doc.servers) {
    const found = current.servers.find(x => x.baseUrl === s.baseUrl);
    if (!found) add.push(s);
    else if (found.name !== s.name) rename.push({ baseUrl: s.baseUrl, from: found.name, to: s.name });
    else keep++;
  }
  const install: ConfigurationPlan["extensions"]["install"] = [], replace: ConfigurationPlan["extensions"]["replace"] = [];
  for (const e of doc.extensions) {
    const m = e.package.manifest, old = current.extensions.find(x => x.id === m.id);
    if (old) replace.push({ id: m.id, name: m.name, from: old.version, to: m.version });
    else install.push({ id: m.id, name: m.name, version: m.version });
  }
  const p = doc.preferences, cur = current.preferences, preferences: string[] = [];
  if (p.theme !== undefined && p.theme !== cur?.theme) preferences.push(t("테마: {name}", { name: t(THEME_LABEL[p.theme]!) }));
  if (p.sound !== undefined && p.sound !== cur?.sound) preferences.push(t("알림음: {state}", { state: p.sound ? t("켜짐") : t("꺼짐") }));
  if (p.volume !== undefined && p.volume !== cur?.volume) preferences.push(t("알림음 크기: {n}%", { n: p.volume }));
  const keybindings: ConfigurationPlan["keybindings"] = [];
  for (const [id, to] of Object.entries(doc.keybindings ?? {})) {
    const from = current.keybindings?.[id] ?? "";
    if (from !== to) keybindings.push({ id, from, to });
  }
  const fresh = install.filter(e => !current.unreadable.some(u => u.id === e.id)).length;
  const total = current.extensions.length + current.unreadable.length + fresh;
  const blocked = total > CONFIGURATION_MAX_EXTENSIONS ? t("확장은 최대 {max}개까지 설치할 수 있습니다 (가져오면 {total}개).", { max: CONFIGURATION_MAX_EXTENSIONS, total }) : null;
  const empty = !add.length && !rename.length && !install.length && !replace.length && !preferences.length && !keybindings.length;
  return { servers: { add, rename, keep }, extensions: { install, replace }, preferences, keybindings, blocked, empty };
}

/** Generic import/export only: no URLs, authentication, remote revisions or sync protocol. */
export class ConfigurationManager {
  private job: ConfigurationJob | null = null;
  private generation = 0;
  constructor(private adapter: {
    capture(): ConfigurationDocument; apply(document: ConfigurationDocument): void;
    backup(): unknown; restore(value: unknown): void; confirm(message: string): Promise<boolean>;
    authorize?(): void;
  }) {}
  cleanup() { this.generation++; this.job = null; }
  status(): ConfigurationJob | null { return this.job ? JSON.parse(JSON.stringify(this.job)) : null; }
  start(kind: "export" | "apply" | "restore" | "authorize", owner: string, input?: unknown): { id: string } {
    if (this.job?.state === "pending") throw new LocalizedError(t("승인 또는 설정 작업이 진행 중입니다"));
    const document = kind === "apply" ? parseConfiguration(input, owner) : undefined;
    const generation = ++this.generation;
    const job: ConfigurationJob = this.job = { id: String(generation), state: "pending" };
    const message = kind === "authorize" ? t("자동 설정 접근 승인: 이 확장이 실행되는 동안 서버 목록·확장 패키지·비민감 설정을 반복해서 읽고 외부 서버로 전송하며, 일반 설정 변경을 추가 승인 없이 적용할 수 있습니다. 토큰은 제외하고 패키지/활성 상태 변경은 자동 적용하지 않습니다. 승인은 확장 코드와 연결 설정에 묶이며 revoke() 또는 확장 삭제로 해제할 수 있습니다. 허용할까요?")
      : kind === "export" ? t("설정 내보내기: 서버 주소·확장 패키지·비민감 설정을 이 확장에 전달합니다. 확장은 이 데이터를 자신의 서버에 전송할 수 있습니다. 토큰은 제외하지만 코드·기본값에 직접 넣은 비밀값은 제거할 수 없습니다.")
      : kind === "apply" ? t("설정 가져오기: 서버 {servers}개 병합, 확장 {extensions}개 설치·교체. 확장은 비활성으로 복원됩니다. 토큰은 유지하고 적용 전에 로컬 백업을 만듭니다.", { servers: document!.servers.length, extensions: document!.extensions.length })
      : t("설정 복원: 마지막 가져오기 전의 로컬 백업으로 되돌립니다. 확장은 자동 실행하지 않습니다.");
    void (async () => {
      try {
        const approved = await this.adapter.confirm(message);
        if (generation !== this.generation) return;
        if (!approved) { job.state = "cancelled"; return; }
        if (kind === "authorize") { if (!this.adapter.authorize) throw new LocalizedError(t("자동 설정 접근 미지원")); this.adapter.authorize(); }
        else if (kind === "export") job.document = parseConfiguration(this.adapter.capture(), owner);
        else if (kind === "restore") restoreBackup(this.adapter);
        else applyWithBackup(this.adapter, document!);
        job.state = "done";
      } catch (error) { if (generation === this.generation) { job.state = "error"; job.error = error instanceof Error ? error.message : t("설정 작업 실패"); } }
    })();
    return { id: job.id };
  }
}
