<script lang="ts">
	import Button from "./Button.svelte";
	import { t, tc } from "../lib/i18n";
	import { ICON_LABEL } from "../lib/brand";
	import { isImageIcon } from "../lib/model-icon-image";
	import { ALL_LEVELS, type Row } from "../lib/connection-form";
	import type { Api } from "../lib/api";
	import type { CatalogModel } from "../lib/types";
	import Icon from "./Icon.svelte";
	import Badge from "./Badge.svelte";
	import ModelLogo from "./ModelLogo.svelte";

	/**
	 * One model's page inside the connection dialog: id, OpenRouter match, display name and icon, limits, capabilities
	 * and thinking levels. Edits go straight into `r` (the dialog's own row); the pickers and delete are the dialog's.
	 */
	let {
		r = $bindable(),
		providerId,
		connection,
		catalogLoaded,
		matched,
		fresh,
		onpickmatch,
		onpickicon,
		onremove,
	}: {
		r: Row;
		providerId: string;
		connection: Api["connection"] | undefined;
		catalogLoaded: boolean;
		/** The OpenRouter model `r` is matched to; null = manual */
		matched: CatalogModel | null;
		/** Just added: focus the id field */
		fresh: boolean;
		onpickmatch: () => void;
		onpickicon: () => void;
		onremove: () => void;
	} = $props();

	const iconName = $derived(r.icon ? (isImageIcon(r.icon) ? t("올린 이미지") : (ICON_LABEL[r.icon] ?? r.icon)) : t("자동"));
