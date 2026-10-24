import type { ExtensionPackage } from "./schema";
import { LocalizedError, t } from "../i18n";

/** A code extension never executes in the application realm. The opaque-origin
 * frame owns a Worker; its CSP is inherited by the blob worker (no network).
 * Only this private MessagePort reaches the capability-checked host. */
const WORKER = `
const pending = new Map(), handlers = new Map(), listeners = new Set(), serverListeners = new Set();
let seq = 0;
const panelTokens = new Map();
function rpc(method, ...args) {
  const id = ++seq;
  if (pending.size >= 100) return Promise.reject(new Error('Too many pending requests'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('SDK request timed out')); }, 5000);
    pending.set(id, { resolve, reject, timer });
    postMessage({ type: 'request', id, method, args });
  });
}
async function register(method, spec, handler) {
  if (typeof handler !== 'function') throw new Error('A handler is required');
  const token = String(++seq);
  handlers.set(token, handler);
  try { await rpc(method, spec, token); } catch (e) { handlers.delete(token); throw e; }
  return token;
}
const sdk = Object.freeze({
  version: 1,
  commands: Object.freeze({ register: (spec, fn) => register('commands.register', spec, fn) }),
  composer: Object.freeze({ setText: text => rpc('composer.setText', text), registerAction: (spec, fn) => register('composer.registerAction', spec, fn) }),
  ui: Object.freeze({
    registerPanel: async (spec, fn) => { const token = await register('ui.registerPanel', spec, fn); panelTokens.set(spec.id, token); },
    update: (id, view, options) => options === undefined ? rpc('ui.update', id, view) : rpc('ui.update', id, view, options),
    open: id => rpc('ui.open', id),
    close: id => rpc('ui.close', id),
    remove: async id => { await rpc('ui.remove', id); handlers.delete(panelTokens.get(id)); panelTokens.delete(id); }
  }),
  navbar: Object.freeze({ set: (id, spec) => rpc('navbar.set', id, spec), remove: id => rpc('navbar.remove', id) }),
  http: Object.freeze({ getJson: (...args) => args.length !== 1 ? Promise.reject(new Error('http.getJson takes exactly one argument')) : rpc('http.getJson', args[0]), requestJson: request => rpc('http.requestJson', request) }),
  configuration: Object.freeze({ authorize: () => rpc('configuration.authorize'), revoke: () => rpc('configuration.revoke'), access: () => rpc('configuration.access'), read: () => rpc('configuration.read'), applyBackground: (document, fingerprint) => rpc('configuration.applyBackground', document, fingerprint), export: () => rpc('configuration.export'), apply: document => rpc('configuration.apply', document), restore: () => rpc('configuration.restore'), status: () => rpc('configuration.status') }),
  server: Object.freeze({
    call: (extension, method, params, sessionId) => rpc('server.call', extension, method, params === undefined ? null : params, sessionId === undefined ? null : sessionId),
    entries: options => rpc('server.entries', options === undefined ? {} : options),
    list: () => rpc('server.list'),
    on: async fn => { if (typeof fn !== 'function') throw new Error('A listener is required'); await rpc('server.subscribe'); serverListeners.add(fn); return () => serverListeners.delete(fn); }
  }),
  shortcuts: Object.freeze({ register: (spec, fn) => register('shortcuts.register', spec, fn), remove: id => rpc('shortcuts.remove', id) }),
  dialog: Object.freeze({ confirm: spec => rpc('dialog.confirm', spec), select: spec => rpc('dialog.select', spec), input: spec => rpc('dialog.input', spec) }),
  session: Object.freeze({ send: (text, mode) => rpc('session.send', text, mode === undefined ? 'prompt' : mode), abort: () => rpc('session.abort') }),
  panes: Object.freeze({
    list: () => rpc('panes.list'), group: () => rpc('panes.group'),
    read: (id, options) => rpc('panes.read', id, options === undefined ? null : options),
    focus: id => rpc('panes.focus', id),
    send: (id, text, mode) => rpc('panes.send', id, text, mode === undefined ? 'prompt' : mode),
    abort: id => rpc('panes.abort', id),
    split: (id, edge, options) => rpc('panes.split', id, edge, options === undefined ? null : options),
    move: (id, target, edge) => rpc('panes.move', id, target, edge),
    swap: (a, b) => rpc('panes.swap', a, b),
    resize: (id, ratio) => rpc('panes.resize', id, ratio),
    leave: id => rpc('panes.leave', id), close: id => rpc('panes.close', id),
    zoom: id => rpc('panes.zoom', id === undefined ? null : id),
    models: () => rpc('panes.models'), configure: (id, settings) => rpc('panes.configure', id, settings),
    compact: (id, instructions) => rpc('panes.compact', id, instructions === undefined ? null : instructions)
  }),
  tools: Object.freeze({ registerRenderer: (toolName, fn) => register('tools.registerRenderer', toolName, fn), removeRenderer: toolName => rpc('tools.removeRenderer', toolName) }),
  messages: Object.freeze({ registerRenderer: (entryType, fn) => register('messages.registerRenderer', entryType, fn), removeRenderer: entryType => rpc('messages.removeRenderer', entryType), setHeader: pattern => rpc('messages.setHeader', pattern), clearHeader: () => rpc('messages.clearHeader') }),
  sessionLabels: Object.freeze({ set: labels => rpc('sessionLabels.set', labels) }),
  mentions: Object.freeze({ set: items => rpc('mentions.set', items) }),
  components: Object.freeze({ setData: value => rpc('components.setData', value === undefined ? null : value) }),
  slots: Object.freeze({ set: (slot, id, spec) => rpc('slots.set', slot, id, spec), remove: (slot, id) => rpc('slots.remove', slot, id) }),
  composerFilter: Object.freeze({ set: fn => register('composerFilter.set', 'filter', fn), clear: () => rpc('composerFilter.clear') }),
  status: Object.freeze({ set: (id, text) => rpc('status.set', id, text), remove: id => rpc('status.remove', id) }),
  context: Object.freeze({ get: () => rpc('context.get') }),
  storage: Object.freeze({ get: key => rpc('storage.get', key), set: (key, value) => rpc('storage.set', key, value) }),
  settings: Object.freeze({ get: () => rpc('settings.get') }),
  notifications: Object.freeze({ show: text => rpc('notifications.show', text), send: spec => rpc('notifications.send', spec), status: () => rpc('notifications.status'), register: (id, rule) => rpc('notifications.register', id, rule), remove: id => rpc('notifications.remove', id) }),
  events: Object.freeze({ on: async fn => { if (typeof fn !== 'function') throw new Error('A listener is required'); await rpc('events.subscribe'); listeners.add(fn); return () => listeners.delete(fn); } }),
  log: (...args) => rpc('log', args.map(x => String(x)).join(' '))
});
for (const level of ['log', 'info', 'warn', 'error']) console[level] = (...args) => { void sdk.log(...args).catch(() => {}); };
onmessage = async ({ data: m }) => {
  if (m.type === 'ping') { postMessage({ type: 'pong' });
  } else if (m.type === 'response') {
    const p = pending.get(m.id); if (!p) return;
    pending.delete(m.id); clearTimeout(p.timer);
    m.error ? p.reject(new Error(m.error)) : p.resolve(m.value);
  } else if (m.type === 'execute') {
    try { const fn = handlers.get(m.token); if (!fn) throw new Error('Unknown handler'); const value = await fn(m.arg); postMessage({ type: 'executed', id: m.id, value: value === undefined ? null : value }); }
    catch(e) { postMessage({ type: 'executed', id: m.id, error: String(e?.message || e) }); }
  } else if (m.type === 'server_event') {
    for (const fn of serverListeners) Promise.resolve().then(() => fn(m.event)).catch(e => console.error(e));
  } else if (m.type === 'event') {
    for (const fn of listeners) Promise.resolve().then(() => fn(m.event)).catch(e => console.error(e));
  } else if (m.type === 'start') {
    try {
      // Fail closed on WebViews that do not inherit the sandbox CSP.
      let connectBlocked = false, scriptBlocked = false;
      try { await fetch('data:,extension-csp-probe'); } catch { connectBlocked = true; }
      try { importScripts('data:,'); } catch { scriptBlocked = true; }
      if (!connectBlocked || !scriptBlocked) throw new Error('Sandbox CSP is not enforced on this WebView');
      const fn = new Function('sdk', '"use strict"; return (async () => {\\n' + m.code + '\\n})();');
      await fn(sdk); postMessage({ type: 'ready' });
    } catch(e) { postMessage({ type: 'fatal', error: String(e?.message || e) }); }
  }
};
`;

