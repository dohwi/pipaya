<script module lang="ts">
	import Button from "../Button.svelte";
	import type { UINode } from "../../lib/extensions/ui";

	const VIEW = Symbol("extension-view");

	export interface ViewContext {
		readonly root: UINode;
		readonly errors: Record<string, string>;
		readonly focusId: string | null;
		setError(key: string, message: string): void;
		clearErrors(keys: string[]): void;
		focus(id: string): void;
	}

	/** Deterministic, DOM-safe id so labels, hints and panels can reference each other. */
	export function domId(namespace: string, id: string, part = ""): string {
		const safe = (value: string) => value.replace(/[^A-Za-z0-9_-]/g, (ch) => `_${ch.codePointAt(0)!.toString(16)}_`);
		return `ext-${safe(namespace)}-${safe(id)}${part ? `-${safe(part)}` : ""}`;
	}
</script>

<script lang="ts">
	import { LocalizedError, msg, t } from "../../lib/i18n";
	import { paneIn } from "../../lib/motion";
	import { slidingIndicator } from "../../lib/sliding-indicator";
	import { getContext, setContext, tick } from "svelte";
	import Select from "../Select.svelte";
	import ExtensionView from "./ExtensionView.svelte";
	import ExtensionIcon from "./ExtensionIcon.svelte";
	import { fieldsIn, validateUIEvent, type UIEvent, type UIFieldValue } from "../../lib/extensions/ui";

	type Kind<T extends UINode["type"]> = Extract<UINode, { type: T }>;
	type Field = ReturnType<typeof fieldsIn>[number];
	type TextField = Kind<"input"> | Kind<"textarea">;

	interface Props {
		node: UINode;
		namespace: string;
		values: Record<string, UIFieldValue>;
		pending?: boolean;
		/** Inherited from an ancestor form; callers normally leave this unset. */
		disabled?: boolean;
		/** Synchronous local update only. */
		onchange: (id: string, value: UIFieldValue) => void;
		ondispatch: (event: UIEvent) => Promise<void>;
	}

	let { node, namespace, values, pending = false, disabled = false, onchange, ondispatch }: Props = $props();

	// Errors and focus requests are shared by every recursive instance through context.
	const inherited = getContext<ViewContext | undefined>(VIEW);
	let errors = $state<Record<string, string>>({});
	let focusId = $state<string | null>(null);
	const view: ViewContext =
		inherited ??
		{
			get root() {
				return node;
			},
			get errors() {
				return errors;
			},
			get focusId() {
				return focusId;
			},
			setError(key, message) {
				if (message) errors[key] = message;
				else delete errors[key];
			},
			clearErrors(keys) {
				for (const key of keys) delete errors[key];
			},
			focus(id) {
				focusId = id;
			},
		};
	if (!inherited) {
		setContext(VIEW, view);
		$effect(() => {
			// An authoritative update invalidates local validation messages without
			// remounting controls, tabs, or discarding the surface's draft values.
			node;
			errors = {};
		});
		$effect(() => {
			const id = focusId;
			if (!id) return;
			void (async () => {
				// A field inside an inactive tab needs the tab switch to render first.
				for (let attempt = 0; attempt < 3; attempt += 1) {
					await tick();
					const element = document.getElementById(domId(namespace, id));
					if (element) {
						element.focus();
						break;
					}
				}
				focusId = null;
			})();
		});
	}

	const locked = $derived(pending || disabled);

	// ---- values --------------------------------------------------------------------------------
	function textOf(field: Field): string {
		const raw = values[field.id];
		if (typeof raw === "string") return raw;
		return field.type === "checkbox" ? "" : (field.value ?? "");
	}
	function checkedOf(field: Kind<"checkbox">): boolean {
		const raw = values[field.id];
		return typeof raw === "boolean" ? raw : (field.checked ?? false);
	}
	function valueOf(field: Field): UIFieldValue {
		return field.type === "checkbox" ? checkedOf(field) : textOf(field);
	}

	// ---- errors / dispatch ---------------------------------------------------------------------
	const problemOf = (key: string, fallback?: string) => (Object.hasOwn(view.errors, key) ? view.errors[key] : "") || fallback || "";

	const GENERIC = msg("입력 내용을 확인해 주세요.");
	/** validateUIEvent throws technical English `path: message`; show a friendly message in the current language instead. */
	function reason(cause: unknown): string {
		const raw = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
		if (!raw) return t("요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.");
		const detail = raw.slice(raw.indexOf(": ") + 2);
		if (detail === "is required") return t("필수 항목입니다.");
		let match = /^must be at most (\d+) characters$/.exec(detail);
		if (match) return t("{n}자 이하로 입력해 주세요.", { n: match[1]! });
		match = /^must be at least (\d+) characters$/.exec(detail);
		if (match) return t("{n}자 이상 입력해 주세요.", { n: match[1]! });
		if (detail === "expected an email address") return t("올바른 이메일 주소를 입력해 주세요. (예: name@example.com)");
		if (detail === "expected a finite number") return t("숫자만 입력해 주세요.");
		if (detail === "must be empty or one of the option values") return t("목록에 있는 항목을 선택해 주세요.");
		if (/disabled|unknown target|expected a (string|boolean)|^event|^view/.test(detail)) return t(GENERIC);
		// Our own messages (LocalizedError) reach the user as they are; anything else is a technical error.
		return cause instanceof LocalizedError ? raw : t(GENERIC);
	}

	type Checked = { event: UIEvent; message: "" } | { event?: undefined; message: string };
	/** Authoritative validation; returns the sanitized event to dispatch. */
	function check(event: UIEvent): Checked {
		try {
			return { event: validateUIEvent(view.root, event), message: "" };
		} catch (cause) {
			return { message: reason(cause) };
		}
	}
	/** Full (submit-grade) rules for a single field, by validating it as a one-field form. */
	function fieldProblem(field: Field, value: UIFieldValue): string {
		const id = field.id === "x-form" ? "y-form" : "x-form";
		try {
			validateUIEvent({ type: "form", id, submitLabel: t("확인"), children: [field] }, { type: "submit", id, values: { [field.id]: value } });
			return "";
		} catch (cause) {
			return reason(cause);
		}
	}

	/** Validates, then dispatches. Problems and rejections are shown inline under `key`. */
	async function emit(event: UIEvent, key: string): Promise<boolean> {
		const { event: safe, message } = check(event);
		view.setError(key, message);
		if (!safe) return false;
		try {
			await ondispatch(safe);
			return true;
		} catch (cause) {
			view.setError(key, reason(cause));
			return false;
		}
	}

	// ---- fields --------------------------------------------------------------------------------
	function onInput(field: TextField, event: Event) {
		view.setError(field.id, "");
		onchange(field.id, (event.currentTarget as HTMLInputElement | HTMLTextAreaElement).value);
	}
	function commitText(field: TextField, event: Event) {
		const value = (event.currentTarget as HTMLInputElement | HTMLTextAreaElement).value;
		onchange(field.id, value);
		void emit({ type: "change", id: field.id, value }, field.id);
	}
	function commitChoice(field: Kind<"select"> | Kind<"checkbox">, event: Event) {
		const target = event.currentTarget as HTMLInputElement | HTMLSelectElement;
		const value = field.type === "checkbox" ? (target as HTMLInputElement).checked : target.value;
		onchange(field.id, value);
		void emit({ type: "change", id: field.id, value }, field.id);
	}

	// ---- forms ---------------------------------------------------------------------------------
	async function submit(form: Kind<"form">, event: SubmitEvent) {
		event.preventDefault();
		if (locked || form.disabled) return;
		const fields = fieldsIn(form);
		const collected: Record<string, UIFieldValue> = {};
		for (const field of fields) if (!field.disabled) collected[field.id] = valueOf(field);

		view.clearErrors([form.id, ...fields.map((field) => field.id)]);
		let invalid = 0;
		let first = "";
		for (const field of fields) {
			if (field.disabled) continue;
			const message = fieldProblem(field, collected[field.id]!);
			if (!message) continue;
			view.setError(field.id, message);
			first ||= field.id;
			invalid += 1;
		}
		if (invalid) {
			view.setError(form.id, t("{n}개 항목을 확인해 주세요.", { n: invalid }));
			view.focus(first);
			return;
		}
		const { event: safe, message } = check({ type: "submit", id: form.id, values: collected });
		if (!safe) {
			view.setError(form.id, message);
			return;
		}
		try {
			await ondispatch(safe);
		} catch (cause) {
			view.setError(form.id, reason(cause));
		}
	}

	// ---- tabs ----------------------------------------------------------------------------------
	let selectedTab = $state<string | undefined>();
	let tabDir = $state(1);
	function pickTab(ids: string[], id: string) {
		tabDir = ids.indexOf(id) >= ids.indexOf(selectedTab ?? ids[0]) ? 1 : -1;
		selectedTab = id;
	}
	const tabIndex = $derived.by(() => {
		if (node.type !== "tabs") return 0;
		const found = node.items.findIndex((item) => item.id === selectedTab);
		return found < 0 ? 0 : found;
	});

	$effect(() => {
		const target = view.focusId;
		if (!target || node.type !== "tabs") return;
		const hit = node.items.find((item) => item.children.some((child) => fieldsIn(child).some((field) => field.id === target)));
		if (hit) selectedTab = hit.id;
	});

	function onTabKey(event: KeyboardEvent, ids: string[], index: number) {
		const last = ids.length - 1;
		const next =
			event.key === "ArrowRight" ? (index >= last ? 0 : index + 1)
			: event.key === "ArrowLeft" ? (index <= 0 ? last : index - 1)
			: event.key === "Home" ? 0
			: event.key === "End" ? last
			: -1;
		if (next < 0) return;
		event.preventDefault();
		pickTab(ids, ids[next]);
		const tabs = (event.currentTarget as HTMLElement).parentElement?.querySelectorAll<HTMLElement>('[role="tab"]');
		tabs?.[next]?.focus();
	}

	// ---- presentation helpers ------------------------------------------------------------------
	const gaps = { small: "gap-small", medium: "gap-medium", large: "gap-large" } as const;
	const percent = (value: number, max: number) => Math.round((value / max) * 100);
	const range = (value: number, max: number) => Math.min(Math.max(Number.isFinite(value) ? value : 0, 0), max);
	const limit = (max: number | undefined) => (max && max > 0 ? max : 100);
