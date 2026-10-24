/**
 * Declarative, data-only UI SDK for extensions.
 *
 * Extensions describe a view as plain JSON data. Nothing in this file accepts HTML, URLs, CSS,
 * class names, event handlers, or any other executable/renderer-specific surface: the host
 * renderer maps each node type to its own trusted component.
 *
 * Validation follows schema.ts: strict plain data (no accessors, no symbols, no unknown fields,
 * no exotic prototypes), and every parse returns a freshly built tree that shares no references
 * with the input. Errors are deterministic `path: message` strings.
 */

export type UITone = "neutral" | "info" | "success" | "warning" | "danger";
export type UIFieldValue = string | boolean;

export interface UIStackNode { type: "stack"; id: string; direction?: "vertical" | "horizontal"; gap?: "small" | "medium" | "large"; children: UINode[] }
export interface UIGridNode { type: "grid"; id: string; columns?: 1 | 2 | 3; children: UINode[] }
export interface UICardNode { type: "card"; id: string; title?: string; description?: string; children: UINode[] }
export interface UITabItem { id: string; label: string; children: UINode[] }
export interface UITabsNode { type: "tabs"; id: string; items: UITabItem[] }
export interface UIFormNode { type: "form"; id: string; children: UINode[]; submitLabel: string; disabled?: boolean }
export interface UITextNode { type: "text"; id: string; text: string; tone?: UITone; size?: "small" | "body" | "heading" }
export interface UIBadgeNode { type: "badge"; id: string; text: string; tone?: UITone }
export interface UIDividerNode { type: "divider"; id: string }
export interface UICodeNode { type: "code"; id: string; text: string; language?: string }
export interface UIAlertNode { type: "alert"; id: string; text: string; title?: string; tone?: UITone }
export interface UIProgressNode { type: "progress"; id: string; label: string; value: number; max?: number }
export interface UIStatNode { type: "stat"; id: string; label: string; value: string; hint?: string }
export interface UITableColumn { id: string; label: string }
export interface UITableRow { id: string; cells: string[] }
export interface UITableNode { type: "table"; id: string; columns: UITableColumn[]; rows: UITableRow[]; caption?: string }
export interface UIListItem { id: string; title: string; description?: string; badge?: string }
export interface UIListNode { type: "list"; id: string; items: UIListItem[]; emptyText?: string }
export interface UIButtonNode { type: "button"; id: string; label: string; variant?: "primary" | "secondary" | "danger"; disabled?: boolean }
export interface UIInputNode {
	type: "input"; id: string; label: string; value?: string; inputType?: "text" | "email" | "number";
	placeholder?: string; required?: boolean; disabled?: boolean; error?: string; minLength?: number; maxLength?: number;
}
export interface UITextareaNode {
	type: "textarea"; id: string; label: string; value?: string; placeholder?: string; required?: boolean;
	disabled?: boolean; error?: string; minLength?: number; maxLength?: number; rows?: number;
}
export interface UISelectOption { value: string; label: string }
export interface UISelectNode {
	type: "select"; id: string; label: string; value?: string; options: UISelectOption[];
	required?: boolean; disabled?: boolean; error?: string;
}
export interface UICheckboxNode { type: "checkbox"; id: string; label: string; checked?: boolean; required?: boolean; disabled?: boolean; error?: string }

export interface IconPath { d: string; fill?: string; fillRule?: "nonzero" | "evenodd" }
/** Data-only vector icon: a viewBox plus a few filled path outlines. Never raw SVG/HTML/URLs. */
export interface IconSpec { viewBox: string; paths: IconPath[] }
export interface UIIconNode { type: "icon"; id: string; icon: IconSpec; size?: "small" | "medium" | "large"; label?: string }

export type UINode =
	| UIIconNode | UIStackNode | UIGridNode | UICardNode | UITabsNode | UIFormNode | UITextNode | UIBadgeNode
	| UIDividerNode | UICodeNode | UIAlertNode | UIProgressNode | UIStatNode | UITableNode | UIListNode
	| UIButtonNode | UIInputNode | UITextareaNode | UISelectNode | UICheckboxNode;

export type UIFieldNode = UIInputNode | UITextareaNode | UISelectNode | UICheckboxNode;

