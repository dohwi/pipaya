<script lang="ts">
	import { t } from "../../lib/i18n";
	import Icon from "../ui/Icon.svelte";
	import { app } from "../../lib/store.svelte";
	import { splitTokens } from "../../lib/composer-text";
	import { groupHandle } from "../../lib/peers";
	import { nameInLang } from "../../lib/member-names";
	import type { ImageBlock } from "../../lib/types";

	/**
	 * Message text with the tokens the composer marks drawn as chips in the same hues (app.css --mark-*), so a sent message
	 * reads the way it was typed:
	 *  @name    a session or group, amber like the agent-to-agent header; a session chip opens that session
	 *  #imageN  an attached image, a quiet grey chip with an image icon; opens it in the viewer
	 *  #path    a file, the same grey chip with a file icon; opens the preview when the message belongs to a session
	 * Amber is the only accent, so a message full of tags does not turn into a rainbow.
	 */
	let { text, images = [], sessionId = null }: { text: string; images?: ImageBlock[]; sessionId?: string | null } = $props();

	// Every way a name may be written (stored Korean and the romanized display form) → the session it names.
	const sessions = $derived.by(() => {
		const map = new Map<string, string>();
		for (const s of app.sessions) {
			if (!s.name) continue;
			map.set(s.name.toLowerCase(), s.id);
			map.set(nameInLang(s.name).toLowerCase(), s.id);
		}
		return map;
	});
	const groups = $derived(app.groups.map((g) => groupHandle(g.name)).filter(Boolean));
	const parts = $derived(splitTokens(text, { names: [...sessions.keys(), ...groups], images: images.length }));
	const sessionOf = (name: string) => sessions.get(name.toLowerCase());
	const openImage = (n: number) => app.openImage(images.map((m) => ({ src: `data:${m.mimeType};base64,${m.data}`, mimeType: m.mimeType })), n - 1);
	const openFile = (path: string) => sessionId && app.openFile(sessionId, { path, name: path.split("/").filter(Boolean).pop() ?? path });
</script>

{#each parts as p, i (i)}{#if p.kind === "mention" && sessionOf(p.name!)}{@const id = sessionOf(p.name!)!}<button type="button" class="tok mention" title={t("{name} 대화 열기", { name: p.text })} onclick={() => void app.openAny(id)}>{p.text}</button>{:else if p.kind === "mention"}<span class="tok mention">{p.text}</span>{:else if p.kind === "image"}<button type="button" class="tok image" title={t("이미지 크게 보기")} onclick={() => openImage(Number(p.name))}><Icon name="image" />{p.text.slice(1)}</button>{:else if p.kind === "file" && sessionId}<button type="button" class="tok file" title={t("{name} 미리 보기", { name: p.name! })} onclick={() => openFile(p.name!)}><Icon name="file" />{p.text.slice(1)}</button>{:else if p.kind === "file"}<span class="tok file"><Icon name="file" />{p.text.slice(1)}</span>{:else}{p.text}{/if}{/each}

<style>
	/* Shaped like inline code in a reply (Markdown.svelte): 8px corners, em padding so the chip grows with its text, a hairline
	   ring. The hue (app.css --mark-*) tints the fill and the ring; only @names colour their text. */
	.tok {
		--hue: var(--mark-file);
		display: inline;
		padding: 1px 0.4em; /* em sides scale with the text, like inline code */
		border-radius: var(--radius-sm);
		background: color-mix(in srgb, var(--hue) 12%, transparent);
		box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--hue) 22%, transparent); /* a ring, not a border: the line box stays the text's */
		color: inherit;
		font: inherit;
		font-size: 0.88em; /* inline code's size: the chip (content box + 2px) stays under the 1.55 line, so chips on wrapped lines never touch */
		overflow-wrap: anywhere;
		-webkit-box-decoration-break: clone;
		box-decoration-break: clone;
		transition: background var(--motion-fast) var(--ease-std);
	}
	.mention {
		--hue: var(--mark-mention);
		color: var(--hue);
		font-weight: 600;
	}
	.image {
		--hue: var(--mark-img);
	}
	/* The # sigil gives way to a small icon in the text's own colour, dimmed. */
	.tok :global(svg) {
		width: 12px;
		height: 12px;
		margin-right: 4px;
		vertical-align: -1px; /* measured: centres the 12px glyph on the chip text's ink */
		opacity: 0.7;
	}
	button.tok {
		cursor: pointer;
	}
	button.tok:hover {
		background: color-mix(in srgb, var(--hue) 22%, transparent);
	}
</style>
