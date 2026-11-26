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
let EdgeResizeController: typeof SidebarResizeModule.EdgeResizeController;
let FOLD_PAST: number;
let UNFOLD_HYSTERESIS: number;
let RAIL_W: number;
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
  ({ SidebarResizeController, EdgeResizeController, FOLD_PAST, UNFOLD_HYSTERESIS, RAIL_W } = await loadRunes("shell/sidebar-resize"));
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
  test("snaps shut mid-drag with hysteresis, unfolds by dragging from rail, toggles on click, and handles keyboard", () => {
    let width = 288;
    let persistedW = 288;
    let collapsed = false;
    let persistedCollapsed = false;
    const ctrl = new SidebarResizeController({
      isCollapsed: () => collapsed,
      setCollapsed: (v, persist = true) => {
        collapsed = v;
        if (persist) persistedCollapsed = v;
      },
      shownWidth: () => width,
      setWidth: (w, persist = true) => {
        width = Math.max(220, Math.min(560, w));
        if (persist) persistedW = width;
      },
    });

    // up() while idle is a no-op
    ctrl.up();
    expect(collapsed).toBe(false);

    // Drag wider without persisting until release
    ctrl.down({ clientX: 288, pointerId: 1, button: 0, currentTarget: null } as unknown as PointerEvent);
    expect(ctrl.resizing).toBe(true);
    ctrl.move({ clientX: 328, buttons: 1, pointerType: "mouse" } as unknown as PointerEvent);
    expect(width).toBe(328);
    expect(persistedW).toBe(288);
    ctrl.up();
    expect(ctrl.resizing).toBe(false);
    expect(persistedW).toBe(328);

    // Drag below minWidth (preview), then past fold threshold (snaps immediately), then test hysteresis
    ctrl.down({ clientX: 328, pointerId: 2, button: 0, currentTarget: null } as unknown as PointerEvent);
    ctrl.move({ clientX: 180, buttons: 1, pointerType: "mouse" } as unknown as PointerEvent);
    expect(collapsed).toBe(false);
    expect(ctrl.foldingPreview).toBe(true);
    // Past foldAt (220 - 80 = 140) -> snaps immediately
    ctrl.move({ clientX: 220 - FOLD_PAST - 10, buttons: 1, pointerType: "mouse" } as unknown as PointerEvent);
    expect(collapsed).toBe(true);
    expect(ctrl.foldingPreview).toBe(false);
    // Back inside hysteresis band (140..170) -> stays folded
    ctrl.move({ clientX: 220 - FOLD_PAST + UNFOLD_HYSTERESIS - 5, buttons: 1, pointerType: "mouse" } as unknown as PointerEvent);
    expect(collapsed).toBe(true);
    // Release while folded -> persists folded and restores pre-drag open width (328)
    ctrl.up();
    expect(persistedCollapsed).toBe(true);
    expect(persistedW).toBe(328);

    // Pull out from collapsed rail (starts at RAIL_W = 56) past unfoldAt (170) -> snaps open mid-drag
    ctrl.down({ clientX: RAIL_W, pointerId: 3, button: 0, currentTarget: null } as unknown as PointerEvent);
    ctrl.move({ clientX: 220 - FOLD_PAST + UNFOLD_HYSTERESIS - 10, buttons: 1, pointerType: "mouse" } as unknown as PointerEvent);
    expect(collapsed).toBe(true);
    ctrl.move({ clientX: 260, buttons: 1, pointerType: "mouse" } as unknown as PointerEvent);
    expect(collapsed).toBe(false);
    expect(width).toBe(260);
    ctrl.up();
    expect(persistedCollapsed).toBe(false);
    expect(persistedW).toBe(260);

    // Plain click (no drag) toggles collapsed without altering width
    ctrl.down({ clientX: 260, pointerId: 4, button: 0, currentTarget: null } as unknown as PointerEvent);
    ctrl.up();
    expect(collapsed).toBe(true);
    expect(persistedCollapsed).toBe(true);
    expect(persistedW).toBe(260);

    // Keyboard: ArrowRight unfolds when collapsed; ArrowRight+Shift widens when open; Enter toggles
    let prevented = false;
    ctrl.key({ key: "ArrowRight", shiftKey: false, preventDefault: () => (prevented = true) } as unknown as KeyboardEvent);
    expect(prevented).toBe(true);
    expect(collapsed).toBe(false);

    ctrl.key({ key: "ArrowRight", shiftKey: true, preventDefault: () => (prevented = true) } as unknown as KeyboardEvent);
    expect(persistedW).toBe(324);

    ctrl.key({ key: "Enter", shiftKey: false, preventDefault: () => (prevented = true) } as unknown as KeyboardEvent);
    expect(collapsed).toBe(true);
  });

  test("handles right-side dock symmetry (pull left to unfold, push right to fold)", () => {
    let width = 360;
    let collapsed = false;
    const ctrl = new EdgeResizeController(
      {
        isCollapsed: () => collapsed,
        setCollapsed: (v) => {
          collapsed = v;
        },
        shownWidth: () => width,
        setWidth: (w) => {
          width = Math.max(200, Math.min(800, w));
        },
      },
      { side: "right", collapsedWidth: 0, minWidth: 200, maxWidth: () => 800 },
    );

    // Push right past foldAt (200 - 80 = 120): dx = +250 -> want = 110 -> snaps shut
    ctrl.down({ clientX: 1000, pointerId: 1, button: 0, currentTarget: null } as unknown as PointerEvent);
    ctrl.move({ clientX: 1250, buttons: 1, pointerType: "mouse" } as unknown as PointerEvent);
    expect(collapsed).toBe(true);
    ctrl.up();
    expect(width).toBe(360);

    // Pull left from collapsed (0px): dx = -160 -> want = 160 >= unfoldAt (150) -> snaps open
    ctrl.down({ clientX: 1360, pointerId: 2, button: 0, currentTarget: null } as unknown as PointerEvent);
    ctrl.move({ clientX: 1200, buttons: 1, pointerType: "mouse" } as unknown as PointerEvent);
    expect(collapsed).toBe(false);
    expect(width).toBe(200);
    ctrl.move({ clientX: 1060, buttons: 1, pointerType: "mouse" } as unknown as PointerEvent);
    expect(width).toBe(300);
    ctrl.up();
    expect(collapsed).toBe(false);
    expect(width).toBe(300);

    // Non-primary mouse button is ignored
    ctrl.down({ clientX: 1060, pointerId: 3, button: 2, currentTarget: null } as unknown as PointerEvent);
    expect(ctrl.resizing).toBe(false);
  });
});

