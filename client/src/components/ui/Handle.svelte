<script lang="ts">
	import type { Activity } from "../../lib/activity";

	/**
	 * The `@name` handle a conversation is called by, before its title: one look in the sidebar row, the tab bar and a
	 * group's chips (docs/design-system.md, "The `@name` handle"). 11px on a 16px line box, so the row centres it on the
	 * title's centre line; faint while idle, otherwise the activity colour the agent badge beside it has.
	 *
	 *  text   the handle as shown (`peerLabel(...).text`)
	 *  state  the session's activity (idle = faint)
	 */
	let { text, state = "idle" }: { text: string; state?: Activity } = $props();
</script>

<span class="who mono {state}">{text}</span>

<style>
	.who {
		flex: none;
		font-size: var(--fs-2xs);
		font-weight: 600;
		color: var(--text-faint);
		line-height: 16px; /* whole-pixel line box centred by the row: the handle's ink centre lands on the title's (centre line, not baseline) */
	}
	.working {
		color: var(--info);
	}
	.asking {
		color: var(--warn);
	}
	.done {
		color: var(--ok);
	}
	.failed {
		color: var(--danger);
	}
</style>
