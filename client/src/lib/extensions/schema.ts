import { httpOrigin } from "./http";
import { t } from "../i18n";

export const SDK_VERSION = 1;
/** Whole package as JSON. Big enough for a design pack (fonts, icons, images) in `assets`. */
export const MAX_PACKAGE_BYTES = 1024 * 1024;
export const PERMISSIONS = Object.freeze([
	"commands", "composer", "status", "context", "storage", "notifications", "events", "ui", "navbar", "http", "configuration", "http-write", "configuration-background", "system-notifications", "locales",
	"server", "shortcuts", "dialogs", "session", "tools", "messages", "slots", "composer-filter", "panes", "session-labels", "composer-mentions",
	"ui-style", "ui-components",
] as const);
export type Permission = (typeof PERMISSIONS)[number];

/**
 * Where a trusted extension component (`ui-components`) can be mounted. Each name is a stable place in the app; adding
 * one means placing `<ExtensionMount slot="...">` there.
 */
export const UI_SLOTS = Object.freeze([
	"app.overlay", "header.start", "header.end", "header.below", "sidebar.top", "sidebar.bottom",
	"pane.top", "pane.bottom", "composer.top", "composer.toolbar", "composer.bottom",
	"message.user.after", "message.assistant.after",
] as const);
export type UISlot = (typeof UI_SLOTS)[number];
/** Built-in pieces a trusted extension component may replace. The original is passed as the `fallback` snippet. */
export const UI_PARTS = Object.freeze([
	"header.title", "sidebar.brand", "pane.empty", "pane.welcome", "composer.send", "statusline", "message.user", "message.assistant",
] as const);
export type UIPart = (typeof UI_PARTS)[number];
/** `data-part` names the app puts on its main elements: the stable selectors for `ui-style` CSS. */
export const STYLE_PARTS = Object.freeze([
	"app", "sidebar", "sidebar.brand", "sidebar.bottom", "header", "header.title", "pane", "messages", "message.user", "message.assistant",
	"composer", "composer.box", "composer.bar", "statusline",
	"rail", "tabbar", "toasts", "palette", "tool", "welcome", "sessions", "modal",
] as const);
export const COMPONENT_LIMITS = Object.freeze({ components: 20, source: 64 * 1024, mounts: 20, styles: 64 * 1024 });
/**
 * Design files a package carries (`assets`, needs `ui-style` or `ui-components`): base64 `data:` URLs of images and fonts.
 * Styles reach one as `asset("name")` (replaced by `url("data:...")`), components as `ext.assets.name`.
 */
export const ASSET_LIMITS = Object.freeze({ count: 40, bytes: 768 * 1024, name: 64 });
export const ASSET_TYPES = Object.freeze([
	"image/png", "image/jpeg", "image/webp", "image/gif", "image/avif", "image/svg+xml",
	"font/woff2", "font/woff", "font/ttf", "font/otf",
] as const);
const ASSET_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ASSET_URL = /^data:([a-z0-9.+/-]+);base64,[A-Za-z0-9+/]*={0,2}$/;
/** `asset("name")` / `asset('name')` / `asset(name)` in a stylesheet. */
export const ASSET_REF = /asset\(\s*(?:"([^"]*)"|'([^']*)'|([^\s"')]*))\s*\)/g;
export interface ComponentMount { slot: UISlot; component: string; order?: number }

