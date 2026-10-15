<script lang="ts" module>
	import type { Attachment as DraftAttachment } from "../lib/images";
	/** Unsent input per session ("" = new chat); outlives the component so switching sessions keeps what was typed. */
	const drafts = new Map<string, { text: string; attachments: DraftAttachment[] }>();
</script>

<script lang="ts">
	import { untrack } from "svelte";
	import { insertToken, mentionAt, mirrorHtml, replaceMention, type Mention } from "../lib/composer-text";
	import { fadeIn, fadeOut } from "../lib/motion";
	import Icon from "./Icon.svelte";
	import ModelPicker from "./ModelPicker.svelte";
	import AttachmentStrip from "./AttachmentStrip.svelte";
	import QueuedList from "./QueuedList.svelte";
	import StatusLine from "./StatusLine.svelte";
	import ExtensionPanels from "./extensions/ExtensionPanels.svelte";
	import SlashMenu from "./SlashMenu.svelte";
	import { argumentSuggestions, commandQuery, commandText, isCommandInput, matchCommands, matchSkills, matchTemplates, parseSlash, SKILL_PREFIX, TEMPLATE_PREFIX, type SlashCommand } from "../lib/commands";
	import { app } from "../lib/store.svelte";
	import { getPane } from "../lib/pane";
	import { extensions } from "../lib/extensions/host.svelte";
	import { fileToAttachment, type Attachment } from "../lib/images";
	import { isTouch } from "../lib/format";
	import { msg, t } from "../lib/i18n";

	const pane = getPane();
	const chat = $derived(app.chatOf(pane.id));

	// Unsent input survives switching to another session and back (kept per session, in memory; "" = new chat).
	let text = $state("");
	let ta: HTMLTextAreaElement | undefined = $state();
	let mirror: HTMLDivElement | undefined = $state();
	let fileInput: HTMLInputElement | undefined = $state();
	let wrapEl: HTMLDivElement | undefined = $state();
	let attachments = $state<Attachment[]>([]);
	let dragging = $state(false);
	let composing = false;

	const running = $derived(chat?.running ?? false);
	const compacting = $derived(chat?.compacting ?? false);
	/** Most recent prompt of this conversation, shown in the empty input: glows softly while it runs, grey once done. */
	const lastPrompt = $derived.by(() => {
		const items = chat?.items;
		if (!items) return "";
		for (let i = items.length - 1; i >= 0; i--) {
			const it = items[i]!;
			if (it.kind === "user") return it.text.replace(/\s+/g, " ").trim();
		}
		return "";
	});
	const promptHint = $derived(!compacting && text.length === 0 && lastPrompt ? lastPrompt : "");
	const vision = $derived(app.effectiveModelOf(pane.id)?.vision ?? false);
	const canSend = $derived((text.trim().length > 0 || attachments.length > 0) && (app.net === "online" || parseSlash(text) !== null) && !app.sending && (!compacting || parseSlash(text) !== null));

	export function focus() {
		ta?.focus();
	}
	export function setText(t: string) {
		text = t;
		queueMicrotask(resize);
		ta?.focus();
	}

	function resize() {
		if (!ta) return;
		ta.style.height = "auto";
		ta.style.height = `${Math.min(ta.scrollHeight, 220)}px`;
	}
	$effect(() => {
		text;
		resize();
	});

	// Publish the composer's top edge so floating UI (toasts) can sit above the input instead of over it.
	$effect(() => {
		if (!wrapEl || !pane.focused) return;
		const el = wrapEl;
		const root = document.documentElement;
		const update = () => root.style.setProperty("--composer-top", `${Math.max(0, root.clientHeight - el.getBoundingClientRect().top)}px`);
		update();
		const ro = new ResizeObserver(update);
		ro.observe(el);
		window.addEventListener("resize", update);
		return () => {
			ro.disconnect();
			window.removeEventListener("resize", update);
			root.style.removeProperty("--composer-top");
		};
	});

	// Each conversation has its own input: stash the one being left, restore the one being entered.
	let draftKey: string | null | undefined;
	function stash() {
		if (draftKey === undefined) return;
		const k = draftKey ?? "";
		if (text || attachments.length) drafts.set(k, { text, attachments });
		else drafts.delete(k);
	}
	$effect(() => {
		const id = pane.id;
		untrack(() => {
			stash();
			draftKey = id;
			const d = drafts.get(id ?? "");
			text = d?.text ?? "";
			attachments = d?.attachments ?? [];
		});
		if (pane.focused && !isTouch()) queueMicrotask(() => ta?.focus());
		return () => untrack(stash);
	});

	// Edit-and-branch hands over text once; declared after the effect above so it wins when both fire together.
	$effect(() => {
		const p = app.prefill;
		if (p === null || !pane.focused) return;
		app.prefill = null;
		// Keep what is already typed: append instead of overwriting.
		const cur = untrack(() => text);
		setText(cur.trim() ? `${cur.replace(/\s+$/, "")}\n${p}` : p);
	});

	// ── commands and finite arguments share the recommendation menu above the input ──
	let slashIndex = $state(0);
	let slashDismissed = $state(false);
	const slashQuery = $derived(commandQuery(text));
	const commandList = $derived(slashQuery !== null ? matchCommands(slashQuery) : []);
	// Skills sit in the same menu after the commands, as `/skill:name`, tagged so they are not mistaken for commands.
	let skillList = $state<{ name: string; description: string }[]>([]);
	const skillMatches = $derived(slashQuery !== null ? matchSkills(skillList, slashQuery) : []);
	// Prompt templates follow the skills as `/prompt:name`.
	let templateList = $state<{ name: string; description: string }[]>([]);
	const templateMatches = $derived(slashQuery !== null ? matchTemplates(templateList, slashQuery) : []);
	const slashList = $derived<(SlashCommand | { skill: { name: string; description: string } } | { template: { name: string; description: string } })[]>([
		...commandList,
		...skillMatches.map((skill) => ({ skill })),
		...templateMatches.map((template) => ({ template })),
	]);
	const skillsWanted = $derived(slashQuery !== null || text.includes(`/${SKILL_PREFIX}`));
	const skillsCwd = $derived((pane.id ? app.session(pane.id)?.cwd : null) || app.workdirAbs);
	$effect(() => {
		const api = app.api;
		const cwd = skillsCwd;
		app.skillsTick;
		if (!(slashQuery !== null || text.includes(`/${TEMPLATE_PREFIX}`)) || !api || app.net !== "online") return;
		const controller = new AbortController();
		api.templates(cwd, controller.signal)
			.then((r) => { if (!controller.signal.aborted) templateList = r.templates.map((k) => ({ name: k.name, description: k.description })); })
			.catch(() => { if (!controller.signal.aborted) templateList = []; });
		return () => controller.abort();
	});
	$effect(() => {
		const api = app.api;
		const cwd = skillsCwd;
		app.skillsTick;
		if (!skillsWanted || !api || app.net !== "online") return;
		const controller = new AbortController();
		api.skills(cwd, controller.signal, pane.id)
			.then((r) => { if (!controller.signal.aborted) skillList = r.skills.filter((k) => k.enabled).map((k) => ({ name: k.name, description: k.description })); })
			.catch(() => { if (!controller.signal.aborted) skillList = []; });
		return () => controller.abort();
	});
	const argSuggestions = $derived(argumentSuggestions(text));

	// ── @file mentions: the token right before the caret, e.g. "look at @src/comp" ──
	let caret = $state(0);
	let mentionFiles = $state<{ path: string; dir: boolean }[]>([]);
	let mentionLoaded = $state(false);
	const mention = $derived(slashQuery !== null || argSuggestions ? null : mentionAt("file", text, caret));

	// ── $agent: the token right before the caret picks a sub-agent by hand, e.g. "$explore find the login flow" ──
	let agentList = $state<{ name: string; description: string }[]>([]);
	const agentMention = $derived(slashQuery !== null || argSuggestions || mention ? null : mentionAt("agent", text, caret));
	const agentMatches = $derived(agentMention ? agentList.filter((a) => a.name.startsWith(agentMention.query)) : []);

	// ── #image: the token right before the caret picks an attached image, e.g. "compare #image1 and #image2" ──
	const imageMention = $derived(slashQuery !== null || argSuggestions || mention || agentMention || !attachments.length ? null : mentionAt("image", text, caret));
	// A fully typed token is done: hiding the menu keeps Enter free to send.
	const imageMatches = $derived(
		imageMention
			? attachments.map((a, i) => ({ n: i + 1, name: a.name })).filter((a) => `image${a.n}`.startsWith(imageMention.query) && `image${a.n}` !== imageMention.query)
			: [],
	);
	// Re-read the list each time a `$` is started, so edits made in server settings show up without a reload.
	const agentsWanted = $derived(agentMention !== null);
	$effect(() => {
		const api = app.api;
		if (!agentsWanted || !api || app.net !== "online") return;
		const controller = new AbortController();
		api.subagents()
			.then((r) => { if (!controller.signal.aborted) agentList = r.settings.enabled ? r.settings.agents.filter((a) => a.enabled).map((a) => ({ name: a.name, description: a.description })) : []; })
			.catch(() => { if (!controller.signal.aborted) agentList = []; });
		return () => controller.abort();
	});
	const mentionCwd = $derived((pane.id ? app.session(pane.id)?.cwd : null) || app.workdirAbs);
	$effect(() => {
		const q = mention?.query;
		const cwd = mentionCwd;
		const api = app.api;
		if (q === undefined || !api || app.net !== "online") {
			mentionFiles = [];
			mentionLoaded = false;
			return;
		}
		const controller = new AbortController();
		const timer = setTimeout(() => {
			api.listFiles(cwd, q, controller.signal)
				.then((r) => { mentionFiles = r.entries; mentionLoaded = true; })
				.catch(() => { if (!controller.signal.aborted) { mentionFiles = []; mentionLoaded = true; } });
		}, 80);
		return () => {
			clearTimeout(timer);
			controller.abort();
		};
	});

	const menuItems = $derived(mention
		? mentionFiles.map((f) => ({ id: f.path, text: `@${f.path}`, desc: f.dir ? msg("폴더") : "" }))
		: agentMention
			? agentMatches.map((a) => ({ id: a.name, text: `$${a.name}`, desc: a.description }))
		: imageMention
			? imageMatches.map((a) => ({ id: `image${a.n}`, text: `#image${a.n}`, desc: a.name }))
		: argSuggestions
			? argSuggestions.options.map((option) => ({ id: option.value, text: option.value, desc: option.desc, current: option.current }))
			: slashList.map((it) => "skill" in it
				? { id: `skill:${it.skill.name}`, text: `/${SKILL_PREFIX}${it.skill.name}`, desc: it.skill.description, tag: msg("스킬") }
				: "template" in it
				? { id: `template:${it.template.name}`, text: `/${TEMPLATE_PREFIX}${it.template.name}`, desc: it.template.description, tag: msg("템플릿") }
				: { id: it.name, text: commandText(it), args: it.args, desc: it.desc }));
	const slashOpen = $derived(mention !== null ? !slashDismissed && (mentionLoaded || mentionFiles.length > 0) : agentMention !== null ? !slashDismissed && agentMatches.length > 0 : imageMention !== null ? !slashDismissed && imageMatches.length > 0 : (slashQuery !== null || argSuggestions !== null) && !slashDismissed && attachments.length === 0);

	function syncCaret() {
		caret = ta?.selectionStart ?? text.length;
	}

	/** Put `insert` in place of the mention at the caret, and keep typing after it. */
	function applyMention(m: Mention, insert: string, keepSpace = false) {
		const next = replaceMention(text, caret, m, insert, keepSpace);
		text = next.text;
		caret = next.caret;
		queueMicrotask(() => {
			ta?.focus();
			ta?.setSelectionRange(next.caret, next.caret);
			resize();
		});
	}
	/** Replace the @token with the chosen path. Folders keep the menu open so the user can keep drilling down. */
	function pickMention(index: number) {
		const file = mentionFiles[index];
		if (!file || !mention) return;
		if (!pickedPaths.includes(file.path)) pickedPaths.push(file.path);
		applyMention(mention, `@${file.path}${file.dir ? "" : " "}`, file.dir);
	}
	/** Replace the $token with the chosen sub-agent's name. */
	function pickAgent(index: number) {
		const agent = agentMatches[index];
		if (agent && agentMention) applyMention(agentMention, `$${agent.name} `);
	}
	/** Replace the #token with the chosen image's reference. */
	function pickImage(index: number) {
		const img = imageMatches[index];
		if (img && imageMention) applyMention(imageMention, `#image${img.n} `);
	}
	// Esc hides the menu only for the text it was pressed on; any further typing brings it back.
	$effect(() => {
		text;
		app.effectiveModel?.id;
		slashIndex = 0;
		slashDismissed = false;
	});

	async function runSlash(cmd: SlashCommand, arg: string) {
		if (cmd.argumentOptions && !arg.trim()) {
			setText(`${commandText(cmd)} `);
			return;
		}
		text = "";
		slashDismissed = false;
		try {
			await cmd.run(arg);
		} catch (e) {
			app.toast(t("{cmd} 실패: {error}", { cmd: commandText(cmd), error: e instanceof Error ? e.message : String(e) }), "error", pane.id);
		}
	}

	/** Menu pick: commands that take an argument are completed into the input; the rest run immediately. */
	function pickSlash(cmd: SlashCommand) {
		if (cmd.argumentOptions || (cmd.args && !cmd.args.startsWith("["))) {
			setText(`${commandText(cmd)} `);
			return;
		}
		void runSlash(cmd, "");
	}

	function pickRecommendation(index: number, completeOnly = false) {
		if (mention) return pickMention(index);
		if (agentMention) return pickAgent(index);
		if (imageMention) return pickImage(index);
		if (argSuggestions) {
			const option = argSuggestions.options[index];
			if (!option) return;
			if (completeOnly) {
				setText(`${commandText(argSuggestions.cmd)} ${option.value}`);
				// Completion must not cause the next Enter to select a different option.
				queueMicrotask(() => { slashDismissed = true; });
			} else void runSlash(argSuggestions.cmd, option.value);
			return;
		}
		const cmd = slashList[index];
		if (!cmd) return;
		if ("skill" in cmd) return void setText(`/${SKILL_PREFIX}${cmd.skill.name} `);
		if ("template" in cmd) return void setText(`/${TEMPLATE_PREFIX}${cmd.template.name} `);
		if (completeOnly) setText(`${commandText(cmd)}${cmd.args ? " " : ""}`);
		else pickSlash(cmd);
	}

	/** Never leak a mistyped command into a model request. Keep it in the input for correction. */
	function rejectUnknownCommand(): boolean {
		if (!isCommandInput(text)) return false;
		app.toast(t("알 수 없는 명령입니다. /를 입력해 목록을 확인하세요"), "error", pane.id);
		return true;
	}

	/**
	 * After a successful send, forget the input. Sending from a new chat creates a session and switches this pane to it
	 * mid-await, which stashes the just-sent text under the new-chat key; drop that or the next new chat shows it again.
	 */
	function clearSent(key: string | null) {
		drafts.delete(key ?? "");
		if (pane.id !== key) return; // already moved to the new session, whose input was restored empty
		text = "";
		attachments = [];
	}

	async function submit() {
		if (!canSend) return;
		const parsed = parseSlash(text);
		if (parsed) return void runSlash(parsed.cmd, parsed.arg);
		if (rejectUnknownCommand()) return;
		const filtered = await extensions.filterComposer(text);
		if ("cancel" in filtered) return void app.toast(filtered.cancel, "error", pane.id);
		const body = filtered.text;
		const imgs = attachments.map((a) => ({ type: "image" as const, data: a.data, mimeType: a.mimeType }));
		const key = pane.id;
		const ok = await app.send(body, imgs, pane.id);
		if (ok) clearSent(key);
	}

	const hasInput = $derived(text.trim().length > 0 || attachments.length > 0);

	/** While a run is active: deliver the input as `steer` (between tool calls) or `follow_up` (after the run). */
	async function during(kind: "steer" | "queue") {
		if (!hasInput || app.net !== "online" || compacting) return;
		const parsed = parseSlash(text);
		if (parsed) return void runSlash(parsed.cmd, parsed.arg);
		if (rejectUnknownCommand()) return;
		const filtered = await extensions.filterComposer(text);
		if ("cancel" in filtered) return void app.toast(filtered.cancel, "error", pane.id);
		const imgs = attachments.map((a) => ({ type: "image" as const, data: a.data, mimeType: a.mimeType }));
		const key = pane.id;
		const ok = await (kind === "steer" ? app.steer(filtered.text, imgs, pane.id) : app.queue(filtered.text, imgs, pane.id));
		if (ok) clearSent(key);
	}

	// ── Up/Down in the input walks back through the prompts already sent in this conversation ──
	const sentPrompts = $derived.by(() => {
		const out: string[] = [];
		for (const it of chat?.items ?? []) if (it.kind === "user" && it.text.trim() && out[out.length - 1] !== it.text) out.push(it.text);
		return out;
	});
	let histIndex = -1; // index into sentPrompts, -1 = not browsing
	let histShown = "";
	let histDraft = "";
	function showHistory(value: string) {
		histShown = value;
		text = value;
		queueMicrotask(() => { resize(); ta?.setSelectionRange(value.length, value.length); syncCaret(); });
	}
	/** Returns true when the key was used to move through the history. */
	function browseHistory(e: KeyboardEvent): boolean {
		if (e.shiftKey || e.altKey || e.ctrlKey || e.metaKey || composing || e.isComposing || !ta) return false;
		if (ta.selectionStart !== ta.selectionEnd) return false;
		if (histIndex >= 0 && text !== histShown) histIndex = -1; // edited since: start over from the newest
		if (e.key === "ArrowUp") {
			if (text.slice(0, ta.selectionStart).includes("\n")) return false; // still lines above the caret
			const next = histIndex < 0 ? sentPrompts.length - 1 : histIndex - 1;
			if (next < 0) return histIndex >= 0; // already at the oldest
			if (histIndex < 0) histDraft = text;
			histIndex = next;
			showHistory(sentPrompts[next]!);
			return true;
		}
		if (e.key === "ArrowDown" && histIndex >= 0) {
			if (text.slice(ta.selectionEnd).includes("\n")) return false;
			histIndex++;
			if (histIndex >= sentPrompts.length) {
				histIndex = -1;
				showHistory(histDraft);
			} else showHistory(sentPrompts[histIndex]!);
			return true;
		}
		return false;
	}

	function onKey(e: KeyboardEvent) {
		if (slashOpen && !composing && !e.isComposing) {
			const n = menuItems.length;
			if (e.key === "ArrowDown" || e.key === "ArrowUp") {
				if (n) {
					e.preventDefault();
					slashIndex = (slashIndex + (e.key === "ArrowDown" ? 1 : -1) + n) % n;
				}
				return;
			}
			if (e.key === "Escape") {
				e.preventDefault();
				slashDismissed = true;
				return;
			}
			if (e.key === "Tab" && n) {
				e.preventDefault();
				pickRecommendation(slashIndex, true);
				return;
			}
			if (e.key === "Enter" && !e.shiftKey && n && !isTouch()) {
				e.preventDefault();
				pickRecommendation(slashIndex);
				return;
			}
		}
		if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !slashOpen && browseHistory(e)) {
			e.preventDefault();
			return;
		}
		if (e.key !== "Enter" || e.shiftKey || composing || e.isComposing) return;
		// Phones: Enter inserts a newline, the buttons send. Desktop: Enter sends.
		if (isTouch()) return;
		e.preventDefault();
		// Commands run locally even mid-run (/stop, ...).
		const parsed = parseSlash(text);
		if (parsed) return void runSlash(parsed.cmd, parsed.arg);
		if (rejectUnknownCommand()) return;
		// Mid-run: Enter steers, Alt/Ctrl+Enter queues for afterwards.
		if (running) void during(e.altKey || e.ctrlKey || e.metaKey ? "queue" : "steer");
		else void submit();
	}

	/** `#image1`-style reserved words refer to attachments by position (1-based). */
	const IMG_TOKEN = /#image(\d+)\b/g;
	/** Paths picked from the @ menu; only these (exact) tokens get highlighted. */
	let pickedPaths = $state<string[]>([]);
	const highlighted = $derived(mirrorHtml(text, { templates: templateList, skills: skillList, agents: agentList, images: attachments.length, paths: pickedPaths }));

	function insertImageToken(n: number) {
		const next = insertToken(text, ta?.selectionStart ?? text.length, `#image${n}`);
		text = next.text;
		queueMicrotask(() => { ta?.setSelectionRange(next.caret, next.caret); syncCaret(); });
	}

	function removeAttachment(id: string) {
		const i = attachments.findIndex((x) => x.id === id);
		if (i < 0) return;
		const gone = i + 1;
		text = text
			.replace(new RegExp(`[ \\t]?#image${gone}\\b`, "g"), "")
			.replace(IMG_TOKEN, (m, n) => (Number(n) > gone ? `#image${Number(n) - 1}` : m));
		attachments = attachments.filter((x) => x.id !== id);
	}

	async function addFiles(files: Iterable<File>) {
		for (const f of files) {
			if (!f.type.startsWith("image/")) continue;
			if (attachments.length >= 8) {
				app.toast(t("이미지는 최대 8장까지 첨부할 수 있습니다"), "error", pane.id);
				break;
			}
			try {
				attachments.push(await fileToAttachment(f));
				insertImageToken(attachments.length);
			} catch {
				app.toast(t("{name}를 읽지 못했습니다", { name: f.name || t("이미지") }), "error", pane.id);
			}
		}
	}

	function onPaste(e: ClipboardEvent) {
		const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith("image/"));
		if (files.length) {
			e.preventDefault();
			void addFiles(files);
		}
	}

	function onDrop(e: DragEvent) {
		if (!pane.focused) return;
		e.preventDefault();
		dragging = false;
		if (e.dataTransfer?.files) void addFiles(e.dataTransfer.files);
	}
