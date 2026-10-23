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

/** Display names (the company, not the product) for every mark, including ones the picker no longer offers. */
export const BRAND_LABEL: Record<Brand, string> = {
	claude: "Anthropic", openai: "OpenAI", gemini: "Google", grok: "xAI", deepseek: "DeepSeek", qwen: "Alibaba", mistral: "Mistral AI",
	meta: "Meta", zai: "Z.ai", moonshot: "Moonshot AI", minimax: "MiniMax", nvidia: "NVIDIA", perplexity: "Perplexity", cohere: "Cohere",
	microsoft: "Microsoft", amazon: "Amazon", tencent: "Tencent", bytedance: "ByteDance", xiaomi: "Xiaomi", stepfun: "StepFun",
};

/** The pipaya mark itself, selectable as a model icon next to the model makers. */
export const PIPAYA_ICON = "pipaya";

/** What the icon picker offers: the companies that train their own models. Perplexity is a search service, so it is not listed (an icon already saved with it still shows). */
export const MAKER_ICONS: Brand[] = [
	"claude", "openai", "gemini", "grok", "meta", "mistral", "deepseek", "qwen", "zai", "moonshot", "minimax",
	"cohere", "nvidia", "microsoft", "amazon", "tencent", "bytedance", "xiaomi", "stepfun",
];
/** Product names people search by, besides the company name. */
export const ICON_ALIASES: Record<string, string> = { claude: "claude", gemini: "gemini gemma", grok: "grok", qwen: "qwen", zai: "glm", moonshot: "kimi", meta: "llama", microsoft: "phi", amazon: "nova", bytedance: "seed doubao", xiaomi: "mimo", nvidia: "nemotron" };
export const ICON_LABEL: Record<string, string> = { [PIPAYA_ICON]: "pipaya", ...BRAND_LABEL };

/** The model id wins over the provider, so a Claude reached through OpenRouter or Bedrock still shows Claude. */
export function brandOf(provider: string | null | undefined, model: string | null | undefined): Brand | null {
	for (const text of [model, provider]) {
		if (!text) continue;
		for (const [re, brand] of BY_MODEL) if (re.test(text)) return brand;
	}
	return null;
}
