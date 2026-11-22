import { describe, expect, test } from "bun:test";
import { append, pair } from "../src/lib/layout";
import { parseAppBackup } from "../src/lib/store/configuration-ops";
import { applyDraftPatch, resolveDraftFallback, shouldAdoptServerDefault, startingTierOf } from "../src/lib/store/draft-model";
import { canAddToGroup, stripSessionFromGroups } from "../src/lib/store/groups-ops";
import { LONG_AWAY_MS, watchWake } from "../src/lib/store/wake";
import type { Draft } from "../src/lib/store-model";
import type { DefaultModelSelection, Group, ModelInfo } from "../src/lib/types";

const models: ModelInfo[] = [
  {
    provider: "openai",
    id: "gpt-5",
    name: "GPT-5",
    reasoning: true,
    thinkingLevels: ["low", "medium", "high"],
    defaultThinkingLevel: "medium",
    defaultServiceTier: "flex",
    contextWindow: 128_000,
    maxTokens: 16_000,
    vision: true,
    configured: true,
  },
  {
    provider: "anthropic",
    id: "claude-sonnet",
    name: "Claude Sonnet",
    reasoning: true,
    thinkingLevels: ["low", "high"],
    defaultThinkingLevel: "high",
    contextWindow: 200_000,
    maxTokens: 16_000,
    vision: true,
    configured: true,
  },
  {
    provider: "anthropic",
    id: "claude-disabled",
    name: "Disabled",
    reasoning: false,
    contextWindow: 200_000,
    maxTokens: 8_000,
    vision: false,
    configured: true,
    available: false,
  },
];

describe("store/draft-model", () => {
  test("resolveDraftFallback returns null when current draft is usable, otherwise server default or first usable", () => {
    const usable: Draft = { provider: "openai", model: "gpt-5", thinkingLevel: "low", serviceTier: null };
    expect(resolveDraftFallback(models, usable, null)).toBeNull();

    const broken: Draft = { provider: "anthropic", model: "claude-disabled", thinkingLevel: "off", serviceTier: null };
    const def: DefaultModelSelection = { provider: "anthropic", model: "claude-sonnet", thinkingLevel: "high", serviceTier: null };
    expect(resolveDraftFallback(models, broken, def)).toEqual({
      provider: "anthropic",
      model: "claude-sonnet",
      thinkingLevel: "high",
      serviceTier: null,
    });
    expect(resolveDraftFallback(models, broken, null)).toEqual({ provider: "openai", model: "gpt-5" });
  });

  test("applyDraftPatch aligns model default thinking level and starting service tier when switching models", () => {
    const cur: Draft = { provider: "openai", model: "gpt-5", thinkingLevel: "low", serviceTier: "flex" };
    const next = applyDraftPatch(cur, { provider: "anthropic", model: "claude-sonnet" }, models, null);
    expect(next).toEqual({
      provider: "anthropic",
      model: "claude-sonnet",
      thinkingLevel: "high",
      serviceTier: null,
    });

    const explicit = applyDraftPatch(cur, { provider: "anthropic", model: "claude-sonnet", thinkingLevel: "low" }, models, null);
    expect(explicit.thinkingLevel).toBe("low");
  });

  test("startingTierOf prefers matching serverDefault serviceTier over model default", () => {
    const def: DefaultModelSelection = { provider: "openai", model: "gpt-5", thinkingLevel: "medium", serviceTier: "priority" };
    expect(startingTierOf(models, def, "openai", "gpt-5")).toBe("priority");
    expect(startingTierOf(models, null, "openai", "gpt-5")).toBe("flex");
  });

  test("shouldAdoptServerDefault checks both change and usability", () => {
    const a: DefaultModelSelection = { provider: "openai", model: "gpt-5", thinkingLevel: "medium", serviceTier: null };
    const b: DefaultModelSelection = { provider: "anthropic", model: "claude-sonnet", thinkingLevel: "high", serviceTier: null };
    const unavailable: DefaultModelSelection = { provider: "anthropic", model: "claude-disabled", thinkingLevel: "off", serviceTier: null };
    expect(shouldAdoptServerDefault(a, a, models)).toBe(false);
    expect(shouldAdoptServerDefault(a, b, models)).toBe(true);
    expect(shouldAdoptServerDefault(a, unavailable, models)).toBe(false);
  });
});