/** Color tokens: a hex color or a numeric `rgb()/rgba()`. */
const COLOR_TOKENS = [
	"--bg", "--bg-side", "--bg-group", "--bg-elev", "--bg-hover", "--bg-active", "--bg-code",
	"--border", "--border-strong", "--text", "--text-dim", "--text-faint", "--user-bg",
	"--accent", "--accent-hover", "--accent-fg", "--accent-soft",
	"--info", "--ok", "--ok-fg", "--warn", "--danger", "--info-soft", "--ok-soft", "--warn-soft", "--danger-soft", "--scrim",
	"--lv-minimal", "--lv-low", "--lv-medium", "--lv-high", "--lv-xhigh", "--lv-max",
	"--mark-img", "--mark-file", "--mark-header", "--mark-mention",
] as const;
/** Size tokens: integer px within [min, max]. */
export const SIZE_TOKENS: Readonly<Record<string, readonly [number, number]>> = Object.freeze({
	"--radius": [0, 32], "--radius-panel": [0, 32], "--radius-sm": [0, 32], "--radius-control": [0, 32], "--radius-xs": [0, 32], "--radius-pill": [0, 999],
	"--control-h": [24, 64], "--control-h-sm": [20, 56], "--content-w": [480, 1200], "--sidebar-w": [200, 480],
	"--fs-2xs": [8, 40], "--fs-xs": [8, 40], "--fs-sm": [8, 40], "--fs-md": [8, 40], "--fs-base": [8, 40], "--fs-lg": [8, 40], "--fs-xl": [8, 40], "--fs-2xl": [8, 48],
});
/** Font tokens: a font-family list (names, quotes, commas; no functions). A package's `assets` can supply the faces. */
const FONT_TOKENS = ["--font", "--mono"] as const;
/** Every design token a theme may set. Anything else (layout, z-index, motion) is for `ui-style`. */
export const THEME_TOKENS: readonly string[] = Object.freeze([...COLOR_TOKENS, ...Object.keys(SIZE_TOKENS), ...FONT_TOKENS]);

export const SETTING_TYPES = Object.freeze(["string", "number", "boolean", "select"] as const);
export type SettingType = (typeof SETTING_TYPES)[number];
export type SettingValue = string | number | boolean;
export interface SettingOption { value: string; label: string }
/** One user-editable setting declared by a manifest. The host renders the form and validates values. */
export interface SettingField {
	key: string;
	type: SettingType;
	label: string;
	description?: string;
	placeholder?: string;
	default?: SettingValue;
	required?: boolean;
	secret?: boolean;
	format?: "origin";
	min?: number;
	max?: number;
	options?: SettingOption[];
}
export const MAX_SETTING_FIELDS = 20;

export interface ExtensionPackage {
	manifest: {
		id: string;
		name: string;
		version: string;
		sdkVersion: 1;
		description?: string;
		permissions: Permission[];
		settings?: SettingField[];
		settingsScope?: "local" | "server";
	};
	theme?: { dark?: Record<string, string>; light?: Record<string, string> };
	commands?: { name: string; description: string; template: string }[];
	/** UI language packs (needs the `locales` permission). Korean source string -> translation, same as the built-in English. */
	locales?: LocalePackage[];
	/** App-wide CSS (needs `ui-style`). Target `[data-part="..."]` (see STYLE_PARTS). */
	styles?: string;
	/** Images and fonts as base64 `data:` URLs by name (needs `ui-style` or `ui-components`); see ASSET_LIMITS. */
	assets?: Record<string, string>;
	/** Svelte 5 component sources by name (needs `ui-components`). They run in the app itself, with its full access. */
	components?: Record<string, string>;
	mounts?: ComponentMount[];
	replaces?: Partial<Record<UIPart, string>>;
	code?: string;
}
export interface LocalePackage { tag: string; name: string; messages: Record<string, string> }
/** Mirrors the server's limits for `PUT /locales/:tag` so a package that installs also publishes. */
export const LOCALE_LIMITS = Object.freeze({ packs: 5, messages: 3000, key: 1000, value: 2000, name: 60 });
export const LOCALE_TAG = /^[a-z]{2,3}(?:-[a-z0-9]{2,8}){0,3}$/;
/** Shipped with the client, so a package cannot replace them. */
const RESERVED_LOCALES = ["ko", "en"];

const ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const COMMAND_NAME = /^[a-z][a-z0-9-]{0,39}$/;
const NUMERIC_VERSION = "(?:0|[1-9][0-9]*)";
const PRERELEASE = "(?:0|[1-9][0-9]*|[0-9]*[a-zA-Z-][0-9a-zA-Z-]*)";
const VERSION = new RegExp(`^${NUMERIC_VERSION}\\.${NUMERIC_VERSION}\\.${NUMERIC_VERSION}(?:-${PRERELEASE}(?:\\.${PRERELEASE})*)?$`);
const COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const BYTE = "(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])";
const ALPHA = "(?:0|1|0?\\.[0-9]{1,4}|1\\.0{1,4})";
const RGB = new RegExp(`^rgba?\\(\\s?${BYTE}\\s?,\\s?${BYTE}\\s?,\\s?${BYTE}\\s?(?:,\\s?${ALPHA}\\s?)?\\)$`);
const FONT_LIST = /^[A-Za-z0-9 ,"'_-]{1,200}$/;
const SETTING_KEY = /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/;
const MAX_SETTING_STRING = 2000;
const DIMENSION = /^(?:0|[1-9][0-9]*)px$/;
const MAX_CODE_BYTES = 128 * 1024;
const encoder = new TextEncoder();

function fail(path: string, message: string): never {
	throw new Error(`${path}: ${message}`);
}

function object(input: unknown, path: string, keys: readonly string[]): Record<string, unknown> {
	if (input === null || typeof input !== "object") fail(path, "expected a plain object");
	const prototype = Object.getPrototypeOf(input);
	if (prototype !== Object.prototype && prototype !== null) fail(path, "expected a plain object");
	const result: Record<string, unknown> = Object.create(null);
	for (const key of Reflect.ownKeys(input)) {
		if (typeof key !== "string" || !keys.includes(key)) fail(path, `unknown field ${String(key)}`);
		const descriptor = Object.getOwnPropertyDescriptor(input, key)!;
		if (!descriptor.enumerable || !("value" in descriptor)) fail(`${path}.${key}`, "expected an enumerable data field");
		result[key] = descriptor.value;
	}
	return result;
}

function array(input: unknown, path: string, max: number): unknown[] {
	if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) fail(path, "expected an array");
	if (input.length > max) fail(path, `must contain at most ${max} entries`);
	// JSON arrays must be dense data, without hidden fields, getters, or custom serialization.
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
	if (nonempty && input.trim().length === 0) fail(path, "must not be empty");
	return input;
}

function matches(pattern: RegExp, value: string): boolean {
	// JavaScript's $ also matches before a final newline; require an exact full match.
	return pattern.exec(value)?.[0] === value;
}

function palette(input: unknown, path: string): Record<string, string> {
	const source = object(input, path, THEME_TOKENS);
	const result: Record<string, string> = {};
	for (const token of THEME_TOKENS) {
		if (!Object.hasOwn(source, token)) continue;
		const size = Object.hasOwn(SIZE_TOKENS, token) ? SIZE_TOKENS[token] : undefined;
		const font = (FONT_TOKENS as readonly string[]).includes(token);
		const value = text(source[token], `${path}.${token}`, font ? 200 : 40);
		if (size) {
			const [min, max] = size;
			if (!matches(DIMENSION, value) || Number(value.slice(0, -2)) < min || Number(value.slice(0, -2)) > max) {
				fail(`${path}.${token}`, `expected integer px between ${min} and ${max}`);
			}
		} else if (font) {
			if (!matches(FONT_LIST, value)) fail(`${path}.${token}`, "expected a font-family list (letters, digits, spaces, quotes, commas, - and _)");
		} else if (!matches(COLOR, value) && !matches(RGB, value)) {
			fail(`${path}.${token}`, "expected a hex color (#rgb, #rgba, #rrggbb, #rrggbbaa) or rgb()/rgba() with numbers");
		}
		// Only the fixed token whitelist reaches this assignment.
		result[token] = value;
	}
	return result;
}

function isOrigin(value: string): boolean {
	try { httpOrigin(value); return true; } catch { return false; }
}

