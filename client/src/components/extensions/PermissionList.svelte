<script lang="ts">
	import { t } from "../../lib/i18n";
	import { permissionLabels } from "../../lib/extensions/labels";
	import type { ExtensionPackage } from "../../lib/extensions/schema";
	import Icon from "../Icon.svelte";
	import Notice from "../Notice.svelte";

	/** What a package asks for, in the sentences the consent dialog and the extension's detail page both show. */
	let { pkg }: { pkg: ExtensionPackage } = $props();
</script>

{#if pkg.manifest.permissions.length}
	<ul class="permissions">
		{#each pkg.manifest.permissions as permission (permission)}
			<li><Icon name="check" /><span>{t(permissionLabels[permission])}</span></li>
		{/each}
	</ul>
{:else}
	<p class="hint">{t("요청한 추가 권한이 없습니다.")}</p>
{/if}
<p class="hint">{t("확장은 자신의 설정을 읽을 수 있습니다.")}</p>
{#if pkg.manifest.permissions.includes("ui-components")}
	<Notice tone="danger" size="sm">{t("격리 없이 앱 안에서 직접 실행되어 대화와 서버 토큰을 포함한 모든 데이터에 접근합니다. 신뢰하는 패키지만 켜세요.")}</Notice>
{:else}
	<Notice tone="warn" size="sm">{t("격리된 환경에서 실행되지만 안전과 자원 사용은 보장되지 않습니다. 신뢰하는 패키지만 켜세요.")}</Notice>
{/if}

<style>
	.hint { overflow-wrap: anywhere; }
	.permissions { list-style: none; margin: 0; padding: 10px 12px; display: flex; flex-direction: column; gap: 6px; border-radius: var(--radius-sm); background: var(--bg-code); font-size: var(--fs-xs); color: var(--text-dim); }
	.permissions li { display: flex; align-items: flex-start; gap: 8px; }
	.permissions li :global(svg) { flex: none; width: 14px; height: 14px; margin-top: 3px; stroke: var(--ok); stroke-width: 2.2; }
</style>
