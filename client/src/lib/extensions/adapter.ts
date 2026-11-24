/**
 * Builds the `HostAdapter` bridging `ExtensionHost` to `AppStore`, notifications, commands, and workspace adapters.
 * Extracted from `App.svelte` so the root shell component stays focused on layout and lifecycle.
 */
import { copyText } from "../clipboard";
import { COMMANDS, runCommand } from "../commands";
import { getLang, t } from "../i18n";
import { notificationRules } from "../notification-rules";
import { notifications } from "../notifications";
import { app } from "../store.svelte";
import { openExternal } from "../tauri";
import type { HostAdapter } from "./host.svelte";
import { paneAdapter } from "./panes";
import { workspaceAdapter } from "./workspace";

export function createExtensionHostAdapter(): HostAdapter {
  const api = () => {
    if (!app.api) throw new Error(t("서버에 연결해 주세요"));
    return app.api;
  };
  return {
    prefill: (text) => {
      app.prefill = text;
    },
    notify: (text) => app.toast(text),
    systemNotifications: {
      send: (owner, spec) => api().sendNotification(owner, spec),
      status: () => notifications.status(),
      register: async (owner, id, rule) => {
        await notificationRules.register(api(), owner, id, rule);
      },
      remove: async (owner, id) => {
        await notificationRules.remove(api(), owner, id);
      },
      revoke: async (owner) => {
        await notificationRules.revoke(api(), owner);
      },
    },
    context: () => ({
      sessionId: app.activeId,
      model: app.effective.model,
      provider: app.effective.provider,
      running: app.runningHere,
      online: app.net === "online",
      language: getLang(),
    }),
    session: {
      send: async (text, mode) => {
        if (!app.activeId) throw new Error(t("열려 있는 대화가 없습니다"));
        const ok =
          mode === "steer"
            ? await app.steer(text)
            : mode === "follow_up"
              ? await app.queue(text)
              : await app.send(text);
        if (!ok) throw new Error(t("보내지 못했습니다"));
      },
      abort: async () => {
        if (app.activeId) await app.abort();
      },
    },
    panes: paneAdapter(app),
    workspace: workspaceAdapter(app, {
      names: () => COMMANDS.map((c) => c.name),
      run: (name, arg) => runCommand(name, arg),
    }),
    dialog: (request) => app.extensionRequests.ask(request),
    dark: () => app.prefs.resolvedDark,
    reservedCommands: () => COMMANDS.map((c) => c.name),
    connection: () => app.conn,
    openUrl: (url) => openExternal(url),
    copy: (text) => copyText(text),
    serverId: () => app.serverId,
    deviceId: () => notifications.id,
    listChanged: () => app.listChanged(),
    statesChanged: () => app.statesChanged(),
    configuration: {
      capture: () => app.captureConfiguration(),
      apply: (document) => app.applyConfiguration(document),
      applyBackground: (document) => app.applyBackgroundConfiguration(document),
      backup: () => app.backupConfiguration(),
      restore: (value) => app.restoreConfiguration(value),
      confirm: (message) => app.extensionRequests.confirm(message),
    },
  };
}
