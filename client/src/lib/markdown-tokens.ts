/**
 * Inline interactive tokens (`@session`, `@group`, `/skill:name`) inside rendered assistant markdown.
 * Runs as a DOM pass on `<template>` content right before `patchHtml` merges it into the DOM, so:
 *  - `renderMarkdown` / `renderStreaming` caches stay untouched when sessions open, rename or close
 *  - `<code>`, `<pre>`, `<a>`, `<button>` are never entered
 *  - every chip is built with `createElement` + `textContent` + `dataset` (no raw HTML concatenation)
 */
import { knownMention } from "./composer-text";
import type { MentionIndex } from "./peers";

export type MarkdownTokenPart = { text: string; kind?: "mention" | "skill"; name?: string };

/** Tags whose text nodes are literal code, links or controls and must never receive inline chips. */
const SKIP_TAGS = new Set(["CODE", "PRE", "A", "BUTTON", "SCRIPT", "STYLE", "TEXTAREA", "INPUT"]);

const MENTION_BLOCK_PREV = /[\p{L}\p{N}_.%+\-@/]$/u;
const SKILL_BLOCK_PREV = /[\p{L}\p{N}_./-]$/u;

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

/**
 * Split a plain prose run from rendered markdown into text and known `@name` / `/skill:name` tokens.
 * Mirrors `splitTokens` boundaries: `@name` matches at the start, after whitespace, or after opening/delimiter
 * punctuation (`(@서아, ...)`), never inside emails (`a@b.c`) or paths (`/@name`).
 * `prevText` carries the preceding sibling's trailing text so `<strong>x</strong>@name` is not treated as a boundary.
 */
export function splitMarkdownTokens(
	text: string,
	opts: { names: readonly string[]; skills?: boolean; prevText?: string },
): MarkdownTokenPart[] {
	const checkMentions = opts.names.length > 0 && text.includes("@");
	const checkSkills = !!opts.skills && text.includes("/skill:");
	if (!checkMentions && !checkSkills) return [{ text }];
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
	const blockStartSkill = !!opts.prevText && SKILL_BLOCK_PREV.test(opts.prevText);
	const re = /(?<![\p{L}\p{N}_.%+\-@/])@([^\s@]+)|(?<![\p{L}\p{N}_./-])\/skill:([a-z0-9]+(?:-[a-z0-9]+)*)(?![A-Za-z0-9_/-])/gu;
	for (let m = re.exec(text); m; m = re.exec(text)) {
		const at = m.index;
		if (m[2]) {
			if (checkSkills && !(at === 0 && blockStartSkill)) push(at, { text: `/skill:${m[2]}`, kind: "skill", name: m[2] });
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
export function mentionSignature(html: string, index: MentionIndex): string {
	if (!index.names.length || !html.includes("@")) return "";
	let sig = "";
	const re = /(?<![\p{L}\p{N}_.%+\-@/])@([^\s@<>]+)/gu;
	for (let m = re.exec(html); m; m = re.exec(html)) {
		const hasEntity = m[1]!.includes("&");
		const candidate = hasEntity ? decodeBasicEntities(m[1]!) : m[1]!;
		const hit = knownMention(candidate, index.names);
		if (hit) {
			const target = index.resolve(hit);
			if (target) sig += `${hit}:${target.kind}:${target.id};`;
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
	openSkill: (name: string) => string;
}

/**
 * Walk `root` in place and replace known `@session` / `@group` and `/skill:name` prose occurrences with interactive
 * `<button type="button">` chips, skipping code blocks, inline code, links and buttons.
 */
export function decorateMarkdownTokens(
	root: ParentNode,
	opts: { index: MentionIndex; skills: boolean; labels: DecorateLabels },
): void {
	// Strip any pre-existing data-mention-* / data-skill attributes before creating genuine chips (defense in depth).
	for (const el of root.querySelectorAll("[data-mention-id], [data-mention-kind], [data-skill]")) {
		el.removeAttribute("data-mention-id");
		el.removeAttribute("data-mention-kind");
		el.removeAttribute("data-skill");
	}
	const doc = root.ownerDocument ?? document;
	const walk = (parent: ParentNode) => {
		const children = Array.from(parent.childNodes);
		for (let i = 0; i < children.length; i++) {
			const child = children[i]!;
			if (child.nodeType === ELEMENT_NODE) {
				if (SKIP_TAGS.has((child as Element).tagName.toUpperCase())) continue;
				walk(child as Element);
				continue;
			}
			if (child.nodeType !== TEXT_NODE) continue;
			const val = child.nodeValue ?? "";
			if (!val) continue;
			const prevText = i > 0 ? (children[i - 1]?.textContent ?? "") : "";
			const parts = splitMarkdownTokens(val, { names: opts.index.names, skills: opts.skills, prevText });
			if (parts.length === 1 && !parts[0]!.kind) continue;
			const frag = doc.createDocumentFragment();
			for (const p of parts) {
				if (p.kind === "mention" && p.name) {
					const target = opts.index.resolve(p.name);
					if (target) {
						const btn = doc.createElement("button");
						btn.type = "button";
						btn.className = "wd-mention";
						btn.dataset.mentionKind = target.kind;
						btn.dataset.mentionId = target.id;
						btn.title = target.kind === "group" ? opts.labels.openGroup(p.text) : opts.labels.openSession(p.text);
						const span = doc.createElement("span");
						span.className = "wd-lbl";
						span.textContent = p.text;
						btn.appendChild(span);
						frag.appendChild(btn);
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
				}
				frag.appendChild(doc.createTextNode(p.text));
			}
			parent.replaceChild(frag, child);
		}
	};
	walk(root);
}
