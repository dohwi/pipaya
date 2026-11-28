<script lang="ts">
	import { t } from "../../lib/i18n";
	import Icon from "../ui/Icon.svelte";
	import { app } from "../../lib/store.svelte";
	import { getPane } from "../../lib/pane";
	import type { MentionTarget } from "../../lib/peers";
	import { hideMentionHover, scheduleMentionHoverHide, showMentionHover } from "../../lib/mention-hover.svelte";
	import { openMentionMenu } from "../../lib/mention-menu";
	import { splitTokens } from "../../lib/composer-text";
	import { baseName, formatFileLine, splitFilePath, splitFileRef } from "../../lib/files";
	import type { ImageBlock } from "../../lib/types";

	/**
	 * Message text with the tokens the composer marks drawn as chips in the same hues (app.css --mark-*), so a sent message
	 * reads the way it was typed:
	 *  @name     a session or group, amber like the agent-to-agent header; opens that session or group
	 *  #imageN   an attached image, a quiet grey chip with an image icon; opens it in the viewer
	 *  #path     a file (with optional `:line`), the same grey chip with a file icon; opens the preview
	 *  /skill:x  a skill the server confirmed it injected, in the composer's accent hue with a skill icon; opens its details
	 *  /prompt:x a prompt template, in the same accent hue with a prompt icon; opens the templates list
	 * Amber is the only accent, so a message full of tags does not turn into a rainbow.
	 */
	let { text, images = [], skills = [], sessionId = null }: { text: string; images?: ImageBlock[]; skills?: readonly string[]; sessionId?: string | null } = $props();

	const pane = getPane();
	const paneServer = $derived(pane.server ?? app.serverId);
	const mentionIdx = $derived(app.mentionIndexOf(paneServer));
	const parts = $derived(splitTokens(text, { names: mentionIdx.names, images: images.length, skills }));
	const openImage = (n: number) => app.openImage(images.map((m) => ({ src: `data:${m.mimeType};base64,${m.data}`, mimeType: m.mimeType })), n - 1);
	const openFile = (raw: string) => {
		if (!sessionId || paneServer !== app.serverId) return;
		const ref = splitFileRef(raw.replace(/^\.\//, ""));
		if (!ref.path || ref.path.split("/").includes("..")) return;
		app.openFile(sessionId, { path: ref.path, name: baseName(ref.path), ...(ref.line ? { line: ref.line } : {}), ...(ref.endLine ? { endLine: ref.endLine } : {}) });
	};
	function scopeTarget(target: MentionTarget): MentionTarget {
		if (target.kind === "session" && !target.server && paneServer && paneServer !== app.serverId) {
			return { ...target, server: paneServer };
		}
		return target;
	}
	function isSelfTarget(target: MentionTarget): boolean {
		if (target.kind !== "session" || !sessionId || target.id !== sessionId) return false;
		return !target.server || !paneServer || target.server === paneServer;
	}
</script>

{#snippet fileLabel(raw: string)}{@const ref = splitFileRef(raw)}{@const suffix = formatFileLine(ref.line, ref.endLine)}{@const fp = splitFilePath(ref.path)}{#if fp}<span class="path"><span class="dir">{fp.dir}</span><span class="base">{fp.base}{suffix}</span></span>{:else}<span class="tlabel">{raw}</span>{/if}{/snippet}

{#each parts as p, i (i)}{#if p.kind === "mention" && mentionIdx.resolve(p.name!)}{@const target = scopeTarget(mentionIdx.resolve(p.name!)!)}{#if isSelfTarget(target)}<span class="tok mention self" title={t("현재 대화")}><span class="tlabel">{p.text}</span></span>{:else}{@const act = app.mentionActivity(target)}<button type="button" class="tok mention" class:closed={target.kind === "session" && target.closed} data-activity={act !== "idle" ? act : undefined} aria-label={target.kind === "group" ? t("{name} 그룹 열기", { name: p.text }) : target.closed ? t("{name} 닫힌 대화 보기", { name: p.text }) : t("{name} 대화 미리 보기", { name: p.text })} onclick={(e) => { hideMentionHover(); app.openMention(target, { direct: e.ctrlKey || e.metaKey }); }} oncontextmenu={(e) => openMentionMenu(e, target, { label: p.text, currentSessionId: sessionId })} onpointerenter={(e) => { if (e.pointerType === "mouse") showMentionHover(e.currentTarget, target, p.text); }} onpointerleave={(e) => { if (e.pointerType === "mouse") scheduleMentionHoverHide(); }}>{#if act !== "idle"}<span class="mdot" data-activity={act}></span>{/if}<span class="tlabel">{p.text}</span></button>{/if}{:else if p.kind === "mention"}<span class="tok mention" title={p.text}><span class="tlabel">{p.text}</span></span>{:else if p.kind === "image"}<button type="button" class="tok image" title={t("이미지 크게 보기")} onclick={() => openImage(Number(p.name))}><Icon name="image" /><span class="tlabel">{p.text.slice(1)}</span></button>{:else if p.kind === "file" && sessionId && paneServer === app.serverId}<button type="button" class="tok file" title={t("{name} 미리 보기", { name: p.name! })} onclick={() => openFile(p.name!)}><Icon name="file" />{@render fileLabel(p.text.slice(1))}</button>{:else if p.kind === "file"}<span class="tok file" title={p.name!}><Icon name="file" />{@render fileLabel(p.text.slice(1))}</span>{:else if p.kind === "skill"}<button type="button" class="tok skill" title={t("스킬 {name} 보기", { name: p.name! })} onclick={() => app.openSkills(sessionId, p.name!)}><Icon name="skill" /><span class="tlabel">{p.text}</span></button>{:else if p.kind === "prompt"}<button type="button" class="tok skill" title={t("프롬프트 {name} 보기", { name: p.name! })} onclick={() => app.openTemplates(sessionId)}><Icon name="prompt" /><span class="tlabel">{p.text}</span></button>{:else}{p.text}{/if}{/each}

<style>
	/* Shaped like inline code in a reply (Markdown.svelte): 4px corners (--radius-xs), em padding so the chip grows with its text, a hairline
	   ring. Atomic inline-flex keeps icon + label together as one chip when lines wrap, truncating cleanly at max-width: 100%.
	   The hue (app.css --mark-*) tints the fill and the ring; only @names colour their text. */
	.tok {
		--hue: var(--mark-file);
		display: inline-flex;
		align-items: center;
		gap: 4px;
		max-width: 100%;
		padding: 1px 0.4em; /* em sides scale with the text, like inline code */
		border-radius: var(--radius-xs);
		background: color-mix(in srgb, var(--hue) 12%, transparent);
		box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--hue) 22%, transparent); /* a ring, not a border: the line box stays the text's */
		color: inherit;
		font: inherit;
		font-size: 0.88em; /* inline code's size: the chip (content box + 2px) stays under the 1.55 line, so chips on wrapped lines never touch */
		line-height: 18px; /* whole-pixel 20px box (18 + 2 padding) so button and span chips share one height */
		vertical-align: middle; /* box-centred so icon-bearing chips (#file, /skill) and text-only @mentions share one y-axis */
		position: relative;
		top: -1px; /* measured: lifts middle (x-height/2) onto the 24px line and Hangul ink centre */
		transition: none; /* instant hover tint avoids GPU background-color layer promotion snapping inline chips by 1px */
	}
	.tlabel {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.path {
		display: inline-flex;
		min-width: 0;
	}
	.dir {
		flex: 0 999999 auto;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		opacity: 0.68;
	}
	.base {
		flex: 0 1 auto;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.mention {
		--hue: var(--mark-mention);
		color: var(--hue);
		font-weight: 600;
	}
	.mention.self {
		--hue: var(--mark-mention-self);
	}
	.mention.closed {
		--hue: var(--mark-mention-closed);
		font-weight: 500;
		background: color-mix(in srgb, var(--hue) 8%, transparent);
		box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--hue) 26%, transparent);
	}
	.mdot {
		flex: none;
		width: 6px;
		height: 6px;
		border-radius: var(--radius-pill);
	}
	.mdot[data-activity="working"] {
		background: var(--info);
		animation: tok-dot-pulse var(--anim-working-duration) var(--anim-working-ease) infinite;
	}
	.mdot[data-activity="asking"] {
		background: var(--warn);
		animation: tok-dot-pulse var(--anim-working-duration) var(--anim-working-ease) infinite;
	}
	.mdot[data-activity="done"] {
		background: var(--ok);
	}
	.mdot[data-activity="failed"] {
		background: var(--danger);
	}
	@keyframes tok-dot-pulse {
		0%, 100% { opacity: 1; }
		50% { opacity: var(--anim-working-dim); }
	}
	@media (prefers-reduced-motion: reduce) {
		.mdot {
			animation: none;
		}
	}
	.image {
		--hue: var(--mark-img);
	}
	.skill {
		--hue: var(--accent);
		font-weight: 600;
	}
	/* The # sigil gives way to a small icon in the text's own colour, dimmed. */
	.tok :global(svg) {
		flex: none;
		width: 12px;
		height: 12px;
		opacity: 0.7;
	}
	button.tok {
		cursor: pointer;
	}
	@media (hover: hover) {
		button.tok:hover {
			background: color-mix(in srgb, var(--hue) 22%, transparent);
		}
	}
</style>
