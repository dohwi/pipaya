/**
 * Inline interactive tokens (`@session`, `@group`, `/skill:name`, `/prompt:name`, `#path`, and repo-relative file
 * paths in inline `<code>`) inside rendered assistant markdown.
 * Runs as a DOM pass on `<template>` content right before `patchHtml` merges it into the DOM, so:
 *  - `renderMarkdown` / `renderStreaming` caches stay untouched when sessions open, rename or close
 *  - `<pre>`, `<a>`, `<button>` are never entered (inline `<code>` is converted only when its sole text is a known `@mention` or an unambiguous file path)
 *  - every chip is built with `createElement` + `textContent` + `dataset` (no raw HTML concatenation)
 */
import { FILE_TOKEN, knownMention } from "./composer-text";
import { formatFileLine, parseInlineCodeFilePath, splitFilePath, splitFileRef, type ParsedFileRef } from "./files";
import type { MentionIndex, MentionTarget } from "./peers";

export type MarkdownTokenPart = { text: string; kind?: "mention" | "skill" | "prompt" | "file"; name?: string };

/** Tags whose subtrees must never receive inline chips (`CODE` is handled separately for sole file paths). */
const SKIP_TAGS = new Set(["CODE", "PRE", "A", "BUTTON", "SCRIPT", "STYLE", "TEXTAREA", "INPUT"]);

const MENTION_BLOCK_PREV = /[\p{L}\p{N}_.%+\-@/]$/u;
const SLASH_BLOCK_PREV = /[\p{L}\p{N}_./-]$/u;

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

/**
 * Split a plain prose run from rendered markdown into text and known `@name`, `/skill:name`, `/prompt:name`, and
 * `#path` tokens. Mirrors `splitTokens` boundaries: `@name` and `/skill:`/`/prompt:` match at the start, after
 * whitespace, or after opening/delimiter punctuation (`(@서아, ...)`), never inside emails (`a@b.c`) or paths.
 * `prevText` carries the preceding sibling's trailing text so `<strong>x</strong>@name` is not treated as a boundary.
 */
export function splitMarkdownTokens(
	text: string,
	opts: { names: readonly string[]; skills?: boolean; prompts?: boolean; files?: boolean; prevText?: string },
): MarkdownTokenPart[] {
	const checkMentions = opts.names.length > 0 && text.includes("@");
	const checkSkills = !!opts.skills && text.includes("/skill:");
	const checkPrompts = !!opts.prompts && text.includes("/prompt:");
	const checkFiles = !!opts.files && text.includes("#");
	if (!checkMentions && !checkSkills && !checkPrompts && !checkFiles) return [{ text }];
	const out: MarkdownTokenPart[] = [];
	let plain = "";
	let last = 0;
	const push = (at: number, part: MarkdownTokenPart) => {
		plain += text.slice(last, at);
		if (plain) out.push({ text: plain });
		plain = "";
		out.push(part);
		last = at + part.text.length;
	};
	const blockStartMention = !!opts.prevText && MENTION_BLOCK_PREV.test(opts.prevText);
	const blockStartSlash = !!opts.prevText && SLASH_BLOCK_PREV.test(opts.prevText);
	const blockStartFile = !!opts.prevText && !/\s$/.test(opts.prevText);
	const re = /(?<![\p{L}\p{N}_.%+\-@/])@([^\s@]+)|(?:^|(?<=\s))#([^\s@#]+)|(?<![\p{L}\p{N}_./-])\/(skill|prompt):([a-z0-9]+(?:-[a-z0-9]+)*)(?![A-Za-z0-9_/-])/gu;
	for (let m = re.exec(text); m; m = re.exec(text)) {
		const at = m.index;
		if (m[3]) {
			if (at === 0 && blockStartSlash) continue;
			const slug = m[4]!;
			if (m[3] === "skill" && checkSkills) push(at, { text: `/skill:${slug}`, kind: "skill", name: slug });
			else if (m[3] === "prompt" && checkPrompts) push(at, { text: `/prompt:${slug}`, kind: "prompt", name: slug });
			continue;
		}
		if (m[2]) {
			if (!checkFiles || (at === 0 && blockStartFile)) continue;
			const path = m[2].replace(/[.,;:!?)\]}'"]+$/, "");
			if (FILE_TOKEN.test(path)) {
				push(at, { text: `#${path}`, kind: "file", name: path });
				re.lastIndex = last;
			}
			continue;
		}
		if (m[1]) {
			const hit = checkMentions && !(at === 0 && blockStartMention) ? knownMention(m[1], opts.names) : null;
			if (hit) {
				push(at, { text: `@${m[1].slice(0, hit.length)}`, kind: "mention", name: hit });
				re.lastIndex = last;
			} else {
				re.lastIndex = at + 1;
			}
		}
	}
	plain += text.slice(last);
	if (plain) out.push({ text: plain });
	return out;
}

