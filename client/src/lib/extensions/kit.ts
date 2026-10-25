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
import Modal from "../../components/Modal.svelte";
import ModalHeader from "../../components/ModalHeader.svelte";
import Select from "../../components/Select.svelte";
import Segmented from "../../components/Segmented.svelte";
import Accordion from "../../components/Accordion.svelte";
import Notice from "../../components/Notice.svelte";
import Markdown from "../../components/Markdown.svelte";
import SearchField from "../../components/SearchField.svelte";
import ExtensionView from "../../components/extensions/ExtensionView.svelte";
import { fadeIn, fadeOut, surfaceIn, surfaceOut, collapseIn, collapseOut, reduced } from "../motion";

/**
 * `ext.data` / `ext.settings` are getters: read them inside the component (markup, $derived, $effect) to stay reactive.
 * `ext.assets` holds the package's design files as `data:` URLs (`<img src={ext.assets["logo.svg"]}>`).
 */
export function kit(id: string, data: () => unknown, settings: () => Record<string, unknown>, assets: Readonly<Record<string, string>> = {}): Record<string, unknown> {
	const ext = {
		id,
		assets: Object.freeze({ ...assets }),
		get data() { return data(); },
		get settings() { return settings(); },
		get language() { return getLang(); },
		get dark() { return app.prefs.resolvedDark; },
	};
	return {
		ext, app, extensions, t, tc, getPane,
		// building blocks, so a component looks like the app without copying its markup
		Icon, Button, IconButton, Badge, Switch, Pin, StatusDot, Modal, ModalHeader, Select, Segmented, Accordion, Notice, Markdown, SearchField,
		// the declarative renderer, for a component that mixes its own look with plain nodes
		ExtensionView,
		// the app's motion, so a popover enters and leaves like the built-in ones
		motion: Object.freeze({ fadeIn, fadeOut, surfaceIn, surfaceOut, collapseIn, collapseOut, reduced }),
	};
}
