<script lang="ts">
	import Button from "./Button.svelte";
	import { t } from "../lib/i18n";
	import { app } from "../lib/store.svelte";
	import { DEFAULT_TERMINAL_FONT, TERMINAL_LIMITS } from "../lib/terminal-prefs";
	import Switch from "./Switch.svelte";
	import Select from "./Select.svelte";
	import SettingRow from "./SettingRow.svelte";

	const p = $derived(app.prefs.terminal);
	const L = TERMINAL_LIMITS;
	const quote = (name: string) => (/^[\w-]+$/.test(name) ? name : `"${name}"`);
	/** The value is a whole font-family list; each preset is one such list, the first being the default. */
	const presets = [
		{ value: DEFAULT_TERMINAL_FONT, label: "Maple Mono NGS NF" },
		...["Maple Mono", "JetBrains Mono", "Fira Code", "D2Coding", "Cascadia Code", "Menlo", "Consolas", "monospace"].map((f) => ({ value: quote(f), label: f })),
	];
	const numeric = (key: "fontSize" | "lineHeight" | "scrollback") => (e: Event) =>
		app.prefs.setTerminal({ [key]: +(e.currentTarget as HTMLInputElement).value });
</script>

<div class="head">
	<div class="section-label">{t("터미널")}</div>
	<Button size="sm" onclick={() => app.prefs.resetTerminal()}>{t("기본값으로")}</Button>
</div>
<SettingRow label={t("글꼴")} for="terminal-font">
	<Select
		id="terminal-font"
		editable
		mono
		size="sm"
		width="min(320px, calc(100% - 6em))"
		label={t("터미널 글꼴")}
		placeholder={t("설치된 글꼴 이름")}
		value={p.fontFamily}
		onchange={(fontFamily) => app.prefs.setTerminal({ fontFamily })}
		options={presets}
	/>
</SettingRow>
<SettingRow label={t("글자 크기")} for="terminal-size">
	<input id="terminal-size" type="number" min={L.fontSize.min} max={L.fontSize.max} step="1" value={p.fontSize} aria-label={t("터미널 글자 크기")} onchange={numeric("fontSize")} />
</SettingRow>
<SettingRow label={t("줄 높이")} for="terminal-line">
	<input id="terminal-line" type="number" min={L.lineHeight.min} max={L.lineHeight.max} step="0.05" value={p.lineHeight} aria-label={t("터미널 줄 높이")} onchange={numeric("lineHeight")} />
</SettingRow>
<SettingRow label={t("스크롤백 줄 수")} for="terminal-scroll">
	<input id="terminal-scroll" type="number" min={L.scrollback.min} max={L.scrollback.max} step="500" value={p.scrollback} aria-label={t("터미널 스크롤백 줄 수")} onchange={numeric("scrollback")} />
</SettingRow>
<SettingRow label={t("커서 깜빡임")}>
	<Switch checked={p.cursorBlink} label={t("커서 깜빡임")} onchange={(on) => app.prefs.setTerminal({ cursorBlink: on })} />
</SettingRow>
<SettingRow label={t("앱 단축키 우선")} hint={t("터미널 안에서도 앱 단축키가 셸보다 먼저 동작합니다")}>
	<Switch checked={p.appKeysFirst} label={t("앱 단축키 우선")} onchange={(on) => app.prefs.setTerminal({ appKeysFirst: on })} />
</SettingRow>

<style>
	.head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
	}
	input[type="number"] {
		width: 96px;
		height: 34px;
		padding: 0 9px;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-sm);
		background: var(--bg);
		color: var(--text);
		font-family: var(--mono);
		font-size: var(--fs-sm);
		transition:
			border-color var(--motion-fast) var(--ease-std),
			box-shadow var(--motion-fast) var(--ease-std);
	}
	input[type="number"]:focus-visible {
		outline: none;
		border-color: var(--accent);
		box-shadow: 0 0 0 3px var(--accent-soft);
	}
</style>