const decodeBasicEntities = (s: string) =>
	s.replace(/&(amp|lt|gt|quot|#39);/g, (_, e: string) => (e === "amp" ? "&" : e === "lt" ? "<" : e === "gt" ? ">" : e === "quot" ? '"' : "'"));

/**
 * Stable signature of the `@name` resolutions that actually appear in `html`.
 * Messages without `@` (or whose resolved targets did not change when an unrelated session opened/closed) keep the
 * exact same signature, avoiding unnecessary DOM re-patching and keeping loaded inline media untouched.
 */
export function mentionSignature(html: string, index: MentionIndex, selfId?: string | null): string {
	if (!index.names.length || !html.includes("@")) return "";
	let sig = "";
	const re = /(?<![\p{L}\p{N}_.%+\-@/])@([^\s@<>]+)/gu;
	for (let m = re.exec(html); m; m = re.exec(html)) {
		const hasEntity = m[1]!.includes("&");
		const candidate = hasEntity ? decodeBasicEntities(m[1]!) : m[1]!;
		const hit = knownMention(candidate, index.names);
		if (hit) {
			const target = index.resolve(hit);
			if (target) {
				const self = target.kind === "session" && selfId && target.id === selfId ? ":self" : "";
				sig += `${hit}:${target.kind}:${target.id}${self};`;
			}
			re.lastIndex = hasEntity ? m.index + 1 : m.index + 1 + hit.length;
		} else {
			re.lastIndex = m.index + 1;
		}
	}
	return sig;
}

export interface DecorateLabels {
	openSession: (name: string) => string;
	openGroup: (name: string) => string;
	selfSession?: string;
	openSkill: (name: string) => string;
	openPrompt: (name: string) => string;
	openFile: (name: string) => string;
}

function buildFileButton(doc: Document, ref: ParsedFileRef, label: (name: string) => string): HTMLButtonElement {
	const suffix = formatFileLine(ref.line, ref.endLine);
	const display = `${ref.path}${suffix}`;
	const btn = doc.createElement("button");
	btn.type = "button";
	btn.className = "wd-file";
	btn.dataset.file = ref.path;
	if (ref.line) btn.dataset.line = String(ref.line);
	if (ref.endLine) btn.dataset.endLine = String(ref.endLine);
	btn.title = label(display);
	const fp = splitFilePath(ref.path);
	if (fp) {
		const pathWrap = doc.createElement("span");
		pathWrap.className = "wd-path";
		const dir = doc.createElement("span");
		dir.className = "wd-dir";
		dir.textContent = fp.dir;
		const base = doc.createElement("span");
		base.className = "wd-base";
		base.textContent = `${fp.base}${suffix}`;
		pathWrap.append(dir, base);
		btn.appendChild(pathWrap);
	} else {
		const span = doc.createElement("span");
		span.className = "wd-lbl";
		span.textContent = display;
		btn.appendChild(span);
	}
	return btn;
}

function buildMentionNode(
	doc: Document,
	text: string,
	target: MentionTarget,
	labels: DecorateLabels,
	selfId?: string | null,
): HTMLElement {
	const isSelf = target.kind === "session" && Boolean(selfId) && target.id === selfId;
	let el: HTMLElement;
	if (isSelf) {
		el = doc.createElement("span");
		el.className = "wd-mention wd-self";
		el.dataset.mentionSelf = "1";
		el.title = labels.selfSession ?? text;
	} else {
		const btn = doc.createElement("button");
		btn.type = "button";
		btn.className = "wd-mention";
		btn.dataset.mentionKind = target.kind;
		btn.dataset.mentionId = target.id;
		btn.title = target.kind === "group" ? labels.openGroup(text) : labels.openSession(text);
		el = btn;
	}
	const span = doc.createElement("span");
	span.className = "wd-lbl";
	span.textContent = text;
	el.appendChild(span);
	return el;
}

/**
 * Walk `root` in place and replace known `@session` / `@group`, `/skill:name`, `/prompt:name`, `#path` prose tokens,
 * and sole known `@mention` or repo-relative file paths inside inline `<code>` with interactive `<button type="button">`
 * chips (or a calm non-clickable `<span>` chip when a `@session` names the current session itself).
 * Never enters `<pre>`, `<a>`, `<button>`, or other `<code>`.
 */
export function decorateMarkdownTokens(
	root: ParentNode,
	opts: { index: MentionIndex; selfId?: string | null; skills: boolean; prompts?: boolean; files?: boolean; labels: DecorateLabels },
): void {
	// Strip any pre-existing chip attributes before creating genuine chips (defense in depth).
	for (const el of root.querySelectorAll("[data-mention-id], [data-mention-kind], [data-mention-self], [data-skill], [data-prompt], button[data-file]")) {
		el.removeAttribute("data-mention-id");
		el.removeAttribute("data-mention-kind");
		el.removeAttribute("data-mention-self");
		el.removeAttribute("data-skill");
		el.removeAttribute("data-prompt");
		el.removeAttribute("data-file");
		el.removeAttribute("data-line");
		el.removeAttribute("data-end-line");
	}
	const doc = root.ownerDocument ?? document;
	const walk = (parent: ParentNode) => {
		const children = Array.from(parent.childNodes);
		for (let i = 0; i < children.length; i++) {
			const child = children[i]!;
			if (child.nodeType === ELEMENT_NODE) {
				const el = child as Element;
				const tag = el.tagName.toUpperCase();
				if (tag === "CODE") {
					// Convert an inline `<code>` whose sole text is a known `@session`/`@group` or an unambiguous repo-relative file path.
					if (el.childNodes.length === 1 && el.firstChild?.nodeType === TEXT_NODE) {
						const raw = el.firstChild.nodeValue ?? "";
						const trimmed = raw.trim();
						if (/^@[^\s@]+$/.test(trimmed)) {
							const target = opts.index.resolve(trimmed.slice(1));
							if (target) {
								parent.replaceChild(buildMentionNode(doc, trimmed, target, opts.labels, opts.selfId), el);
								continue;
							}
						}
						if (opts.files) {
							const ref = parseInlineCodeFilePath(raw);
							if (ref) parent.replaceChild(buildFileButton(doc, ref, opts.labels.openFile), el);
						}
					}
					continue;
				}
				if (SKIP_TAGS.has(tag)) continue;
				walk(el);
				continue;
			}
			if (child.nodeType !== TEXT_NODE) continue;
			const val = child.nodeValue ?? "";
			if (!val) continue;
			const prevText = i > 0 ? (children[i - 1]?.textContent ?? "") : "";
			const parts = splitMarkdownTokens(val, {
				names: opts.index.names,
				skills: opts.skills,
				prompts: opts.prompts ?? true,
				files: opts.files,
				prevText,
			});
			if (parts.length === 1 && !parts[0]!.kind) continue;
			const frag = doc.createDocumentFragment();
			for (const p of parts) {
				if (p.kind === "mention" && p.name) {
					const target = opts.index.resolve(p.name);
					if (target) {
						frag.appendChild(buildMentionNode(doc, p.text, target, opts.labels, opts.selfId));
						continue;
					}
				} else if (p.kind === "skill" && p.name) {
					const btn = doc.createElement("button");
					btn.type = "button";
					btn.className = "wd-skill";
					btn.dataset.skill = p.name;
					btn.title = opts.labels.openSkill(p.name);
					const span = doc.createElement("span");
					span.className = "wd-lbl";
					span.textContent = p.text;
					btn.appendChild(span);
					frag.appendChild(btn);
					continue;
				} else if (p.kind === "prompt" && p.name) {
					const btn = doc.createElement("button");
					btn.type = "button";
					btn.className = "wd-prompt";
					btn.dataset.prompt = p.name;
					btn.title = opts.labels.openPrompt(p.name);
					const span = doc.createElement("span");
					span.className = "wd-lbl";
					span.textContent = p.text;
					btn.appendChild(span);
					frag.appendChild(btn);
					continue;
				} else if (p.kind === "file" && p.name && opts.files) {
					const ref = splitFileRef(p.name.replace(/^\.\//, ""));
					if (ref.path && !ref.path.split("/").includes("..")) {
						frag.appendChild(buildFileButton(doc, ref, opts.labels.openFile));
						continue;
					}
				}
				frag.appendChild(doc.createTextNode(p.text));
			}
			parent.replaceChild(frag, child);
		}
	};
	walk(root);
}