export type UIEvent =
	| { type: "action"; id: string }
	| { type: "change"; id: string; value: UIFieldValue }
	| { type: "submit"; id: string; values: Record<string, UIFieldValue> };

export interface UIPanelSpec {
	id: string;
	title: string;
	description?: string;
	placement?: "panel" | "composer";
	view: UINode;
}

export const UI_ID_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;
export const UI_LIMITS = Object.freeze({
	nodes: 200,
	depth: 8,
	viewBytes: 60 * 1024,
	children: 50,
	tabs: 8,
	options: 50,
	tableRows: 100,
	tableColumns: 8,
	listItems: 100,
	label: 120,
	title: 80,
	description: 500,
	text: 8000,
	code: 16000,
	cell: 2000,
	fieldValue: 16000,
	optionValue: 200,
	maxMaxValue: 1e9,
	iconPaths: 8,
	iconPathData: 8192,
	iconViewBoxMax: 512,
	rowsMin: 2,
	rowsMax: 12,
});

const encoder = new TextEncoder();
const TONES = ["neutral", "info", "success", "warning", "danger"] as const;
const FIELD_TYPES = ["input", "textarea", "select", "checkbox"] as const;
const LONE_SURROGATE = /\p{Cs}/u;
const EMAIL = /^[^\s@]+@[^\s@]+$/;
const NUMBER = /^-?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/;

const NODE_KEYS: Readonly<Record<UINode["type"], readonly string[]>> = {
	stack: ["type", "id", "direction", "gap", "children"],
	grid: ["type", "id", "columns", "children"],
	card: ["type", "id", "title", "description", "children"],
	tabs: ["type", "id", "items"],
	form: ["type", "id", "children", "submitLabel", "disabled"],
	text: ["type", "id", "text", "tone", "size"],
	badge: ["type", "id", "text", "tone"],
	divider: ["type", "id"],
	code: ["type", "id", "text", "language"],
	alert: ["type", "id", "text", "title", "tone"],
	progress: ["type", "id", "label", "value", "max"],
	stat: ["type", "id", "label", "value", "hint"],
	table: ["type", "id", "columns", "rows", "caption"],
	list: ["type", "id", "items", "emptyText"],
	button: ["type", "id", "label", "variant", "disabled"],
	input: ["type", "id", "label", "value", "inputType", "placeholder", "required", "disabled", "error", "minLength", "maxLength"],
	textarea: ["type", "id", "label", "value", "placeholder", "required", "disabled", "error", "minLength", "maxLength", "rows"],
	select: ["type", "id", "label", "value", "options", "required", "disabled", "error"],
	checkbox: ["type", "id", "label", "checked", "required", "disabled", "error"],
	icon: ["type", "id", "icon", "size", "label"],
};

const PATH_DATA = /^[MmLlHhVvCcSsQqTtAaZz0-9eE+\-., \t\n\r]+$/;
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/** Options that tighten how a view is parsed (used by restricted surfaces such as the navbar). */
export interface ViewOptions {
	maxNodes?: number;
	maxDepth?: number;
	maxBytes?: number;
	/** When set, only these node types are accepted. */
	allowed?: readonly UINode["type"][];
}

function fail(path: string, message: string): never {
	throw new Error(`${path}: ${message}`);
}

// ---------------------------------------------------------------------------
// Strict plain-data primitives
// ---------------------------------------------------------------------------

/** Copy own enumerable data fields of a plain object into a null-prototype record. */
function snapshot(input: unknown, path: string, maxKeys: number = UI_LIMITS.nodes): Record<string, unknown> {
	if (input === null || typeof input !== "object" || Array.isArray(input)) fail(path, "expected a plain object");
	const prototype = Object.getPrototypeOf(input);
	if (prototype !== Object.prototype && prototype !== null) fail(path, "expected a plain object");
	const keys = Reflect.ownKeys(input);
	if (keys.length > maxKeys) fail(path, `must contain at most ${maxKeys} fields`);
	const result: Record<string, unknown> = Object.create(null);
	for (const key of keys) {
		if (typeof key !== "string") fail(path, `unknown field ${String(key)}`);
		const descriptor = Object.getOwnPropertyDescriptor(input, key)!;
		if (!descriptor.enumerable || !("value" in descriptor)) fail(`${path}.${key}`, "expected an enumerable data field");
		result[key] = descriptor.value;
	}
	return result;
}

