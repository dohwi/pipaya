/**
 * Syntax colours for fenced code blocks, loaded only when an answer shows code.
 *
 * highlight.js core and each language are separate chunks: nothing is downloaded until a block in a known language
 * is rendered, then that one language (and the core, once). Rendering is synchronous (marked), so the first time a
 * language is met the block is drawn plain and marked as waiting; `onHighlightReady` tells the views to draw it again.
 * No language given, or one not listed here: plain text (guessing the language would need every grammar loaded).
 */
import type { HLJSApi, LanguageFn } from "highlight.js";

type Loader = () => Promise<{ default: LanguageFn }>;

/** One grammar per entry; the keys are the names highlight.js registers them under. */
const LOADERS: Record<string, Loader> = {
	bash: () => import("highlight.js/lib/languages/bash"),
	c: () => import("highlight.js/lib/languages/c"),
	cpp: () => import("highlight.js/lib/languages/cpp"),
	csharp: () => import("highlight.js/lib/languages/csharp"),
	css: () => import("highlight.js/lib/languages/css"),
	dart: () => import("highlight.js/lib/languages/dart"),
	diff: () => import("highlight.js/lib/languages/diff"),
	dockerfile: () => import("highlight.js/lib/languages/dockerfile"),
	go: () => import("highlight.js/lib/languages/go"),
	graphql: () => import("highlight.js/lib/languages/graphql"),
	ini: () => import("highlight.js/lib/languages/ini"),
	java: () => import("highlight.js/lib/languages/java"),
	javascript: () => import("highlight.js/lib/languages/javascript"),
	json: () => import("highlight.js/lib/languages/json"),
	kotlin: () => import("highlight.js/lib/languages/kotlin"),
	lua: () => import("highlight.js/lib/languages/lua"),
	makefile: () => import("highlight.js/lib/languages/makefile"),
	markdown: () => import("highlight.js/lib/languages/markdown"),
	nginx: () => import("highlight.js/lib/languages/nginx"),
	php: () => import("highlight.js/lib/languages/php"),
	powershell: () => import("highlight.js/lib/languages/powershell"),
	protobuf: () => import("highlight.js/lib/languages/protobuf"),
	python: () => import("highlight.js/lib/languages/python"),
	ruby: () => import("highlight.js/lib/languages/ruby"),
	rust: () => import("highlight.js/lib/languages/rust"),
	scss: () => import("highlight.js/lib/languages/scss"),
	shell: () => import("highlight.js/lib/languages/shell"),
	sql: () => import("highlight.js/lib/languages/sql"),
	swift: () => import("highlight.js/lib/languages/swift"),
	typescript: () => import("highlight.js/lib/languages/typescript"),
	xml: () => import("highlight.js/lib/languages/xml"),
	yaml: () => import("highlight.js/lib/languages/yaml"),
};

/** Fence labels models write, to the grammar that draws them. A label that is a grammar's own name needs no entry. */
const ALIASES: Record<string, string> = {
	sh: "bash", zsh: "bash", ksh: "bash",
	console: "shell", shellsession: "shell", terminal: "shell",
	js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript", node: "javascript",
	ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
	py: "python", python3: "python", py3: "python",
	rs: "rust", golang: "go", kt: "kotlin", kts: "kotlin", rb: "ruby",
	"c++": "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", h: "c", cs: "csharp", "c#": "csharp",
	ps: "powershell", ps1: "powershell", pwsh: "powershell",
	yml: "yaml", toml: "ini", conf: "ini", cfg: "ini", properties: "ini", env: "bash",
	html: "xml", htm: "xml", xhtml: "xml", svg: "xml", plist: "xml", svelte: "xml", vue: "xml",
	jsonc: "json", json5: "json", jsonl: "json", ndjson: "json",
	md: "markdown", mdx: "markdown", patch: "diff", docker: "dockerfile", containerfile: "dockerfile",
	make: "makefile", mk: "makefile", proto: "protobuf", gql: "graphql", sass: "scss",
};

/** Bigger blocks stay plain: one highlight pass is linear but slow on huge pastes (40 kB of TypeScript takes ~40 ms). */
export const MAX_HIGHLIGHT_CHARS = 60_000;

/** The grammar a fence label stands for, or null when there is none to load (plain text). */
export function languageOf(label: string | undefined | null): string | null {
	const key = (label ?? "").trim().toLowerCase();
	if (!key) return null;
	const name = ALIASES[key] ?? key;
	return Object.hasOwn(LOADERS, name) ? name : null;
}

let hljs: HLJSApi | null = null;
let core: Promise<HLJSApi> | null = null;
/** Grammars by name: registered, loading, or failed (a failed one stays plain and is not fetched again). */
const state = new Map<string, "ready" | "loading" | "failed">();
const listeners = new Set<() => void>();

/** Called once each time a grammar finishes loading (or fails): blocks that were waiting can be drawn again. */
export function onHighlightReady(fn: () => void): () => void {
	listeners.add(fn);
	return () => listeners.delete(fn);
}

const loadCore = () =>
	(core ??= import("highlight.js/lib/core").then((m) => {
		hljs = m.default;
		return hljs;
	}));

/** Start fetching the grammar for `label` (and the core) if it is not there yet. No-op for plain text. */
export function preloadLanguage(label: string | undefined | null): void {
	const name = languageOf(label);
	if (!name || state.has(name)) return;
	state.set(name, "loading");
	void Promise.all([loadCore(), LOADERS[name]!()])
		.then(([api, lang]) => {
			api.registerLanguage(name, lang.default);
			state.set(name, "ready");
		})
		.catch(() => {
			state.set(name, "failed");
			// a failed core fetch may succeed for the next grammar
			if (!hljs) core = null;
		})
		.finally(() => {
			for (const fn of [...listeners]) fn();
		});
}

/**
 * The block's code as highlighted HTML (text escaped, tokens in `hljs-*` spans), "wait" when its grammar is still on its
 * way (fetching starts now), or null to draw it plain: no or unknown language, a failed fetch, or too big a block.
 */
export function highlightCode(code: string, label: string | undefined | null): string | "wait" | null {
	const name = languageOf(label);
	if (!name || !code || code.length > MAX_HIGHLIGHT_CHARS) return null;
	const s = state.get(name);
	if (s === "failed") return null;
	if (s !== "ready" || !hljs) {
		preloadLanguage(label);
		return "wait";
	}
	try {
		return hljs.highlight(code, { language: name, ignoreIllegals: true }).value;
	} catch {
		return null;
	}
}
