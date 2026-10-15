/** A hostname that says nothing about the device ("localhost", an address) is no name. */
export function usefulHostname(host: string | undefined | null): string {
  const h = (host ?? "").trim();
  return !h || /^(localhost(\.localdomain)?|android|::1|0\.0\.0\.0|127\.\d+\.\d+\.\d+)$/i.test(h) ? "" : h;
}