</script>

	<section class="fsec">
		<label>
			<span class="idlabel">{t("모델 ID")}{#if r.fromUpstream}<Badge tone="neutral" size="sm"><Icon name="server" />{t("업스트림 제공")}</Badge>{/if}</span>
			<!-- svelte-ignore a11y_autofocus -->
			<input class="field mono" bind:value={r.id} readonly={r.fromUpstream} aria-readonly={r.fromUpstream} placeholder="upstream-model-id" autocomplete="off" autocapitalize="off" spellcheck="false" autofocus={fresh && !r.fromUpstream} />
			<small class="hint">{r.fromUpstream ? t("업스트림 모델 목록에서 불러온 ID라 수정할 수 없습니다. 바꾸려면 모델을 삭제하고 다시 불러오세요.") : t("업스트림이 제공하는 ID입니다. 요청에 그대로 쓰이므로 OpenRouter 선택으로 바뀌지 않습니다.")}</small>
		</label>
		{#if catalogLoaded}
			{@const hit = matched}
						<div class="matchrow">
				<span class="mlabel">{t("OpenRouter 매칭 모델")}</span>
				<button type="button" class="mtrigger" onclick={onpickmatch}>
					{#if hit}
						<Icon name="check" />
						<span class="mono mtext">{hit.id}</span>
					{:else}
						<Icon name="unlink" />
						<span class="mtext dim">{t("수동 입력")}</span>
					{/if}
					<Icon name="chevron-down" />
				</button>
			</div>
			{#if hit}
				<p class="hint note mono src ok"><Icon name="check" /> {t("추론 강도: {levels}", { levels: hit.levels.join(", ") || "-" })}</p>
			{:else if r.catalogId === undefined && r.id.trim()}
				<p class="hint note src bad"><Icon name="alert" /> {t("자동으로 찾지 못했습니다. 매칭 모델을 고르거나 아래 값을 직접 입력하세요.")}</p>
			{/if}
		{/if}
		<div class="namerow">
			<button type="button" class="iconpick" onclick={onpickicon} aria-label={`${t("아이콘")}: ${iconName}`} title={`${t("아이콘")}: ${iconName}`}>
				<span class="mlogo"><ModelLogo conn={connection} icon={r.icon} provider={providerId} model={r.id} size={20} colored={Boolean(r.icon)} /></span>
				<Icon name="chevron-down" />
			</button>
			<label>
				<span>{t("표시 이름")} <em>({tc("optional", "선택")})</em></span>
				<input class="field" bind:value={r.name} placeholder={t("ID와 같으면 비워 두세요")} autocomplete="off" />
			</label>
		</div>
	</section>
	<section class="fsec">
		<div class="section-label">{t("제한")}</div>
		<div class="grid2">
			<label>
				<span>{t("컨텍스트 크기")}</span>
				<input class="field mono" inputmode="numeric" bind:value={r.contextWindow} />
			</label>
			<label>
				<span>{t("최대 출력")}</span>
				<input class="field mono" inputmode="numeric" bind:value={r.maxTokens} />
			</label>
		</div>
	</section>
	<section class="fsec">
		<div class="section-label">{t("기능")}</div>
		<div class="caps">
			{#if !r.imageGeneration}<button type="button" class="cap" aria-pressed={r.reasoning} onclick={() => (r.reasoning = !r.reasoning)}><Icon name="brain" /> {t("추론")}</button>{/if}
			<button type="button" class="cap" aria-pressed={r.vision} onclick={() => (r.vision = !r.vision)}><Icon name="image" /> {t("이미지 입력")}</button>
			<button type="button" class="cap" aria-pressed={r.imageGeneration} onclick={() => { r.imageGeneration = !r.imageGeneration; if (r.imageGeneration) r.reasoning = false; }}><Icon name="bolt" /> {t("이미지 생성")}</button>
		</div>
	</section>
	{#if r.reasoning && !r.imageGeneration && !matched}
		<section class="fsec">
			<div class="section-label">{t("추론 강도")} <em>({tc("optional", "선택")})</em></div>
			<div class="caps" role="group" aria-label={t("추론 강도")}>
				{#each ALL_LEVELS as l (l)}
					<button
						type="button"
						class="cap"
						aria-pressed={r.thinkingLevels.includes(l)}
						onclick={() => (r.thinkingLevels = r.thinkingLevels.includes(l) ? r.thinkingLevels.filter((x) => x !== l) : [...r.thinkingLevels, l])}
					>{l}</button>
				{/each}
			</div>
			<p class="hint note">{r.thinkingLevels.length ? t("고른 강도만 이 모델에서 선택할 수 있습니다.") : t("고르지 않으면 모델 이름으로 자동 설정하고, 찾지 못하면 minimal부터 high까지 보여줍니다.")}</p>
			{#if r.thinkingSource}
				{@const s = r.thinkingSource}
				{#if s.catalogId}
					<p class="hint note mono src ok"><Icon name="check" /> {t("OpenRouter {id}와 일치: {levels}", { id: s.catalogId, levels: s.levels.join(", ") })}{s.kind === "custom" ? ` (${t("직접 지정")})` : ""}</p>
				{:else}
					<p class="hint note mono src off"><Icon name="unlink" /> {t("OpenRouter 모델과 연결되지 않음: {levels}", { levels: s.levels.join(", ") })}</p>
				{/if}
			{/if}
		</section>
	{/if}
	<Button variant="ghost" class="danger-text" onclick={onremove}><Icon name="trash" /> {t("이 모델 삭제")}</Button>

<style>
	.idlabel {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.src {
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.src :global(svg) {
		width: 14px;
		height: 14px;
		flex: none;
		stroke-width: 2;
	}
	.src.off {
		color: var(--text-faint);
	}
	.matchrow {
		display: flex;
		flex-direction: column;
		gap: 5px;
	}
	.mlabel {
		font-size: var(--fs-xs);
		font-weight: 600;
		color: var(--text-dim);
	}
	.mtrigger {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		height: var(--control-h);
		padding: 0 12px;
		background: var(--bg);
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-control);
		color: var(--text);
		font-size: var(--fs-md);
		text-align: left;
		transition: border-color var(--motion-fast) var(--ease-std);
	}
	.mtrigger:hover {
		background: var(--bg-hover);
	}
	.namerow {
		display: flex;
		align-items: flex-end;
		gap: 8px;
	}
	.namerow label {
		flex: 1;
	}
	.iconpick {
		flex: none;
		display: flex;
		align-items: center;
		gap: 4px;
		height: var(--control-h);
		padding: 0 10px;
		background: var(--bg);
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-control);
		color: var(--text);
		transition: border-color var(--motion-fast) var(--ease-std);
	}
	.iconpick:hover {
		border-color: var(--accent);
	}
	.iconpick :global(svg:not(.model):not(.logo)) {
		width: 13px;
		height: 13px;
		stroke: var(--text-dim);
		stroke-width: 2;
	}
	.mtext {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: var(--fs-sm);
	}
	.mtext.dim {
		color: var(--text-dim);
	}
	.mtrigger :global(svg:not(.model):not(.logo)) {
		width: 15px;
		height: 15px;
		flex: none;
		stroke-width: 2;
		color: var(--text-dim);
	}
	:global(.btn.danger-text) {
		align-self: flex-start;
	}
	.caps {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}
	.cap {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		height: 32px;
		padding: 0 12px;
		border-radius: var(--radius-pill);
		border: 1px solid var(--border);
		background: var(--bg);
		color: var(--text-dim);
		font-size: var(--fs-sm);
		font-weight: 500;
		transition: background var(--motion-fast) var(--ease-std), color var(--motion-fast) var(--ease-std), border-color var(--motion-fast) var(--ease-std);
	}
	.cap :global(svg) {
		width: 16px;
		height: 16px;
		stroke-width: 1.8;
	}
	.cap:hover {
		background: var(--bg-hover);
	}
	/* pressed = the selected FilterChip look */
	.cap[aria-pressed="true"] {
		background: var(--bg-active);
		border-color: var(--border-strong);
		color: var(--text);
		font-weight: 600;
	}
	.field[readonly] {
		color: var(--text-dim);
		background: var(--bg-elev);
		cursor: default;
	}
	.src.ok :global(svg) {
		color: var(--text);
	}
	.src.bad {
		color: var(--danger);
	}
	.grid2 {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 10px;
	}
	label {
		display: flex;
		flex-direction: column;
		gap: 5px;
		min-width: 0;
	}
	label em {
		font-style: normal;
		font-weight: 400;
		color: var(--text-faint);
	}
	.fsec {
		gap: 12px;
	}
	.mlogo {
		flex: none;
		display: grid;
		place-items: center;
		color: var(--text-dim);
	}
	section {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}
	.note {
		margin: 0;
	}
	label > span {
		font-size: var(--fs-xs);
		font-weight: 600;
		color: var(--text-dim);
	}
	@media (max-width: 640px) {
		/* name/ID and model ID/display name stack; the two numbers stay side by side */
		.grid2 {
			grid-template-columns: 1fr;
		}
		.fsec .grid2:has(input[inputmode="numeric"]) {
			grid-template-columns: 1fr 1fr;
		}
	}
</style>
