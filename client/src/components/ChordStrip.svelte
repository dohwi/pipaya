<script lang="ts">
	import { t } from "../lib/i18n";
	import { app } from "../lib/store.svelte";
	import { chord } from "../lib/chord.svelte";
	import { ACTIONS, chordNext, recordingCombo, recordingLabel } from "../lib/keys";
	import { fadeIn, fadeOut } from "../lib/motion";

	const MAX_SHOWN = 6;
	const prefix = $derived(chord.prefix);
	const next = $derived(prefix ? chordNext(prefix, app.prefs.bindings) : []);
	const label = (id: string) => t(ACTIONS.find((a) => a.id === id)?.label ?? id);
	const alone = $derived(prefix ? ACTIONS.find((a) => !a.fixed && app.prefs.bindings[a.id] === recordingCombo(prefix)) : undefined);
</script>

{#if prefix}
	<div class="strip" role="status" aria-live="polite" in:fadeIn out:fadeOut>
		<kbd class="now">{recordingLabel(prefix)}</kbd>
		<span class="wait">{t("다음 키를 기다리는 중")}</span>
		<span class="next">
			{#each next.slice(0, MAX_SHOWN) as n (n.id)}
				<span class="opt"><kbd>{n.rest}</kbd>{label(n.id)}</span>
			{/each}
			{#if next.length > MAX_SHOWN}<span class="more">+{next.length - MAX_SHOWN}</span>{/if}
		</span>
		<span class="keys">
			{#if alone}<span class="opt"><kbd>Enter</kbd>{label(alone.id)}</span>{/if}
			<span class="opt"><kbd>Esc</kbd>{t("취소")}</span>
		</span>
	</div>
{/if}

<style>
	.strip {
		position: fixed;
		left: 0;
		right: 0;
		bottom: 0;
		z-index: var(--z-toast);
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 8px 16px calc(8px + var(--sab));
		background: var(--accent);
		color: var(--accent-fg);
		font-size: var(--fs-xs);
		line-height: 1.2;
		user-select: none;
	}
	/* In the dark theme the accent is near white, which makes a glaring bar: use the raised dark surface instead. */
	:global(:root[data-theme="dark"]) .strip {
		background: var(--bg-elev);
		color: var(--text);
		border-top: 1px solid var(--border-strong);
		box-shadow: 0 -6px 20px rgba(0, 0, 0, 0.35);
	}
	:global(:root[data-theme="dark"]) .strip kbd {
		background: var(--bg-active);
		border: 1px solid var(--border-strong);
		color: var(--text);
	}
	:global(:root[data-theme="dark"]) .strip .now {
		color: var(--accent-hover);
	}
	/* the strip is dark in light mode: the key caps take its colours instead of the page's */
	kbd {
		padding: 4px 4px;
		border: 0;
		background: color-mix(in srgb, var(--accent-fg) 18%, transparent);
		color: inherit;
	}
	.now {
		font-weight: 700;
	}
	.wait {
		flex: none;
		opacity: 0.85;
	}
	.next {
		flex: 1;
		min-width: 0;
		display: flex;
		gap: 12px;
		overflow: hidden;
		white-space: nowrap;
	}
	.keys {
		flex: none;
		display: flex;
		gap: 12px;
	}
	.opt {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		white-space: nowrap;
	}
	.more {
		opacity: 0.7;
	}
	@media (max-width: 640px) {
		.wait,
		.next {
			display: none;
		}
		.keys {
			margin-left: auto;
		}
	}
</style>
