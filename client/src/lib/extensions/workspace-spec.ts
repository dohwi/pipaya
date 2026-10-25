/** Names `sdk.workspace` accepts. Kept free of app imports so the extension host can validate with them. */
export const SETTINGS_TABS = Object.freeze(["general", "servers", "keys", "extensions", "backup", "agent"] as const);
export type SettingsTab = (typeof SETTINGS_TABS)[number];
/** Built-in screens an extension may open. */
export const WORKSPACE_DIALOGS = Object.freeze(["skills", "commands", "queue", "folder"] as const);
export type WorkspaceDialog = (typeof WORKSPACE_DIALOGS)[number];
