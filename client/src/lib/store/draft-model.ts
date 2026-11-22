import { draftFromDefault, type Draft } from "../store-model";
import type { DefaultModelSelection, ModelInfo, ServiceTier, ThinkingLevel } from "../types";

export function isUsableModel(models: readonly ModelInfo[], provider: string, id: string): boolean {
  return models.some((m) => m.provider === provider && m.id === id && m.configured && m.available !== false);
}

/**
 * Compute a draft patch when the current draft model is no longer usable: prefer the server default if usable,
 * else the first configured+available model, else configured, else the first listed model. Returns null if the
 * current draft is already usable or no fallback exists.
 */
export function resolveDraftFallback(
  models: readonly ModelInfo[],
  draft: Draft,
  serverDefault: DefaultModelSelection | null,
): Partial<Draft> | null {
  if (isUsableModel(models, draft.provider, draft.model)) return null;
  if (serverDefault && isUsableModel(models, serverDefault.provider, serverDefault.model)) {
    return draftFromDefault(serverDefault);
  }
  const pick =
    models.find((m) => m.configured && m.available !== false) ??
    models.find((m) => m.configured) ??
    models[0];
  return pick ? { provider: pick.provider, model: pick.id } : null;
}

/**
 * The speed a chat on this model starts at, as the server decides it: the saved new-chat choice when it is this very
 * model (null there = OpenRouter's own routing), else the model's own default.
 */
export function startingTierOf(
  models: readonly ModelInfo[],
  serverDefault: DefaultModelSelection | null,
  provider: string,
  id: string,
): ServiceTier | null {
  if (serverDefault && serverDefault.provider === provider && serverDefault.model === id && serverDefault.serviceTier !== undefined) {
    return serverDefault.serviceTier;
  }
  return models.find((m) => m.provider === provider && m.id === id)?.defaultServiceTier ?? null;
}

/** The strength a connection names for this model as its starting point, if it names one. */
export function modelDefaultLevelOf(
  models: readonly ModelInfo[],
  provider: string,
  id: string,
): ThinkingLevel | undefined {
  const m = models.find((x) => x.provider === provider && x.id === id);
  return m?.reasoning ? m.defaultThinkingLevel : undefined;
}

/** Merge a partial draft change while keeping the model's starting thinking level and service tier aligned. */
export function applyDraftPatch(
  current: Draft,
  patch: Partial<Draft>,
  models: readonly ModelInfo[],
  serverDefault: DefaultModelSelection | null,
): Draft {
  const next: Draft = { ...current, ...patch };
  if (patch.thinkingLevel === undefined && (patch.provider !== undefined || patch.model !== undefined)) {
    next.thinkingLevel = modelDefaultLevelOf(models, next.provider, next.model) ?? next.thinkingLevel;
  }
  if (patch.serviceTier === undefined && (next.provider !== current.provider || next.model !== current.model)) {
    next.serviceTier = startingTierOf(models, serverDefault, next.provider, next.model);
  }
  return next;
}

/** True when the server default changed and is usable, meaning new chats should adopt it. */
export function shouldAdoptServerDefault(
  before: DefaultModelSelection | null,
  now: DefaultModelSelection | null,
  models: readonly ModelInfo[],
): now is DefaultModelSelection {
  if (!now) return false;
  const changed =
    now.provider !== before?.provider ||
    now.model !== before?.model ||
    now.thinkingLevel !== before?.thinkingLevel ||
    now.serviceTier !== before?.serviceTier;
  return changed && isUsableModel(models, now.provider, now.model);
}