function object(input: unknown, path: string, keys: readonly string[]): Record<string, unknown> {
	const result = snapshot(input, path, Math.max(keys.length, 64));
	for (const key of Object.keys(result)) if (!keys.includes(key)) fail(path, `unknown field ${key}`);
	return result;
}

function array(input: unknown, path: string, max: number, min = 0): unknown[] {
	if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) fail(path, "expected an array");
	if (input.length > max) fail(path, `must contain at most ${max} entries`);
	if (input.length < min) fail(path, `must contain at least ${min} entr${min === 1 ? "y" : "ies"}`);
	// Dense data only: length plus one own key per index, no hidden fields, getters, or holes.
	if (Reflect.ownKeys(input).length !== input.length + 1) fail(path, "expected a dense JSON array without extra fields");
	for (let i = 0; i < input.length; i++) {
		const descriptor = Object.getOwnPropertyDescriptor(input, String(i));
		if (!descriptor?.enumerable || !("value" in descriptor)) fail(`${path}[${i}]`, "expected an array data entry");
	}
	return input;
}

function text(input: unknown, path: string, max: number, nonempty = true): string {
	if (typeof input !== "string") fail(path, "expected a string");
	if (input.length > max) fail(path, `must be at most ${max} characters`);
	if (LONE_SURROGATE.test(input)) fail(path, "must be well-formed Unicode");
	if (nonempty && input.trim().length === 0) fail(path, "must not be empty");
	return input;
}

function boolean(input: unknown, path: string): boolean {
	if (typeof input !== "boolean") fail(path, "expected a boolean");
	return input;
}

function oneOf<T extends string | number>(input: unknown, path: string, values: readonly T[]): T {
	if (!values.includes(input as T)) fail(path, `expected one of ${values.map((v) => JSON.stringify(v)).join(", ")}`);
	return input as T;
}

function integer(input: unknown, path: string, min: number, max: number): number {
	if (typeof input !== "number" || !Number.isInteger(input) || input < min || input > max) {
		fail(path, `expected an integer between ${min} and ${max}`);
	}
	return input + 0; // normalizes -0
}

function matches(pattern: RegExp, value: string): boolean {
	// `$` also matches before a final newline; require an exact full match.
	return pattern.exec(value)?.[0] === value;
}

function idText(input: unknown, path: string): string {
	if (typeof input !== "string") fail(path, "expected a string");
	if (!matches(UI_ID_PATTERN, input)) fail(path, "expected an ID matching /^[a-z][a-z0-9-]{0,39}$/");
	return input;
}

function copy(
	out: Record<string, unknown>, source: Record<string, unknown>, path: string, key: string,
	parse: (value: unknown, path: string) => unknown,
): void {
	if (Object.hasOwn(source, key)) out[key] = parse(source[key], `${path}.${key}`);
}

function required(source: Record<string, unknown>, path: string, key: string): unknown {
	if (!Object.hasOwn(source, key)) fail(`${path}.${key}`, "is required");
	return source[key];
}

// ---------------------------------------------------------------------------
// View parsing
// ---------------------------------------------------------------------------

interface ParseContext {
	ids: Set<string>;
	count: number;
	active: Set<object>;
	maxNodes: number;
	maxDepth: number;
	allowed?: readonly UINode["type"][];
}

function claimId(ctx: ParseContext, id: string, path: string): void {
	if (ctx.ids.has(id)) fail(path, `duplicate ID ${id}`);
	ctx.ids.add(id);
}

function uniqueLocal(seen: Set<string>, id: string, path: string): void {
	if (seen.has(id)) fail(path, `duplicate ID ${id}`);
	seen.add(id);
}

function parseChildren(input: unknown, path: string, ctx: ParseContext, depth: number, inForm: boolean): UINode[] {
	return array(input, path, UI_LIMITS.children).map((child, index) => parseNode(child, `${path}[${index}]`, ctx, depth, inForm));
}

