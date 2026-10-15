import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { compileModule } from "svelte/compiler";
import ts from "typescript";
import type { ExtensionHost as Host, ExtensionPanel, HostAdapter } from "../src/lib/extensions/host.svelte";
import type { UIEvent, UINode } from "../src/lib/extensions/ui";

// As in extensions-host.test.ts, compile the actual rune host and replace only the sandbox.
// UI payloads are objects, not command strings: the fake deliberately accepts unknown arguments.
const FAKE_RUNTIME = `
const created = (globalThis.__uiHostRuntimes ??= []);
export class ExtensionRuntime {
  executed = []; stopped = false;
  constructor(callbacks) { this.callbacks = callbacks; created.push(this); }
  async start(pkg) { await globalThis.__uiHostRuntimeStart?.(this); }
  execute(token, arg) {
    if (this.stopped) return Promise.reject(new Error("stopped"));
    this.executed.push({ token, arg });
    return Promise.resolve();
  }
  event() {}
  stop() { this.stopped = true; }
}
`;
interface FakeRuntime {
  callbacks: { request(method: string, args: unknown[]): unknown; failed(error: string): void };
  executed: { token: string; arg: unknown }[];
  stopped: boolean;
}
type TestGlobals = typeof globalThis & {
  __uiHostRuntimes?: FakeRuntime[];
  __uiHostRuntimeStart?: (runtime: FakeRuntime) => void | Promise<void>;
};
const globals = globalThis as TestGlobals;
const runtimes = () => (globals.__uiHostRuntimes ??= []);
let ExtensionHost: new () => Host;
let dir: string;
const storage = new Map<string, string>();
const hosts: Host[] = [];
const originalGlobals = new Map<string, PropertyDescriptor | undefined>();
function defineGlobal(name: string, value: unknown) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

beforeAll(async () => {
  for (const name of ["localStorage", "location", "document"]) {
    originalGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  }
  dir = await mkdtemp(join(tmpdir(), "harness-extensions-ui-host-"));
  const fakeFile = join(dir, "fake-runtime.js");
  await writeFile(fakeFile, FAKE_RUNTIME);
  const build = await Bun.build({
    entrypoints: [resolve("src/lib/extensions/host.svelte.ts")], target: "bun",
    plugins: [{ name: "runes", setup(builder) {
      builder.onResolve({ filter: /^\.\/runtime$/ }, () => ({ path: fakeFile }));
      builder.onLoad({ filter: /\.svelte\.ts$/ }, async ({ path }) => {
        const source = ts.transpileModule(await Bun.file(path).text(), {
          compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
        }).outputText;
        return { contents: compileModule(source, { filename: path, generate: "client" }).js.code, loader: "js" };
      });
    } }],
  });
  if (!build.success) throw new Error(build.logs.join("\n"));
  const file = join(dir, "host.mjs");
  await writeFile(file, await build.outputs[0]!.text());
  ExtensionHost = (await import(file)).ExtensionHost;
});
afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  for (const [name, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  delete globals.__uiHostRuntimes;
  delete globals.__uiHostRuntimeStart;
});
beforeEach(() => {
  storage.clear(); runtimes().length = 0;
  delete globals.__uiHostRuntimeStart;
  defineGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, String(value)); },
    removeItem: (key: string) => { storage.delete(key); },
  });
  defineGlobal("location", { search: "" });
  defineGlobal("document", { documentElement: { style: { setProperty() {}, removeProperty() {} } } });
});
afterEach(() => { for (const host of hosts.splice(0)) host.stop(); });