function optionalFlag(source: Record<string, unknown>, name: string, path: string): boolean | undefined {
	if (!Object.hasOwn(source, name)) return undefined;
	if (typeof source[name] !== "boolean") fail(`${path}.${name}`, "expected a boolean");
	return source[name] as boolean;
}

function finite(source: Record<string, unknown>, name: string, path: string): number | undefined {
	if (!Object.hasOwn(source, name)) return undefined;
	const value = source[name];
	if (typeof value !== "number" || !Number.isFinite(value)) fail(`${path}.${name}`, "expected a finite number");
	return value as number;
}

function settingField(value: unknown, path: string, keys: Set<string>): SettingField {
	const source = object(value, path, ["key", "type", "label", "description", "placeholder", "default", "required", "secret", "format", "min", "max", "options"]);
	const key = text(source.key, `${path}.key`, 40);
	if (!matches(SETTING_KEY, key)) fail(`${path}.key`, "expected a letter followed by letters, digits or underscores (max 40)");
	if (keys.has(key)) fail(`${path}.key`, `duplicate setting key ${key}`);
	keys.add(key);
	const type = source.type;
	if (typeof type !== "string" || !SETTING_TYPES.includes(type as SettingType)) fail(`${path}.type`, "expected string, number, boolean or select");
	const field: SettingField = { key, type: type as SettingType, label: text(source.label, `${path}.label`, 60) };
	if (Object.hasOwn(source, "description")) field.description = text(source.description, `${path}.description`, 200, false);
	if (Object.hasOwn(source, "placeholder")) field.placeholder = text(source.placeholder, `${path}.placeholder`, 80, false);
	const required = optionalFlag(source, "required", path);
	if (required !== undefined) field.required = required;
	const secret = optionalFlag(source, "secret", path);
	if (secret !== undefined) { if (type !== "string") fail(`${path}.secret`, "secret requires a string"); field.secret = secret; }
	if (secret && Object.hasOwn(source, "default")) fail(`${path}.default`, "secret fields must not contain defaults");

	if (type !== "string" && Object.hasOwn(source, "format")) fail(`${path}.format`, "format is only allowed for string settings");
	if (type !== "number") for (const name of ["min", "max"]) if (Object.hasOwn(source, name)) fail(`${path}.${name}`, "min/max are only allowed for number settings");
	if (type !== "select" && Object.hasOwn(source, "options")) fail(`${path}.options`, "options are only allowed for select settings");

	if (type === "string" && Object.hasOwn(source, "format")) {
		if (source.format !== "origin") fail(`${path}.format`, "only the origin format is supported");
		field.format = "origin";
	}
	if (type === "number") {
		const min = finite(source, "min", path);
		const max = finite(source, "max", path);
		if (min !== undefined) field.min = min;
		if (max !== undefined) field.max = max;
		if (min !== undefined && max !== undefined && min > max) fail(`${path}.min`, "min must not exceed max");
	}
	if (type === "select") {
		if (!Object.hasOwn(source, "options")) fail(`${path}.options`, "select settings require options");
		const values = new Set<string>();
		field.options = array(source.options, `${path}.options`, 20).map((item, index) => {
			const optionPath = `${path}.options[${index}]`;
			const option = object(item, optionPath, ["value", "label"]);
			const optionValue = text(option.value, `${optionPath}.value`, 60);
			if (values.has(optionValue)) fail(`${optionPath}.value`, `duplicate option ${optionValue}`);
			values.add(optionValue);
			return { value: optionValue, label: text(option.label, `${optionPath}.label`, 60) };
		});
		if (field.options.length < 2) fail(`${path}.options`, "select settings need at least 2 options");
	}
	if (Object.hasOwn(source, "default")) {
		const fallback = source.default;
		const bad = (message: string) => fail(`${path}.default`, message);
		if (type === "string") {
			if (typeof fallback !== "string") bad("expected a string");
			if ((fallback as string).length > MAX_SETTING_STRING) bad(`must be at most ${MAX_SETTING_STRING} characters`);
			if (field.format === "origin" && !isOrigin(fallback as string)) bad("expected an http(s) origin");
		} else if (type === "number") {
			if (typeof fallback !== "number" || !Number.isFinite(fallback)) bad("expected a finite number");
			if (field.min !== undefined && (fallback as number) < field.min) bad("must not be below min");
			if (field.max !== undefined && (fallback as number) > field.max) bad("must not exceed max");
		} else if (type === "boolean") {
			if (typeof fallback !== "boolean") bad("expected a boolean");
		} else if (typeof fallback !== "string" || !field.options!.some(option => option.value === fallback)) {
			bad("must be one of the options");
		}
		field.default = fallback as SettingValue;
	}
	return field;
}

