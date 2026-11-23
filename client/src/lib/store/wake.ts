/** Away longer than this and a mobile OS may have killed the streams: coming back forces a full resync. */
export const LONG_AWAY_MS = 30_000;

/** Minimum interval between burst wake triggers (visibilitychange + focus + pageshow). */
const WAKE_DEBOUNCE_MS = 2_000;

/**
 * Watch browser visibility, focus, pageshow, and online transitions so streams reopen cleanly after sleep or
 * backgrounding. Returns a disposer removing every attached listener.
 *
 * Mobile OSes silently kill background sockets (EventSource gets no error), and Android WebViews sometimes skip
 * visibilitychange, so focus/pageshow wake too while `wake` merges bursts.
 */
export function watchWake(
  onResync: (force: boolean) => void,
  now: () => number = () => Date.now(),
): () => void {
  let wokeAt = 0;
  let onlineAt = 0;
  let leftAt = 0;
  const left = () => {
    if (!leftAt) leftAt = now();
  };
  const wake = () => {
    const t = now();
    if (t - wokeAt < WAKE_DEBOUNCE_MS) return;
    wokeAt = t;
    const away = leftAt ? t - leftAt : Number.POSITIVE_INFINITY;
    leftAt = 0;
    onResync(away >= LONG_AWAY_MS);
  };
  const onVisibility = () => {
    if (document.hidden) left();
    else wake();
  };
  const onOnline = () => {
    const t = now();
    if (t - onlineAt < WAKE_DEBOUNCE_MS) return;
    onlineAt = t;
    onResync(true);
  };
  window.addEventListener("blur", left);
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("focus", wake);
  window.addEventListener("pageshow", wake);
  window.addEventListener("online", onOnline);
  return () => {
    window.removeEventListener("blur", left);
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("focus", wake);
    window.removeEventListener("pageshow", wake);
    window.removeEventListener("online", onOnline);
  };
}