function lengthBounds(source: Record<string, unknown>, out: Record<string, unknown>, path: string): void {
	copy(out, source, path, "minLength", (v, p) => integer(v, p, 0, UI_LIMITS.fieldValue));
	copy(out, source, path, "maxLength", (v, p) => integer(v, p, 0, UI_LIMITS.fieldValue));
	if (typeof out.minLength === "number" && typeof out.maxLength === "number" && out.minLength > out.maxLength) {
		fail(`${path}.minLength`, "must be less than or equal to maxLength");
	}
	if (typeof out.value === "string" && typeof out.maxLength === "number" && out.value.length > out.maxLength) {
		fail(`${path}.value`, `must be at most maxLength (${out.maxLength}) characters`);
	}
}

function parseViewBox(input: unknown, path: string): string {
	if (typeof input !== "string" || input.length > 100) fail(path, "expected a viewBox string 'minx miny width height'");
	const parts = input.split(" ");
	if (parts.length !== 4 || !parts.every((part) => matches(NUMBER, part) && Number.isFinite(Number(part)))) {
		fail(path, "expected four finite numbers separated by single spaces: 'minx miny width height'");
	}
	const [minX, minY, width, height] = parts.map(Number) as [number, number, number, number];
	if (Math.abs(minX) > 1e6 || Math.abs(minY) > 1e6) fail(path, "origin must be within +/-1000000");
	for (const size of [width, height]) {
		if (size < 1 || size > UI_LIMITS.iconViewBoxMax) fail(path, `width and height must be between 1 and ${UI_LIMITS.iconViewBoxMax}`);
	}
	return input;
}

function parseIcon(input: unknown, path: string): IconSpec {
	const source = object(input, path, ["viewBox", "paths"]);
	const viewBox = parseViewBox(required(source, path, "viewBox"), `${path}.viewBox`);
	const paths = array(required(source, path, "paths"), `${path}.paths`, UI_LIMITS.iconPaths, 1).map((raw, index) => {
		const pathPath = `${path}.paths[${index}]`;
		const entry = object(raw, pathPath, ["d", "fill", "fillRule"]);
		const d = required(entry, pathPath, "d");
		if (typeof d !== "string") fail(`${pathPath}.d`, "expected a string");
		if (d.length > UI_LIMITS.iconPathData) fail(`${pathPath}.d`, `must be at most ${UI_LIMITS.iconPathData} characters`);
		if (d.trim().length === 0) fail(`${pathPath}.d`, "must not be empty");
		if (!matches(PATH_DATA, d)) fail(`${pathPath}.d`, "contains characters that are not valid SVG path data");
		const out: IconPath = { d };
		copy(out as unknown as Record<string, unknown>, entry, pathPath, "fill", (v, p) => {
			if (v !== "currentColor" && !(typeof v === "string" && matches(HEX_COLOR, v))) fail(p, "expected '#rrggbb' or 'currentColor'");
			return v;
		});
		copy(out as unknown as Record<string, unknown>, entry, pathPath, "fillRule", (v, p) => oneOf(v, p, ["nonzero", "evenodd"] as const));
		return out;
	});
	return { viewBox, paths };
}