export interface ResolvedSettings {
	values: Record<string, SettingValue>;
	errors: Record<string, string>;
	ok: boolean;
}

function plain(input: unknown): input is Record<string, unknown> {
	return input !== null && typeof input === "object" && !Array.isArray(input);
}

/** Textual fields treat "" (and null) as "not set"; numbers and booleans never accept "". */
function unset(field: SettingField, value: unknown): boolean {
	if (value === undefined || value === null) return true;
	return value === "" && (field.type === "string" || field.type === "select");
}

/**
 * Validate a user-edited value set against the manifest schema. Pure; never mutates its input.
 * Apply defaults, drop unknown keys and validate types strictly (no coercion: "5" is not a number).
 * Invalid values are reported in `errors` and left out of `values`.
 */
export function resolveSettings(fields: readonly SettingField[], raw: unknown): ResolvedSettings {
	const source = plain(raw) ? raw : {};
	const values: Record<string, SettingValue> = {};
	const errors: Record<string, string> = {};
	for (const field of fields) {
		let value: unknown = Object.hasOwn(source, field.key) ? source[field.key] : undefined;
		if (field.required && field.type === "string" && typeof value === "string" && !value.trim()) value = undefined;
		if (unset(field, value)) {
			if (field.default !== undefined) values[field.key] = field.default;
			else if (field.required) errors[field.key] = t("필수 항목입니다");
			continue;
		}
		const bad = (message: string) => { errors[field.key] = message; };
		if (field.type === "string") {
			if (typeof value !== "string") bad(t("문자열이어야 합니다"));
			else if (value.length > MAX_SETTING_STRING) bad(t("최대 {n}자까지 입력할 수 있습니다", { n: MAX_SETTING_STRING }));
			else if (field.format === "origin" && !isOrigin(value)) bad(t("올바른 주소(origin)가 아닙니다"));
			else values[field.key] = value;
		} else if (field.type === "number") {
			if (typeof value !== "number" || !Number.isFinite(value)) bad(t("숫자여야 합니다"));
			else if (field.min !== undefined && value < field.min) bad(t("최소 {n} 이상", { n: field.min }));
			else if (field.max !== undefined && value > field.max) bad(t("최대 {n} 이하", { n: field.max }));
			else values[field.key] = value;
		} else if (field.type === "boolean") {
			if (typeof value !== "boolean") bad(t("참/거짓 값이어야 합니다"));
			else values[field.key] = value;
		} else if (typeof value !== "string" || !field.options?.some(option => option.value === value)) {
			bad(t("선택할 수 없는 값입니다"));
		} else {
			values[field.key] = value;
		}
	}
	return { values, errors, ok: Object.keys(errors).length === 0 };
}

/** Copy `raw` and add the default of every declared field that has no value yet. Existing values are kept as-is. */
export function fillSettingDefaults(fields: readonly SettingField[], raw: unknown): Record<string, unknown> {
	const result: Record<string, unknown> = plain(raw) ? JSON.parse(JSON.stringify(raw)) : {};
	for (const field of fields) {
		if (field.default !== undefined && unset(field, Object.hasOwn(result, field.key) ? result[field.key] : undefined)) result[field.key] = field.default;
	}
	return result;
}

