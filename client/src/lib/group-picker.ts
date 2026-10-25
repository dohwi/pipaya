import { app } from "./store.svelte";
import { msg, t } from "./i18n";
import { tilde } from "./format";

/** Touch has no drag and drop (and menus have no target to drop on): pick the conversation to pull `x` together with. */
export function chooseGroup(x: { id: string; title: string }) {
	const own = app.groupOf(x.id);
	app.palette = {
		title: t("'{title}'와 묶기", { title: x.title }),
		empty: msg("묶을 다른 대화가 없습니다"),
		items: [...app.sessions, ...app.terminals]
			.filter((s) => s.id !== x.id)
			.map((s) => ({ id: s.id, title: s.title, sub: app.groupOf(s.id)?.name ?? tilde(s.cwd, app.workspace?.home), current: !!own && app.groupOf(s.id)?.id === own.id })),
		onpick: (it) => void app.groupWith(x.id, it.id),
	};
}