function parseNode(input: unknown, path: string, ctx: ParseContext, depth: number, inForm: boolean): UINode {
	const source = snapshot(input, path);
	const type = source.type;
	if (typeof type !== "string" || !Object.hasOwn(NODE_KEYS, type)) {
		fail(`${path}.type`, `expected one of ${Object.keys(NODE_KEYS).join(", ")}`);
	}
	if (ctx.active.has(input as object)) fail(path, "cycle detected");
	if (ctx.allowed && !ctx.allowed.includes(type as UINode["type"])) {
		fail(`${path}.type`, `node type "${type}" is not allowed here; only non-interactive nodes (${ctx.allowed.join(", ")}) are accepted`);
	}
	if (depth > ctx.maxDepth) fail(path, `nesting must be at most ${ctx.maxDepth} levels deep`);
	if (++ctx.count > ctx.maxNodes) fail(path, `view must contain at most ${ctx.maxNodes} nodes`);
	for (const key of Object.keys(source)) {
		if (!NODE_KEYS[type as UINode["type"]].includes(key)) fail(path, `unknown field ${key} for ${type}`);
	}
	const id = idText(required(source, path, "id"), `${path}.id`);
	claimId(ctx, id, `${path}.id`);
	const out: Record<string, unknown> = { type, id };
	const label = (v: unknown, p: string) => text(v, p, UI_LIMITS.label);
	const tone = (v: unknown, p: string) => oneOf(v, p, TONES);
	const flag = boolean;
	const optionalText = (max: number) => (v: unknown, p: string) => text(v, p, max, false);

	ctx.active.add(input as object);
	try {
		switch (type as UINode["type"]) {
			case "stack":
				copy(out, source, path, "direction", (v, p) => oneOf(v, p, ["vertical", "horizontal"] as const));
				copy(out, source, path, "gap", (v, p) => oneOf(v, p, ["small", "medium", "large"] as const));
				out.children = parseChildren(required(source, path, "children"), `${path}.children`, ctx, depth + 1, inForm);
				break;
			case "grid":
				copy(out, source, path, "columns", (v, p) => oneOf(v, p, [1, 2, 3] as const));
				out.children = parseChildren(required(source, path, "children"), `${path}.children`, ctx, depth + 1, inForm);
				break;
			case "card":
				copy(out, source, path, "title", (v, p) => text(v, p, UI_LIMITS.title));
				copy(out, source, path, "description", optionalText(UI_LIMITS.description));
				out.children = parseChildren(required(source, path, "children"), `${path}.children`, ctx, depth + 1, inForm);
				break;
			case "tabs": {
				const items = array(required(source, path, "items"), `${path}.items`, UI_LIMITS.tabs, 1);
				out.items = items.map((raw, index) => {
					const itemPath = `${path}.items[${index}]`;
					const item = object(raw, itemPath, ["id", "label", "children"]);
					const itemId = idText(required(item, itemPath, "id"), `${itemPath}.id`);
					claimId(ctx, itemId, `${itemPath}.id`);
					return {
						id: itemId,
						label: label(required(item, itemPath, "label"), `${itemPath}.label`),
						children: parseChildren(required(item, itemPath, "children"), `${itemPath}.children`, ctx, depth + 1, inForm),
					};
				});
				break;
			}
			case "form":
				if (inForm) fail(path, "forms must not be nested (directly or through cards/tabs)");
				out.submitLabel = label(required(source, path, "submitLabel"), `${path}.submitLabel`);
				copy(out, source, path, "disabled", flag);
				out.children = parseChildren(required(source, path, "children"), `${path}.children`, ctx, depth + 1, true);
				break;
			case "text":
				out.text = text(required(source, path, "text"), `${path}.text`, UI_LIMITS.text);
				copy(out, source, path, "tone", tone);
				copy(out, source, path, "size", (v, p) => oneOf(v, p, ["small", "body", "heading"] as const));
				break;
			case "badge":
				out.text = label(required(source, path, "text"), `${path}.text`);
				copy(out, source, path, "tone", tone);
				break;
			case "divider":
				break;
			case "code":
				out.text = text(required(source, path, "text"), `${path}.text`, UI_LIMITS.code);
				copy(out, source, path, "language", label);
				break;
			case "alert":
				out.text = text(required(source, path, "text"), `${path}.text`, UI_LIMITS.text);
				copy(out, source, path, "title", (v, p) => text(v, p, UI_LIMITS.title));
				copy(out, source, path, "tone", tone);
				break;
			case "progress": {
				out.label = label(required(source, path, "label"), `${path}.label`);
				const number = (v: unknown, p: string, min: number, max: number) => {
					if (typeof v !== "number" || !Number.isFinite(v)) fail(p, "expected a finite number");
					if (v < min || v > max) fail(p, `must be between ${min} and ${max}`);
					return v + 0;
				};
				let max = 100;
				if (Object.hasOwn(source, "max")) {
					max = number(source.max, `${path}.max`, 0, UI_LIMITS.maxMaxValue);
					if (max <= 0) fail(`${path}.max`, "must be positive");
					out.max = max;
				}
				out.value = number(required(source, path, "value"), `${path}.value`, 0, max);
				break;
			}
			case "stat":
				out.label = label(required(source, path, "label"), `${path}.label`);
				out.value = label(required(source, path, "value"), `${path}.value`);
				copy(out, source, path, "hint", optionalText(UI_LIMITS.description));
				break;
			case "table": {
				const columnIds = new Set<string>();
				const columns = array(required(source, path, "columns"), `${path}.columns`, UI_LIMITS.tableColumns, 1).map((raw, index) => {
					const columnPath = `${path}.columns[${index}]`;
					const column = object(raw, columnPath, ["id", "label"]);
					const columnId = idText(required(column, columnPath, "id"), `${columnPath}.id`);
					uniqueLocal(columnIds, columnId, `${columnPath}.id`);
					return { id: columnId, label: label(required(column, columnPath, "label"), `${columnPath}.label`) };
				});
				const rowIds = new Set<string>();
				const rows = array(required(source, path, "rows"), `${path}.rows`, UI_LIMITS.tableRows).map((raw, index) => {
					const rowPath = `${path}.rows[${index}]`;
					const row = object(raw, rowPath, ["id", "cells"]);
					const rowId = idText(required(row, rowPath, "id"), `${rowPath}.id`);
					uniqueLocal(rowIds, rowId, `${rowPath}.id`);
					const cells = array(required(row, rowPath, "cells"), `${rowPath}.cells`, columns.length);
					if (cells.length !== columns.length) fail(`${rowPath}.cells`, `expected exactly ${columns.length} cells`);
					return { id: rowId, cells: cells.map((cell, c) => text(cell, `${rowPath}.cells[${c}]`, UI_LIMITS.cell, false)) };
				});
				out.columns = columns;
				out.rows = rows;
				copy(out, source, path, "caption", optionalText(UI_LIMITS.description));
				break;
			}
			case "list": {
				const itemIds = new Set<string>();
				out.items = array(required(source, path, "items"), `${path}.items`, UI_LIMITS.listItems).map((raw, index) => {
					const itemPath = `${path}.items[${index}]`;
					const item = object(raw, itemPath, ["id", "title", "description", "badge"]);
					const itemId = idText(required(item, itemPath, "id"), `${itemPath}.id`);
					uniqueLocal(itemIds, itemId, `${itemPath}.id`);
					const result: Record<string, unknown> = {
						id: itemId,
						title: text(required(item, itemPath, "title"), `${itemPath}.title`, UI_LIMITS.title),
					};
					copy(result, item, itemPath, "description", optionalText(UI_LIMITS.description));
					copy(result, item, itemPath, "badge", label);
					return result;
				});
				copy(out, source, path, "emptyText", optionalText(UI_LIMITS.description));
				break;
			}
			case "button":
				out.label = label(required(source, path, "label"), `${path}.label`);
				copy(out, source, path, "variant", (v, p) => oneOf(v, p, ["primary", "secondary", "danger"] as const));
				copy(out, source, path, "disabled", flag);
				break;
			case "input":
			case "textarea":
				out.label = label(required(source, path, "label"), `${path}.label`);
				copy(out, source, path, "value", optionalText(UI_LIMITS.fieldValue));
				if (type === "input") copy(out, source, path, "inputType", (v, p) => oneOf(v, p, ["text", "email", "number"] as const));
				copy(out, source, path, "placeholder", optionalText(UI_LIMITS.label));
				copy(out, source, path, "required", flag);
				copy(out, source, path, "disabled", flag);
				copy(out, source, path, "error", optionalText(UI_LIMITS.description));
				lengthBounds(source, out, path);
				if (type === "textarea") copy(out, source, path, "rows", (v, p) => integer(v, p, UI_LIMITS.rowsMin, UI_LIMITS.rowsMax));
				break;
			case "select": {
				out.label = label(required(source, path, "label"), `${path}.label`);
				const values = new Set<string>();
				out.options = array(required(source, path, "options"), `${path}.options`, UI_LIMITS.options, 1).map((raw, index) => {
					const optionPath = `${path}.options[${index}]`;
					const option = object(raw, optionPath, ["value", "label"]);
					const value = text(required(option, optionPath, "value"), `${optionPath}.value`, UI_LIMITS.optionValue, false);
					if (values.has(value)) fail(`${optionPath}.value`, "duplicate option value");
					values.add(value);
					return { value, label: label(required(option, optionPath, "label"), `${optionPath}.label`) };
				});
				copy(out, source, path, "value", (v, p) => {
					const value = text(v, p, UI_LIMITS.optionValue, false);
					if (value !== "" && !values.has(value)) fail(p, "must be empty or one of the option values");
					return value;
				});
				copy(out, source, path, "required", flag);
				copy(out, source, path, "disabled", flag);
				copy(out, source, path, "error", optionalText(UI_LIMITS.description));
				break;
			}
			case "checkbox":
				out.label = label(required(source, path, "label"), `${path}.label`);
				copy(out, source, path, "checked", flag);
				copy(out, source, path, "required", flag);
				copy(out, source, path, "disabled", flag);
				copy(out, source, path, "error", optionalText(UI_LIMITS.description));
				break;
			case "icon":
				out.icon = parseIcon(required(source, path, "icon"), `${path}.icon`);
				copy(out, source, path, "size", (v, p) => oneOf(v, p, ["small", "medium", "large"] as const));
				copy(out, source, path, "label", label);
				break;
		}
	} finally {
		ctx.active.delete(input as object);
	}
	return out as unknown as UINode;
}

