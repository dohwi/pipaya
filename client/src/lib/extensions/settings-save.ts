/**
 * How a page of an extension changes a few of its settings (`save(partial)` of a custom settings section or field).
 * It goes through the same rules as the form: only declared fields, never a `readonly` one (the extension writes those),
 * and the result must validate against the schema. Pure; throws a user-facing `LocalizedError`.
 */
import { LocalizedError, t } from "../i18n";
import { describeSettingErrors, resolveSettings, type SettingField } from "./schema";

export interface PartialSave {
	/** Every setting after the change: what a store that replaces the whole object takes (a client extension's own). */
	whole: Record<string, unknown>;
	/** Only the changed keys with their validated values, and the list of keys, for the server's keyed write. */
	changed: Record<string, unknown>;
	keys: string[];
}

const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));

export function planPartialSave(fields: readonly SettingField[] | undefined, current: Record<string, unknown>, partial: unknown): PartialSave {
	if (!isPlain(partial)) throw new LocalizedError(t("설정은 객체여야 합니다"));
	const keys = Object.keys(partial);
	if (keys.length > 100) throw new LocalizedError(t("한 번에 바꿀 수 있는 설정이 너무 많습니다"));
	for (const key of keys) if (key === "__proto__" || key === "constructor" || key === "prototype") throw new LocalizedError(t("잘못된 설정 이름"));
	const next = { ...current };
	for (const key of keys) {
		if (partial[key] === undefined || partial[key] === null) delete next[key];
		else next[key] = partial[key];
	}
	if (!fields?.length) {
		const changed: Record<string, unknown> = {};
		for (const key of keys) if (Object.hasOwn(next, key)) changed[key] = next[key];
		if (JSON.stringify(next).length > 16000) throw new LocalizedError(t("설정은 최대 16KB입니다"));
		return { whole: next, changed, keys };
	}
	for (const key of keys) {
		const field = fields.find((f) => f.key === key);
		if (!field) throw new LocalizedError(t("선언되지 않은 설정입니다 — {key}", { key }));
		if (field.readonly) throw new LocalizedError(t("{label}은(는) 확장이 직접 쓰는 값이라 바꿀 수 없습니다", { label: field.label }));
	}
	const { values, errors, ok } = resolveSettings(fields, next);
	if (!ok) throw new LocalizedError(t("설정이 올바르지 않습니다 — {detail}", { detail: describeSettingErrors(fields, errors) }));
	const changed: Record<string, unknown> = {};
	for (const key of keys) if (Object.hasOwn(values, key)) changed[key] = values[key];
	// Keys outside the form (undeclared, readonly) stay exactly as they are; the declared ones take their validated value.
	const whole = { ...current };
	for (const key of keys) { if (Object.hasOwn(changed, key)) whole[key] = changed[key]; else delete whole[key]; }
	if (JSON.stringify(whole).length > 16000) throw new LocalizedError(t("설정은 최대 16KB입니다"));
	return { whole, changed, keys };
}
