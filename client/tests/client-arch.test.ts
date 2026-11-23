import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { compileModule } from "svelte/compiler";
import ts from "typescript";
import {
  EXT_STORAGE_KEYS,
  dropLegacyLocalSwitches,
  pruneKeptSettings,
  readBootingIds,
  readExtensionShortcuts,
  readKeptSettingsMap,
  readSafeModeFlag,
  writeBootingIds,
  writeKeptSettingsMap,
  writeSafeModeFlag,
} from "../src/lib/extensions/storage";
import type * as DrawerSwipeModule from "../src/lib/shell/drawer-swipe.svelte";
import type * as SidebarResizeModule from "../src/lib/shell/sidebar-resize.svelte";
import type * as UiOverlayModule from "../src/lib/store/ui-overlay.svelte";

class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  throwOnSet = false;
  get length() {
    return this.map.size;
  }
  clear() {
    this.map.clear();
  }
  getItem(key: string) {
    return this.map.get(key) ?? null;
  }
  key(index: number) {
    return [...this.map.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
  setItem(key: string, value: string) {
    if (this.throwOnSet) throw new Error("QuotaExceededError");
    this.map.set(key, String(value));
  }
}

let dir: string;
let UiOverlayState: typeof UiOverlayModule.UiOverlayState;
let SidebarResizeController: typeof SidebarResizeModule.SidebarResizeController;
let FOLD_PAST: number;
let DrawerSwipeController: typeof DrawerSwipeModule.DrawerSwipeController;

async function loadRunes(relPath: string) {
  const build = await Bun.build({
    entrypoints: [resolve(`src/lib/${relPath}.svelte.ts`)],
    target: "bun",
    plugins: [
      {
        name: "runes",
        setup(builder) {
          builder.onLoad({ filter: /\.svelte\.ts$/ }, async ({ path }) => {
            const source = ts.transpileModule(await Bun.file(path).text(), {
              compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
            }).outputText;
            return { contents: compileModule(source, { filename: path, generate: "client" }).js.code, loader: "js" };
          });
        },
      },
    ],
  });
  const file = join(dir, `${relPath.replace(/\//g, "_")}.mjs`);
  await writeFile(file, await build.outputs[0]!.text());
  return import(file);
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "pipaya-arch-"));
  ({ UiOverlayState } = await loadRunes("store/ui-overlay"));
  ({ SidebarResizeController, FOLD_PAST } = await loadRunes("shell/sidebar-resize"));
  ({ DrawerSwipeController } = await loadRunes("shell/drawer-swipe"));
});

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("extensions/storage", () => {
  test("booting ids handle empty, corrupt JSON, removal, and quota errors safely", () => {
    const store = new MemoryStorage();
    expect(readBootingIds(store)).toEqual([]);

    store.setItem(EXT_STORAGE_KEYS.boot, "{broken");
    expect(readBootingIds(store)).toEqual([]);

    store.setItem(EXT_STORAGE_KEYS.boot, JSON.stringify(["a", 123, null, "b"]));
    expect(readBootingIds(store)).toEqual(["a", "b"]);

    writeBootingIds(["x", "y"], store);
    expect(readBootingIds(store)).toEqual(["x", "y"]);

    writeBootingIds([], store);
    expect(store.getItem(EXT_STORAGE_KEYS.boot)).toBeNull();

    store.throwOnSet = true;
    expect(() => writeBootingIds(["z"], store)).not.toThrow();
  });

  test("kept settings map parses only plain objects and prunes oldest entries", () => {
    const store = new MemoryStorage();
    store.setItem(EXT_STORAGE_KEYS.kept, JSON.stringify({ ok: { a: 1 }, badArr: [1], badNull: null }));
    const map = readKeptSettingsMap(store);
    expect([...map.keys()]).toEqual(["ok"]);

    map.set("b", { v: 2 });
    map.set("c", { v: 3 });
    pruneKeptSettings(map, 2);
    expect([...map.keys()]).toEqual(["b", "c"]);

    writeKeptSettingsMap(map, store);
    expect([...readKeptSettingsMap(store).keys()]).toEqual(["b", "c"]);

    writeKeptSettingsMap(new Map(), store);
    expect(store.getItem(EXT_STORAGE_KEYS.kept)).toBeNull();
  });

  test("shortcuts filter rejects invalid keys and truncates long combos", () => {
    const store = new MemoryStorage();
    store.setItem(
      EXT_STORAGE_KEYS.shortcutKeys,
      JSON.stringify({
        "my.ext:open-panel": "Ctrl+Shift+K",
        "bad Key:1": "Ctrl+A",
        "ext:empty": "",
        "ext:long": "x".repeat(60),
      }),
    );
    expect(readExtensionShortcuts(store)).toEqual({
      "my.ext:open-panel": "Ctrl+Shift+K",
      "ext:empty": "",
      "ext:long": "x".repeat(40),
    });
  });

  test("safe mode flag checks storage and query param; legacy switches drop per-server and global keys", () => {
    const store = new MemoryStorage();
    expect(readSafeModeFlag(store, "")).toBe(false);
    expect(readSafeModeFlag(store, "?extensions=off")).toBe(true);

    writeSafeModeFlag(true, store);
    expect(readSafeModeFlag(store, "")).toBe(true);
    writeSafeModeFlag(false, store);
    expect(readSafeModeFlag(store, "")).toBe(false);

    store.setItem(`${EXT_STORAGE_KEYS.localIds}.srv1`, "1");
    store.setItem(EXT_STORAGE_KEYS.legacySource, "local");
    dropLegacyLocalSwitches("srv1", store);
    expect(store.getItem(`${EXT_STORAGE_KEYS.localIds}.srv1`)).toBeNull();
    expect(store.getItem(EXT_STORAGE_KEYS.legacySource)).toBeNull();
  });
});

