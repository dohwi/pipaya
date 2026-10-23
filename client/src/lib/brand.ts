import type { BRAND_MARKS } from "./brand-marks";

/** Which model maker a provider/model pair belongs to, for the logo shown next to an agent. null = no known mark (the pipaya face is used). */
export type Brand = keyof typeof BRAND_MARKS;

/**
 * Matched against the model id first, then the provider. Ids follow OpenRouter's `maker/model` shape
 * (`z-ai/glm-4.6`, `moonshotai/kimi-k2`, `meta-llama/...`), so the maker prefix is enough for most.
 * Order matters: the first match wins.
 */
const BY_MODEL: [RegExp, Brand][] = [
	[/claude|anthropic|opus|sonnet|haiku/i, "claude"],
	[/gpt|^o\d|\bo\d-|codex|openai|chatgpt/i, "openai"],
	[/gemini|gemma|google/i, "gemini"],
	[/grok|x-?ai/i, "grok"],
	[/deepseek/i, "deepseek"],
	[/qwen|qwq|alibaba/i, "qwen"],
	[/mistral|mixtral|codestral|devstral|magistral|ministral|pixtral/i, "mistral"],
	[/llama|\bmeta\b/i, "meta"],
	[/glm|z-ai|zhipu|\bz\.ai\b/i, "zai"],
	[/kimi|moonshot/i, "moonshot"],
	[/minimax|\babab/i, "minimax"],
	[/nvidia|nemotron/i, "nvidia"],
	[/perplexity|\bsonar/i, "perplexity"],
	[/cohere|\bcommand\b|command-[ar]/i, "cohere"],
	[/microsoft|\bphi-?\d|\bwizardlm/i, "microsoft"],
	[/amazon|\bnova\b|nova-|bedrock/i, "amazon"],
	[/hunyuan|tencent/i, "tencent"],
	[/bytedance|doubao|\bseed\b|seed-/i, "bytedance"],
	[/xiaomi|\bmimo/i, "xiaomi"],
	[/stepfun|\bstep-/i, "stepfun"],
];

/** Each maker's own colour, used only where the logo is shown coloured. Grok, Meta-style black marks follow the theme text colour. */
export const BRAND_COLOR: Record<Brand, string> = {
	claude: "#D97757",
	openai: "#10A37F",
	gemini: "#3186FF",
	grok: "var(--text)",
	deepseek: "#4D6BFE",
	qwen: "#615CED",
	mistral: "#FA520F",
	meta: "#0081FB",
	zai: "var(--text)",
	moonshot: "var(--text)",
	minimax: "#F23F5D",
	nvidia: "#76B900",
	perplexity: "#22B8CD",
	cohere: "#39594D",
	microsoft: "#00A4EF",
	amazon: "#FF9900",
	tencent: "#0052D9",
	bytedance: "#325AB4",
	xiaomi: "#FF6900",
	stepfun: "#005AFF",
};

/** Display names for the icon picker. */
export const BRAND_LABEL: Record<Brand, string> = {
	claude: "Claude", openai: "OpenAI", gemini: "Gemini", grok: "Grok", deepseek: "DeepSeek", qwen: "Qwen", mistral: "Mistral",
	meta: "Meta", zai: "Z.ai", moonshot: "Moonshot", minimax: "MiniMax", nvidia: "NVIDIA", perplexity: "Perplexity", cohere: "Cohere",
	microsoft: "Microsoft", amazon: "Amazon", tencent: "Tencent", bytedance: "ByteDance", xiaomi: "Xiaomi", stepfun: "StepFun",
};

/** The model id wins over the provider, so a Claude reached through OpenRouter or Bedrock still shows Claude. */
export function brandOf(provider: string | null | undefined, model: string | null | undefined): Brand | null {
	for (const text of [model, provider]) {
		if (!text) continue;
		for (const [re, brand] of BY_MODEL) if (re.test(text)) return brand;
	}
	return null;
}
