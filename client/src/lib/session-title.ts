import { t } from "./i18n";

/** The server stores this literal for a session nobody has named yet; it is a marker, not display text. */
export const DEFAULT_SESSION_TITLE = "New session";

/** Title to show: the untitled marker becomes the localized "new chat"; real titles pass through. */
export const sessionTitle = (title: string | undefined | null): string => (!title || title === DEFAULT_SESSION_TITLE ? t("새 대화") : title);
