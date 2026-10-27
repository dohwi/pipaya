<script lang="ts" module>
	import type { ExtensionPackage } from "../../lib/extensions/schema";
	/** What came of an import, shown in a dialog of its own: an inline notice was easy to miss. */
	export type ImportResult = { tone: "ok" | "warn" | "danger"; title: string; detail: string; pkg?: ExtensionPackage; running?: boolean; replaced?: boolean };
</script>

<script lang="ts">
	import Button from "../Button.svelte";
	import { t } from "../../lib/i18n";
	import { featuresOf } from "../../lib/extensions/labels";
	import { extensions, type InstalledExtension } from "../../lib/extensions/host.svelte";
	import Icon from "../Icon.svelte";
	import Modal from "../Modal.svelte";
	import Notice from "../Notice.svelte";
	import PermissionList from "./PermissionList.svelte";

	/**
	 * The two dialogs of importing an extension: the preview (what it is, what it asks for, where it will live) and,
	 * once that is decided, the result. Only one shows at a time; the result wins.
	 */
	let {
		preview,
		result,
		replacement,
		willResume,
		filename,
		target,
		serverName,
		busy,
		oncancel,
		onimport,
		onclose,
		onshow,
	}: {
		preview: ExtensionPackage | null;
		result: ImportResult | null;
		/** The installed extension with the same id, when the import would replace it */
		replacement: InstalledExtension | undefined;
		/** The replacement keeps running without a second consent (same id, no new permission) */
		willResume: boolean;
		filename: string;
		target: "server" | "device";
		serverName: string;
		busy: Record<string, boolean>;
		oncancel: () => void;
		onimport: () => void;
		onclose: () => void;
		onshow: () => void;
	} = $props();

	/** The default action takes focus once it can: right after a file is read it is still disabled for a moment. */
	function focusOk(node: HTMLElement) {
		let tries = 0;
		const go = () => {
			const ok = node.querySelector<HTMLButtonElement>("[data-ok]");
			if (!ok || !node.isConnected) return;
			if (ok.disabled && tries++ < 20) return void setTimeout(go, 25);
			ok.focus();
		};
		go();
	}
</script>