function newHost() {
  const host = new ExtensionHost();
  const calls = { prefill: [] as string[], notify: [] as string[], context: 0 };
  const adapter: HostAdapter = {
    prefill: text => { calls.prefill.push(text); },
    notify: text => { calls.notify.push(text); },
    context: () => { calls.context++; throw new Error("UI must not access app context"); },
    dark: () => true,
    reservedCommands: () => ["help", "stop"],
  };
  host.init(adapter); hosts.push(host);
  return { host, calls };
}
function pkg(id = "example.ui", permissions = ["ui"], code = "/* fake UI extension */") {
  return { manifest: { id, name: `Name ${id}`, version: "1.0.0", sdkVersion: 1, permissions }, code };
}
async function activate(host: Host, id = "example.ui", permissions = ["ui"]) {
  host.install(pkg(id, permissions));
  await host.enable(id);
  expect(host.find(id).state).toBe("active");
  return { id, runtime: runtimes().at(-1)! };
}
function call(host: Host, id: string, method: string, args: unknown[] = [], runtime = runtimes().at(-1)): unknown {
  return (host as unknown as { request(id: string, method: string, args: unknown[], runtime: unknown): unknown })
    .request(id, method, args, runtime);
}
const button = (id = "go", disabled = false): UINode => ({ type: "button", id, label: "Go", disabled });
function spec(id = "tools", view: UINode = button()) { return { id, title: "Tools", view }; }
function register(host: Host, owner: string, id = "tools", view: UINode = button(), token = "ui-handler", runtime?: FakeRuntime) {
  call(host, owner, "ui.registerPanel", [spec(id, view), token], runtime);
  return host.panels.find(panel => panel.owner === owner && panel.id === id)!;
}
const run = (panel: ExtensionPanel, event: unknown) => panel.run(event as UIEvent);
const action = { type: "action", id: "go" } as const;
function form(): UINode {
  return { type: "form", id: "settings", submitLabel: "Save", children: [
    { type: "input", id: "name", label: "Name", value: "Default", required: true, minLength: 2, maxLength: 10 },
    { type: "textarea", id: "notes", label: "Notes", value: "Default notes" },
    { type: "select", id: "choice", label: "Choice", value: "a", required: true,
      options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] },
    { type: "checkbox", id: "accept", label: "Accept", checked: true, required: true },
    { type: "input", id: "locked", label: "Locked", disabled: true, value: "private" },
    button(),
  ] };
}
const values = () => ({ name: "Ada", notes: "", choice: "b", accept: true });

