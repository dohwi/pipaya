import { httpOrigin } from "./http";
import { t } from "../i18n";

export const SDK_VERSION = 1;
export const MAX_PACKAGE_BYTES = 256 * 1024;
export const PERMISSIONS = Object.freeze([
	"commands", "composer", "status", "context", "storage", "notifications", "events", "ui", "navbar", "http", "configuration", "http-write", "configuration-background", "system-notifications", "locales",
	"server", "shortcuts", "dialogs", "session", "tools", "messages", "slots", "composer-filter",
] as const);
export type Permission = (typeof PERMISSIONS)[number];

export const THEME_TOKENS = Object.freeze([
	"--bg", "--bg-side", "--bg-elev", "--bg-hover", "--bg-active", "--bg-code",
	"--border", "--border-strong", "--text", "--text-dim", "--text-faint", "--user-bg",
	"--accent", "--accent-hover", "--accent-fg", "--accent-soft", "--ok", "--warn",
	"--danger", "--radius", "--radius-panel", "--radius-sm", "--content-w",
] as const);

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
		const value = text(source[token], `${path}.${token}`, 16);
		if (token === "--content-w" || token.startsWith("--radius")) {
			const min = token === "--content-w" ? 480 : 0;
			const max = token === "--content-w" ? 1200 : 32;
			if (!matches(DIMENSION, value) || Number(value.slice(0, -2)) < min || Number(value.slice(0, -2)) > max) {
				fail(`${path}.${token}`, `expected integer px between ${min} and ${max}`);
			}
		} else if (!matches(COLOR, value)) {
			fail(`${path}.${token}`, "expected a hex color (#rgb, #rgba, #rrggbb, or #rrggbbaa)");
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
export function parsePackage(input: unknown): ExtensionPackage {
	const source = object(input, "package", ["manifest", "theme", "commands", "locales", "code"]);
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
	if (!result.theme && !result.commands?.length && !result.locales?.length && !result.code?.trim()) {
		fail("package", "must contain a theme, nonempty commands, language packs, or nonempty code");
	}
	// All input fields are validated JSON data before serialization; no toJSON hooks are allowed.
	if (encoder.encode(JSON.stringify(source)).byteLength > MAX_PACKAGE_BYTES) {
		fail("package", `must be at most ${MAX_PACKAGE_BYTES} UTF-8 bytes`);
	}
	return result;
}
