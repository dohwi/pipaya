/**
 * The page a server extension shows above its settings form (`pi.ui.setPanel`). The server hands over plain JSON in the
 * same node format as client extension UI; this turns every text into the language in use and validates the tree with the
 * client's own parser, so a server extension is held to exactly the rules a client extension is (size, depth, ids, node
 * types, no unknown fields). A tree this client cannot accept (a node type from a newer server) shows nothing.
 */
import { cleanTable, localize, pickLang, type TranslationTable } from "./extensions/translations";
import { getLang } from "./i18n";
import { parseView, type UINode } from "./extensions/ui";

/** Properties that hold text a person reads. Everything else (ids, types, enum values, field values) is left alone. */
const TEXT_KEYS = new Set(["title", "description", "text", "label", "hint", "emptyText", "caption", "submitLabel", "placeholder", "error", "badge"]);
const LANGUAGE_VALUE = /^[a-z]{2,3}(?:-[a-z0-9]{2,8}){0,3}$/;

/** `{ ko: "...", en: "..." }`: a plain object whose keys are all language tags and whose values are strings. */
function isLocalizedValue(v: unknown): v is Record<string, string> {
	if (!v || typeof v !== "object" || Array.isArray(v)) return false;
	const entries = Object.entries(v);
	return entries.length > 0 && entries.length <= 10 && entries.every(([k, x]) => LANGUAGE_VALUE.test(k) && typeof x === "string");
}

function text(v: unknown, table: TranslationTable | undefined, lang: string): unknown {
	if (typeof v === "string") return localize(v, table, lang);
	if (isLocalizedValue(v)) return pickLang(v, lang);
	return v;
}

function walk(node: unknown, table: TranslationTable | undefined, lang: string, parent = ""): unknown {
	if (Array.isArray(node)) return node.map((x) => walk(x, table, lang, parent));
	if (!node || typeof node !== "object") return node;
	const source = node as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(source)) {
		if (TEXT_KEYS.has(key)) out[key] = text(value, table, lang);
		// A stat's value is shown as it is written; a field's or an option's value is data and stays untouched.
		else if (key === "value" && source.type === "stat") out[key] = text(value, table, lang);
		// Table cells are text, one array per row.
		else if (key === "cells" && Array.isArray(value)) out[key] = value.map((cell) => text(cell, table, lang));
		else if (key === "children" || key === "items" || key === "options" || key === "rows" || key === "columns") out[key] = walk(value, table, lang, key);
		else out[key] = value;
	}
	return out;
}

/** The tree in the language in use, validated. `null` when there is none; `problem` says why a tree was refused. */
export function serverPanelView(raw: unknown, translations?: unknown, lang = getLang()): { view: UINode | null; problem?: string } {
	if (raw === undefined || raw === null) return { view: null };
	try {
		return { view: parseView(walk(raw, cleanTable(translations), lang)) };
	} catch (cause) {
		return { view: null, problem: cause instanceof Error ? cause.message : String(cause) };
	}
}