describe("UI permission and registration", () => {
  test("each UI method independently checks ui permission before inspecting arguments", async () => {
    const { host, calls } = newHost();
    const allowed = await activate(host, "example.allowed");
    register(host, allowed.id, "tools", button(), "allowed", allowed.runtime);
    call(host, allowed.id, "ui.open", ["tools"], allowed.runtime);
    const denied = await activate(host, "example.denied", ["composer", "context"]);
    const panels = host.panels;
    const requests: [string, unknown[]][] = [
      ["ui.registerPanel", [spec(), "denied"]], ["ui.update", ["tools", button("new")]],
      ["ui.open", ["tools"]], ["ui.close", ["tools"]], ["ui.remove", ["tools"]],
    ];
    for (const [method, args] of requests) {
      expect(() => call(host, denied.id, method, args, denied.runtime), method).toThrow(/권한|permission/i);
      expect(() => call(host, denied.id, method, [null], denied.runtime), method).toThrow(/권한|permission/i);
      expect(host.panels).toBe(panels);
      expect(host.activePanel).toBe(`${allowed.id}:tools`);
      expect(host.panelOpen).toBe(true);
    }
    expect(denied.runtime.executed).toEqual([]);
    expect(calls).toEqual({ prefill: [], notify: [], context: 0 });
  });

  test("registration stores a detached validated spec, defaults to a separate panel, and does not execute", async () => {
    const { host, calls } = newHost();
    const { id, runtime } = await activate(host);
    const view: UINode = { type: "stack", id: "root", children: [button()] };
    const input = { ...spec("tools", view), description: "Tool description" };
    call(host, id, "ui.registerPanel", [input, "handler"], runtime);
    const panel = host.panels[0]!;
    expect(panel).toMatchObject({ owner: id, id: "tools", title: "Tools", description: "Tool description", revision: 0, view });
    // placement is optional in the contract; omission has the same behavior as "panel".
    expect(panel.placement ?? "panel").toBe("panel");
    expect(panel.view).not.toBe(view);
    expect((panel.view as Extract<UINode, { type: "stack" }>).children).not.toBe(view.children);
    input.title = "Mutated";
    (view.children[0] as Extract<UINode, { type: "button" }>).label = "Mutated";
    expect(panel.title).toBe("Tools");
    expect(panel.view).toEqual({ type: "stack", id: "root", children: [button()] });
    call(host, id, "ui.open", ["tools"], runtime);
    expect(host.activePanel).toBe(`${id}:tools`);
    expect(host.panelOpen).toBe(true);
    expect(runtime.executed).toEqual([]);
    expect(calls).toEqual({ prefill: [], notify: [], context: 0 });
  });

  test("malformed specs, unsafe view surfaces, and invalid handler tokens register nothing", async () => {
    const { host } = newHost();
    const { id, runtime } = await activate(host);
    const badSpecs = [null, { ...spec(), id: "Bad" }, { ...spec(), title: "" },
      { ...spec(), placement: "modal" }, { ...spec(), owner: "example.other" },
      spec("tools", { ...button(), onclick: "steal()" } as UINode),
      spec("tools", { type: "html", id: "raw", html: "<script>steal()</script>" } as unknown as UINode)];
    for (const bad of badSpecs) {
      expect(() => call(host, id, "ui.registerPanel", [bad, "handler"], runtime)).toThrow();
      expect(host.panels).toEqual([]);
    }
    for (const token of [null, 1, "", "x".repeat(41)]) {
      expect(() => call(host, id, "ui.registerPanel", [spec(), token], runtime)).toThrow();
      expect(host.panels).toEqual([]);
    }
    expect(runtime.executed).toEqual([]);
  });

  test("duplicate IDs are owner-local and the five-panel cap is enforced without mutation", async () => {
    const { host } = newHost();
    const a = await activate(host, "example.alpha");
    register(host, a.id, "p0", button(), "a", a.runtime);
    const before = host.panels;
    expect(() => register(host, a.id, "p0", button(), "duplicate", a.runtime)).toThrow();
    expect(host.panels).toBe(before);
    for (let i = 1; i < 5; i++) register(host, a.id, `p${i}`, button(), `a${i}`, a.runtime);
    const full = host.panels;
    expect(() => register(host, a.id, "p5", button(), "sixth", a.runtime)).toThrow();
    expect(host.panels).toBe(full);
    const b = await activate(host, "example.beta");
    register(host, b.id, "p0", button(), "b", b.runtime);
    expect(host.panels.filter(panel => panel.owner === a.id)).toHaveLength(5);
    expect(host.panels.filter(panel => panel.owner === b.id)).toHaveLength(1);
    call(host, a.id, "ui.remove", ["p0"], a.runtime);
    register(host, a.id, "replacement", button(), "fresh", a.runtime);
    expect(host.panels.filter(panel => panel.owner === a.id)).toHaveLength(5);
  });

  test("composer contributions cannot be opened as a separate panel", async () => {
    const { host } = newHost();
    const { id, runtime } = await activate(host);
    call(host, id, "ui.registerPanel", [{ ...spec(), placement: "composer" }, "handler"], runtime);
    expect(host.panels[0]!.placement).toBe("composer");
    expect(() => call(host, id, "ui.open", ["tools"], runtime)).toThrow();
    expect(() => host.openPanel(id, "tools")).toThrow();
    expect(host.activePanel).toBeNull();
    expect(host.panelOpen).toBe(false);
    await host.panels[0]!.run(action);
    expect(runtime.executed).toEqual([{ token: "handler", arg: action }]);
  });
});

