/**
 * What a trusted component gets from `import { ... } from "pipaya"`: the app's own stores, translation and building
 * blocks. Components run in the app itself, so this is a convenience, not a boundary. Loaded together with the compiler.
 */
import { app } from "../store.svelte";
import { t, tc, getLang } from "../i18n";
import { getPane } from "../pane";
import { extensions } from "./host.svelte";
import Icon from "../../components/Icon.svelte";
import Button from "../../components/Button.svelte";
import IconButton from "../../components/IconButton.svelte";
import Badge from "../../components/Badge.svelte";
import Switch from "../../components/Switch.svelte";
import Pin from "../../components/Pin.svelte";
import StatusDot from "../../components/StatusDot.svelte";

/** `ext.data` / `ext.settings` are getters: read them inside the component (markup, $derived, $effect) to stay reactive. */
export function kit(id: string, data: () => unknown, settings: () => Record<string, unknown>): Record<string, unknown> {
	const ext = {
		id,
		get data() { return data(); },
		get settings() { return settings(); },
		get language() { return getLang(); },
		get dark() { return app.prefs.resolvedDark; },
	};
	return { ext, app, extensions, t, tc, getPane, Icon, Button, IconButton, Badge, Switch, Pin, StatusDot };
}