{#if preview || result}
	<!-- one dialog for the whole import: the result takes the preview's place inside it, so deciding does not close one window and open another -->
	<Modal
		onclose={result ? onclose : oncancel}
		role={result?.tone === "danger" ? "alertdialog" : "dialog"}
		labelledby={result ? "import-result-title" : "import-preview-title"}
		describedby={result ? "import-result-detail" : undefined}
		width={result ? "s" : "l"}
		maxHeight="var(--dvh)"
		layer={3}
		sheet={false}
		portal
	>
		{#if result}
			{@const r = result}
			<div class="rmodal {r.tone}" use:focusOk>
				<div class="rhead">
					<span class="rmark" aria-hidden="true"><Icon name={r.tone === "ok" ? "check" : "alert"} /></span>
					<h2 id="import-result-title">{r.title}</h2>
				</div>
				<div class="rbody">
					{#if r.pkg}
						<div class="rpkg">
							<strong>{r.pkg.manifest.name}</strong>
							<span class="meta">{r.pkg.manifest.id} · {t("버전")} {r.pkg.manifest.version}</span>
							<div class="tags">
								{#each featuresOf(r.pkg) as feature (feature)}<span class="chip">{t(feature)}</span>{/each}
								<span class="chip {r.running ? "ok" : ""}">{r.running ? t("실행 중") : t("비활성")}</span>
							</div>
						</div>
					{/if}
					<p id="import-result-detail" class="rdetail">{r.detail}</p>
				</div>
				<div class="rfoot">
					{#if r.pkg}
						<Button variant="primary" size="sm" data-ok onclick={onshow}>{t("설치된 확장 보기")}</Button>
						<Button size="sm" onclick={onclose}>{t("닫기")}</Button>
					{:else}
						<Button variant="primary" size="sm" data-ok onclick={onclose}>{t("확인")}</Button>
					{/if}
				</div>
			</div>
		{:else if preview}
			{@const p = preview}
			<div class="rmodal" use:focusOk>
				<div class="rhead">
					<span class="rmark info" aria-hidden="true"><Icon name="plus" /></span>
					<h2 id="import-preview-title">{replacement ? t("확장 교체") : t("확장 가져오기")}</h2>
				</div>
				<div class="rbody">
					<div class="rpkg">
						<strong>{p.manifest.name}</strong>
						<span class="meta">{p.manifest.id} · {t("버전")} {p.manifest.version} · {filename}</span>
						{#if p.manifest.description}<span class="rdesc">{p.manifest.description}</span>{/if}
						<div class="tags" aria-label={t("포함 기능")}>
							{#each featuresOf(p) as feature (feature)}<span class="chip">{t(feature)}</span>{/each}
						</div>
					</div>
					{#if !replacement}
						<p class="hint">{target === "server" ? t("{name}에 접속한 모든 기기가 공유합니다", { name: serverName }) : t("이 기기에만 설치되고 서버를 바꿔도 남습니다")}</p>
					{/if}
					<h5 class="rsub">{t("요청 권한과 실행 안내")}</h5>
					<PermissionList pkg={p} />
					{#if replacement}
						<Notice tone="warn" size="sm">{t("같은 ID의 버전 {version}을 교체합니다.", { version: replacement.package.manifest.version })} {replacement.scope === "device" ? t("(이 기기의 확장)") : t("(이 서버의 확장)")} {willResume ? t("실행 중이던 확장이며 새 권한이 없어 교체 직후 바로 다시 실행됩니다.") : t("실행 중인 확장은 중지되고 새 패키지는 비활성 상태가 됩니다.")}{#if replacement.enabled && !willResume && !extensions.safeMode} {t("새 권한을 요청하므로 다시 활성화해야 합니다.")}{/if}</Notice>
					{/if}
				</div>
				<div class="rfoot">
					<Button size="sm" disabled={busy.$import} onclick={oncancel}>{t("취소")}</Button>
					<Button variant="primary" size="sm" data-ok disabled={busy.$import || busy[p.manifest.id]} onclick={onimport}>{willResume ? t("교체하고 바로 실행") : replacement ? t("교체하여 가져오기") : t("비활성 상태로 가져오기")}</Button>
				</div>
			</div>
		{/if}
	</Modal>
{/if}

<style>
	/* above the settings window (z 60/61) it is opened from */
	.rmodal { display: flex; flex-direction: column; gap: 14px; padding: 20px 22px 18px; overflow-y: auto; font-size: var(--fs-md); line-height: 1.5; }
	.rmark.info { background: var(--accent-soft, var(--bg-hover)); color: var(--accent, var(--text)); }
	.rdesc { color: var(--text-dim); font-size: var(--fs-sm); overflow-wrap: anywhere; }
	.rsub { margin: 4px 0 0; font-size: var(--fs-xs); font-weight: 600; color: var(--text-dim); }
	.rhead { display: flex; align-items: center; gap: 12px; }
	.rhead h2 { margin: 0; font-size: var(--fs-lg); font-weight: 600; overflow-wrap: anywhere; }
	.rmark { flex: none; display: grid; place-items: center; width: 32px; height: 32px; border-radius: 50%; background: var(--ok-soft); color: var(--ok); }
	.rmodal.warn .rmark { background: var(--warn-soft); color: var(--warn); }
	.rmodal.danger .rmark { background: var(--danger-soft); color: var(--danger); }
	.rmark :global(svg) { width: 18px; height: 18px; stroke-width: 2.2; }
	.rbody { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
	.rpkg { display: flex; flex-direction: column; gap: 4px; padding: 10px 12px; border-radius: var(--radius-sm); background: var(--bg-code); min-width: 0; }
	.rpkg strong { font-weight: 600; overflow-wrap: anywhere; }
	.rdetail { margin: 0; color: var(--text-dim); font-size: var(--fs-sm); overflow-wrap: anywhere; }
	.rfoot { display: flex; justify-content: flex-end; gap: 8px; flex-wrap: wrap; }
	.rfoot :global(.btn) { min-width: 76px; }

	.meta, .hint { font-size: var(--fs-xs); color: var(--text-faint); overflow-wrap: anywhere; }
	.meta { font-family: var(--mono); font-size: var(--fs-2xs); }
	.tags { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
</style>