describe("UI updates and owner isolation", () => {
  test("updates replace arrays and entries immutably, increment revision, and detach the new view", async () => {
    const { host } = newHost();
    const { id, runtime } = await activate(host);
    const original = register(host, id);
    const other = register(host, id, "other");
    const before = host.panels;
    const view: UINode = { type: "stack", id: "root", children: [button("next")] };
    call(host, id, "ui.update", ["tools", view], runtime);
    const updated = host.panels[0]!;
    expect(host.panels).not.toBe(before);
    expect(updated).not.toBe(original);
    expect(updated).toMatchObject({ owner: id, id: "tools", title: "Tools", revision: 1, view });
    expect(updated.run).toBe(original.run);
    expect(updated.view).not.toBe(view);
    expect(original.revision).toBe(0);
    expect(original.view).toEqual(button());
    expect(host.panels[1]).toBe(other);
    view.children.length = 0;
    expect(updated.view).toEqual({ type: "stack", id: "root", children: [button("next")] });
    call(host, id, "ui.update", ["tools", button("latest")], runtime);
    expect(host.panels[0]!.revision).toBe(2);
    expect(updated.revision).toBe(1);
  });

  test("bad views cannot partially update a panel, its revision, or its open state", async () => {
    const { host } = newHost();
    const { id, runtime } = await activate(host);
    const panel = register(host, id);
    call(host, id, "ui.open", ["tools"], runtime);
    const before = host.panels;
    const badViews = [null, { type: "stack", id: "root", children: [button("valid"), { type: "button", id: "invalid" }] },
      { type: "stack", id: "root", children: [button(), button()] }, { ...button(), style: "position:fixed" }];
    for (const view of badViews) {
      expect(() => call(host, id, "ui.update", ["tools", view], runtime)).toThrow();
      expect(host.panels).toBe(before);
      expect(host.panels[0]).toBe(panel);
      expect(panel.revision).toBe(0);
      expect(panel.view).toEqual(button());
      expect(host.activePanel).toBe(`${id}:tools`);
      expect(host.panelOpen).toBe(true);
    }
    expect(() => call(host, id, "ui.update", ["missing", button()], runtime)).toThrow();
    expect(host.panels).toBe(before);
  });

  test("update, open, close, and remove cannot target another owner's panel", async () => {
    const { host } = newHost();
    const a = await activate(host, "example.alpha");
    const b = await activate(host, "example.beta");
    const aPanel = register(host, a.id, "private", button(), "a", a.runtime);
    register(host, b.id, "own", button(), "b", b.runtime);
    call(host, a.id, "ui.open", ["private"], a.runtime);
    const before = host.panels;
    for (const [method, args] of [["ui.update", ["private", button("stolen")]], ["ui.open", ["private"]],
      ["ui.close", ["private"]]] as [string, unknown[]][]) {
      expect(() => call(host, b.id, method, args, b.runtime), method).toThrow();
      expect(host.panels).toBe(before);
    }
    // Removing an absent owner-local ID is an idempotent no-op, not a cross-owner delete.
    call(host, b.id, "ui.remove", ["private"], b.runtime);
    expect(host.panels).toEqual(before);
    expect(host.panels.find(panel => panel.owner === a.id)).toBe(aPanel);
    call(host, b.id, "ui.close", ["own"], b.runtime);
    expect(host.activePanel).toBe(`${a.id}:private`);
    expect(host.panelOpen).toBe(true);
    register(host, b.id, "private", button(), "b-private", b.runtime);
    call(host, b.id, "ui.update", ["private", button("beta")], b.runtime);
    expect(aPanel.view).toEqual(button());
    call(host, b.id, "ui.open", ["private"], b.runtime);
    call(host, a.id, "ui.close", ["private"], a.runtime);
    call(host, a.id, "ui.remove", ["private"], a.runtime);
    expect(host.activePanel).toBe(`${b.id}:private`);
    expect(host.panelOpen).toBe(true);
    expect(host.panels.some(panel => panel.owner === b.id && panel.id === "private")).toBe(true);
    call(host, b.id, "ui.close", ["private"], b.runtime);
    expect(host.panelOpen).toBe(false);
    call(host, b.id, "ui.open", ["private"], b.runtime);
    call(host, b.id, "ui.remove", ["private"], b.runtime);
    expect(host.activePanel).toBeNull();
    expect(host.panelOpen).toBe(false);
  });
});

