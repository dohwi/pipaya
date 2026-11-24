import type { ThinkingLevel } from "./types";

const THINKING_LABELS: Record<ThinkingLevel, string> = {
	off: "Off",
	minimal: "Minimal",
	low: "Low",
	medium: "Medium",
	high: "High",
	xhigh: "XHigh",
	max: "Max",
};

/** Display label for a thinking/reasoning level (Title Case, with `xhigh` as `XHigh`). Unknown values pass through. */
export const thinkingLabel = (level: string): string => THINKING_LABELS[level as ThinkingLevel] ?? level;