</script>

<svelte:window
	ondragover={(e) => {
		if (pane.focused && e.dataTransfer?.types.includes("Files")) {
			e.preventDefault();
			dragging = true;
		}
	}}
	ondragleave={(e) => {
		if (!e.relatedTarget) dragging = false;
	}}
	ondrop={onDrop}
/>

{#if dragging}
	<div class="drop" in:fadeIn out:fadeOut>{t("이미지를 놓아서 첨부")}</div>
{/if}

<div class="wrap" bind:this={wrapEl}>
	{#if !pane.id && app.net === "online"}
		<button class="where mono" onclick={() => (app.dirPicker = true)} title={t("새 대화가 작업할 디렉터리 (눌러서 바꾸기)")} aria-label={t("작업 디렉터리: {path}", { path: app.workdirAbs })}>
			<Icon name="folder" />
			<span class="p">{app.workdirAbs || t("서버 기본 디렉터리")}</span>
			<span class="chg">{t("변경")}</span>
		</button>
	{/if}
	<div class="extension-widgets"><ExtensionPanels placement="composer" /></div>
	<div class="box" class:glow-working={running} class:disabled={app.net !== "online"} data-level={running && app.effectiveModelOf(pane.id)?.reasoning ? app.effectiveOf(pane.id).thinkingLevel : undefined}>
		{#if slashOpen}
			<SlashMenu items={menuItems} index={slashIndex} label={mention ? msg("파일") : agentMention ? msg("서브에이전트") : imageMention ? msg("이미지") : argSuggestions ? t("{cmd} 값 선택", { cmd: commandText(argSuggestions.cmd) }) : msg("명령")} empty={mention ? msg("일치하는 파일이 없습니다") : agentMention ? msg("일치하는 서브에이전트가 없습니다") : argSuggestions?.empty} onpick={pickRecommendation} onhover={(i) => (slashIndex = i)} />
		{/if}
		{#if attachments.length}
			<AttachmentStrip {attachments} onremove={removeAttachment} />
		{/if}

		{#if chat?.queued.length}
			<QueuedList queued={chat.queued} oncancel={(q) => app.cancelQueued(q, pane.id)} />
		{/if}

		<div class="field-wrap">
		{#if promptHint}
			<div class="prompt-hint" aria-hidden="true" title={promptHint}>{promptHint}</div>
		{/if}
		<div class="mirror" bind:this={mirror} aria-hidden="true">{@html highlighted}</div>
		<textarea
			bind:this={ta}
			onscroll={() => { if (mirror && ta) mirror.scrollTop = ta.scrollTop; }}
			data-composer
			bind:value={text}
			onkeydown={onKey}
			oninput={syncCaret}
			onkeyup={(e) => { if (!["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(e.key)) syncCaret(); }}
			onclick={syncCaret}
			onfocus={syncCaret}
			onpaste={onPaste}
			oncompositionstart={() => (composing = true)}
			oncompositionend={() => (composing = false)}
			rows="1"
			placeholder={promptHint ? "" : compacting ? t("컨텍스트 압축 중 · 메시지는 완료 후 보낼 수 있습니다") : running ? t("작업 중 · Enter 끼워 넣기 / Alt+Enter 대기열 · / 명령") : t("에이전트에게 메시지 보내기 · / 명령")}
			aria-label={running ? t("작업 중 · Enter 끼워 넣기 / Alt+Enter 대기열 · / 명령") : t("에이전트에게 메시지 보내기 · / 명령")}
			enterkeyhint="send"
			autocapitalize="sentences"
			spellcheck="false"
		></textarea>
</div>

		<div class="bar">
			<button class="iconbtn" onclick={() => fileInput?.click()} disabled={!vision} aria-label={t("이미지 첨부")} title={vision ? t("이미지 첨부") : t("이 모델은 이미지를 지원하지 않습니다")}>
				<Icon name="image" />
			</button>
			<input bind:this={fileInput} type="file" accept="image/*" multiple hidden onchange={(e) => { const picked = [...(e.currentTarget.files ?? [])]; e.currentTarget.value = ""; void addFiles(picked); }} />

			<ModelPicker />
			<span class="grow"></span>

			{#if compacting}
				<span class="compacting" role="status"><span class="spinner"></span> {t("압축 중")}</span>
				<button class="send stop" onclick={() => app.abort(pane.id)} disabled={app.net !== "online"} aria-label={t("압축 취소")} title={t("컨텍스트 압축 취소")}><Icon name="stop" /></button>
			{:else if running}
				<button class="mode" onclick={() => during("queue")} disabled={!hasInput} title={t("현재 작업이 모두 끝난 뒤 실행 (Alt+Enter)")}>
					<Icon name="list" /><span>{t("대기열")}</span><kbd>⌥↵</kbd>
				</button>
				<button class="mode primary" onclick={() => during("steer")} disabled={!hasInput} title={t("진행 중인 작업에 바로 끼워 넣기: 실행 중인 도구가 끝나면 다음 모델 호출 전에 전달됩니다 (Enter)")}>
					<Icon name="bolt" /><span>{t("끼워 넣기")}</span><kbd>↵</kbd>
				</button>
				<button class="send stop" onclick={() => app.abort(pane.id)} aria-label={t("중지")} title={t("작업 중지")}><Icon name="stop" /></button>
			{:else}
				<button class="send" class:on={canSend} onclick={submit} disabled={!canSend} aria-label={t("보내기")}>
					{#if app.sending}<span class="spinner"></span>{:else}<Icon name="send" />{/if}
				</button>
			{/if}
		</div>
	</div>
	{#if extensions.actions.length}
		<div class="extension-actions" aria-label={t("확장 액션")}>
			{#each extensions.actions as action (`${action.owner}:${action.id}`)}
				<button title={action.owner} onclick={() => action.run().catch(e => app.toast(t("확장 실패: {error}", { error: e instanceof Error ? e.message : String(e) }), "error", pane.id))}>{action.label}</button>
			{/each}
		</div>
	{/if}
	<StatusLine />
</div>

<style>
	.extension-widgets { max-height: min(40dvh, 320px); overflow-y: auto; overscroll-behavior: contain; }
	.extension-widgets:not(:empty) { margin-bottom: 8px; }
	.extension-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
	.extension-actions button { padding: 4px 10px; border: 1px solid var(--border); border-radius: var(--radius-sm); color: var(--text-dim); font-size: var(--fs-xs); }
	.wrap {
		padding: 0 16px calc(12px + var(--sab));
		max-width: calc(var(--content-w) + 32px);
		width: 100%;
		margin: 0 auto;
	}
	.where {
		display: flex;
		align-items: center;
		gap: 7px;
		max-width: 100%;
		height: 28px;
		margin: 0 0 8px 2px;
		padding: 0 10px 0 8px;
		font-size: var(--fs-xs);
		color: var(--text-dim);
		background: var(--bg-elev);
		border: 1px solid var(--border);
		border-radius: var(--radius-pill);
		transition:
			border-color var(--motion-fast) var(--ease-std),
			color var(--motion-fast) var(--ease-std);
	}
	.where:hover {
		color: var(--text);
		border-color: var(--border-strong);
	}
	.where :global(svg) {
		width: 14px;
		height: 14px;
		flex: none;
		stroke: currentColor;
		fill: none;
		stroke-width: 1.8;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	.where .p {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		text-align: left;
	}
	.where .chg {
		flex: none;
		color: var(--text-faint);
	}
	.box {
		position: relative;
		border: 1px solid var(--border-strong);
		border-radius: 22px;
		background: color-mix(in srgb, var(--bg-elev) 92%, transparent);
		-webkit-backdrop-filter: blur(14px) saturate(135%);
		backdrop-filter: blur(14px) saturate(135%);
		transition:
			border-color var(--motion-fast) var(--ease-std),
			box-shadow var(--motion-fast) var(--ease-std),
			opacity var(--motion-fast) var(--ease-std);
		box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
	}
	.box:focus-within {
		border-color: var(--text-faint);
		box-shadow: 0 0 0 3px var(--accent-soft);
	}
	.box.disabled {
		opacity: 0.6;
	}
	textarea {
		display: block;
		width: 100%;
		resize: none;
		border: 0;
		outline: 0;
		background: transparent;
		padding: 14px 18px 4px;
		font-size: var(--fs-lg);
		line-height: 1.5;
		max-height: 220px;
		min-height: 28px;
	}
	textarea {
		position: relative;
		z-index: 1;
	}
	/* highlight layer behind the transparent textarea: same metrics, only `#imageN` tokens are tinted */
	.mirror {
		position: absolute;
		inset: 0;
		padding: 14px 18px 4px;
		font-size: var(--fs-lg);
		line-height: 1.5;
		white-space: pre-wrap;
		overflow-wrap: break-word;
		overflow-y: auto;
		color: transparent;
		pointer-events: none;
	}
	/* mention tags: # (images) violet, @ (files) mint, sub-agents amber; the hues come from the theme (app.css) */
	.mirror :global(mark) {
		color: transparent;
		border-radius: var(--radius-xs);
	}
	.mirror :global(mark.img) {
		background: color-mix(in srgb, var(--mark-img) 32%, transparent);
		box-shadow: 0 0 0 1px color-mix(in srgb, var(--mark-img) 55%, transparent);
	}
	.mirror :global(mark.file) {
		background: color-mix(in srgb, var(--mark-file) 30%, transparent);
		box-shadow: 0 0 0 1px color-mix(in srgb, var(--mark-file) 55%, transparent);
	}
	.mirror :global(mark.skill) {
		background: color-mix(in srgb, var(--accent) 22%, transparent);
		box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 50%, transparent);
	}
	.mirror :global(mark.agent) {
		background: color-mix(in srgb, var(--mark-agent) 30%, transparent);
		box-shadow: 0 0 0 1px color-mix(in srgb, var(--mark-agent) 55%, transparent);
	}
	textarea::placeholder {
		color: var(--text-faint);
	}
	.field-wrap {
		position: relative;
	}
	/* mirrors the textarea's first line so it reads as a placeholder */
	.prompt-hint {
		position: absolute;
		top: 14px;
		left: 18px;
		right: 18px;
		font-size: var(--fs-lg);
		line-height: 1.5;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		pointer-events: none;
	}
	.prompt-hint {
		color: var(--text-faint);
	}
	/* working: the hint stays plain grey; the box takes the shared .glow-working outline (app.css) */
	.box.glow-working {
		--glow-base: var(--border-strong);
	}
	.bar {
		display: flex;
		align-items: center;
		gap: 4px;
		padding: 4px 8px 8px;
	}
	.grow {
		flex: 1;
	}
	.send {
		display: grid;
		place-items: center;
		width: 38px;
		height: 38px;
		border-radius: 50%;
		background: var(--bg-active);
		color: var(--text-faint);
		transition:
			background var(--motion-fast) var(--ease-std),
			color var(--motion-fast) var(--ease-std),
			transform var(--motion-fast) var(--ease);
		flex: none;
	}
	.send.on {
		background: var(--accent);
		color: var(--accent-fg);
	}
	.send:active:not(:disabled) {
		transform: scale(0.9);
	}
	.send.stop {
		background: var(--text);
		color: var(--bg);
	}
	.send :global(svg) {
		width: 19px;
		height: 19px;
		stroke: currentColor;
		fill: none;
		stroke-width: 2.1;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	.send.stop :global(svg) {
		fill: currentColor;
		stroke-width: 1;
	}
	.compacting {
		display: inline-flex;
		align-items: center;
		gap: 7px;
		padding: 0 8px;
		font-size: var(--fs-xs);
		color: var(--text-dim);
	}
	.mode {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		height: 34px;
		padding: 0 10px;
		margin-right: 4px;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-pill);
		color: var(--text-dim);
		font-size: var(--fs-sm);
		font-weight: 500;
		white-space: nowrap;
		flex: none;
		transition:
			background var(--motion-fast) var(--ease-std),
			color var(--motion-fast) var(--ease-std);
	}
	.mode:hover:not(:disabled) {
		background: var(--bg-active);
		color: var(--text);
	}
	.mode:disabled {
		opacity: 0.4;
	}
	.mode.primary {
		background: var(--accent);
		border-color: var(--accent);
		color: var(--accent-fg);
	}
	.mode.primary:hover:not(:disabled) {
		background: var(--accent-hover);
		color: var(--accent-fg);
	}
	.mode :global(svg) {
		width: 14px;
		height: 14px;
		stroke: currentColor;
		fill: none;
		stroke-width: 2;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	kbd {
		font-family: var(--mono);
		font-size: var(--fs-2xs);
		opacity: 0.6;
	}
	@media (max-width: 640px), (pointer: coarse) {
		kbd {
			display: none;
		}
		/* One row cannot hold the model picker, two labelled buttons and stop: keep the buttons icon-only so none is squashed */
		.mode {
			width: 36px;
			height: 36px;
			padding: 0;
			margin-right: 0;
			justify-content: center;
			border-radius: 50%;
		}
		.mode span {
			display: none;
		}
		.mode :global(svg) {
			width: 17px;
			height: 17px;
		}
	}
	.drop {
		position: fixed;
		inset: 0;
		z-index: var(--z-dropzone);
		display: grid;
		place-items: center;
		background: var(--scrim);
		color: #fff; /* sits on the dark scrim in both themes */
		font-size: var(--fs-2xl);
		font-weight: 600;
		border: 3px dashed var(--text-faint);
		pointer-events: none;
	}
</style>
