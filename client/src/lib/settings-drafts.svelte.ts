/**
 * Unsaved input of the settings forms. A pane is rebuilt whenever the user opens another section, another server or
 * closes Settings; without this, a half-typed address, key or keyword list was gone after a look elsewhere. Each form
 * keeps its draft here under its own key (with the server it belongs to) and drops it when it is saved or cancelled.
 *
 * Memory only, on purpose: drafts hold API keys and tokens, which must never be written to disk in clear. They last as
 * long as the app runs, which covers "I went to check something else and came back".
 */
class SettingsDrafts {
	/** Plain, not reactive: forms write here from their own effects, and a reactive read there would loop. */
	private store = new Map<string, unknown>();

	get<T>(key: string): T | undefined {
		const value = this.store.get(key);
		return value === undefined ? undefined : (structuredClone(value) as T);
	}

	set<T>(key: string, value: T): void {
		this.store.set(key, structuredClone($state.snapshot(value) as T));
	}

	clear(key: string): void {
		this.store.delete(key);
	}

	has(key: string): boolean {
		return this.store.has(key);
	}
}

export const settingsDrafts = new SettingsDrafts();

/**
 * Keeps one form's state in `settingsDrafts` while the component lives: call it once in the component's script with a
 * getter and a setter for the state and the key it belongs under. The kept value comes back when the component is
 * built again (the setter is called once, right away); every later change is written through; null/undefined clears it.
 * `keep` says whether the current state is worth keeping (unchanged forms are dropped, so a reload shows fresh values).
 */
export function keepDraft<T>(key: () => string, get: () => T | null | undefined, set: (value: T) => void, keep: (value: T) => boolean = () => true): void {
	const kept = settingsDrafts.get<T>(key());
	if (kept !== undefined) set(kept);
	$effect(() => {
		const value = get();
		const k = key();
		if (value === null || value === undefined || !keep(value)) settingsDrafts.clear(k);
		else settingsDrafts.set(k, value);
	});
}