/** Validate untrusted JSON data as a view and return a fresh, reference-free tree. */
export function parseView(input: unknown, options: ViewOptions = {}): UINode {
	const maxBytes = Math.min(options.maxBytes ?? UI_LIMITS.viewBytes, UI_LIMITS.viewBytes);
	const ctx: ParseContext = {
		ids: new Set(), count: 0, active: new Set(), allowed: options.allowed,
		maxNodes: Math.min(options.maxNodes ?? UI_LIMITS.nodes, UI_LIMITS.nodes),
		maxDepth: Math.min(options.maxDepth ?? UI_LIMITS.depth, UI_LIMITS.depth),
	};
	const view = parseNode(input, "view", ctx, 1, false);
	// Every accepted value is plain data, so serialization has no hooks and is deterministic.
	if (encoder.encode(JSON.stringify(view)).byteLength > maxBytes) {
		fail("view", `must be at most ${maxBytes} UTF-8 bytes when serialized`);
	}
	return view;
}

/** Strict-object / text / required helpers for sibling modules that validate their own envelopes. */
export const uiParse = Object.freeze({ object, text, required, fail });

/** Validate a panel contribution (metadata plus its view). */
export function parsePanelSpec(input: unknown): UIPanelSpec {
	const source = object(input, "panel", ["id", "title", "description", "placement", "view"]);
	const result: UIPanelSpec = {
		id: idText(required(source, "panel", "id"), "panel.id"),
		title: text(required(source, "panel", "title"), "panel.title", UI_LIMITS.title),
	} as UIPanelSpec;
	if (Object.hasOwn(source, "description")) result.description = text(source.description, "panel.description", UI_LIMITS.description, false);
	if (Object.hasOwn(source, "placement")) result.placement = oneOf(source.placement, "panel.placement", ["panel", "composer"] as const);
	const view = parseView(required(source, "panel", "view"));
	result.view = view;
	return result;
}

