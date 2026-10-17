import { mount } from "svelte";
import "./app.css";
import "./lib/i18n.svelte";
import App from "./App.svelte";
import { installNoContextMenu } from "./lib/no-context-menu";
import { installRipple } from "./lib/ripple";

installRipple();
installNoContextMenu();

// Looping animations (spinners, pulses, shimmers) stop while the window is hidden; see `html.page-hidden` in app.css.
const syncHidden = () => document.documentElement.classList.toggle("page-hidden", document.hidden);
document.addEventListener("visibilitychange", syncHidden);
syncHidden();

mount(App, { target: document.getElementById("app")! });