describe("validated UI handler events", () => {
  test("dynamic handlers receive detached typed action, change, and submit objects, without app context", async () => {
    const { host, calls } = newHost();
    const { id, runtime } = await activate(host);
    const panel = register(host, id, "tools", form(), "typed-handler", runtime);
    const events: UIEvent[] = [action, { type: "change", id: "name", value: "Grace" },
      { type: "change", id: "accept", value: false }, { type: "submit", id: "settings", values: values() }];
    for (const event of events) {
      await panel.run(event);
      const execution = runtime.executed.at(-1)!;
      expect(execution).toEqual({ token: "typed-handler", arg: event });
      expect(execution.arg).not.toBe(event);
      expect(typeof execution.arg).toBe("object");
    }
    const submitted = runtime.executed.at(-1)!.arg as Extract<UIEvent, { type: "submit" }>;
    expect(submitted.values).not.toBe((events[3] as typeof submitted).values);
    (events[3] as typeof submitted).values.name = "Mutated";
    expect(submitted.values.name).toBe("Ada");
    expect(calls).toEqual({ prefill: [], notify: [], context: 0 });
  });

  test("malformed, wrong-target, and disabled events never execute a handler", async () => {
    const { host } = newHost();
    const { id, runtime } = await activate(host);
    const view: UINode = { type: "stack", id: "root", children: [form(), button("blocked", true),
      { type: "form", id: "disabled-form", submitLabel: "No", disabled: true, children: [
        button("nested"), { type: "input", id: "nested-field", label: "Nested" }] }] };
    const panel = register(host, id, "tools", view);
    const badEvents = [null, {}, "go", { type: "unknown", id: "go" }, { type: "action", id: "missing" },
      { type: "action", id: "go", value: "extra" }, { type: "action", id: "name" },
      { type: "action", id: "blocked" }, { type: "action", id: "nested" },
      { type: "change", id: "go", value: "text" }, { type: "change", id: "name" },
      { type: "change", id: "name", value: true }, { type: "change", id: "accept", value: "true" },
      { type: "change", id: "choice", value: "not-an-option" }, { type: "change", id: "locked", value: "changed" },
      { type: "change", id: "nested-field", value: "text" }, { type: "submit", id: "go", values: {} },
      { type: "submit", id: "disabled-form", values: { "nested-field": "text" } }];
    for (const event of badEvents) {
      await expect(run(panel, event), JSON.stringify(event)).rejects.toThrow();
      expect(runtime.executed).toEqual([]);
    }
  });

  test("captured callbacks validate actions, changes, and submissions against the current updated view", async () => {
    const { host } = newHost();
    const { id, runtime } = await activate(host);
    const staleViewPanel = register(host, id, "tools", form());
    const next = form() as Extract<UINode, { type: "form" }>;
    next.children = next.children.map<UINode>(node => node.id === "go" ? button("next") : node.id === "choice"
      ? { type: "select", id: "choice", label: "Choice", required: true, options: [{ value: "c", label: "C" }] }
      : node.id === "name" ? { ...node, value: "Ada", maxLength: 3 } as UINode : node);
    call(host, id, "ui.update", ["tools", next], runtime);
    const invalid: UIEvent[] = [action, { type: "change", id: "name", value: "Grace" },
      { type: "change", id: "choice", value: "b" }, { type: "submit", id: "settings", values: values() }];
    for (const event of invalid) await expect(staleViewPanel.run(event)).rejects.toThrow();
    expect(runtime.executed).toEqual([]);
    const valid: UIEvent[] = [{ type: "action", id: "next" }, { type: "change", id: "choice", value: "c" },
      { type: "submit", id: "settings", values: { ...values(), choice: "c" } }];
    for (const event of valid) await staleViewPanel.run(event);
    expect(runtime.executed).toEqual(valid.map(arg => ({ token: "ui-handler", arg })));
    call(host, id, "ui.update", ["tools", { ...next, disabled: true }], runtime);
    for (const event of valid) await expect(staleViewPanel.run(event)).rejects.toThrow();
    expect(runtime.executed).toHaveLength(3);
  });

  test("submit requires every enabled field explicitly even when the view supplies defaults", async () => {
    const { host } = newHost();
    const { id, runtime } = await activate(host);
    const panel = register(host, id, "tools", form());
    for (const key of Object.keys(values())) {
      const missing: Record<string, string | boolean> = values();
      delete missing[key];
      await expect(run(panel, { type: "submit", id: "settings", values: missing }), key).rejects.toThrow();
    }
    const invalidValues = [{}, { ...values(), name: "" }, { ...values(), name: "A" },
      { ...values(), name: "x".repeat(11) }, { ...values(), choice: "" }, { ...values(), choice: "unknown" },
      { ...values(), accept: false }, { ...values(), notes: true }, { ...values(), locked: "injected" },
      { ...values(), extra: "injected" }];
    for (const invalid of invalidValues) {
      await expect(run(panel, { type: "submit", id: "settings", values: invalid })).rejects.toThrow();
    }
    expect(runtime.executed).toEqual([]);
    await panel.run({ type: "submit", id: "settings", values: values() });
    expect(runtime.executed).toEqual([{ token: "ui-handler", arg: { type: "submit", id: "settings", values: values() } }]);
  });

  test("email and number submission constraints reject invalid values without blocking intermediate changes", async () => {
    const { host } = newHost();
    const { id, runtime } = await activate(host);
    const panel = register(host, id, "tools", { type: "form", id: "typed", submitLabel: "Save", children: [
      { type: "input", id: "email", label: "Email", inputType: "email", required: true },
      { type: "input", id: "amount", label: "Amount", inputType: "number", required: true }] });
    await panel.run({ type: "change", id: "email", value: "not-yet-an-email" });
    await panel.run({ type: "change", id: "amount", value: "-" });
    for (const fields of [{ email: "bad", amount: "1" }, { email: "a@b", amount: "NaN" },
      { email: "a@b", amount: "1e999" }]) {
      await expect(run(panel, { type: "submit", id: "typed", values: fields })).rejects.toThrow();
    }
    expect(runtime.executed).toHaveLength(2);
    await panel.run({ type: "submit", id: "typed", values: { email: "a@b", amount: "-1.5" } });
    expect(runtime.executed).toHaveLength(3);
  });
});

