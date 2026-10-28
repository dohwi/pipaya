<script lang="ts">
	import { errorText } from "../../lib/api";
	import { t } from "../../lib/i18n";
	import { onDestroy, untrack } from "svelte";
	import { extensions, type ExtensionPanel } from "../../lib/extensions/host.svelte";
	import { findNode, fieldsIn, type UIEvent, type UIFieldValue } from "../../lib/extensions/ui";
	import ExtensionView from "./ExtensionView.svelte";

	let { panel }: { panel: ExtensionPanel } = $props();
	let values = $state.raw<Record<string, UIFieldValue>>({});
	let pending = $state(false);
	let error = $state("");
	const instanceId = $props.id();
	const namespace = $derived(`${instanceId}-${panel.owner}:${panel.id}`);
	const ownerName = $derived(extensions.installed.find((entry) => entry.package.manifest.id === panel.owner)?.package.manifest.name ?? panel.owner);
	type Default = { type: string; value: UIFieldValue | undefined };
	let defaults = new Map<string, Default>();
	let identity = "";
	let alive = true;
	let request = 0;
	let queue: Promise<void> = Promise.resolve();
	let queued = 0;

	$effect.pre(() => {
		const view = panel.view;
		const key = `${panel.owner}:${panel.id}`;
		// Only the authoritative view/identity triggers reconciliation, never a local edit.
		untrack(() => {
			const next: Record<string, UIFieldValue> = {};
			const nextDefaults = new Map<string, Default>();
			for (const field of fieldsIn(view)) {
				const type = field.type === "input" ? `input:${field.inputType ?? "text"}` : field.type;
				const value = field.type === "checkbox" ? field.checked : field.value;
				const previous = defaults.get(field.id);
				const preserve = identity === key && previous?.type === type && previous.value === value;
				next[field.id] = preserve && Object.hasOwn(values, field.id)
					? values[field.id]
					: (value ?? (field.type === "checkbox" ? false : ""));
				nextDefaults.set(field.id, { type, value });
			}
			// Rebuilding the record also removes deleted fields and incompatible field types.
			values = next;
			defaults = nextDefaults;
			identity = key;
			error = "";
		});
	});

	function change(id: string, value: UIFieldValue) {
		if (!alive || pending) return;
		const field = findNode(panel.view, id);
		if (!field || !(field.type === "input" || field.type === "textarea" || field.type === "select" || field.type === "checkbox")) return;
		if (field.disabled || typeof value !== (field.type === "checkbox" ? "boolean" : "string")) return;
		values = { ...values, [id]: value };
	}

	async function dispatch(event: UIEvent): Promise<void> {
		if (!alive || pending) return;
		if (queued >= 20) { error = t("입력 처리 중입니다. 잠시 후 다시 시도하세요."); return; }
		queued++;
		const current = panel;
		const token = ++request;
		// Blur/change fires immediately before a submit click. Locking controls on
		// change would cancel that click; serialize change without disabling UI.
		const locks = event.type !== "change";
		if (locks) pending = true;
		error = "";
		const execution = queue.then(async () => {
			if (!alive || panel.run !== current.run) return;
			// The host revalidates against the current schema before invoking code.
			await current.run(event);
		});
		queue = execution.catch(() => {});
		try {
			await execution;
		} catch (cause) {
			// A reply to an older view (or a replaced extension) must not pollute the new UI.
			if (alive && request === token && panel.owner === current.owner && panel.id === current.id && panel.run === current.run) {
				error = errorText(cause);
			}
		} finally {
			queued--;
			if (alive && locks) pending = false;
		}
	}

	onDestroy(() => {
		alive = false;
		request += 1;
	});
</script>

<div class="extension-surface" aria-busy={pending}>
	<ExtensionView node={panel.view} {namespace} {values} {pending} onchange={change} ondispatch={dispatch} />
	<div class="feedback" aria-live="polite" aria-atomic="true">
		{#if error}
			<p class="error"><span class="attribution">{ownerName} ({panel.owner})</span><span>{error}</span></p>
		{/if}
	</div>
</div>

<style>
	.extension-surface { min-width: 0; }
	.feedback { color: var(--danger); font-size: var(--fs-xs); line-height: 1.7; overflow-wrap: anywhere; }
	.error { display: flex; flex-direction: column; gap: 4px; margin: 16px 0 0; padding: 12px 12px; border: 1px solid var(--danger); border-radius: var(--radius-sm); background: var(--danger-soft); }
	.attribution { font-weight: 600; }
</style>
