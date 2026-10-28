/**
 * Put sanitized HTML into `node`, touching only the top-level children that differ.
 *
 * `{@html}` throws away and rebuilds every child whenever the string changes. While an answer streams that happens
 * every frame, so finished paragraphs and code blocks were re-created (re-laid-out, re-painted, selection lost, the
 * caret animation restarted) although only the last block grows. Here the unchanged leading children stay as they are.
 */
export function patchHtml(node: HTMLElement, html: string) {
	apply(node, html);
	return {
		update(next: string) {
			apply(node, next);
		},
	};
}

function apply(node: HTMLElement, html: string) {
	const tpl = document.createElement("template");
	tpl.innerHTML = html;
	const next = Array.from(tpl.content.childNodes);
	const cur = Array.from(node.childNodes);
	let i = 0;
	for (; i < next.length; i++) {
		const old = cur[i];
		const nu = next[i]!;
		if (!old) {
			node.append(nu);
		} else if (!old.isEqualNode(nu)) {
			old.replaceWith(nu);
		}
	}
	for (let j = cur.length - 1; j >= next.length; j--) cur[j]!.remove();
}