/** One-line summary of validation errors, e.g. "서버 주소: 필수 항목입니다 · 간격: 최소 10 이상". */
export function describeSettingErrors(fields: readonly SettingField[], errors: Record<string, string>, limit = 3): string {
	const parts = fields.filter(field => Object.hasOwn(errors, field.key)).map(field => `${field.label}: ${errors[field.key]}`);
	return parts.slice(0, limit).join(" · ") + (parts.length > limit ? ` ${t("외 {n}개", { n: parts.length - limit })}` : "");
}

/** Validate portable JSON data and return a fresh package with no input object references. */
/** Validates the `settings` fields a server extension declares in its package.json (same rules as a client manifest's). Throws on a bad field. */
export function parseSettingFields(input: unknown): SettingField[] {
	const keys = new Set<string>();
	return array(input, "settings", MAX_SETTING_FIELDS).map((value, index) => settingField(value, `settings[${index}]`, keys));
}

const COMPONENT_NAME = /^[A-Z][A-Za-z0-9]{0,39}$/;

function parseComponents(source: Record<string, unknown>, result: ExtensionPackage, permissions: Permission[]) {
	const has = ["components", "mounts", "replaces"].filter(key => Object.hasOwn(source, key));
	if (!has.length) return;
	if (!permissions.includes("ui-components")) fail("manifest.permissions", `${has.join(", ")} require the ui-components permission`);
	if (!Object.hasOwn(source, "components")) fail("components", "mounts and replaces need components");
	const raw = object(source.components, "components", Object.keys(source.components && typeof source.components === "object" ? source.components : {}));
	const names = Object.keys(raw);
	if (!names.length) fail("components", "must not be empty");
	if (names.length > COMPONENT_LIMITS.components) fail("components", `must contain at most ${COMPONENT_LIMITS.components} components`);
	const components: Record<string, string> = {};
	for (const name of names) {
		if (!matches(COMPONENT_NAME, name)) fail(`components.${name}`, "expected a PascalCase name (max 40)");
		const code = text(raw[name], `components.${name}`, COMPONENT_LIMITS.source);
		if (encoder.encode(code).byteLength > COMPONENT_LIMITS.source) fail(`components.${name}`, `must be at most ${COMPONENT_LIMITS.source} UTF-8 bytes`);
		components[name] = code;
	}
	result.components = components;
	const known = (value: unknown, path: string) => {
		const name = text(value, path, 40);
		if (!Object.hasOwn(components, name)) fail(path, `unknown component ${name}`);
		return name;
	};
	if (Object.hasOwn(source, "mounts")) {
		result.mounts = array(source.mounts, "mounts", COMPONENT_LIMITS.mounts).map((value, index) => {
			const path = `mounts[${index}]`;
			const mount = object(value, path, ["slot", "component", "order"]);
			if (typeof mount.slot !== "string" || !UI_SLOTS.includes(mount.slot as UISlot)) fail(`${path}.slot`, `expected one of ${UI_SLOTS.join(", ")}`);
			const out: ComponentMount = { slot: mount.slot as UISlot, component: known(mount.component, `${path}.component`) };
			if (Object.hasOwn(mount, "order")) {
				const order = finite(mount, "order", path)!;
				if (!Number.isInteger(order) || Math.abs(order) > 1000) fail(`${path}.order`, "expected an integer between -1000 and 1000");
				out.order = order;
			}
			return out;
		});
	}
	if (Object.hasOwn(source, "replaces")) {
		const replaces = object(source.replaces, "replaces", UI_PARTS);
		result.replaces = {};
		for (const part of UI_PARTS) if (Object.hasOwn(replaces, part)) result.replaces[part] = known(replaces[part], `replaces.${part}`);
	}
}