// ---------------------------------------------------------------------------
// Tree helpers
// ---------------------------------------------------------------------------

function childrenOf(node: UINode): UINode[] {
	switch (node.type) {
		case "stack": case "grid": case "card": case "form":
			return Array.isArray(node.children) ? node.children : [];
		case "tabs":
			return Array.isArray(node.items) ? node.items.flatMap((item) => (Array.isArray(item?.children) ? item.children : [])) : [];
		default:
			return [];
	}
}

function isField(node: UINode): node is UIFieldNode {
	return (FIELD_TYPES as readonly string[]).includes(node.type);
}

/** Depth-first (document order) search by node ID. Tab item IDs are not nodes. */
export function findNode(view: UINode, id: string): UINode | undefined {
	const seen = new Set<UINode>();
	const stack: UINode[] = [view];
	while (stack.length) {
		const node = stack.pop()!;
		if (!node || typeof node !== "object" || seen.has(node)) continue;
		seen.add(node);
		if (node.id === id) return node;
		const children = childrenOf(node);
		for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]!);
	}
	return undefined;
}

/** All input/textarea/select/checkbox nodes in `node` (including itself), in document order. */
export function fieldsIn(node: UINode): UIFieldNode[] {
	const fields: UIFieldNode[] = [];
	const seen = new Set<UINode>();
	const stack: UINode[] = [node];
	while (stack.length) {
		const current = stack.pop()!;
		if (!current || typeof current !== "object" || seen.has(current)) continue;
		seen.add(current);
		if (isField(current)) fields.push(current);
		const children = childrenOf(current);
		for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]!);
	}
	return fields;
}