describe("store/groups-ops", () => {
  test("canAddToGroup enforces MAX_PANES and allows existing members", () => {
    let layout = pair("a", "b", "right");
    for (const id of ["c", "d", "e", "f", "g", "h"]) layout = append(layout, id);
    const fullGroup: Group = { id: "g1", name: "full", layout, createdAt: 1, updatedAt: 1 };
    expect(canAddToGroup(fullGroup, "new")).toBe(false);
    expect(canAddToGroup(fullGroup, "a")).toBe(true);
    expect(canAddToGroup(undefined, "new")).toBe(true);
  });

  test("stripSessionFromGroups removes a pane and dissolves a two-pane group", () => {
    const g2: Group = { id: "g2", name: "pair", layout: pair("a", "b", "right"), createdAt: 1, updatedAt: 1 };
    const g3: Group = { id: "g3", name: "trio", layout: append(pair("c", "d", "right"), "e"), createdAt: 1, updatedAt: 1 };
    expect(stripSessionFromGroups([g2, g3], "missing")).toBeNull();
    expect(stripSessionFromGroups([g2, g3], "a")?.map((g) => g.id)).toEqual(["g3"]);
    const shrunk = stripSessionFromGroups([g2, g3], "e");
    expect(shrunk?.length).toBe(2);
    expect(shrunk?.[1]?.id).toBe("g3");
  });
});

describe("store/configuration-ops", () => {
  test("parseAppBackup validates server shape and optional bindings", () => {
    const ok = parseAppBackup({
      servers: [{ id: "s1", name: "Main", baseUrl: "http://127.0.0.1:8787/", token: "tok" }],
      preferences: { theme: "dark" },
      bindings: {},
    });
    expect(ok.servers).toEqual([{ id: "s1", name: "Main", baseUrl: "http://127.0.0.1:8787", token: "tok" }]);
    expect(ok.bindings).toEqual({});

    expect(() => parseAppBackup(null)).toThrow();
    expect(() => parseAppBackup({ servers: [{ id: 123, name: "x", baseUrl: "http://127.0.0.1:8787", token: "t" }], preferences: {} })).toThrow();
  });
});

describe("store/wake", () => {
  test("watchWake debounces bursts, distinguishes long absence, and removes listeners on dispose", () => {
    const winListeners = new Map<string, Set<() => void>>();
    const docListeners = new Map<string, Set<() => void>>();
    let hidden = false;
    const prevWindow = globalThis.window;
    const prevDocument = globalThis.document;
    globalThis.window = {
      addEventListener: (k: string, fn: () => void) => {
        if (!winListeners.has(k)) winListeners.set(k, new Set());
        winListeners.get(k)!.add(fn);
      },
      removeEventListener: (k: string, fn: () => void) => {
        winListeners.get(k)?.delete(fn);
      },
    } as unknown as Window & typeof globalThis;
    globalThis.document = {
      get hidden() { return hidden; },
      addEventListener: (k: string, fn: () => void) => {
        if (!docListeners.has(k)) docListeners.set(k, new Set());
        docListeners.get(k)!.add(fn);
      },
      removeEventListener: (k: string, fn: () => void) => {
        docListeners.get(k)?.delete(fn);
      },
    } as unknown as Document;

    try {
      let t = 10_000;
      const calls: boolean[] = [];
      const stop = watchWake((force) => calls.push(force), () => t);

      // Short absence: visibility hidden -> visible after 5s
      hidden = true;
      for (const fn of docListeners.get("visibilitychange") ?? []) fn();
      t += 5_000;
      hidden = false;
      for (const fn of docListeners.get("visibilitychange") ?? []) fn();
      // Burst focus immediately after should be debounced
      for (const fn of winListeners.get("focus") ?? []) fn();
      expect(calls).toEqual([false]);

      // Long absence: blur -> focus after LONG_AWAY_MS
      for (const fn of winListeners.get("blur") ?? []) fn();
      t += LONG_AWAY_MS + 1_000;
      for (const fn of winListeners.get("focus") ?? []) fn();
      expect(calls).toEqual([false, true]);

      // Online always forces resync
      for (const fn of winListeners.get("online") ?? []) fn();
      expect(calls).toEqual([false, true, true]);

      stop();
      expect(winListeners.get("focus")?.size).toBe(0);
      expect(docListeners.get("visibilitychange")?.size).toBe(0);
    } finally {
      globalThis.window = prevWindow;
      globalThis.document = prevDocument;
    }
  });
});
