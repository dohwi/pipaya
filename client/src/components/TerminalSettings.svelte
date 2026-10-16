<script lang="ts">
	import { t } from "../lib/i18n";
	import { app } from "../lib/store.svelte";
	import { TERMINAL_LIMITS } from "../lib/terminal-prefs";
	import Switch from "./Switch.svelte";

	const p = $derived(app.prefs.terminal);
	const L = TERMINAL_LIMITS;
	const presets = ["Maple Mono", "JetBrains Mono", "Fira Code", "D2Coding", "Cascadia Code", "Menlo", "Consolas", "monospace"];
	const quote = (name: string) => (/^[\w-]+$/.test(name) ? name : `"${name}"`);

	let draft = $state<string | null>(null);
	function commitFont() {
		if (draft !== null) app.prefs.setTerminal({ fontFamily: draft });
		draft = null;
	}
	const numeric = (key: "fontSize" | "lineHeight" | "scrollback") => (e: Event) =>
		app.prefs.setTerminal({ [key]: +(e.currentTarget as HTMLInputElement).value });
</script>

<div class="head">
	<div class="mono-label">{t("터미널")}</div>
	<button class="btn sm" onclick={() => app.prefs.resetTerminal()}>{t("기본값으로")}</button>
</div>
<label class="row">
	<span>{t("글꼴")}</span>
	<input
		type="text"
		list="terminal-fonts"
		spellcheck="false"
		autocomplete="off"
		aria-label={t("터미널 글꼴")}
		value={draft ?? p.fontFamily}
		oninput={(e) => (draft = e.currentTarget.value)}
		onchange={commitFont}
		onblur={commitFont}
	/>
	<datalist id="terminal-fonts">
		{#each presets as f (f)}<option value={quote(f)}></option>{/each}
	</datalist>
</label>
<label class="row">
	<span>{t("글자 크기")}</span>
	<input type="number" min={L.fontSize.min} max={L.fontSize.max} step="1" value={p.fontSize} aria-label={t("터미널 글자 크기")} onchange={numeric("fontSize")} />
</label>
<label class="row">
	<span>{t("줄 높이")}</span>
	<input type="number" min={L.lineHeight.min} max={L.lineHeight.max} step="0.05" value={p.lineHeight} aria-label={t("터미널 줄 높이")} onchange={numeric("lineHeight")} />
</label>
<label class="row">
	<span>{t("스크롤백 줄 수")}</span>
	<input type="number" min={L.scrollback.min} max={L.scrollback.max} step="500" value={p.scrollback} aria-label={t("터미널 스크롤백 줄 수")} onchange={numeric("scrollback")} />
</label>
<div class="row">
	<span>{t("커서 깜빡임")}</span>
	<Switch checked={p.cursorBlink} label={t("커서 깜빡임")} onchange={(on) => app.prefs.setTerminal({ cursorBlink: on })} />
</div>
<span class="hint">
	{t("기본 글꼴은 Maple Mono입니다. 이 기기에 설치된 글꼴 이름도 쓸 수 있고, 목록은 쉼표로 이어 씁니다. 바로 적용되며 이 기기에만 저장됩니다.")}
</span>

<style>
	.head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
	}
	.row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 14px;
		font-size: var(--fs-md);
		line-height: 1.4;
	}
	.row input[type="text"] {
		flex: 1;
		min-width: 0;
		max-width: 320px;
	}
	.row input[type="number"] {
		width: 96px;
	}
	.row input {
		padding: 5px 9px;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-sm);
		background: var(--bg-elev);
		color: var(--text);
		font: inherit;
		font-family: var(--mono);
		font-size: var(--fs-sm);
	}
	.hint {
		font-size: var(--fs-xs);
		color: var(--text-faint);
	}
</style>