describe("store/ui-overlay", () => {
  test("handles image clamping, falsy goal ids, and settings/schedule openers", () => {
    const ui = new UiOverlayState();

    ui.openImage([], 0);
    expect(ui.viewer).toBeNull();

    const imgs = [
      { src: "a.png", mimeType: "image/png" },
      { src: "b.png", mimeType: "image/png" },
    ];
    ui.openImage(imgs, 99);
    expect(ui.viewer?.index).toBe(1);
    ui.openImage(imgs, -5);
    expect(ui.viewer?.index).toBe(0);

    ui.openGoal(null);
    ui.openGoal("");
    expect(ui.goalDialog).toBeNull();
    ui.openGoal("s1");
    expect(ui.goalDialog).toBe("s1");

    ui.openSettings();
    expect(ui.settingsOpen).toBe(true);
    expect(ui.settingsDirect).toBe(false);
    expect(ui.settingsTab).toBe("general");

    ui.openScheduleFor("s2");
    expect(ui.scheduleFor).toBe("s2");
    expect(ui.settingsDirect).toBe(true);
    expect(ui.settingsTab).toBe("schedules");

    ui.openScheduleEdit("t1");
    expect(ui.scheduleEdit).toBe("t1");
    expect(ui.settingsTab).toBe("schedules");

    ui.graphPeek = { server: "dev", session: "s1" };
    ui.closePeek();
    expect(ui.graphPeek).toBeNull();
  });
});

describe("shell/sidebar-resize", () => {
  test("drags width without persisting until release, folds past threshold, and handles keyboard", () => {
    let width = 288;
    let persisted = 288;
    let collapsed = false;
    const ctrl = new SidebarResizeController({
      shownWidth: () => width,
      setWidth: (w, persist = true) => {
        width = Math.max(200, Math.min(480, w));
        if (persist) persisted = width;
      },
      toggleCollapsed: () => {
        collapsed = !collapsed;
      },
    });

    // up() while idle is a no-op
    ctrl.up();
    expect(collapsed).toBe(false);

    ctrl.down({ clientX: 300, pointerId: 1, currentTarget: null } as unknown as PointerEvent);
    expect(ctrl.resizing).toBe(true);

    ctrl.move({ clientX: 340, buttons: 1, pointerType: "mouse" } as unknown as PointerEvent);
    expect(width).toBe(328);
    expect(persisted).toBe(288);

    ctrl.up();
    expect(ctrl.resizing).toBe(false);
    expect(persisted).toBe(328);

    // Drag far past minimum to fold and restore starting width
    ctrl.down({ clientX: 328, pointerId: 2, currentTarget: null } as unknown as PointerEvent);
    ctrl.move({ clientX: 328 - (328 - (200 - FOLD_PAST - 20)), buttons: 1, pointerType: "mouse" } as unknown as PointerEvent);
    expect(ctrl.foldOnRelease).toBe(true);
    ctrl.up();
    expect(collapsed).toBe(true);
    expect(persisted).toBe(328);

    // Keyboard steps
    let prevented = false;
    ctrl.key({ key: "ArrowRight", shiftKey: true, preventDefault: () => (prevented = true) } as unknown as KeyboardEvent);
    expect(prevented).toBe(true);
    expect(persisted).toBe(392);
  });
});

describe("shell/drawer-swipe", () => {
  test("opens on horizontal drag past threshold and cancels on drag-item or vertical scroll", () => {
    let open = false;
    let draggingItem = false;
    const ctrl = new DrawerSwipeController({
      isNarrow: () => true,
      isOpen: () => open,
      setOpen: (v) => {
        open = v;
      },
      isDraggingItem: () => draggingItem,
      getDrawerWidth: () => 300,
    });

    const mkTouch = (x: number, y: number, timeStamp: number) =>
      ({ touches: [{ clientX: x, clientY: y }], timeStamp, target: null }) as unknown as TouchEvent;

    // Vertical scroll cancels swipe
    ctrl.start(mkTouch(10, 100, 0));
    ctrl.move(mkTouch(12, 130, 16));
    expect(ctrl.swipe).toBeNull();

    // Horizontal swipe past 35% opens drawer
    ctrl.start(mkTouch(10, 100, 100));
    ctrl.move(mkTouch(40, 102, 116));
    ctrl.move(mkTouch(160, 104, 132));
    expect(ctrl.swipe).toBeGreaterThan(100);
    ctrl.end();
    expect(open).toBe(true);
    expect(ctrl.swipe).toBeNull();

    // Item drag mid-flight cancels swipe
    ctrl.start(mkTouch(200, 100, 200));
    draggingItem = true;
    ctrl.move(mkTouch(100, 100, 216));
    expect(ctrl.swipe).toBeNull();
  });
});
