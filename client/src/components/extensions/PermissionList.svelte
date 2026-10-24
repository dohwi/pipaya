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
<p class="hint">{t("확장은 자신의 설정을 읽을 수 있습니다. 테마는 화면 색상과 크기를 바꾸며, 템플릿 명령은 입력만 채우고 전송하지 않습니다.")}</p>
<Notice tone="warn" size="sm">{t("확장 코드는 격리된 환경에서 실행되지만 안전성을 보증하지 않습니다. CPU·메모리 등 자원 사용 제한도 보장되지 않으므로 신뢰하는 패키지만 활성화하세요.")}</Notice>

<style>
	.hint { overflow-wrap: anywhere; }
	.permissions { list-style: none; margin: 0; padding: 10px 12px; display: flex; flex-direction: column; gap: 6px; border-radius: var(--radius-sm); background: var(--bg-code); font-size: var(--fs-xs); color: var(--text-dim); }
	.permissions li { display: flex; align-items: flex-start; gap: 8px; }
	.permissions li :global(svg) { flex: none; width: 14px; height: 14px; margin-top: 3px; stroke: var(--ok); fill: none; stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round; }
</style>
