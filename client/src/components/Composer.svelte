<script lang="ts" module>
	import type { Attachment as DraftAttachment } from "../lib/images";
	/** Unsent input per session ("" = new chat); outlives the component so switching sessions keeps what was typed. */
	import type { FileDraft } from "../lib/files";
	const drafts = new Map<string, { text: string; attachments: DraftAttachment[]; files: FileDraft[]; reply: { text: string; who?: string } | null }>();
</script>

<script lang="ts">
	import { untrack } from "svelte";
	import { abortable } from "../lib/abortable";
	import { DebouncedList } from "../lib/debounced-list.svelte";
	import { newHistory, stepHistory } from "../lib/prompt-history";
	import { fileRows, folderRows, memberRows, menuKey, menuKindOf, menuOpen, optionRows, slashRows } from "../lib/slash-menu";
	import { dropImageToken, insertToken, mentionAt, mirrorHtml, replaceMention, type Mention } from "../lib/composer-text";
	import IconButton from "./IconButton.svelte";
	import ModelPicker from "./ModelPicker.svelte";
	import SendControls from "./SendControls.svelte";
	import AttachmentStrip from "./AttachmentStrip.svelte";
	import QueuedList from "./QueuedList.svelte";
	import StatusLine from "./StatusLine.svelte";
	import ExtensionPanels from "./extensions/ExtensionPanels.svelte";
	import SlashMenu from "./SlashMenu.svelte";
	import { cdArgOf, cdCompletion, cdHint, cdRowsOf, cdTab } from "../lib/workdir-path";
	import { allCommands, argumentSuggestions, commandQuery, commandText, isCommandInput, matchCommands, matchFamilyEntries, matchSkills, parseSlash, SKILL_PREFIX, type SlashCommand } from "../lib/commands";
	import { app } from "../lib/store.svelte";
	import { getPane } from "../lib/pane";
	import { extensions } from "../lib/extensions/host.svelte";
	import { fileToAttachment, type Attachment } from "../lib/images";
	import { makeQuote } from "../lib/quote";
	import { fileRejection, fileToDraft, isInlineImage, MAX_FILE_BYTES, MAX_FILES, MAX_FILES_TOTAL, MAX_IMAGES } from "../lib/files";
	import DropOverlay from "./DropOverlay.svelte";
	import WhereChip from "./WhereChip.svelte";
	import ReplyBadge from "./ReplyBadge.svelte";
	import FileStrip from "./FileStrip.svelte";
	import { isTouch } from "../lib/format";
	import { buildCombo, formatCombo, keyName } from "../lib/keys";
	import { msg, t } from "../lib/i18n";

	const pane = getPane();
	const chat = $derived(app.chatOf(pane.id));
	/** A new chat is a real, still empty session (outside a group); its folder can be changed until the first message. */
	const freshSession = $derived(!!pane.id && !app.groupOf(pane.id) && !!chat?.ready && !chat.loadError && chat.items.length === 0);
	const whereShown = $derived(!pane.id || freshSession);
	const wherePath = $derived(pane.id ? (app.session(pane.id)?.cwd ?? app.workdirAbs) : app.workdirAbs);

	// Unsent input survives switching to another session and back (kept per session, in memory; "" = new chat).
	let text = $state("");
	let ta: HTMLTextAreaElement | undefined = $state();
	let mirror: HTMLDivElement | undefined = $state();
	let fileInput: HTMLInputElement | undefined = $state();
	let wrapEl: HTMLDivElement | undefined = $state();
	let attachments = $state<Attachment[]>([]);
	/** Non-image files (and images a text-only model cannot see): sent as-is, saved in the working directory */
	let files = $state<FileDraft[]>([]);
	/** Message being answered: shown as a badge above the input, quoted into the prompt on send (never pasted into the text). */
	let reply = $state<{ text: string; who?: string } | null>(null);
	const replyPreview = $derived(reply ? reply.text.replace(/\s+/g, " ").trim() : "");
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
	const canSend = $derived((text.trim().length > 0 || attachments.length > 0 || files.length > 0) && (app.net === "online" || parseSlash(text) !== null) && !app.sending);

	export function focus() {
		ta?.focus();
	}
	export function setText(t: string) {
		text = t;
				ta?.focus();
	}

	// The textarea's height is not measured in JS: the mirror layer shares its grid cell and sizes it (see .field-wrap).
	// Collapsing the textarea to `auto` on every keystroke shrank the composer for a moment, which made the message list
	// grow, clamp its scrollTop and jump (the flicker while typing long input).

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
		if (text || attachments.length || files.length || reply) drafts.set(k, { text, attachments, files, reply });
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
			files = d?.files ?? [];
			reply = d?.reply ?? null;
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

	// The Reply button on a message hands it over once.
	$effect(() => {
		const r = app.replyTo;
		if (r === null || !pane.focused) return;
		app.replyTo = null;
		reply = r;
		ta?.focus();
	});

	// ── commands and finite arguments share the recommendation menu above the input ──
	let slashIndex = $state(0);
	let slashDismissed = $state(false);
	const slashQuery = $derived(commandQuery(text));
	const commandList = $derived(slashQuery !== null ? matchCommands(slashQuery) : []);
	// Skills sit in the same menu after the commands, as `/skill:name`, tagged so they are not mistaken for commands.
	let skillList = $state<{ name: string; description: string }[]>([]);
	const skillMatches = $derived(slashQuery !== null ? matchSkills(skillList, slashQuery) : []);
	// Commands server extensions find at run time (`/prefix:name`, e.g. prompt files) follow the skills.
	type FamilyEntry = { prefix: string; label: string; name: string; description: string; args?: string };
	let familyList = $state<FamilyEntry[]>([]);
	const familyMatches = $derived(slashQuery !== null ? matchFamilyEntries(familyList, slashQuery) : []);
	const slashList = $derived<(SlashCommand | { skill: { name: string; description: string } } | { family: FamilyEntry })[]>([
		...commandList,
		...skillMatches.map((skill) => ({ skill })),
		...familyMatches.map((family) => ({ family })),
	]);
	const skillsWanted = $derived(slashQuery !== null || text.includes(`/${SKILL_PREFIX}`));
	const skillsCwd = $derived((pane.id ? app.session(pane.id)?.cwd : null) || app.workdirAbs);
	$effect(() => {
		const api = app.api;
		const cwd = skillsCwd;
		app.skillsTick;
		app.serverExtensionsTick;
		if (!(slashQuery !== null || /(^|\s)\/[a-z][a-z0-9-]*:/.test(text)) || !api || app.net !== "online") return;
		return abortable((signal) => api.commandFamilies(cwd, signal), {
			ok: (r) => (familyList = r.families.flatMap((f) => f.entries.map((e) => ({ prefix: f.prefix, label: f.label ?? f.prefix, name: e.name, description: e.description ?? "", ...(e.args ? { args: e.args } : {}) })))),
			fail: () => (familyList = []),
		});
	});
	$effect(() => {
		const api = app.api;
		const cwd = skillsCwd;
		app.skillsTick;
		if (!skillsWanted || !api || app.net !== "online") return;
		return abortable((signal) => api.skills(cwd, signal, pane.id), {
			ok: (r) => (skillList = r.skills.filter((k) => k.enabled).map((k) => ({ name: k.name, description: k.description }))),
			fail: () => (skillList = []),
		});
	});
	const argSuggestions = $derived(argumentSuggestions(text));

	// ── #file mentions (and #imageN): the token right before the caret, e.g. "look at #src/comp" ──
	let caret = $state(0);
	/** Files under the folder for the `#` token being typed, listed after a short pause */
	const fileList = new DebouncedList<{ cwd: string; q: string }, { path: string; dir: boolean }>();
	const mentionFiles = $derived(fileList.rows);
	const mentionLoaded = $derived(fileList.loaded);
	// ── /cd <path>: folders of the typed path are suggested above the input (`~`, absolute and workspace-relative) ──
	const cdArg = $derived(slashQuery === null ? cdArgOf(text) : null);
	const cdTarget = $derived(cdArg === null ? null : cdHint(cdArg, { root: app.workspace?.root, home: app.workspace?.home }));
	/** Folders of the typed `/cd` path, listed after a short pause; `for` is the folder they belong to. */
	const cdList = new DebouncedList<{ dir: string; hidden: boolean }, { name: string; path: string }>();
	/** The arrow keys moved the highlight: Enter then goes to that folder instead of the typed path */
	let cdNav = $state(false);
	// Only the folder and whether dot-folders are wanted start a new listing: typing a name just filters the rows.
	const cdDir = $derived(cdTarget?.dir ?? null);
	const cdHidden = $derived(!!cdTarget?.filter.startsWith("."));
	$effect(() => {
		const dir = cdDir;
		const hidden = cdHidden;
		const api = app.api;
		return cdList.follow(dir === null ? null : { dir, hidden }, api && app.net === "online" ? async (q, signal) => (await api.listDirs(q.dir, q.hidden, signal)).entries : null);
	});
	const cdRows = $derived(cdRowsOf(cdTarget, cdList.rows, cdList.for?.dir ?? null));
	const cdValue = (name: string) => cdCompletion(cdTarget, name);
	const mention = $derived(slashQuery !== null || argSuggestions || cdArg !== null ? null : mentionAt("file", text, caret));
	// Attached images share the `#` menu, above the files: "compare #image1 and #image2". A fully typed token is done, so Enter stays free to send.
	const imageMatches = $derived(
		mention
			? attachments.map((a, i) => ({ n: i + 1, name: a.name })).filter((a) => `image${a.n}`.startsWith(mention.query.toLowerCase()) && `image${a.n}` !== mention.query)
			: [],
	);

	// ── @mentions: the list comes from extensions (`sdk.mentions.set`); the core knows no names ──
	const mentionItems = $derived(extensions.mentions().filter((m) => !m.except || m.except !== pane.id));
	const memberMention = $derived(slashQuery !== null || argSuggestions || mention ? null : mentionAt("member", text, caret));
	const memberMatches = $derived(memberMention ? mentionItems.filter((m) => {
		const q = memberMention.query.toLowerCase();
		return m.insert.slice(1).toLowerCase().startsWith(q) || m.keywords.toLowerCase().includes(q);
	}) : []);

	const mentionCwd = $derived((pane.id ? app.session(pane.id)?.cwd : null) || app.workdirAbs);
	$effect(() => {
		const q = mention?.query;
		const cwd = mentionCwd;
		const api = app.api;
		return fileList.follow(q === undefined ? null : { cwd, q }, api && app.net === "online" ? async (k, signal) => (await api.listFiles(k.cwd, k.q, signal)).entries : null);
	});

	/** Which of the four kinds of typing owns the menu, and whether it shows (see lib/slash-menu). */
	const menuKind = $derived(menuKindOf({ slashQuery, hasArgSuggestions: argSuggestions !== null, cdArg, fileMention: mention !== null, memberMention: memberMention !== null }));
	const slashOpen = $derived(menuOpen(menuKind, { dismissed: slashDismissed, cdRows: cdRows.length, fileLoaded: mentionLoaded, files: mentionFiles.length, images: imageMatches.length, members: memberMatches.length, attachments: attachments.length }));

	/** Menu rows carry a `group` so the menu can draw a divider and a heading wherever it changes. */
	const menuItems = $derived(
		menuKind === "cd"
			? folderRows(cdRows, cdValue)
			: menuKind === "file"
				? fileRows(imageMatches, mentionFiles)
				: menuKind === "member"
					? memberRows(memberMatches)
					: argSuggestions
						? optionRows(argSuggestions.options)
						: slashRows(slashList.map((it) => ("skill" in it || "family" in it ? it : { command: it }))),
	);

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
		});
	}
	/** Replace the #token with the chosen image or path. Folders keep the menu open so the user can keep drilling down. */
	function pickMention(index: number) {
		if (!mention) return;
		if (index < imageMatches.length) return applyMention(mention, `#image${imageMatches[index]!.n} `);
		const file = mentionFiles[index - imageMatches.length];
		if (!file) return;
		if (!pickedPaths.includes(file.path)) pickedPaths.push(file.path);
		applyMention(mention, `#${file.path}${file.dir ? "" : " "}`, file.dir);
	}
	/** Replace the @token with the chosen group member. */
	function pickMember(index: number) {
		const m = memberMatches[index];
		if (m && memberMention) applyMention(memberMention, `${m.insert} `);
	}
	// Esc hides the menu only for the text it was pressed on; any further typing brings it back.
	$effect(() => {
		text;
		app.effectiveModel?.id;
		slashIndex = 0;
		cdNav = false;
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

	/** Put a folder into the `/cd` argument. The menu stays open on it, so the next level is one keystroke away. */
	function completeCd(index: number) {
		const d = cdRows[index];
		if (d) setText(`/cd ${cdValue(d.name)}`);
	}

	/** Tab: the highlighted folder, else like a shell: the only match, or the longest common start of them. */
	function tabCd() {
		const step = cdTab(cdTarget, cdRows.map((d) => d.name), cdNav);
		if (step.do === "text") setText(`/cd ${step.text}`);
		else if (step.do === "row") completeCd(slashIndex);
	}

	/** Enter: go to the folder picked with the arrows. Otherwise the typed path is used as written (it may be a new folder). */
	function enterCd(): boolean {
		const d = cdNav ? cdRows[slashIndex] : undefined;
		if (!cdTarget || !d) return false;
		void runSlash(allCommands().find((c) => c.name === "cd")!, `${cdTarget.prefix}${d.name}`);
		return true;
	}

	function pickRecommendation(index: number, completeOnly = false) {
		if (cdArg !== null) return completeCd(index);
		if (mention) return pickMention(index);
		if (memberMention) return pickMember(index);
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
		if ("family" in cmd) return void setText(`/${cmd.family.prefix}:${cmd.family.name} `);
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
		reply = null;
		releaseFiles(files);
		files = [];
	}

	function releaseFiles(list: FileDraft[]) {
		for (const f of list) if (f.preview) URL.revokeObjectURL(f.preview);
	}

	/**
	 * Turn the input into what goes to the server, or handle it here: a slash command runs, an unknown one is refused,
	 * and an extension may veto or rewrite the text. Returns null when there is nothing to send.
	 */
	async function prepare() {
		const parsed = parseSlash(text);
		if (parsed) return void runSlash(parsed.cmd, parsed.arg), null;
		if (rejectUnknownCommand()) return null;
		const filtered = await extensions.filterComposer(text);
		if ("cancel" in filtered) return void app.toast(filtered.cancel, "error", pane.id), null;
		return {
			key: pane.id,
			body: (reply ? makeQuote(reply.text, reply.who) : "") + filtered.text,
			images: attachments.map((a) => ({ type: "image" as const, data: a.data, mimeType: a.mimeType })),
		};
	}

	async function submit() {
		if (!canSend) return;
		const out = await prepare();
		if (out && (await app.send(out.body, out.images, pane.id, files))) clearSent(out.key);
	}

	const hasInput = $derived(text.trim().length > 0 || attachments.length > 0 || files.length > 0);

	/** While a run is active: deliver the input as `steer` (between tool calls) or `follow_up` (after the run). */
	async function during(kind: "steer" | "queue") {
		if (!hasInput || app.net !== "online") return;
		const out = await prepare();
		if (!out) return;
		const ok = await (kind === "steer" ? app.steer(out.body, out.images, pane.id, files) : app.queue(out.body, out.images, pane.id, files));
		if (ok) clearSent(out.key);
	}

	let lastQueueTick = app.queueSendTick;
	$effect(() => {
		const tick = app.queueSendTick;
		if (tick === lastQueueTick) return;
		lastQueueTick = tick;
		if (pane.focused && running) void untrack(() => during("queue"));
	});
	const queueKey = $derived(formatCombo(app.prefs.bindings.queueMessage ?? ""));
	const runningHint = $derived(queueKey ? t("작업 중 · Enter 끼워 넣기 / {key} 대기열 · / 명령", { key: queueKey }) : t("작업 중 · Enter 끼워 넣기 · / 명령"));

	// ── Up/Down in the input walks back through the prompts already sent in this conversation ──
	const sentPrompts = $derived.by(() => {
		const out: string[] = [];
		for (const it of chat?.items ?? []) if (it.kind === "user" && it.text.trim() && out[out.length - 1] !== it.text) out.push(it.text);
		return out;
	});
	const history = newHistory();
	/** Returns true when the key was used to move through the history. */
	function browseHistory(e: KeyboardEvent): boolean {
		if (e.shiftKey || e.altKey || e.ctrlKey || e.metaKey || composing || e.isComposing || !ta) return false;
		if (ta.selectionStart !== ta.selectionEnd || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return false;
		const step = stepHistory(history, e.key, text, text.slice(0, ta.selectionStart), text.slice(ta.selectionEnd), sentPrompts);
		if (step.used && step.text !== undefined) {
			const value = step.text;
			text = value;
			queueMicrotask(() => { ta?.setSelectionRange(value.length, value.length); syncCaret(); });
		}
		return step.used;
	}

	function onKey(e: KeyboardEvent) {
		if (slashOpen && !composing && !e.isComposing) {
			const act = menuKey(e.key, { index: slashIndex, count: menuItems.length, kind: menuKind, shift: e.shiftKey, touch: isTouch() });
			if (act?.do === "move") {
				e.preventDefault();
				slashIndex = act.to;
				if (menuKind === "cd") cdNav = true;
				return;
			}
			if (act?.do === "dismiss") {
				e.preventDefault();
				slashDismissed = true;
				return;
			}
			if (act?.do === "complete") {
				e.preventDefault();
				if (menuKind === "cd") tabCd();
				else pickRecommendation(slashIndex, true);
				return;
			}
			if (act?.do === "enter-folder") {
				// Only a folder chosen with the arrows is entered; otherwise the typed path is used as written, so fall through.
				if (enterCd()) e.preventDefault();
			} else if (act?.do === "pick") {
				e.preventDefault();
				pickRecommendation(slashIndex);
				return;
			}
			// An arrow key with no rows to move through is not the menu's: it falls through to the input.
			if (!act && (e.key === "ArrowDown" || e.key === "ArrowUp")) return;
		}
		if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !slashOpen && browseHistory(e)) {
			e.preventDefault();
			return;
		}
		if (e.key !== "Enter" || composing || e.isComposing) return;
		// Phones: Enter inserts a newline, the buttons send. Desktop: Enter sends.
		if (isTouch()) return;
		const combo = buildCombo({ mod: e.ctrlKey || e.metaKey, alt: e.altKey, shift: e.shiftKey }, [keyName(e.code)]);
		// Mid-run: plain Enter always steers; the user's queue shortcut (Alt+Enter by default) queues for afterwards.
		if (running && combo !== "Enter" && combo === app.prefs.bindings.queueMessage) {
			e.preventDefault();
			void during("queue");
			return;
		}
		if (e.shiftKey) return;
		e.preventDefault();
		// Commands run locally even mid-run (/stop, ...).
		const parsed = parseSlash(text);
		if (parsed) return void runSlash(parsed.cmd, parsed.arg);
		if (rejectUnknownCommand()) return;
		if (running) void during("steer");
		else void submit();
	}

	/** Paths picked from the # menu; only these (exact) tokens get highlighted. */
	let pickedPaths = $state<string[]>([]);
	const highlighted = $derived(mirrorHtml(text, { commands: familyList.map((f) => `${f.prefix}:${f.name}`), skills: skillList, mentions: mentionItems.map((m) => m.insert.slice(1)), images: attachments.length, paths: pickedPaths }));

	function insertImageToken(n: number) {
		const next = insertToken(text, ta?.selectionStart ?? text.length, `#image${n}`);
		text = next.text;
		queueMicrotask(() => { ta?.setSelectionRange(next.caret, next.caret); syncCaret(); });
	}

	function removeAttachment(id: string) {
		const i = attachments.findIndex((x) => x.id === id);
		if (i < 0) return;
		const gone = i + 1;
		text = dropImageToken(text, gone);
		attachments = attachments.filter((x) => x.id !== id);
	}

	const rejectionText = (r: "count" | "size" | "total", name: string) =>
		r === "count"
			? t("파일은 최대 {n}개까지 첨부할 수 있습니다", { n: MAX_FILES })
			: r === "size"
				? t("{name}: 파일은 {n}MB까지 첨부할 수 있습니다", { name, n: MAX_FILE_BYTES / 1024 / 1024 })
				: t("한 메시지에 첨부할 수 있는 파일은 모두 합쳐 {n}MB까지입니다", { n: MAX_FILES_TOTAL / 1024 / 1024 });

	/** Pictures the model can see go in as images (downscaled); everything else is attached as a file. */
	async function addFiles(picked: Iterable<File>) {
		const fail = (name: string, fallback: string) => app.toast(t("{name}을(를) 읽지 못했습니다", { name: name || fallback }), "error", pane.id);
		for (const f of picked) {
			if (isInlineImage(f, vision)) {
				if (attachments.length >= MAX_IMAGES) {
					app.toast(t("이미지는 최대 8장까지 첨부할 수 있습니다"), "error", pane.id);
					continue;
				}
				try {
					attachments.push(await fileToAttachment(f));
					insertImageToken(attachments.length);
				} catch {
					fail(f.name, t("이미지"));
				}
				continue;
			}
			const rejected = fileRejection(f, files);
			if (rejected) {
				app.toast(rejectionText(rejected.reason, f.name), "error", pane.id);
				if (rejected.stop) break;
				continue;
			}
			try {
				files.push(await fileToDraft(f));
			} catch {
				fail(f.name, t("파일"));
			}
		}
	}

	function removeFile(id: string) {
		const f = files.find((x) => x.id === id);
		if (f) releaseFiles([f]);
		files = files.filter((x) => x.id !== id);
	}

	function onPaste(e: ClipboardEvent) {
		const pasted = [...(e.clipboardData?.files ?? [])];
		if (pasted.length) {
			e.preventDefault();
			void addFiles(pasted);
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

{#if dragging}<DropOverlay />{/if}

<div class="wrap" bind:this={wrapEl}>
	{#if whereShown && app.net === "online"}
		<WhereChip path={wherePath} onclick={() => (app.dirPicker = true)} />
	{/if}
	<div class="extension-widgets"><ExtensionPanels placement="composer" /></div>
	<div class="box" class:glow-working={running || compacting} class:glow-compacting={compacting} class:disabled={app.net !== "online"} data-level={running && !compacting && app.effectiveModelOf(pane.id)?.reasoning ? app.effectiveOf(pane.id).thinkingLevel : undefined}>
		{#if slashOpen}
			<SlashMenu items={menuItems} index={slashIndex} label={menuKind === "cd" ? msg("폴더") : menuKind === "file" ? msg("파일") : menuKind === "member" ? msg("멘션") : argSuggestions ? t("{cmd} 값 선택", { cmd: commandText(argSuggestions.cmd) }) : msg("명령")} empty={menuKind === "cd" ? msg("일치하는 폴더가 없습니다") : menuKind === "file" ? msg("일치하는 파일이 없습니다") : argSuggestions?.empty} onpick={pickRecommendation} onhover={(i) => (slashIndex = i)} />
		{/if}
		{#if reply}
			<ReplyBadge who={reply.who} text={replyPreview} oncancel={() => (reply = null)} />
		{/if}
		{#if attachments.length}
			<AttachmentStrip {attachments} onremove={removeAttachment} />
		{/if}
		{#if files.length}
			<FileStrip {files} onremove={removeFile} />
		{/if}

		{#if chat?.waiting.length}
			<QueuedList queued={chat.waiting} oncancel={(q) => app.cancelQueued(q, pane.id)} />
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
			placeholder={promptHint ? "" : running ? runningHint : t("에이전트에게 메시지 보내기 · / 명령")}
			aria-label={running ? runningHint : t("에이전트에게 메시지 보내기 · / 명령")}
			enterkeyhint="enter"
			autocapitalize="sentences"
			spellcheck="false"
		></textarea>
</div>

		<div class="bar">
			<IconButton icon="attach" label={t("파일 첨부")} title={vision ? t("파일 첨부") : t("파일 첨부 (이 모델은 이미지를 직접 보지 못해 파일로 전달됩니다)")} onclick={() => fileInput?.click()} />
			<input bind:this={fileInput} type="file" multiple hidden onchange={(e) => { const picked = [...(e.currentTarget.files ?? [])]; e.currentTarget.value = ""; void addFiles(picked); }} />

			<ModelPicker />
			<span class="grow"></span>

			<SendControls
				{compacting}
				{running}
				{canSend}
				{hasInput}
				sending={app.sending}
				online={app.net === "online"}
				onsend={submit}
				onqueue={() => during("queue")}
				{queueKey}
				onsteer={() => during("steer")}
				onstop={() => app.abort(pane.id)}
			/>
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
		scrollbar-gutter: stable;
	}
	textarea {
		grid-area: 1 / 1;
		min-width: 0;
		align-self: stretch;
		height: 100%;
		position: relative;
		z-index: 1;
	}
	/* highlight layer behind the transparent textarea: same metrics, only `#imageN` tokens are tinted */
	.mirror {
		grid-area: 1 / 1;
		min-width: 0;
		max-height: 220px;
		padding: 14px 18px 4px;
		font-size: var(--fs-lg);
		line-height: 1.5;
		white-space: pre-wrap;
		overflow-wrap: break-word;
		overflow-y: auto;
		scrollbar-gutter: stable;
		color: transparent;
		pointer-events: none;
	}
	/* mention tags: #imageN violet, #files mint, @members sky; the hues come from the theme (app.css) */
	.mirror :global(mark) {
		color: transparent;
		-webkit-box-decoration-break: clone;
		box-decoration-break: clone;
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
	.mirror :global(mark.member) {
		background: color-mix(in srgb, var(--mark-member) 30%, transparent);
		box-shadow: 0 0 0 1px color-mix(in srgb, var(--mark-member) 55%, transparent);
	}
	textarea::placeholder {
		color: var(--text-faint);
	}
	/* mirror and textarea share one cell; the mirror (same metrics, trailing newline) is in flow and sets the height */
	.field-wrap {
		position: relative;
		display: grid;
		grid-template-columns: minmax(0, 1fr);
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
		min-width: 0;
	}
	/* narrow pane (split group, small window): tighter paddings and smaller type instead of wrapping or overlapping */
	@container (max-width: 480px) {
		.wrap {
			padding: 0 10px calc(8px + var(--sab));
		}
		.bar {
			gap: 2px;
			padding: 2px 6px 6px;
			min-width: 0;
		}
	}
	@container (max-width: 420px) {
		.box {
			border-radius: 18px;
		}
		textarea,
		.mirror {
			padding: 10px 14px 2px;
		}
		.prompt-hint {
			top: 10px;
			left: 14px;
			right: 14px;
		}
	}
	@container (max-width: 420px) {
		@media (pointer: fine) {
			textarea,
			.mirror,
			.prompt-hint {
				font-size: var(--fs-md);
			}
		}
	}
</style>
