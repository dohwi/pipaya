import { activityOf } from "./activity";
import { copyText } from "./clipboard";
import { openContextMenu } from "./context-menu";
import { t } from "./i18n";
import { hideMentionHover } from "./mention-hover.svelte";
import type { MentionTarget } from "./peers";
import { app } from "./store.svelte";
import { viewport } from "./viewport.svelte";
import type { RowMenuItem } from "../components/ui/RowMenu.svelte";

/**
 * Open a right-click context menu on a `@mention` chip:
 *  - open session (same server): peek, open chat, open beside in split group, stop if running, copy `@name`
 *  - closed session: read-only preview, resume & open, copy `@name`
 *  - remote server session: read-only preview, switch to server & open, copy `@name`
 *  - group: open group, copy `@group`
 */
export function openMentionMenu(
	e: MouseEvent,
	target: MentionTarget,
	opts: { label: string; currentSessionId?: string | null },
): void {
	const items: RowMenuItem[] = [];
	const copyLabel = opts.label.startsWith("@") ? opts.label : `@${opts.label}`;

	if (target.kind === "group") {
		if (!app.groups.some((g) => g.id === target.id)) return;
		items.push({
			icon: "group",
			label: t("그룹 열기"),
			title: "",
			run: () => app.openMention(target, { direct: false }),
		});
	} else {
		const targetServer = target.server ?? app.serverId;
		const s = targetServer ? app.sessionAny(target.id, targetServer) : undefined;
		if (!s || !targetServer) return;
		const isSameServer = targetServer === app.serverId;
		const isClosed = s.closed;
		const isPeekingThis = app.chatPeek?.server === targetServer && app.chatPeek?.session === target.id;

		if (isClosed) {
			if (!isPeekingThis) {
				items.push({
					icon: "chat",
					label: t("기록 미리 보기"),
					title: "",
					run: () => app.openMention({ ...target, closed: true }, { direct: false }),
				});
			}
			items.push({
				icon: "undo",
				label: t("다시 열기"),
				title: "",
				run: () => app.openMention({ ...target, closed: true }, { direct: true }),
			});
		} else if (!isSameServer) {
			const srv = app.servers.find((x) => x.id === targetServer);
			const srvName = srv ? app.serverLabel(srv) : targetServer;
			if (!isPeekingThis) {
				items.push({
					icon: "chat",
					label: t("미리 보기"),
					title: "",
					run: () => app.openMention(target, { direct: false }),
				});
			}
			items.push({
				icon: "server",
				label: t("{server}에서 열기", { server: srvName }),
				title: "",
				run: () => app.openMention(target, { direct: true }),
			});
		} else {
			if (!isPeekingThis && target.id !== app.activeId) {
				items.push({
					icon: "chat",
					label: t("미리 보기"),
					title: "",
					run: () => app.openMention(target, { direct: false }),
				});
			}
			items.push({
				icon: "arrow-right",
				label: t("대화 열기"),
				title: "",
				run: () => app.openMention(target, { direct: true }),
			});

			// Offer side-by-side split into a group with the current active chat on wide screens.
			const anchorId = app.activeId ?? opts.currentSessionId ?? null;
			const anchorGroup = anchorId ? app.groupOf(anchorId) : undefined;
			const targetGroup = app.groupOf(target.id);
			const alreadyTogether = !!anchorGroup && anchorGroup.id === targetGroup?.id;
			if (!viewport.narrow && anchorId && anchorId !== target.id && app.session(anchorId) && !alreadyTogether) {
				items.push({
					icon: "columns",
					label: t("옆에 분할해서 열기"),
					title: "",
					run: () => {
						app.closeChatPeek();
						void app.groupWith(target.id, anchorId);
					},
				});
			}

			const link = app.links[targetServer];
			const act = link ? activityOf(link.data, target.id) : "idle";
			if (act === "working" || act === "asking") {
				items.push({
					icon: "stop",
					label: t("작업 중지"),
					title: "",
					run: () => void app.abort(target.id),
				});
			}
		}
	}

	e.preventDefault();
	e.stopPropagation();
	hideMentionHover();

	items.push({
		icon: "copy",
		label: t("이름 복사"),
		title: "",
		run: () => {
			void copyText(copyLabel).then((ok) => {
				if (ok) app.toast(t("{name}을(를) 복사했습니다", { name: copyLabel }), "ok");
			});
		},
	});

	openContextMenu({ x: e.clientX, y: e.clientY }, `mention:${target.kind}:${target.id}`, items);
}
