<script lang="ts">
	import { t } from "../../lib/i18n";
	import { chipIn, chipOut, reflow } from "../../lib/motion";
	import Icon from "../ui/Icon.svelte";
	import ComposerStrip from "./ComposerStrip.svelte";

	/** Selected skills waiting in the composer, one removable tag each. */
	let { skills, onremove }: { skills: readonly string[]; onremove: (name: string) => void } = $props();
</script>

<ComposerStrip>
	{#each skills as name (name)}
		<div class="skill-slot" animate:reflow in:chipIn out:chipOut>
			<span class="skill-tag">
				<Icon name="skill" />
				<span class="skill-name mono">{name}</span>
				<button type="button" class="skill-rm" onclick={() => onremove(name)} aria-label={t("{name} 스킬 제거", { name })} title={t("{name} 스킬 제거", { name })}><Icon name="x" /></button>
			</span>
		</div>
	{/each}
</ComposerStrip>

<style>
	.skill-slot {
		flex: none;
	}
	.skill-tag {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		height: 28px;
		padding: 0 4px 0 8px;
		border: 1px solid color-mix(in srgb, var(--accent) 28%, transparent);
		border-radius: var(--radius-sm);
		background: var(--accent-soft);
		color: var(--accent);
		font-size: var(--fs-xs);
		line-height: 20px;
	}
	.skill-tag > :global(svg) {
		width: 14px;
		height: 14px;
		flex: none;
		stroke-width: 1.9;
	}
	.skill-name {
		max-width: 180px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-weight: 600;
		line-height: 20px;
	}
	.skill-rm {
		display: grid;
		place-items: center;
		flex: none;
		width: 20px;
		height: 20px;
		padding: 0;
		border-radius: var(--radius-sm);
		color: inherit;
	}
	.skill-rm :global(svg) {
		width: 12px;
		height: 12px;
		stroke-width: 2;
	}
	@media (hover: hover) {
		.skill-rm:hover {
			background: color-mix(in srgb, var(--accent) 18%, transparent);
		}
	}
</style>
