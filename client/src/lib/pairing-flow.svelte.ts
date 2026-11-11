import { describeConnectError, verifyServer } from "./api";
import { hostOf } from "./format";
import { deviceIdentity } from "./notifications";
import { PairingError, redeemPairing, type PairingLink } from "./pairing";
import { t } from "./i18n";

export type Linking = { name: string; baseUrl: string; state: "confirm" | "working" | "done" | "failed"; error?: string };

/** What the flow needs of the store: add the server (true when it was new, false when the address was known) and say something. */
export interface PairingEnv {
  add(input: { name: string; baseUrl: string; token: string }): boolean;
  toast(text: string, kind: "ok" | "error"): void;
}

/**
 * Connecting from a link or QR: the card shown over the whole app. A link that reaches the app (camera, message, command
 * line) only asks first: anyone can craft one that points at their own server, so nothing is redeemed or added until the
 * user confirms the address shown on the card.
 */
export class PairingFlow {
  /** Progress of the connection; drives the card. null = no card. */
  linking = $state<Linking | null>(null);
  private seen = new Set<string>();
  private pending: PairingLink | null = null;

  constructor(private readonly env: PairingEnv) {}

  connect(link: PairingLink): void {
    if (this.seen.has(link.code)) return;
    this.seen.add(link.code);
    this.pending = link;
    this.linking = { name: link.name || hostOf(link.baseUrl), baseUrl: link.baseUrl, state: "confirm" };
  }

  /** The user approved the address on the card: trade the one-time code for the token and add the server. */
  async confirm(): Promise<void> {
    const link = this.pending;
    if (!link || this.linking?.state !== "confirm") return;
    this.pending = null;
    const name = link.name || hostOf(link.baseUrl);
    this.linking = { name, baseUrl: link.baseUrl, state: "working" };
    try {
      const token = await redeemPairing(link, (await deviceIdentity().catch(() => null))?.name);
      await verifyServer(link.baseUrl, token);
      const added = this.env.add({ name: link.name, baseUrl: link.baseUrl, token });
      this.linking = { name, baseUrl: link.baseUrl, state: "done" };
      this.env.toast(added ? t("서버를 추가했습니다") : t("이미 등록된 주소라 정보를 갱신했습니다"), "ok");
    } catch (e) {
      const why: Record<string, string> = {
        expired: t("연결 코드가 만료됐거나 이미 사용됐습니다. PC에서 새 QR을 만들어 주세요."),
        throttled: t("잘못된 코드가 너무 많이 시도됐습니다. 잠시 뒤 다시 시도해 주세요."),
        unsupported: t("이 서버는 QR 연결을 지원하지 않습니다. 서버를 최신 버전으로 업데이트해 주세요."),
        timeout: t("서버 응답 시간이 초과되었습니다."),
        unreachable: t("{url}에 연결할 수 없습니다. 주소와 서버 실행 여부를 확인하세요.", { url: link.baseUrl }),
        failed: t("연결하지 못했습니다."),
      };
      const error = e instanceof PairingError ? (why[e.reason] ?? why.failed!) : describeConnectError(e, link.baseUrl);
      this.linking = { name, baseUrl: link.baseUrl, state: "failed", error };
    }
  }

  close(): void {
    // declining a link frees its code, so scanning the same QR again still works
    if (this.pending) this.seen.delete(this.pending.code);
    this.pending = null;
    this.linking = null;
  }
}