// ---------------------------------------------------------------------------
// Event validation
// ---------------------------------------------------------------------------

interface IndexEntry { node: UINode; blocked: boolean }

function indexNodes(root: UINode): Map<string, IndexEntry> {
	const index = new Map<string, IndexEntry>();
	const visit = (node: UINode, blocked: boolean) => {
		index.set(node.id, { node, blocked });
		const next = blocked || (node.type === "form" && node.disabled === true);
		for (const child of childrenOf(node)) visit(child, next);
	};
	visit(root, false);
	return index;
}

function checkFieldValue(field: UIFieldNode, value: unknown, path: string, full: boolean): UIFieldValue {
	if (field.type === "checkbox") {
		if (typeof value !== "boolean") fail(path, "expected a boolean");
		if (full && field.required && !value) fail(path, "is required");
		return value;
	}
	if (typeof value !== "string") fail(path, "expected a string");
	if (field.type === "select") {
		if (value.length > UI_LIMITS.optionValue) fail(path, `must be at most ${UI_LIMITS.optionValue} characters`);
		if (value !== "" && !field.options.some((option) => option.value === value)) fail(path, "must be empty or one of the option values");
		if (full && field.required && value === "") fail(path, "is required");
		return value;
	}
	text(value, path, UI_LIMITS.fieldValue, false);
	if (field.maxLength !== undefined && value.length > field.maxLength) fail(path, `must be at most ${field.maxLength} characters`);
	if (!full) return value;
	if (field.required && value.length === 0) fail(path, "is required");
	if (field.minLength !== undefined && value.length < field.minLength) fail(path, `must be at least ${field.minLength} characters`);
	if (field.type === "input" && value !== "") {
		if (field.inputType === "email" && !matches(EMAIL, value)) fail(path, "expected an email address");
		if (field.inputType === "number" && !(matches(NUMBER, value) && Number.isFinite(Number(value)))) fail(path, "expected a finite number");
	}
	return value;
}

/**
 * Validate an untrusted renderer/user event against `view` and return a fresh sanitized event.
 * `view` is re-validated first so a tampered tree can never widen what an event may do.
 */
export function validateUIEvent(view: UINode, event: unknown): UIEvent {
	const root = parseView(view);
	const index = indexNodes(root);
	const source = snapshot(event, "event");
	const type = oneOf(source.type, "event.type", ["action", "change", "submit"] as const);
	const payload = type === "action" ? null : type === "change" ? "value" : "values";
	object(source, "event", payload ? ["type", "id", payload] : ["type", "id"]);
	const id = idText(required(source, "event", "id"), "event.id");
	const entry = index.get(id);
	if (!entry) fail("event.id", `unknown target ${id}`);
	const { node } = entry;
	const disabled = (node as { disabled?: boolean }).disabled === true;
	const inactive = () => {
		if (entry.blocked) fail("event.id", `target ${id} is inside a disabled form`);
		if (disabled) fail("event.id", `target ${id} is disabled`);
	};

	if (type === "action") {
		if (node.type !== "button") fail("event.type", `action requires a button target, got ${node.type}`);
		inactive();
		return { type, id };
	}
	if (type === "change") {
		if (!isField(node)) fail("event.type", `change requires a field target, got ${node.type}`);
		inactive();
		return { type, id, value: checkFieldValue(node, required(source, "event", "value"), "event.value", false) };
	}
	if (node.type !== "form") fail("event.type", `submit requires a form target, got ${node.type}`);
	inactive();
	const fields = fieldsIn(node).filter((field) => !field.disabled);
	const raw = required(source, "event", "values");
	const values = snapshot(raw, "event.values", UI_LIMITS.nodes);
	const expected = new Set(fields.map((field) => field.id));
	for (const key of Object.keys(values)) {
		if (!expected.has(key)) fail(`event.values.${key}`, "unknown or disabled field");
	}
	const out: Record<string, UIFieldValue> = {};
	for (const field of fields) {
		if (!Object.hasOwn(values, field.id)) fail(`event.values.${field.id}`, "is required");
		out[field.id] = checkFieldValue(field, values[field.id], `event.values.${field.id}`, true);
	}
	return { type, id, values: out };
}
