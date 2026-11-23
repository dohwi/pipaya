import { app } from "./store.svelte";
import { msg, t } from "./i18n";
import { tilde } from "./format";
import { errorText } from "./api";

/**
 * Pick the working tree (the main checkout or a git worktree of the same repository) a conversation should work in.
 * The server lists them; the one it works in now is marked. Touch and keyboard reach this from the row's menu;
 * dragging the row onto a folder of the same project does the same (see Sidebar).
 */
export async function chooseWorkdir(x: { id: string; title: string }, serverId?: string | null): Promise<void> {
	const sid = serverId ?? app.serverId;
	const link = sid ? app.links[sid] : null;
	if (!link) return;
	let list: { path: string; branch: string | null; home: boolean; current: boolean }[];
	try {
		list = (await link.api.sessionWorkdirs(x.id)).workdirs;
	} catch (e) {
		app.toast(`${t("작업 폴더 목록을 불러오지 못했습니다")}: ${errorText(e)}`, "error");
		return;
	}
	const home = link.workspace?.home;
	app.palette = {
		title: t("'{title}'의 작업 폴더", { title: x.title }),
		empty: msg("옮길 수 있는 worktree가 없습니다. 같은 저장소의 다른 worktree로만 옮길 수 있습니다"),
		items: list.map((w) => ({
			id: w.path,
			title: w.branch ?? w.path.split(/[\\/]/).filter(Boolean).pop() ?? w.path,
			sub: tilde(w.path, home),
			tag: w.home ? t("원래 폴더") : undefined,
			current: w.current,
		})),
		onpick: (it) => void app.moveWorkdir(x.id, it.id, true, link.id),
	};
}