export const SANDBOX_CSP = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:; worker-src blob:; connect-src 'none'; img-src 'none'; style-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'";
export const SANDBOX_HTML = `<!doctype html><meta http-equiv="Content-Security-Policy" content="${SANDBOX_CSP}"><script>
addEventListener('message', function init(e) {
  if (e.source !== parent || !e.ports[0]) return;
  removeEventListener('message', init);
  const port = e.ports[0];
  const url = URL.createObjectURL(new Blob([${JSON.stringify(WORKER)}], {type:'text/javascript'}));
  try {
    const worker = new Worker(url); URL.revokeObjectURL(url);
    worker.onmessage = e => port.postMessage(e.data);
    worker.onerror = () => port.postMessage({type:'fatal',error:'Worker execution failed'});
    port.onmessage = e => worker.postMessage(e.data);
    port.start(); worker.postMessage({type:'start',code:e.data.code});
  } catch (err) { port.postMessage({type:'fatal',error:String(err)}); }
});
</script>`;

export interface RuntimeCallbacks {
  request(method: string, args: unknown[]): unknown | Promise<unknown>;
  failed(error: string): void;
}

export class ExtensionRuntime {
  private frame: HTMLIFrameElement | null = null;
  private port: MessagePort | null = null;
  private pending = new Map<number, { resolve(value?: unknown): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private seq = 0;
  private stopped = false;
  private startup?: { resolve(): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout> };
  private count = 0;
  private windowAt = Date.now();
  private heartbeat?: ReturnType<typeof setInterval>;
  private pongDeadline?: ReturnType<typeof setTimeout>;

  constructor(private callbacks: RuntimeCallbacks) {}

  start(pkg: ExtensionPackage): Promise<void> {
    return new Promise((resolve, reject) => {
      this.startup = { resolve, reject, timer: setTimeout(() => this.fail(t("확장 시작 시간 초과")), 5000) };
      const frame = this.frame = document.createElement("iframe");
      frame.hidden = true;
      frame.title = `Extension sandbox: ${pkg.manifest.id}`;
      frame.setAttribute("sandbox", "allow-scripts");
      frame.setAttribute("referrerpolicy", "no-referrer");
      frame.srcdoc = SANDBOX_HTML;
      frame.onload = () => {
        if (this.stopped || this.port) return;
        const channel = new MessageChannel();
        this.port = channel.port1;
        channel.port1.onmessage = e => void this.receive(e.data);
        frame.contentWindow?.postMessage({ code: pkg.code }, "*", [channel.port2]);
      };
      document.body.append(frame);
    });
  }

  private async receive(raw: unknown) {
    if (this.stopped) return;
    if (Date.now() - this.windowAt > 1000) { this.windowAt = Date.now(); this.count = 0; }
    if (++this.count > 200) return this.fail(t("확장 메시지 제한 초과"));
    if (!raw || typeof raw !== "object") return this.fail(t("잘못된 확장 메시지"));
    const m = raw as Record<string, unknown>;
    if (m.type === "ready" && this.startup) {
      clearTimeout(this.startup.timer); this.startup.resolve(); this.startup = undefined;
      this.heartbeat = setInterval(() => {
        // Background tabs may delay timers; issue a fresh ping rather than
        // comparing wall-clock timestamps after a suspended WebView resumes.
        if (this.pongDeadline || this.stopped) return;
        this.port?.postMessage({ type: "ping" });
        this.pongDeadline = setTimeout(() => this.fail(t("확장 응답 없음 · 실행 중지")), 5000);
      }, 4000);
    } else if (m.type === "pong") {
      clearTimeout(this.pongDeadline); this.pongDeadline = undefined;
    } else if (m.type === "fatal") {
      this.fail(typeof m.error === "string" ? m.error.slice(0, 500) : t("확장 실행 오류"));
    } else if (m.type === "executed" && typeof m.id === "number") {
      const p = this.pending.get(m.id);
      if (p) { clearTimeout(p.timer); this.pending.delete(m.id); m.error ? p.reject(new Error(String(m.error).slice(0, 500))) : p.resolve(m.value); }
    } else if (m.type === "request" && Number.isSafeInteger(m.id) && typeof m.method === "string" && Array.isArray(m.args)) {
      try {
        const limit = ["configuration.apply", "configuration.applyBackground", "http.requestJson"].includes(m.method) ? 4 * 1024 * 1024 + 4096 : 70000;
        if (m.args.length > 10 || new TextEncoder().encode(JSON.stringify(m.args)).length > limit) throw new LocalizedError(t("SDK 요청 크기 제한 초과"));
        const value = await this.callbacks.request(m.method, m.args);
        if (!this.stopped) this.port?.postMessage({ type: "response", id: m.id, value });
      } catch (e) {
        if (!this.stopped) this.port?.postMessage({ type: "response", id: m.id, error: e instanceof Error ? e.message : t("SDK 요청 실패") });
      }
    } else this.fail(t("잘못된 확장 프로토콜"));
  }

  /** Runs a handler of the extension and returns what it returned (plain data; only renderers use it). */
  execute(token: string, arg: unknown = ""): Promise<unknown> {
    if (this.stopped || !this.port) return Promise.reject(new LocalizedError(t("확장이 실행 중이 아닙니다")));
    if (this.pending.size >= 20) return Promise.reject(new LocalizedError(t("동시 실행 제한 초과")));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, timer: setTimeout(() => this.fail(t("확장 실행 시간 초과")), 10000) });
      this.port!.postMessage({ type: "execute", id, token, arg });
    });
  }

  event(event: unknown) { if (!this.stopped) this.port?.postMessage({ type: "event", event }); }
  serverEvent(event: unknown) { if (!this.stopped) this.port?.postMessage({ type: "server_event", event }); }

  private fail(error: string) {
    if (this.stopped) return;
    this.stop(error);
    this.callbacks.failed(error);
  }

  stop(reason = t("확장이 비활성화되었습니다")) {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.heartbeat); clearTimeout(this.pongDeadline);
    this.port?.close(); this.port = null;
    this.frame?.remove(); this.frame = null;
    if (this.startup) { clearTimeout(this.startup.timer); this.startup.reject(new Error(reason)); this.startup = undefined; }
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(reason)); }
    this.pending.clear();
  }
}
