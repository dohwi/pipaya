import { msg } from "./i18n";
import type { CompactionSettings, DefaultModelSelection, FallbackModelSettings, ModelChoice, ModelInfo, ProviderInfo, SystemModelSettings } from "./types";

/**
 * Settings that no longer work (a model was removed, or its connection lost its key). One place decides what counts
 * as a problem, so the sidebar, the server chips, the settings menu and the fields all agree. A new check is one more
 * entry in `settingsProblems`; the badges follow by themselves.
 */
export type ProblemKind = "no-key" | "missing";
export type ProblemRole = "default" | "compaction" | "system" | "fallback";

export interface SettingsProblem {
	role: ProblemRole;
	kind: ProblemKind;
	/** Settings section that fixes it */
	tab: "models";
	model: { provider: string; model: string };
}

export const PROBLEM_ROLE_LABEL: Record<ProblemRole, string> = {
	default: msg("새 대화 기본 모델"),
	compaction: msg("컨텍스트 압축 모델"),
	system: msg("시스템 모델"),
	fallback: msg("폴백 모델"),
};

/** Why a chosen model cannot be used, or null when it can (or nothing is chosen). */
export function modelProblem(
	choice: { provider: string; model: string } | null | undefined,
	models: readonly ModelInfo[],
	providers: readonly ProviderInfo[],
): ProblemKind | null {
	if (!choice) return null;
	const p = providers.find((x) => x.id === choice.provider);
	if (!p) return "missing";
	if (!p.configured) return "no-key";
	return models.some((m) => m.provider === choice.provider && m.id === choice.model) ? null : "missing";
}

export interface ProblemInput {
	defaults: DefaultModelSelection | null;
	compaction: Pick<CompactionSettings, "model"> | null;
	system: Pick<SystemModelSettings, "model"> | null;
	fallback?: Pick<FallbackModelSettings, "model"> | null;
	models: readonly ModelInfo[];
	providers: readonly ProviderInfo[];
}

export function settingsProblems(i: ProblemInput): SettingsProblem[] {
	const checks: [ProblemRole, ModelChoice | DefaultModelSelection | null | undefined][] = [
		["default", i.defaults],
		["compaction", i.compaction?.model],
		["system", i.system?.model],
		["fallback", i.fallback?.model],
	];
	const out: SettingsProblem[] = [];
	for (const [role, choice] of checks) {
		const kind = modelProblem(choice, i.models, i.providers);
		if (kind && choice) out.push({ role, kind, tab: "models", model: { provider: choice.provider, model: choice.model } });
	}
	return out;
}