function parseAssets(input: unknown, result: ExtensionPackage, permissions: Permission[]) {
	if (!permissions.includes("ui-style") && !permissions.includes("ui-components")) fail("manifest.permissions", "assets require the ui-style or ui-components permission");
	const raw = object(input, "assets", Object.keys(input && typeof input === "object" ? input : {}));
	const names = Object.keys(raw);
	if (!names.length) fail("assets", "must not be empty");
	if (names.length > ASSET_LIMITS.count) fail("assets", `must contain at most ${ASSET_LIMITS.count} files`);
	const assets: Record<string, string> = {};
	let total = 0;
	for (const name of names) {
		if (!matches(ASSET_NAME, name)) fail(`assets.${name.slice(0, 64)}`, "expected a lowercase file name (letters, digits, . _ -; max 64)");
		const value = text(raw[name], `assets.${name}`, ASSET_LIMITS.bytes + 64);
		const type = matches(ASSET_URL, value) ? ASSET_URL.exec(value)![1]! : "";
		if (!(ASSET_TYPES as readonly string[]).includes(type)) fail(`assets.${name}`, `expected a base64 data: URL of ${ASSET_TYPES.join(", ")}`);
		total += value.length;
		assets[name] = value;
	}
	if (total > ASSET_LIMITS.bytes) fail("assets", `must be at most ${ASSET_LIMITS.bytes} bytes in total`);
	result.assets = assets;
}