describe("shell/drawer-swipe", () => {
  const mkTouch = (x: number, y: number, timeStamp: number, target: unknown = null, count = 1) =>
    ({
      touches: Array.from({ length: count }, () => ({ clientX: x, clientY: y })),
      timeStamp,
      target,
    }) as unknown as TouchEvent;

  const setup = (overrides: {
    narrow?: boolean;
    canOpenLeft?: boolean;
    canOpenRight?: boolean;
    blocked?: boolean;
    leftW?: number;
    rightW?: number;
  } = {}) => {
    const state = {
      narrow: overrides.narrow ?? true,
      left: false,
      right: false,
      canOpenLeft: overrides.canOpenLeft ?? true,
      canOpenRight: overrides.canOpenRight ?? true,
      blocked: overrides.blocked ?? false,
      draggingItem: false,
      leftW: overrides.leftW ?? 300,
      rightW: overrides.rightW ?? 260,
    };
    const ctrl = new DrawerSwipeController({
      isNarrow: () => state.narrow,
      isOpen: (side) => (side === "left" ? state.left : state.right),
      setOpen: (side, v) => {
        if (side === "left") state.left = v;
        else state.right = v;
      },
      canOpen: (side) => (side === "left" ? state.canOpenLeft : state.canOpenRight),
      isBlocked: () => state.blocked,
      isDraggingItem: () => state.draggingItem,
      getDrawerWidth: (side) => (side === "left" ? state.leftW : state.rightW),
    });
    return { state, ctrl };
  };

  test("opens and closes both left and right drawers symmetrically", () => {
    const { state, ctrl } = setup();

    // Vertical scroll activates momentum cooldown (150ms); subsequent touch inside cooldown is ignored
    ctrl.start(mkTouch(100, 100, 0));
    ctrl.move(mkTouch(102, 130, 16));
    expect(ctrl.swipe).toBeNull();
    expect(ctrl.side).toBeNull();

    // Left->right drag after cooldown opens left drawer and never touches rightSwipe
    ctrl.start(mkTouch(100, 100, 200));
    ctrl.move(mkTouch(130, 102, 216));
    ctrl.move(mkTouch(250, 104, 232));
    expect(ctrl.side).toBe("left");
    expect(ctrl.leftSwipe).toBe(150);
    expect(ctrl.rightSwipe).toBeNull();
    ctrl.end();
    expect(state.left).toBe(true);
    expect(state.right).toBe(false);
    expect(ctrl.swipe).toBeNull();

    // Left drawer open: rightward drag is ignored, leftward drag closes it
    ctrl.start(mkTouch(100, 100, 300));
    ctrl.move(mkTouch(140, 100, 316));
    expect(ctrl.swipe).toBeNull();
    ctrl.end();
    expect(state.left).toBe(true);

    ctrl.start(mkTouch(250, 100, 400));
    ctrl.move(mkTouch(200, 100, 450));
    ctrl.move(mkTouch(100, 100, 500));
    expect(ctrl.leftSwipe).toBe(150);
    ctrl.end();
    expect(state.left).toBe(false);

    // Right->left drag opens right drawer using rightW (260) and never touches leftSwipe
    ctrl.start(mkTouch(300, 100, 600));
    ctrl.move(mkTouch(270, 102, 650));
    ctrl.move(mkTouch(180, 104, 700));
    expect(ctrl.side).toBe("right");
    expect(ctrl.rightSwipe).toBe(120);
    expect(ctrl.leftSwipe).toBeNull();
    expect(ctrl.drawerW).toBe(260);
    ctrl.end();
    expect(state.right).toBe(true);
    expect(state.left).toBe(false);

    // Right drawer open: leftward drag is ignored; rightward drag closes right without opening left
    ctrl.start(mkTouch(250, 100, 800));
    ctrl.move(mkTouch(200, 100, 820));
    expect(ctrl.swipe).toBeNull();
    ctrl.end();
    expect(state.right).toBe(true);

    ctrl.start(mkTouch(120, 100, 900));
    ctrl.move(mkTouch(170, 100, 950));
    ctrl.move(mkTouch(250, 100, 1000));
    expect(ctrl.side).toBe("right");
    expect(ctrl.rightSwipe).toBe(130);
    expect(ctrl.leftSwipe).toBeNull();
    ctrl.end();
    expect(state.right).toBe(false);
    expect(state.left).toBe(false);
  });

  test("enforces opening angle guard, flick min distance, and scroll cooldown", () => {
    const { state, ctrl } = setup();

    // Diagonal thumb arc (dx=15, dy=9 -> |dx| < |dy| * 2) does not lock when opening
    ctrl.start(mkTouch(150, 100, 0));
    ctrl.move(mkTouch(165, 109, 16));
    expect(ctrl.swipe).toBeNull();
    ctrl.cancel();

    // Short fast jitter (< 40px) does not flick open
    ctrl.start(mkTouch(100, 100, 100));
    ctrl.move(mkTouch(130, 100, 110)); // dx=30 (< 40), high velocity
    expect(ctrl.leftSwipe).toBe(30);
    ctrl.end();
    expect(state.left).toBe(false);

    // Fast flick >= 40px opens even below 35% width
    ctrl.start(mkTouch(300, 100, 200));
    ctrl.move(mkTouch(250, 100, 220)); // dx=-50 (>= 40), vx > 0.35
    expect(ctrl.rightSwipe).toBe(50);
    ctrl.end();
    expect(state.right).toBe(true);

    // Programmatic scroll (e.g. streaming auto-follow) without a user vertical swipe does NOT block opening
    ctrl.noteScroll({ timeStamp: 900 });
    ctrl.start(mkTouch(100, 100, 950));
    ctrl.move(mkTouch(250, 100, 980));
    ctrl.end();
    expect(state.right).toBe(false); // closed open drawer

    ctrl.noteScroll({ timeStamp: 1500 });
    ctrl.start(mkTouch(300, 100, 1540)); // 40ms after programmatic scroll -> still opens
    ctrl.move(mkTouch(140, 100, 1600));
    ctrl.end();
    expect(state.right).toBe(true);
    state.right = false;

    // User vertical swipe + momentum scroll blocks opening within 150ms, then allows opening after 150ms
    ctrl.start(mkTouch(200, 100, 2000));
    ctrl.move(mkTouch(202, 130, 2016)); // user vertical scroll detected
    ctrl.noteScroll({ timeStamp: 2100 }); // momentum extends cooldown
    ctrl.start(mkTouch(300, 100, 2180)); // 80ms after momentum scroll -> ignored
    ctrl.move(mkTouch(120, 100, 2220));
    expect(ctrl.swipe).toBeNull();
    ctrl.end();
    expect(state.right).toBe(false);

    ctrl.start(mkTouch(300, 100, 2300)); // 200ms after last scroll -> allowed
    ctrl.move(mkTouch(140, 100, 2360));
    ctrl.end();
    expect(state.right).toBe(true);
  });

  test("respects canOpen, isBlocked, narrow, multi-touch, item drag, and zero drawer width fallback", () => {
    const { state, ctrl } = setup({ canOpenRight: false, leftW: 0 });

    // Right disabled (e.g. graph view or no workspace) -> right swipe ignored, left swipe still works with 320 fallback
    ctrl.start(mkTouch(300, 100, 0));
    ctrl.move(mkTouch(150, 100, 50));
    expect(ctrl.swipe).toBeNull();
    ctrl.end();
    expect(state.right).toBe(false);

    ctrl.start(mkTouch(100, 100, 100));
    ctrl.move(mkTouch(260, 100, 150));
    expect(ctrl.drawerW).toBe(320);
    ctrl.end();
    expect(state.left).toBe(true);

    // Item drag mid-flight cancels swipe
    ctrl.start(mkTouch(200, 100, 200));
    state.draggingItem = true;
    ctrl.move(mkTouch(100, 100, 216));
    expect(ctrl.swipe).toBeNull();
    state.draggingItem = false;
    state.left = false;

    // Blocked overlay (e.g. narrow extension dock) blocks opening, but still permits closing an open drawer
    state.canOpenRight = true;
    state.blocked = true;
    ctrl.start(mkTouch(300, 100, 300));
    ctrl.move(mkTouch(120, 100, 350));
    expect(ctrl.swipe).toBeNull();
    state.left = true;
    ctrl.start(mkTouch(240, 100, 360));
    ctrl.move(mkTouch(80, 100, 390));
    ctrl.end();
    expect(state.left).toBe(false);
    state.blocked = false;

    // Multi-touch cancels / ignores swipe
    ctrl.start(mkTouch(100, 100, 400, null, 2));
    ctrl.move(mkTouch(250, 100, 450, null, 1));
    expect(ctrl.swipe).toBeNull();

    // Non-narrow viewport ignores swipe
    state.narrow = false;
    ctrl.start(mkTouch(100, 100, 500));
    ctrl.move(mkTouch(250, 100, 550));
    expect(ctrl.swipe).toBeNull();
  });
});
