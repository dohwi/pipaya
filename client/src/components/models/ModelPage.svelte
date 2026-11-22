<script lang="ts">
	import { focusOnDesktop } from "../../lib/focus";
	import Button from "../ui/Button.svelte";
	import Segmented from "../ui/Segmented.svelte";
	import Ladder from "../ui/Ladder.svelte";
	import { t, tc } from "../../lib/i18n";
	import { ICON_LABEL } from "../../lib/brand";
	import { isImageIcon } from "../../lib/model-icon-image";
	import { ALL_LEVELS, isLastLevel, shownLevels, toggleLevel, type Row } from "../../lib/connection-form";
	import TierOptions from "./TierOptions.svelte";
	import { Api } from "../../lib/api";
	import type { CatalogModel, ThinkingLevel } from "../../lib/types";
	import Icon from "../ui/Icon.svelte";
	import Badge from "../ui/Badge.svelte";
	import Switch from "../ui/Switch.svelte";
	import { CAPS } from "../../lib/model-caps";
	import ModelLogo from "./ModelLogo.svelte";

	/**
	 * One model's page inside the connection dialog: id, OpenRouter match, display name and icon, limits, capabilities
	 * and thinking levels. Edits go straight into `r` (the dialog's own row); the pickers and delete are the dialog's.
	 */
	let {
		r = $bindable(),
		providerId,
		router,
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
		router: boolean;
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

	const uid = $props.id();
	/** The three abilities an owner switches on. Reasoning stays in place but off while the model draws pictures, so the rows never shift under the pointer. */
	const capRows = $derived([
		{ ...CAPS.reasoning, on: r.reasoning && !r.imageGeneration, disabled: !!r.imageGeneration, set: (on: boolean) => (r.reasoning = on) },
		{ ...CAPS.vision, on: r.vision, disabled: false, set: (on: boolean) => (r.vision = on) },
		{ ...CAPS.image, on: !!r.imageGeneration, disabled: false, set: (on: boolean) => { r.imageGeneration = on; if (on) r.reasoning = false; } },
	]);
	/** An upstream model keeps its fixed id, unless the upstream stopped listing it: then it is just a typed-in model. */
	const catalogApi = $derived(connection ? new Api(connection) : null);
	const locked = $derived(!!r.fromUpstream && !r.unavailable);
	const iconName = $derived(r.icon ? (isImageIcon(r.icon) ? t("올린 이미지") : (ICON_LABEL[r.icon] ?? r.icon)) : t("자동"));
	/** The strengths this model really offers (the owner's own list or the matched catalog's), in canonical order. */
	const levels = $derived(shownLevels(r, matched));
	/** "새 대화 기본 강도: 자동" unless a strength this model offers was chosen. */
	const fallbackLevel = $derived<"auto" | ThinkingLevel>(levels.includes(r.defaultThinkingLevel as ThinkingLevel) ? r.defaultThinkingLevel! : "auto");
</script>

	<section class="fsec set-group">
		<label>
			<span class="idlabel">{t("모델 ID")}{#if locked}<Badge tone="neutral" size="sm"><Icon name="server" />{t("업스트림 제공")}</Badge>{/if}</span>
			<input class="field mono" bind:value={r.id} readonly={locked} aria-readonly={locked} placeholder="upstream-model-id" autocomplete="off" autocapitalize="off" spellcheck="false" use:focusOnDesktop={fresh && !locked} />
			<small class="hint">{locked ? t("업스트림 모델 목록에서 불러온 ID라 수정할 수 없습니다.") : t("업스트림이 제공하는 ID입니다. 요청에 그대로 쓰이므로 OpenRouter 선택으로 바뀌지 않습니다.")}</small>
		</label>
		{#if catalogLoaded}
			{@const hit = matched}
						<div class="matchrow">
				<span class="mlabel">{t("OpenRouter에서 찾은 모델")}</span>
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
			{#if hit && r.imageGeneration}
				<p class="hint note src ok"><Icon name="check" /> {t("이미지를 만드는 모델입니다")}</p>
			{:else if hit && hit.reasoning && r.reasoning}
				<p class="hint note mono src ok"><Icon name="check" /> {t("추론 강도: {levels}", { levels: hit.levels.join(", ") })}</p>
			{:else if !hit && r.catalogId === undefined && r.id.trim() && !r.imageGeneration}
				<p class="hint note src bad"><Icon name="alert" /> {t("OpenRouter에서 자동으로 찾지 못했습니다. 모델을 직접 고르거나 아래 값을 입력하세요.")}</p>
			{/if}
			{#if !router && hit && !r.imageGeneration && catalogApi}
				{#key hit.id}<TierOptions api={catalogApi} model={hit.id} />{/key}
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
	<section class="fsec set-group">
		<div class="section-label">{t("기능")}</div>
		<!-- one switch per ability, like every other on/off setting: a row of pressed chips read as badges, not as toggles -->
		<div class="capsw">
			{#each capRows as c (c.key)}
				<div class="caprow" class:on={c.on} class:off={c.disabled}>
					<span class="capic" aria-hidden="true"><Icon name={c.icon} /></span>
					<span class="captext">
						<b>{t(c.label)}</b>
						<small id="{uid}-{c.key}">{c.disabled ? t("이미지 생성 모델은 추론하지 않습니다") : t(c.hint)}</small>
					</span>
					<Switch checked={c.on} disabled={c.disabled} label={t(c.label)} describedby="{uid}-{c.key}" onchange={c.set} />
				</div>
			{/each}
		</div>
		<p class="hint note">{r.imageGeneration ? t("그림만 그리는 모델입니다. 에이전트 설정에서 이미지 모델로 고르세요.") : t("기본은 글로 대화하는 채팅 모델입니다. 켠 기능만 모델에 표시됩니다.")}</p>
		{#if r.imageGeneration}
			<div class="section-label">{t("이미지 API")}</div>
			<Segmented label={t("이미지 API")} value={r.imageApi ?? "auto"}
				options={[{ id: "auto", label: t("자동") }, { id: "openai-images", label: "OpenAI" }, { id: "openrouter-images", label: "OpenRouter" }] as const}
				onchange={(v) => (r.imageApi = v === "auto" ? undefined : v)} />
			<p class="hint note">{t("보통은 자동으로 두세요. 프록시에서 그림이 생성되지 않으면 지원하는 API를 고르세요.")}</p>
		{/if}
	</section>
	{#if r.reasoning && !r.imageGeneration}
		{@const shown = shownLevels(r, matched)}
		<section class="fsec set-group">
			<div class="section-label">{t("선택 가능한 추론 강도")}</div>
			<Ladder
				label={t("선택 가능한 추론 강도")}
				options={ALL_LEVELS.map((l) => ({ id: l, label: l, level: l, disabled: isLastLevel(r, matched, l), title: isLastLevel(r, matched, l) ? t("하나는 남겨 두어야 합니다") : undefined }))}
				selected={shown}
				ontoggle={(l) => toggleLevel(r, matched, l)}
			/>
			<p class="hint note">
				{#if r.thinkingLevels.length}
					{t("고른 강도만 이 모델에서 선택할 수 있습니다.")}
				{:else if matched}
					{t("OpenRouter에서 찾은 모델이 지원하는 강도를 따릅니다. 눌러서 제외할 수 있습니다.")}
				{:else}
					{t("고르지 않으면 모델 이름으로 자동 설정하고, 찾지 못하면 minimal부터 high까지 보여줍니다.")}
				{/if}
			</p>

			<div class="section-label">{t("새 대화 기본 강도")}</div>
			<Ladder
				label={t("새 대화 기본 강도")}
				options={[{ id: "auto" as const, label: t("자동") }, ...levels.map((l) => ({ id: l, label: l, level: l }))]}
				value={fallbackLevel}
				onchange={(l) => (r.defaultThinkingLevel = l === "auto" ? undefined : l)}
			/>
			<p class="hint note">{r.defaultThinkingLevel ? t("이 모델로 새 대화를 시작하면 {level}로 시작합니다.", { level: r.defaultThinkingLevel }) : t("자동이면 이 기기의 지난 강도로 시작합니다.")}</p>
		</section>
	{/if}
	{#if router && !r.imageGeneration && r.id.trim() && catalogApi}
		<section class="fsec set-group">
			<TierOptions api={catalogApi} model={r.id.trim()} label={t("새 대화 기본 속도")} value={r.defaultServiceTier ?? null} onchange={v => (r.defaultServiceTier = v ?? undefined)} />
		</section>
	{/if}
	{#if !r.imageGeneration}
	<section class="fsec set-group">
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
	{/if}
	{#if !locked}
		<Button variant="ghost" class="danger-text" onclick={onremove}><Icon name="trash" /> {t("이 모델 삭제")}</Button>
	{/if}

<style>
	.idlabel {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.src {
		display: flex;
		align-items: center;
		gap: 4px;
	}
	.src :global(svg) {
		width: 14px;
		height: 14px;
		flex: none;
		stroke-width: 2;
	}
	.matchrow {
		display: flex;
		flex-direction: column;
		gap: 4px;
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
	@media (hover: hover) {
		.mtrigger:hover {
			background: var(--bg-hover);
		}
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
		padding: 0 8px;
		background: var(--bg);
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-control);
		color: var(--text);
		transition: border-color var(--motion-fast) var(--ease-std);
	}
	@media (hover: hover) {
		.iconpick:hover {
			border-color: var(--accent);
		}
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
	/* the abilities: one card of switch rows (like the agent tools list), a hairline between rows */
	.capsw {
		display: flex;
		flex-direction: column;
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: var(--radius);
	}
	.caprow {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 12px;
	}
	.caprow + .caprow {
		border-top: 1px solid var(--border);
	}
	/* the 16px glyph on the card's 12px inner line, centred on the label's 20px line */
	.capic {
		flex: none;
		display: grid;
		place-items: center;
		width: 16px;
		height: 20px;
		align-self: flex-start;
		color: var(--text-dim);
		transition: color var(--motion-fast) var(--ease-std);
	}
	.capic :global(svg) {
		width: 16px;
		height: 16px;
		stroke-width: 1.8;
	}
	.caprow.on .capic {
		color: var(--text);
	}
	.captext {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 4px;
		word-break: keep-all; /* don't split a Korean word between syllables */
	}
	.captext b {
		font-size: var(--fs-sm);
		font-weight: 600;
		line-height: 20px; /* whole-pixel line box */
		color: var(--text);
	}
	.captext small {
		font-size: var(--fs-xs);
		line-height: 16px; /* whole-pixel line box */
		color: var(--text-faint);
	}
	/* reasoning while the model draws pictures: kept in place, read as unavailable */
	.caprow.off .captext b,
	.caprow.off .capic {
		color: var(--text-faint);
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
	.grid2 .field:focus {
		box-shadow: inset 0 0 0 3px var(--accent-soft); /* the model limits can land flush with the scrolling form footer */
	}
	.grid2 {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 8px;
	}
	label {
		display: flex;
		flex-direction: column;
		gap: 4px;
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
		gap: 8px;
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