</script>

{#snippet kids(list: UINode[], off: boolean)}
	{#each list as child (child.id)}
		<ExtensionView node={child} {namespace} {values} {pending} disabled={off} {onchange} {ondispatch} />
	{/each}
{/snippet}

{#snippet note(id: string, message: string)}
	<p class="error" id={domId(namespace, id, "error")} aria-live="polite">{message}</p>
{/snippet}

{#if node.type === "stack"}
	<div class="stack {node.direction === 'horizontal' ? 'row' : 'column'} {gaps[node.gap ?? 'medium']}">
		{@render kids(node.children, disabled)}
	</div>
{:else if node.type === "grid"}
	<div class="grid cols-{node.columns ?? 2} gap-medium">
		{@render kids(node.children, disabled)}
	</div>
{:else if node.type === "card"}
	{@const titleId = domId(namespace, node.id, "title")}
	<section class="card" aria-labelledby={node.title ? titleId : undefined}>
		{#if node.title || node.description}
			<header class="card-head">
				{#if node.title}<h4 id={titleId}>{node.title}</h4>{/if}
				{#if node.description}<p class="muted">{node.description}</p>{/if}
			</header>
		{/if}
		{@render kids(node.children, disabled)}
	</section>
{:else if node.type === "tabs"}
	{@const base = domId(namespace, node.id)}
	{@const ids = node.items.map((item) => item.id)}
	{@const active = node.items[tabIndex]}
	{#if active}
		<div class="tabs">
			<div class="tablist" role="tablist" aria-orientation="horizontal" style="--ind-color: var(--accent)" use:slidingIndicator={{ selector: '.tab[aria-selected="true"]', variant: "underline", edge: "bottom", thickness: 2 }}>
				{#each node.items as item, index (item.id)}
					{@const selected = index === tabIndex}
					<button
						type="button"
						role="tab"
						class="tab"
						id="{base}-tab-{item.id}"
						aria-selected={selected}
						aria-controls={selected ? `${base}-panel-${item.id}` : undefined}
						tabindex={selected ? 0 : -1}
						onclick={() => pickTab(ids, item.id)}
						onkeydown={(event) => onTabKey(event, ids, index)}
					>{item.label}</button>
				{/each}
			</div>
			{#key active.id}
				<div class="tabpanel" role="tabpanel" id="{base}-panel-{active.id}" aria-labelledby="{base}-tab-{active.id}" tabindex="0" in:paneIn={{ x: tabDir * 14 }}>
					{@render kids(active.children, disabled)}
				</div>
			{/key}
		</div>
	{/if}
{:else if node.type === "form"}
	{@const off = locked || !!node.disabled}
	{@const message = problemOf(node.id)}
	<form class="form" novalidate aria-busy={pending} aria-describedby={message ? domId(namespace, node.id, "error") : undefined} onsubmit={(event) => submit(node, event)}>
		{@render kids(node.children, off)}
		{@render note(node.id, message)}
		<div class="actions">
			<Button variant="primary" type="submit" disabled={off}>{node.submitLabel}</Button>
		</div>
	</form>
{:else if node.type === "text"}
	{@const size = node.size ?? "body"}
	{#if size === "heading"}
		<h4 class="text size-heading tone-{node.tone ?? 'neutral'}">{node.text}</h4>
	{:else}
		<p class="text size-{size} tone-{node.tone ?? 'neutral'}">{node.text}</p>
	{/if}
{:else if node.type === "badge"}
	<span class="badge tone-{node.tone ?? 'neutral'}">{node.text}</span>
{:else if node.type === "divider"}
	<hr class="divider" />
{:else if node.type === "code"}
	<!-- svelte-ignore a11y_no_noninteractive_tabindex -- scrollable regions must be keyboard focusable -->
	<pre class="code" role="region" tabindex="0" aria-label={node.language ? t("{name} 코드", { name: node.language }) : t("코드")} data-language={node.language}><code>{node.text}</code></pre>
{:else if node.type === "alert"}
	{@const tone = node.tone ?? "info"}
	<div class="alert tone-{tone}" role={tone === "danger" || tone === "warning" ? "alert" : "status"}>
		{#if node.title}<strong>{node.title}</strong>{/if}
		<span>{node.text}</span>
	</div>
{:else if node.type === "progress"}
	{@const max = limit(node.max)}
	{@const current = range(node.value, max)}
	{@const labelId = domId(namespace, node.id, "label")}
	<div class="progress">
		<div class="progress-head">
			<span id={labelId}>{node.label}</span>
			<span class="muted">{percent(current, max)}%</span>
		</div>
		<progress id={domId(namespace, node.id)} value={current} {max} aria-labelledby={labelId}>{percent(current, max)}%</progress>
	</div>
{:else if node.type === "icon"}
	<ExtensionIcon icon={node.icon} size={node.size} label={node.label} />
{:else if node.type === "stat"}
	<dl class="stat">
		<dt>{node.label}</dt>
		<dd class="stat-value">{node.value}</dd>
		{#if node.hint}<dd class="muted">{node.hint}</dd>{/if}
	</dl>
{:else if node.type === "table"}
	{@const captionId = domId(namespace, node.id, "caption")}
	<!-- svelte-ignore a11y_no_noninteractive_tabindex -- scrollable regions must be keyboard focusable -->
	<div class="scroll" role="region" tabindex="0" aria-label={node.caption || t("표")}>
		<table>
			{#if node.caption}<caption id={captionId}>{node.caption}</caption>{/if}
			<thead>
				<tr>
					{#each node.columns as column (column.id)}<th scope="col">{column.label}</th>{/each}
				</tr>
			</thead>
			<tbody>
				{#each node.rows as row (row.id)}
					<tr>
						{#each node.columns as column, index (column.id)}<td>{row.cells[index] ?? ""}</td>{/each}
					</tr>
				{:else}
					<tr><td class="muted" colspan={Math.max(node.columns.length, 1)}>{t("표시할 행이 없습니다.")}</td></tr>
				{/each}
			</tbody>
		</table>
	</div>
{:else if node.type === "list"}
	{#if node.items.length}
		<ul class="list">
			{#each node.items as item (item.id)}
				<li>
					<div class="list-text">
						<span class="list-title">{item.title}</span>
						{#if item.description}<span class="muted">{item.description}</span>{/if}
					</div>
					{#if item.badge}<span class="badge tone-neutral">{item.badge}</span>{/if}
				</li>
			{/each}
		</ul>
	{:else}
		<p class="muted empty">{node.emptyText || t("표시할 항목이 없습니다.")}</p>
	{/if}
{:else if node.type === "button"}
	{@const message = problemOf(node.id)}
	<div class="button-wrap">
		<button
			type="button"
			class="btn {node.variant ?? 'secondary'}"
			disabled={locked || node.disabled}
			aria-busy={pending}
			aria-describedby={message ? domId(namespace, node.id, "error") : undefined}
			onclick={() => void emit({ type: "action", id: node.id }, node.id)}
		>{node.label}</button>
		{@render note(node.id, message)}
	</div>
{:else if node.type === "input" || node.type === "textarea"}
	{@const id = domId(namespace, node.id)}
	{@const message = problemOf(node.id, node.error)}
	<div class="ui-field">
		<label for={id}>{node.label}{#if node.required}<span class="req" aria-hidden="true"> *</span>{/if}</label>
		{#if node.type === "input"}
			<input
				{id}
				class="control"
					type={node.inputType ?? "text"}
				step={node.inputType === "number" ? "any" : undefined}
				value={textOf(node)}
				placeholder={node.placeholder}
				required={node.required}
				minlength={node.minLength}
				maxlength={node.maxLength}
				disabled={locked || node.disabled}
				aria-invalid={message ? "true" : undefined}
				aria-describedby={message ? domId(namespace, node.id, "error") : undefined}
				oninput={(event) => onInput(node, event)}
				onchange={(event) => commitText(node, event)}
			/>
		{:else}
			<textarea
				{id}
				class="control"
				rows={node.rows ?? 4}
				value={textOf(node)}
				placeholder={node.placeholder}
				required={node.required}
				minlength={node.minLength}
				maxlength={node.maxLength}
				disabled={locked || node.disabled}
				aria-invalid={message ? "true" : undefined}
				aria-describedby={message ? domId(namespace, node.id, "error") : undefined}
				oninput={(event) => onInput(node, event)}
				onchange={(event) => commitText(node, event)}
			></textarea>
		{/if}
		{@render note(node.id, message)}
	</div>
{:else if node.type === "select"}
	{@const id = domId(namespace, node.id)}
	{@const message = problemOf(node.id, node.error)}
	{@const current = textOf(node)}
	<div class="ui-field">
		<label for={id}>{node.label}{#if node.required}<span class="req" aria-hidden="true"> *</span>{/if}</label>
		<Select
			{id}
			value={current}
			required={node.required}
			disabled={locked || node.disabled}
			invalid={!!message}
			describedby={message ? domId(namespace, node.id, "error") : undefined}
			onchange={(value) => { onchange(node.id, value); void emit({ type: "change", id: node.id, value }, node.id); }}
			options={[{ value: "", label: t("선택해 주세요") }, ...node.options]}
		/>
		{@render note(node.id, message)}
	</div>
{:else if node.type === "checkbox"}
	{@const id = domId(namespace, node.id)}
	{@const message = problemOf(node.id, node.error)}
	<div class="ui-field">
		<div class="check">
			<input
				{id}
				type="checkbox"
				checked={checkedOf(node)}
				required={node.required}
				disabled={locked || node.disabled}
				aria-invalid={message ? "true" : undefined}
				aria-describedby={message ? domId(namespace, node.id, "error") : undefined}
				onchange={(event) => commitChoice(node, event)}
			/>
			<label for={id}>{node.label}{#if node.required}<span class="req" aria-hidden="true"> *</span>{/if}</label>
		</div>
		{@render note(node.id, message)}
	</div>
{/if}

<style>
	/* tones: one set of custom properties drives text, badges and alerts */
	.tone-neutral { --tone: var(--text-dim); --tone-soft: var(--bg-active); }
	.tone-info { --tone: var(--lv-low); --tone-soft: color-mix(in srgb, var(--lv-low) 14%, transparent); }
	.tone-success { --tone: var(--ok); --tone-soft: var(--ok-soft); }
	.tone-warning { --tone: var(--warn); --tone-soft: var(--warn-soft); }
	.tone-danger { --tone: var(--danger); --tone-soft: var(--danger-soft); }

	/* layout */
	.stack, .grid { min-width: 0; }
	.stack { display: flex; }
	.stack.column { flex-direction: column; }
	.stack.row { flex-direction: row; flex-wrap: wrap; align-items: flex-start; }
	.stack > :global(*) { min-width: 0; }
	.gap-small { gap: 6px; }
	.gap-medium { gap: 12px; }
	.gap-large { gap: 20px; }
	.grid { display: grid; --cols: 2; --min: 9rem; grid-template-columns: repeat(auto-fit, minmax(min(100%, max(var(--min), calc((100% - (var(--cols) - 1) * 20px) / var(--cols)))), 1fr)); align-items: start; }
	.grid.gap-small { gap: 6px; }
	.grid.gap-medium { gap: 12px; }
	.grid.gap-large { gap: 20px; }
	.grid.cols-1 { --cols: 1; }
	.grid.cols-2 { --cols: 2; }
	.grid.cols-3 { --cols: 3; }
	.grid > :global(*) { min-width: 0; }

	.card { display: flex; flex-direction: column; gap: 12px; min-width: 0; padding: 14px 16px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--bg-elev); }
	.card-head { display: flex; flex-direction: column; gap: 2px; }
	h4, p { margin: 0; }
	.card-head h4 { font-size: var(--fs-base); font-weight: 600; overflow-wrap: anywhere; }

	/* text */
	.text, .muted, .list-title, .error, label, .alert, .stat, dd, dt { overflow-wrap: anywhere; }
	.text { color: var(--text); line-height: 1.55; white-space: pre-wrap; }
	.text:not(.tone-neutral) { color: var(--tone); }
	.size-small { font-size: var(--fs-xs); }
	.size-body { font-size: var(--fs-md); }
	.size-heading { font-size: var(--fs-lg); font-weight: 600; line-height: 1.35; }
	.muted { font-size: var(--fs-xs); color: var(--text-faint); line-height: 1.5; }
	.empty { padding: 4px 0; }
	.badge { display: inline-flex; align-items: center; align-self: flex-start; max-width: 100%; padding: 2px 9px; border-radius: var(--radius-pill); background: var(--tone-soft); color: var(--tone); font-size: var(--fs-xs); font-weight: 550; line-height: 1.5; overflow-wrap: anywhere; }
	.badge.tone-neutral { color: var(--text); }
	.divider { width: 100%; margin: 4px 0; border: 0; border-top: 1px solid var(--border); }

	.code { margin: 0; padding: 10px 12px; max-width: 100%; overflow: auto; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg-code); font-family: var(--mono); font-size: var(--fs-xs); line-height: 1.55; tab-size: 2; }
	.code code { font-family: inherit; white-space: pre; }

	.alert { display: flex; flex-direction: column; gap: 2px; padding: 9px 12px; border-radius: var(--radius-sm); background: var(--tone-soft); color: var(--tone); font-size: var(--fs-sm); line-height: 1.5; }
	.alert strong { font-weight: 650; }
	.alert.tone-neutral { color: var(--text); }

	.progress { display: flex; flex-direction: column; gap: 6px; }
	.progress-head { display: flex; justify-content: space-between; gap: 12px; font-size: var(--fs-sm); }
	progress { width: 100%; height: 8px; border: 0; border-radius: var(--radius-pill); overflow: hidden; appearance: none; background: var(--bg-active); accent-color: var(--accent); }
	progress::-webkit-progress-bar { background: var(--bg-active); }
	progress::-webkit-progress-value { background: var(--accent); border-radius: var(--radius-pill); }
	progress::-moz-progress-bar { background: var(--accent); border-radius: var(--radius-pill); }

	.stat { display: flex; flex-direction: column; gap: 2px; margin: 0; padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg-elev); }
	.stat dt { font-size: var(--fs-xs); color: var(--text-dim); }
	.stat dd { margin: 0; }
	.stat-value { font-size: var(--fs-2xl); font-weight: 650; letter-spacing: -0.02em; }

	.scroll { max-width: 100%; overflow-x: auto; border: 1px solid var(--border); border-radius: var(--radius-sm); }
	table { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); }
	caption { padding: 8px 12px; text-align: left; font-size: var(--fs-xs); color: var(--text-dim); }
	th, td { padding: 8px 12px; border-top: 1px solid var(--border); text-align: left; vertical-align: top; }
	thead th { border-top: 0; background: var(--bg-elev); font-weight: 600; color: var(--text-dim); white-space: nowrap; }
	td { overflow-wrap: anywhere; min-width: 6rem; }

	.list { display: flex; flex-direction: column; margin: 0; padding: 0; list-style: none; border: 1px solid var(--border); border-radius: var(--radius-sm); }
	.list li { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 9px 12px; }
	.list li + li { border-top: 1px solid var(--border); }
	.list-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
	.list-title { font-size: var(--fs-md); font-weight: 550; }

	/* tabs */
	.tabs { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
	.tablist { position: relative; display: flex; gap: 2px; overflow-x: auto; border-bottom: 1px solid var(--border); }
	.tab { flex: none; padding: 8px 12px; margin-bottom: -1px; border-bottom: 2px solid transparent; color: var(--text-dim); font-size: var(--fs-sm); font-weight: 550; transition: color var(--motion-fast) var(--ease-std), border-color var(--motion-fast) var(--ease-std); }
	.tab:hover { color: var(--text); }
	.tab[aria-selected="true"] { color: var(--text); border-bottom-color: var(--accent); }
	.tablist:global([data-indicator-ready]) .tab[aria-selected="true"] { border-bottom-color: transparent; }
	.tabpanel { display: flex; flex-direction: column; gap: 12px; min-width: 0; border-radius: var(--radius-sm); }

	/* forms + controls */
	.form { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
	.actions { display: flex; gap: 8px; flex-wrap: wrap; }
	.ui-field { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
	label { font-size: var(--fs-sm); font-weight: 550; color: var(--text); }
	.req { color: var(--danger); }
	.control { width: 100%; min-width: 0; padding: 8px 10px; border: 1px solid var(--border-strong); border-radius: var(--radius-sm); background: var(--bg); color: var(--text); font-size: var(--fs-lg); line-height: 1.4; transition: border-color var(--motion-fast) var(--ease-std), box-shadow var(--motion-fast) var(--ease-std); }
	textarea.control { resize: vertical; min-height: 4.5rem; }
	.control::placeholder { color: var(--text-faint); }
	.control:focus-visible { outline: 2px solid transparent; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
	.control[aria-invalid="true"] { border-color: var(--danger); }
	.control[aria-invalid="true"]:focus-visible { box-shadow: 0 0 0 3px var(--danger-soft); }
	.control:disabled, .btn:disabled, .check input:disabled { opacity: 0.55; cursor: not-allowed; }
	.check { display: flex; align-items: flex-start; gap: 8px; }
	.check input { flex: none; width: 17px; height: 17px; margin: 2px 0 0; accent-color: var(--accent); }
	.check input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
	.check input[aria-invalid="true"] { outline: 2px solid var(--danger); outline-offset: 1px; }
	.check label { font-weight: 450; }
	.error { margin: 0; font-size: var(--fs-xs); line-height: 1.45; color: var(--danger); }
	.error:empty { display: none; }

	.button-wrap { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; min-width: 0; }
	.btn { height: auto; min-height: 38px; max-width: 100%; padding: 8px 18px; line-height: 1.3; font-weight: 600; white-space: normal; overflow-wrap: anywhere; }
	.btn.primary { background: var(--accent); color: var(--accent-fg); }
	.btn.primary:hover:not(:disabled) { background: var(--accent-hover); }
	.btn.secondary { background: var(--bg-elev); border-color: var(--border-strong); color: var(--text); }
	.btn.secondary:hover:not(:disabled) { background: var(--bg-hover); }
	.btn.danger { background: var(--danger-soft); border-color: var(--danger); color: var(--danger); }
	.btn.danger:hover:not(:disabled) { background: var(--danger); color: var(--accent-fg); }

	@media (prefers-reduced-motion: reduce) {
		.tab, .control { transition: none; }
	}
</style>