export function parsePackage(input: unknown): ExtensionPackage {
	const source = object(input, "package", ["manifest", "theme", "commands", "locales", "styles", "assets", "components", "mounts", "replaces", "code"]);
	const manifest = object(source.manifest, "manifest", ["id", "name", "version", "sdkVersion", "description", "permissions", "settings", "settingsScope"]);
	const id = text(manifest.id, "manifest.id", 80);
	if (!matches(ID, id) || ["constructor", "prototype"].includes(id)) fail("manifest.id", "expected a safe lowercase extension ID");
	const name = text(manifest.name, "manifest.name", 80);
	const version = text(manifest.version, "manifest.version", 80);
	if (!matches(VERSION, version)) fail("manifest.version", "expected x.y.z with an optional SemVer prerelease");
	if (manifest.sdkVersion !== SDK_VERSION) fail("manifest.sdkVersion", `only SDK ${SDK_VERSION} is supported`);
	const permissions: Permission[] = [];
	for (const value of array(manifest.permissions, "manifest.permissions", PERMISSIONS.length)) {
		if (typeof value !== "string" || !PERMISSIONS.includes(value as Permission)) fail("manifest.permissions", "unknown permission; expected a supported permission string");
		const permission = value as Permission;
		if (permissions.includes(permission)) fail("manifest.permissions", `duplicate permission ${permission}`);
		permissions.push(permission);
	}
	const result: ExtensionPackage = { manifest: { id, name, version, sdkVersion: SDK_VERSION, permissions } };
	if (Object.hasOwn(manifest, "description")) {
		result.manifest.description = text(manifest.description, "manifest.description", 2000, false);
	}
	if (Object.hasOwn(manifest, "settingsScope")) {
		if (manifest.settingsScope !== "local" && manifest.settingsScope !== "server") fail("manifest.settingsScope", "expected local or server");
		result.manifest.settingsScope = manifest.settingsScope;
	}
	if (Object.hasOwn(manifest, "settings")) {
		const keys = new Set<string>();
		result.manifest.settings = array(manifest.settings, "manifest.settings", MAX_SETTING_FIELDS).map((value, index) => settingField(value, `manifest.settings[${index}]`, keys));
	}
	if (Object.hasOwn(source, "theme")) {
		const theme = object(source.theme, "theme", ["dark", "light"]);
		result.theme = {};
		if (Object.hasOwn(theme, "dark")) result.theme.dark = palette(theme.dark, "theme.dark");
		if (Object.hasOwn(theme, "light")) result.theme.light = palette(theme.light, "theme.light");
	}
	if (Object.hasOwn(source, "commands")) {
		const names = new Set<string>();
		result.commands = array(source.commands, "commands", 20).map((value, index) => {
			const path = `commands[${index}]`;
			const command = object(value, path, ["name", "description", "template"]);
			const name = text(command.name, `${path}.name`, 40);
			if (!matches(COMMAND_NAME, name)) fail(`${path}.name`, "expected a lowercase command name");
			if (names.has(name)) fail(`${path}.name`, `duplicate command ${name}`);
			names.add(name);
			return {
				name,
				description: text(command.description, `${path}.description`, 500),
				template: text(command.template, `${path}.template`, 16000),
			};
		});
		if (result.commands.length && (!permissions.includes("commands") || !permissions.includes("composer"))) {
			fail("manifest.permissions", "commands require both commands and composer permissions (templates prefill only)");
		}
	}
	if (Object.hasOwn(source, "locales")) {
		const tags = new Set<string>();
		result.locales = array(source.locales, "locales", LOCALE_LIMITS.packs).map((value, index) => {
			const path = `locales[${index}]`;
			const pack = object(value, path, ["tag", "name", "messages"]);
			const tag = text(pack.tag, `${path}.tag`, 35);
			if (!matches(LOCALE_TAG, tag)) fail(`${path}.tag`, "expected a lowercase language tag such as ja or pt-br");
			if (RESERVED_LOCALES.includes(tag)) fail(`${path}.tag`, `${tag} is built into the client`);
			if (tags.has(tag)) fail(`${path}.tag`, `duplicate language ${tag}`);
			tags.add(tag);
			const raw = object(pack.messages, `${path}.messages`, Object.keys(pack.messages && typeof pack.messages === "object" ? pack.messages : {}));
			const keys = Object.keys(raw);
			if (!keys.length) fail(`${path}.messages`, "must not be empty");
			if (keys.length > LOCALE_LIMITS.messages) fail(`${path}.messages`, `must contain at most ${LOCALE_LIMITS.messages} entries`);
			const messages: Record<string, string> = Object.create(null);
			for (const key of keys) {
				if (key === "__proto__" || !key || key.length > LOCALE_LIMITS.key) fail(`${path}.messages`, "invalid message key");
				messages[key] = text(raw[key], `${path}.messages[${JSON.stringify(key.slice(0, 40))}]`, LOCALE_LIMITS.value);
			}
			return { tag, name: text(pack.name, `${path}.name`, LOCALE_LIMITS.name), messages: { ...messages } };
		});
		if (result.locales.length && !permissions.includes("locales")) fail("manifest.permissions", "locales require the locales permission");
	}
	if (Object.hasOwn(source, "code")) {
		result.code = text(source.code, "code", MAX_CODE_BYTES, false);
		if (encoder.encode(result.code).byteLength > MAX_CODE_BYTES) fail("code", `must be at most ${MAX_CODE_BYTES} UTF-8 bytes`);
	}
	if (Object.hasOwn(source, "assets")) parseAssets(source.assets, result, permissions);
	if (Object.hasOwn(source, "styles")) {
		if (!permissions.includes("ui-style")) fail("manifest.permissions", "styles require the ui-style permission");
		result.styles = text(source.styles, "styles", COMPONENT_LIMITS.styles);
		// The stylesheet is app-wide: it may not end its own <style> element or pull in other sheets.
		if (/<\/?style|@import/i.test(result.styles)) fail("styles", "must not contain </style> or @import");
		for (const m of result.styles.matchAll(ASSET_REF)) {
			const name = m[1] ?? m[2] ?? m[3] ?? "";
			if (!result.assets || !Object.hasOwn(result.assets, name)) fail("styles", `asset("${name.slice(0, 64)}") is not in assets`);
		}
	}
	parseComponents(source, result, permissions);
	if (!result.theme && !result.commands?.length && !result.locales?.length && !result.code?.trim() && !result.styles && !result.components) {
		fail("package", "must contain a theme, nonempty commands, language packs, styles, components, or nonempty code");
	}
	// All input fields are validated JSON data before serialization; no toJSON hooks are allowed.
	if (encoder.encode(JSON.stringify(source)).byteLength > MAX_PACKAGE_BYTES) {
		fail("package", `must be at most ${MAX_PACKAGE_BYTES} UTF-8 bytes`);
	}
	return result;
}
