<script lang="ts">
	import Button from "./Button.svelte";
	import ImportReview from "./ImportReview.svelte";
	import { collapseIn, collapseOut } from "../lib/motion";
	import { localeTag, msg, t } from "../lib/i18n";
	import Icon from "./Icon.svelte";
	import Notice from "./Notice.svelte";
	import Switch from "./Switch.svelte";
	import { app } from "../lib/store.svelte";
	import { extensions } from "../lib/extensions/host.svelte";
	import {
		CONFIGURATION_MAX_BYTES,
		backupSavedAt,
		hasBackup,
		parseConfiguration,
		planSummary,
		type ConfigurationDocument,
		type ConfigurationPlan,
	} from "../lib/extensions/configuration";
	import { download } from "../lib/download";
	import { fileStamp } from "../lib/format";

	/* ---------- export ---------- */
	let parts = $state({ servers: true, extensions: true, preferences: true, keybindings: true });
	const counts = $derived({
		servers: app.servers.length,
		extensions: extensions.installed.filter((e) => e.scope === "device").length,
		preferences: 3,
		keybindings: Object.keys(app.prefs.changedBindings()).length,
	});
	const nothing = $derived(!parts.servers && !parts.extensions && !parts.preferences && !parts.keybindings);

	const rows = [
		{ key: "servers", title: msg("서버 연결"), sub: msg("이름과 주소만. 토큰은 들어가지 않습니다") },
		{ key: "extensions", title: msg("이 기기의 확장"), sub: msg("이 기기에 설치한 확장과 설정 (서버 확장 제외)") },
		{ key: "preferences", title: msg("앱 설정"), sub: msg("테마, 알림음 사용 여부와 크기") },
		{ key: "keybindings", title: msg("단축키"), sub: msg("기본값에서 바꾼 것만 담깁니다") },
	] as const;

	let exported = $state<string | null>(null);
	function exportFile() {
		try {
			const doc = extensions.exportConfiguration(parts);
			download(doc, `pipaya-settings-${fileStamp()}.json`, true);
			exported = t("서버 {servers}개 · 확장 {extensions}개 · 단축키 {keys}개를 파일로 저장했습니다", { servers: doc.servers.length, extensions: doc.extensions.length, keys: Object.keys(doc.keybindings ?? {}).length });
		} catch (e) {
			app.toast(e instanceof Error ? e.message : t("내보내지 못했습니다"), "error");
		}
	}

	/* ---------- import ---------- */
	type Loaded = { doc: ConfigurationDocument; plan: ConfigurationPlan; filename: string };
	let loaded = $state<Loaded | null>(null);
	let loadError = $state("");
	let reading = $state(false);
	let dragging = $state(false);

	async function readFile(file: File | undefined) {
		if (!file || reading) return;
		loadError = "";
		reading = true;
		try {
			if (file.size > CONFIGURATION_MAX_BYTES) throw new Error(t("설정 파일은 최대 4MiB입니다"));
			let raw: unknown;
			try {
				raw = JSON.parse(await file.text());
			} catch {
				throw new Error(t("JSON 파일이 아닙니다"));
			}
			const doc = parseConfiguration(raw);
			loaded = { doc, plan: extensions.planImport(doc), filename: file.name };
		} catch (e) {
			loaded = null;
			loadError = e instanceof Error ? e.message : String(e);
		} finally {
			reading = false;
		}
	}

	function pick(event: Event & { currentTarget: HTMLInputElement }) {
		const input = event.currentTarget;
		void readFile(input.files?.[0]);
		input.value = "";
	}
	function drop(event: DragEvent) {
		event.preventDefault();
		dragging = false;
		void readFile(event.dataTransfer?.files?.[0]);
	}

	let applied = $state<string[] | null>(null);
	/** Whether the import brought in extensions (they arrive switched off, and the note points to the tab). */
	let appliedExtensions = $state(false);
	let restoredNote = $state("");
	function applyLoaded() {
		if (!loaded || loaded.plan.blocked) return;
		const { doc, plan } = loaded;
		try {
			extensions.importConfiguration(doc);
			applied = planSummary(plan);
			appliedExtensions = plan.extensions.install.length + plan.extensions.replace.length > 0;
			loaded = null;
			savedAt = backupSavedAt();
			canRestore = hasBackup();
		} catch (e) {
			app.toast(e instanceof Error ? e.message : t("가져오지 못했습니다"), "error");
		}
	}

	/* ---------- restore ---------- */
	let canRestore = $state(hasBackup());
	let savedAt = $state(backupSavedAt());
	let confirmingRestore = $state(false);
	function restore() {
		try {
			extensions.restoreConfiguration();
			confirmingRestore = false;
			applied = null;
			restoredNote = t("가져오기 전 상태로 되돌렸습니다. 확장은 모두 꺼진 상태입니다.");
		} catch (e) {
			app.toast(e instanceof Error ? e.message : t("되돌리지 못했습니다"), "error");
		}
	}

	const when = (ts: number) =>
		new Date(ts).toLocaleString(localeTag(), { month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" });
</script>

<section aria-labelledby="bk-export">
	<h3 id="bk-export" class="section-label">{t("내보내기")}</h3>
	<p class="hint">{t("고른 항목을 파일 하나로 저장해 다른 기기에서 가져올 수 있습니다.")}</p>
	<div class="list">
		{#each rows as r (r.key)}
			<div class="item" class:off={!parts[r.key]}>
				<span class="txt">
					<span class="t">{t(r.title)} <span class="n">{r.key === "preferences" ? t("{n}가지", { n: counts[r.key] }) : t("{n}개", { n: counts[r.key] })}</span></span>
					<span class="s">{t(r.sub)}</span>
				</span>
				<Switch checked={parts[r.key]} label={t("{name} 포함", { name: t(r.title) })} onchange={(on) => (parts[r.key] = on)} />
			</div>
		{/each}
	</div>
	<div class="actions">
		<Button variant="primary" disabled={nothing} onclick={exportFile}><Icon name="download" /> {t("파일로 내보내기")}</Button>
	</div>
	{#if exported}<Notice tone="ok" size="sm" role="status">{exported}</Notice>{/if}
	<p class="note"><Icon name="shield" /><span>{t("토큰·비밀번호는 빠지지만, 공유하기 전에 한 번 확인하세요.")}</span></p>
</section>

<section aria-labelledby="bk-import">
	<h3 id="bk-import" class="section-label">{t("가져오기")}</h3>

	{#if !loaded}
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<label
			class="drop"
			class:over={dragging}
			class:busy={reading}
			ondragover={(e) => { e.preventDefault(); dragging = true; }}
			ondragleave={() => (dragging = false)}
			ondrop={drop}
		>
			<input type="file" accept="application/json,.json" disabled={reading} onchange={pick} />
			<Icon name="file" />
			<span class="dt">{reading ? t("파일을 읽는 중…") : t("설정 파일을 끌어다 놓거나 눌러서 고르세요")}</span>
			<span class="ds">{t("pipaya에서 내보낸 JSON · 최대 4MiB")}</span>
		</label>
		{#if loadError}<Notice tone="danger" size="sm" role="alert">{loadError}</Notice>{/if}
	{:else}
		<ImportReview filename={loaded.filename} plan={loaded.plan} oncancel={() => (loaded = null)} onapply={applyLoaded} />
	{/if}

	{#if applied}
		<Notice tone="ok" size="sm">
			<strong>{t("가져왔습니다.")}</strong> {applied.join(" · ") || t("변경 사항이 없습니다.")}
			{#if appliedExtensions}{t("확장은 꺼진 상태입니다.")} <button type="button" class="link" onclick={() => app.openSettings("extensions")}>{t("확장 탭에서 켜기")}</button>{/if}
		</Notice>
	{/if}
	{#if restoredNote}<Notice tone="ok" size="sm" role="status">{restoredNote}</Notice>{/if}
</section>

<section aria-labelledby="bk-restore">
	<h3 id="bk-restore" class="section-label">{t("되돌리기")}</h3>
	{#if canRestore}
		<div class="restore">
			<span class="txt">
				<span class="t">{t("마지막 가져오기 이전 상태")}</span>
				<span class="s">{savedAt ? `${t("{when}에 백업됨", { when: when(savedAt) })} · ` : ""}{t("이 기기에만 저장되어 있습니다")}</span>
			</span>
			{#if !confirmingRestore}
				<Button size="sm" onclick={() => (confirmingRestore = true)}>{t("되돌리기")}</Button>
			{/if}
		</div>
		{#if confirmingRestore}
			<div class="confirm" in:collapseIn out:collapseOut role="group" aria-label={t("되돌리기 확인")}>
				<p>{t("가져오기 전 상태로 되돌립니다. 그 뒤에 바꾼 내용은 사라지고 확장은 모두 꺼집니다.")}</p>
				<div class="actions">
					<Button size="sm" onclick={() => (confirmingRestore = false)}>{t("취소")}</Button>
					<Button variant="danger" size="sm" onclick={restore}>{t("되돌리기")}</Button>
				</div>
			</div>
		{/if}
	{:else}
		<p class="hint">{t("가져오기를 하면 직전 상태가 자동으로 백업됩니다.")}</p>
	{/if}
</section>

<style>
	section {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}
	.hint {
		margin: 0;
		line-height: 1.5;
	}
	.list {
		display: flex;
		flex-direction: column;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		overflow: hidden;
	}
	.item {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 14px;
		padding: 12px 14px;
	}
	.item + .item {
		border-top: 1px solid var(--border);
	}
	.txt {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}
	.t {
		font-size: var(--fs-md);
		font-weight: 600;
	}
	.n {
		margin-left: 6px;
		font-weight: 400;
		font-size: var(--fs-xs);
		color: var(--text-faint);
	}
	.s {
		font-size: var(--fs-xs);
		color: var(--text-faint);
		line-height: 1.45;
	}
	.item.off .t {
		color: var(--text-faint);
	}
	.actions {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
		flex-wrap: wrap;
	}
	.actions :global(svg) {
		width: 16px;
		height: 16px;
	}
	.actions :global(.btn svg), .restore :global(.btn svg) {
		stroke-width: 1.9;
	}
	.note {
		display: flex;
		gap: 8px;
		margin: 0;
		font-size: var(--fs-xs);
		line-height: 1.5;
		color: var(--text-faint);
	}
	.note :global(svg),
	.drop :global(svg) {
		flex: none;
		stroke-width: 1.9;
	}
	.note :global(svg) {
		width: 15px;
		height: 15px;
		margin-top: 2px;
	}

	.drop {
		position: relative;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 6px;
		padding: 26px 16px;
		border: 1.5px dashed var(--border-strong);
		border-radius: var(--radius);
		color: var(--text-dim);
		text-align: center;
		cursor: pointer;
		transition:
			background var(--motion-fast) var(--ease-std),
			border-color var(--motion-fast) var(--ease-std);
	}
	.drop:hover,
	.drop:focus-within,
	.drop.over {
		background: var(--bg-hover);
		border-color: var(--text-faint);
	}
	.drop.busy {
		opacity: 0.6;
		cursor: default;
	}
	.drop input {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		opacity: 0;
		cursor: inherit;
	}
	.drop :global(svg) {
		width: 24px;
		height: 24px;
	}
	.dt {
		font-size: var(--fs-md);
		color: var(--text);
		font-weight: 500;
	}
	.ds {
		font-size: var(--fs-xs);
		color: var(--text-faint);
	}

	.restore {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 14px;
		padding: 12px 14px;
		border: 1px solid var(--border);
		border-radius: var(--radius);
	}
	.confirm {
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding: 12px 14px;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius);
		background: var(--bg-elev);
	}
	.confirm p {
		margin: 0;
		font-size: var(--fs-sm);
		line-height: 1.5;
		color: var(--text-dim);
	}
	.link {
		padding: 0;
		font-size: inherit;
		color: var(--text);
		text-decoration: underline;
		text-underline-offset: 3px;
	}
</style>
