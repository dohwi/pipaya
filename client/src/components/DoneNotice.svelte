<script lang="ts">
	import { t } from "../lib/i18n";
	import { flip } from "svelte/animate";
	import AgentBadge from "./AgentBadge.svelte";
	import Icon from "./Icon.svelte";
	import CountdownClose from "./CountdownClose.svelte";
	import { ms, surfaceIn, surfaceOut } from "../lib/motion";
	import { app } from "../lib/store.svelte";

	/**
	 * Strips under the nav (and under the group strip / connection banner, since the stage starts below them)
	 * saying other sessions finished: on a phone any other session, on a wide screen another pane of the open group. Tap = go there; the ring around × counts down to the auto-dismiss.
	 */

	// Whatever the user focuses no longer needs a strip, however they got there (a pane of a group needs one until focused).
	$effect(() => {
		const focused = app.activeId;
		for (const n of app.feedback.notices) if (n.sid === focused) app.feedback.dismissNotice(n.id);
	});

	function go(id: number, sid: string) {
		app.feedback.dismissNotice(id);
		void app.openSession(sid);
	}
</script>

{#if app.feedback.notices.length}
	<div class="stack" aria-live="polite">
		{#each app.feedback.notices as n (n.id)}
			{@const failed = n.tone === "failed"}
			<div class="row" class:failed role={failed ? "alert" : "status"} animate:flip={{ duration: ms("fast") }} in:surfaceIn={{ y: -10 }} out:surfaceOut={{ y: -10 }}>
				<button class="go" onclick={() => go(n.id, n.sid)}>
					<AgentBadge id={n.sid} state={n.tone} size={18} />
					<span class="title">{app.session(n.sid)?.title ?? t("대화")}</span>
					<span class="verdict">{failed ? t("실패") : t("완료")}</span>
				</button>
				<CountdownClose ms={n.ms} onclick={() => app.feedback.dismissNotice(n.id)} />
			</div>
		{/each}
	</div>
{/if}

<style>
	.stack {
		pointer-events: auto;
		display: flex;
		flex-direction: column;
		border-bottom: 1px solid var(--border-strong);
		background: var(--bg-elev);
		box-shadow: var(--shadow);
	}
	.row {
		--tone: var(--ok);
		display: flex;
		align-items: center;
		height: 44px;
		padding-right: 8px;
		padding-left: var(--sal);
		/* the whole strip is tinted with the tone (pastel green / red) so done / failed reads at a glance */
		background: color-mix(in srgb, var(--tone) 16%, var(--bg-elev));
	}
	.row + .row {
		border-top: 1px solid color-mix(in srgb, var(--tone) 25%, var(--border));
	}
	.row.failed {
		--tone: var(--danger);
	}
	.go {
		flex: 1;
		min-width: 0;
		height: 100%;
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 0 8px 0 16px;
		text-align: left;
		color: var(--text);
		font-size: var(--fs-sm);
	}
	.title {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-weight: 600;
	}
	.verdict {
		flex: none;
		font-size: var(--fs-xs);
		font-weight: 600;
		color: var(--tone);
	}
</style>