describe("UI callback lifetime and cleanup", () => {
  test("private setup can register a panel while disabled, but run requires active state", async () => {
    const { host } = newHost();
    const { id, runtime } = await activate(host);
    host.disable(id);
    const panel = register(host, id, "tools", button(), "disabled", runtime);
    await expect(panel.run(action)).rejects.toThrow();
    expect(runtime.executed).toEqual([]);
    await host.enable(id);
    expect(host.panels).toEqual([]);
    await expect(panel.run(action)).rejects.toThrow();
  });

  test("disable closes and removes only its owner's panels; stale callbacks stay dead after re-enable", async () => {
    const { host } = newHost();
    const a = await activate(host, "example.alpha");
    const stale = register(host, a.id, "tools", button(), "old", a.runtime);
    const b = await activate(host, "example.beta");
    const survivor = register(host, b.id, "tools", button(), "b", b.runtime);
    call(host, a.id, "ui.open", ["tools"], a.runtime);
    host.disable(a.id);
    expect(host.panels).toEqual([survivor]);
    expect(host.activePanel).toBeNull();
    expect(host.panelOpen).toBe(false);
    expect(a.runtime.stopped).toBe(true);
    await expect(stale.run(action)).rejects.toThrow();
    expect(() => a.runtime.callbacks.request("ui.registerPanel", [spec(), "old"])).toThrow();
    await host.enable(a.id);
    const freshRuntime = runtimes().at(-1)!;
    const fresh = register(host, a.id, "tools", button(), "fresh", freshRuntime);
    await expect(stale.run(action)).rejects.toThrow();
    expect(a.runtime.executed).toEqual([]);
    expect(freshRuntime.executed).toEqual([]);
    await fresh.run(action);
    expect(freshRuntime.executed).toEqual([{ token: "fresh", arg: action }]);
  });

  test("remove and re-register with the same ID cannot revive the old callback in the same generation", async () => {
    const { host } = newHost();
    const { id, runtime } = await activate(host);
    const stale = register(host, id, "tools", button(), "old", runtime);
    call(host, id, "ui.open", ["tools"], runtime);
    call(host, id, "ui.remove", ["tools"], runtime);
    expect(host.panels).toEqual([]);
    expect(host.activePanel).toBeNull();
    expect(host.panelOpen).toBe(false);
    await expect(stale.run(action)).rejects.toThrow();
    const fresh = register(host, id, "tools", button(), "new", runtime);
    await expect(stale.run(action)).rejects.toThrow();
    expect(runtime.executed).toEqual([]);
    await fresh.run(action);
    expect(runtime.executed).toEqual([{ token: "new", arg: action }]);
  });

  test("package replacement drops panels and consent, and old callbacks cannot execute the new package", async () => {
    const { host } = newHost();
    const { id, runtime } = await activate(host);
    const stale = register(host, id);
    call(host, id, "ui.open", ["tools"], runtime);
    host.install(pkg(id, ["ui"], "/* replacement */"));
    expect(host.find(id).state).toBe("disabled");
    expect(host.find(id).enabled).toBe(false);
    expect(host.panels).toEqual([]);
    expect(host.activePanel).toBeNull();
    expect(host.panelOpen).toBe(false);
    expect(runtime.stopped).toBe(true);
    await expect(stale.run(action)).rejects.toThrow();
    expect(() => runtime.callbacks.request("ui.open", ["tools"])).toThrow();
    await host.enable(id);
    const nextRuntime = runtimes().at(-1)!;
    const next = register(host, id, "tools", button(), "replacement", nextRuntime);
    await expect(stale.run(action)).rejects.toThrow();
    expect(runtime.executed).toEqual([]);
    expect(nextRuntime.executed).toEqual([]);
    await next.run(action);
    expect(nextRuntime.executed).toEqual([{ token: "replacement", arg: action }]);
  });

  test("extension removal invalidates callbacks even after reinstalling the same extension and panel IDs", async () => {
    const { host } = newHost();
    const { id, runtime } = await activate(host);
    const stale = register(host, id);
    call(host, id, "ui.open", ["tools"], runtime);
    host.remove(id, { keepSettings: false });
    expect(host.installed).toEqual([]);
    expect(host.panels).toEqual([]);
    expect(host.activePanel).toBeNull();
    expect(host.panelOpen).toBe(false);
    await expect(stale.run(action)).rejects.toThrow();
    const fresh = await activate(host, id);
    register(host, fresh.id, "tools", button(), "reinstalled", fresh.runtime);
    await expect(stale.run(action)).rejects.toThrow();
    expect(runtime.executed).toEqual([]);
    expect(fresh.runtime.executed).toEqual([]);
  });

  test("safe mode removes all owners' panels and closes the UI; leaving it does not reactivate", async () => {
    const { host } = newHost();
    const a = await activate(host, "example.alpha");
    const b = await activate(host, "example.beta");
    const aPanel = register(host, a.id, "tools", button(), "a", a.runtime);
    const bPanel = register(host, b.id, "tools", button(), "b", b.runtime);
    call(host, b.id, "ui.open", ["tools"], b.runtime);
    host.setSafeMode(true);
    expect(host.safeMode).toBe(true);
    expect(storage.get("pipaya.extensions.safe")).toBe("1");
    expect(host.panels).toEqual([]);
    expect(host.activePanel).toBeNull();
    expect(host.panelOpen).toBe(false);
    for (const entry of host.installed) {
      expect(entry.state).toBe("disabled"); expect(entry.enabled).toBe(false);
    }
    expect(a.runtime.stopped).toBe(true); expect(b.runtime.stopped).toBe(true);
    await expect(aPanel.run(action)).rejects.toThrow();
    await expect(bPanel.run(action)).rejects.toThrow();
    await expect(host.enable(a.id)).rejects.toThrow();
    host.setSafeMode(false);
    expect(host.panels).toEqual([]);
    expect(host.find(a.id).state).toBe("disabled");
    await expect(aPanel.run(action)).rejects.toThrow();
    expect(a.runtime.executed).toEqual([]); expect(b.runtime.executed).toEqual([]);
  });

  test("activation failure cleans partial UI registrations and a panel opened during startup", async () => {
    let partial: ExtensionPanel | undefined;
    const { host, calls } = newHost();
    globals.__uiHostRuntimeStart = async runtime => {
      runtime.callbacks.request("ui.registerPanel", [spec(), "partial"]);
      runtime.callbacks.request("ui.registerPanel", [{ ...spec("composer"), placement: "composer" }, "partial-composer"]);
      runtime.callbacks.request("ui.open", ["tools"]);
      partial = host.panels[0]!;
      expect(host.find("example.ui").state).toBe("starting");
      expect(host.panels).toHaveLength(2);
      expect(host.panelOpen).toBe(true);
      await expect(partial.run(action)).rejects.toThrow();
      // A later duplicate registration fails after real startup side effects.
      runtime.callbacks.request("ui.registerPanel", [spec(), "duplicate"]);
    };
    const id = host.install(pkg());
    await expect(host.enable(id)).rejects.toThrow(/중복/);
    const runtime = runtimes().at(-1)!;
    expect(partial).toBeDefined();
    expect(host.find(id).state).toBe("error");
    expect(host.find(id).enabled).toBe(false);
    expect(host.find(id).error).toMatch(/중복/);
    expect(host.panels).toEqual([]);
    expect(host.activePanel).toBeNull();
    expect(host.panelOpen).toBe(false);
    expect(runtime.stopped).toBe(true);
    await expect(partial!.run(action)).rejects.toThrow();
    expect(() => runtime.callbacks.request("ui.registerPanel", [spec(), "late"])).toThrow();
    expect(runtime.executed).toEqual([]);
    expect(calls.notify).toHaveLength(1);
    expect(calls.prefill).toEqual([]);
    expect(calls.context).toBe(0);
  });

  test("runtime failure removes panels and closes an open panel", async () => {
    const { host } = newHost();
    const { id, runtime } = await activate(host);
    const stale = register(host, id);
    call(host, id, "ui.open", ["tools"], runtime);
    runtime.callbacks.failed("UI runtime failed");
    expect(host.find(id).state).toBe("error");
    expect(host.find(id).enabled).toBe(false);
    expect(host.panels).toEqual([]);
    expect(host.activePanel).toBeNull();
    expect(host.panelOpen).toBe(false);
    expect(runtime.stopped).toBe(true);
    await expect(stale.run(action)).rejects.toThrow();
    expect(runtime.executed).toEqual([]);
  });
});
