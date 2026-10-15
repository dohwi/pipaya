// Connects i18n.ts to Svelte: `t()` reads `version`, so anything that rendered text re-renders when the language changes.
// Imported once from main.ts; without it (tests) `t()` still works, it just is not reactive.
import { onLangChange, setTracker } from "./i18n";

let version = $state(0);
setTracker(() => {
	void version;
});
onLangChange(() => {
	version++;
});
