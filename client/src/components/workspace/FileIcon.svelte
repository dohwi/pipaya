<script lang="ts">
	/**
	 * VS Code Material-inspired crisp 16x16 SVG file & folder icons for the workspace tree and file tabs.
	 */
	let { name, dir = false, open = false }: { name: string; dir?: boolean; open?: boolean } = $props();

	const lower = $derived(name.toLowerCase());
	const ext = $derived.by(() => {
		const i = lower.lastIndexOf(".");
		return i > 0 ? lower.slice(i + 1) : "";
	});

	const folderColor = $derived.by(() => {
		switch (lower) {
			case "src":
			case "source":
				return "#42a5f5";
			case "client":
			case "web":
			case "app":
			case "pages":
				return "#5c9ce6";
			case "server":
			case "backend":
			case "api":
				return "#ab7df8";
			case "components":
			case "ui":
			case "views":
				return "#4db6ac";
			case "lib":
			case "libs":
			case "utils":
			case "shared":
			case "helpers":
				return "#ffb74d";
			case "routes":
			case "router":
				return "#26c6da";
			case "test":
			case "tests":
			case "__tests__":
			case "spec":
				return "#66bb6a";
			case "docs":
			case "doc":
				return "#4fc3f7";
			case "scripts":
			case "bin":
				return "#ff8a65";
			case "assets":
			case "public":
			case "static":
			case "logo":
			case "images":
			case "img":
				return "#f06292";
			case ".github":
			case ".vscode":
			case ".agents":
			case "config":
				return "#90a4ae";
			case "node_modules":
			case "dist":
			case "build":
			case "tmp":
				return "#78909c";
			default:
				return "#d4a853";
		}
	});

	type FileVisual = { kind: "badge"; label: string; color: string; bg: string } | { kind: "glyph"; icon: string; color: string };

	const fileVisual = $derived.by<FileVisual>(() => {
		if (lower === "dockerfile" || lower.startsWith("dockerfile.") || lower === "compose.yaml" || lower === "compose.yml" || lower === "docker-compose.yml" || lower === "docker-compose.yaml") {
			return { kind: "glyph", icon: "docker", color: "#38bdf8" };
		}
		if (lower === ".gitignore" || lower === ".gitattributes" || lower === ".gitmodules") {
			return { kind: "glyph", icon: "git", color: "#f06543" };
		}
		if (lower === "package.json" || lower === "bun.lock" || lower === "package-lock.json" || lower === "pnpm-lock.yaml") {
			return { kind: "glyph", icon: "pkg", color: "#e06c75" };
		}
		if (lower === "license" || lower.startsWith("license.")) {
			return { kind: "glyph", icon: "license", color: "#e5c07b" };
		}
		if (lower === "tsconfig.json" || lower.startsWith("tsconfig.")) {
			return { kind: "badge", label: "TS", color: "#3178c6", bg: "rgba(49,120,198,0.16)" };
		}
		if (lower.startsWith(".env")) {
			return { kind: "glyph", icon: "gear", color: "#eab308" };
		}

		switch (ext) {
			case "ts":
			case "mts":
			case "cts":
				return { kind: "badge", label: "TS", color: "#3b82f6", bg: "rgba(59,130,246,0.16)" };
			case "tsx":
				return { kind: "badge", label: "TX", color: "#38bdf8", bg: "rgba(56,189,248,0.16)" };
			case "js":
			case "mjs":
			case "cjs":
				return { kind: "badge", label: "JS", color: "#eab308", bg: "rgba(234,179,8,0.16)" };
			case "jsx":
				return { kind: "badge", label: "JX", color: "#38bdf8", bg: "rgba(56,189,248,0.16)" };
			case "svelte":
				return { kind: "glyph", icon: "svelte", color: "#ff4f1f" };
			case "vue":
				return { kind: "glyph", icon: "vue", color: "#42b883" };
			case "html":
			case "htm":
				return { kind: "glyph", icon: "code", color: "#f97316" };
			case "css":
			case "scss":
			case "sass":
			case "less":
				return { kind: "glyph", icon: "hash", color: "#38bdf8" };
			case "json":
			case "jsonc":
				return { kind: "glyph", icon: "braces", color: "#f59e0b" };
			case "md":
			case "markdown":
			case "mdx":
				return { kind: "glyph", icon: "md", color: "#60a5fa" };
			case "py":
				return { kind: "badge", label: "PY", color: "#60a5fa", bg: "rgba(96,165,250,0.16)" };
			case "rs":
				return { kind: "badge", label: "RS", color: "#fb923c", bg: "rgba(251,146,60,0.16)" };
			case "go":
				return { kind: "badge", label: "GO", color: "#22d3ee", bg: "rgba(34,211,238,0.16)" };
			case "java":
			case "kt":
				return { kind: "badge", label: ext.toUpperCase(), color: "#f97316", bg: "rgba(249,115,22,0.16)" };
			case "sh":
			case "bash":
			case "zsh":
			case "ps1":
			case "bat":
				return { kind: "glyph", icon: "term", color: "#4ade80" };
			case "yml":
			case "yaml":
			case "toml":
			case "ini":
			case "conf":
			case "cfg":
				return { kind: "glyph", icon: "gear", color: "#c084fc" };
			case "sql":
			case "db":
			case "sqlite":
				return { kind: "glyph", icon: "db", color: "#f59e0b" };
			case "png":
			case "jpg":
			case "jpeg":
			case "gif":
			case "webp":
			case "bmp":
			case "ico":
			case "avif":
				return { kind: "glyph", icon: "image", color: "#a78bfa" };
			case "svg":
				return { kind: "glyph", icon: "image", color: "#fbbf24" };
			case "pdf":
				return { kind: "glyph", icon: "pdf", color: "#f87171" };
			case "mp3":
			case "wav":
			case "ogg":
			case "m4a":
			case "flac":
			case "aac":
				return { kind: "glyph", icon: "audio", color: "#f472b6" };
			case "mp4":
			case "webm":
			case "mov":
			case "ogv":
				return { kind: "glyph", icon: "video", color: "#fb7185" };
			case "csv":
			case "tsv":
				return { kind: "glyph", icon: "table", color: "#34d399" };
			case "zip":
			case "tar":
			case "gz":
			case "7z":
				return { kind: "glyph", icon: "pkg", color: "#d4a853" };
			default:
				return { kind: "glyph", icon: "file", color: "currentColor" };
		}
	});
</script>

<span class="fi" aria-hidden="true">
	{#if dir}
		{#if open}
			<svg viewBox="0 0 16 16" fill="none">
				<path
					d="M1.5 4.2A1.2 1.2 0 0 1 2.7 3h3.2l1.3 1.4h6.1a1.2 1.2 0 0 1 1.2 1.2v.6H3.3a1.1 1.1 0 0 0-1.05.78L1.5 9.6V4.2Z"
					fill={folderColor}
					fill-opacity="0.78"
				/>
				<path
					d="M2.6 6.4h11.3a.9.9 0 0 1 .87 1.13l-1.18 4.55a1.2 1.2 0 0 1-1.16.92H2.5a1 1 0 0 1-.97-1.24l1.07-5.36Z"
					fill={folderColor}
				/>
			</svg>
		{:else}
			<svg viewBox="0 0 16 16" fill="none">
				<path
					d="M1.5 4.2A1.2 1.2 0 0 1 2.7 3h3.2l1.3 1.4h6.1a1.2 1.2 0 0 1 1.2 1.2v6.2a1.2 1.2 0 0 1-1.2 1.2H2.7a1.2 1.2 0 0 1-1.2-1.2V4.2Z"
					fill={folderColor}
					fill-opacity="0.92"
				/>
			</svg>
		{/if}
	{:else if fileVisual.kind === "badge"}
		<svg viewBox="0 0 16 16" fill="none">
			<rect x="1.2" y="2.2" width="13.6" height="11.6" rx="2.4" fill={fileVisual.bg} stroke={fileVisual.color} stroke-width="1" stroke-opacity="0.7" />
			<text
				x="8"
				y="10.8"
				text-anchor="middle"
				fill={fileVisual.color}
				font-size="7.2"
				font-weight="700"
				font-family="ui-monospace, SFMono-Regular, Menlo, monospace"
			>{fileVisual.label}</text>
		</svg>
	{:else if fileVisual.icon === "svelte"}
		<svg viewBox="0 0 16 16" fill="none">
			<path
				d="M12.2 4.1a3.2 3.2 0 0 0-4.3-1L4.6 5.2a3.1 3.1 0 0 0-1.1 4 3 3 0 0 0 .4.6 3.1 3.1 0 0 0-.1 2.4 3.2 3.2 0 0 0 4.3 1.1l3.3-2.1a3.1 3.1 0 0 0 1.1-4 3 3 0 0 0-.4-.6 3.1 3.1 0 0 0 .1-2.5Z"
				stroke={fileVisual.color}
				stroke-width="1.5"
				stroke-linejoin="round"
			/>
			<path d="M6.4 9.7 9.6 7.6" stroke={fileVisual.color} stroke-width="1.3" stroke-linecap="round" />
		</svg>
	{:else if fileVisual.icon === "vue"}
		<svg viewBox="0 0 16 16" fill="none">
			<path d="M1.8 3h2.8L8 8.8 11.4 3h2.8L8 13.5 1.8 3Z" fill={fileVisual.color} />
			<path d="M4.6 3h2.2L8 5.2 9.2 3h2.2L8 8.8 4.6 3Z" fill="#35495e" />
		</svg>
	{:else if fileVisual.icon === "braces"}
		<svg viewBox="0 0 16 16" fill="none" stroke={fileVisual.color} stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
			<path d="M5.5 3C4.3 3 4 3.6 4 4.6v1.6C4 7.1 3.4 7.7 2.6 8c.8.3 1.4.9 1.4 1.8v1.6c0 1 .3 1.6 1.5 1.6" />
			<path d="M10.5 3c1.2 0 1.5.6 1.5 1.6v1.6c0 .9.6 1.5 1.4 1.8-.8.3-1.4.9-1.4 1.8v1.6c0 1-.3 1.6-1.5 1.6" />
		</svg>
	{:else if fileVisual.icon === "md"}
		<svg viewBox="0 0 16 16" fill="none" stroke={fileVisual.color} stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
			<rect x="1.5" y="3" width="13" height="10" rx="1.8" />
			<path d="M3.8 10.5v-5L6 8l2.2-2.5v5M11.6 5.5v4.8m0 0-1.5-1.5m1.5 1.5 1.5-1.5" />
		</svg>
	{:else if fileVisual.icon === "code"}
		<svg viewBox="0 0 16 16" fill="none" stroke={fileVisual.color} stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
			<path d="M5.2 4.5 2 8l3.2 3.5M10.8 4.5 14 8l-3.2 3.5M9 3.5 7 12.5" />
		</svg>
	{:else if fileVisual.icon === "hash"}
		<svg viewBox="0 0 16 16" fill="none" stroke={fileVisual.color} stroke-width="1.5" stroke-linecap="round">
			<path d="M6.2 3 4.8 13M11.2 3 9.8 13M3 6h10.5M2.5 10H13" />
		</svg>
	{:else if fileVisual.icon === "term"}
		<svg viewBox="0 0 16 16" fill="none" stroke={fileVisual.color} stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
			<rect x="1.6" y="2.8" width="12.8" height="10.4" rx="1.8" />
			<path d="M4.2 6.2 6.5 8 4.2 9.8M8 10h3.6" />
		</svg>
	{:else if fileVisual.icon === "gear"}
		<svg viewBox="0 0 16 16" fill="none" stroke={fileVisual.color} stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
			<circle cx="8" cy="8" r="2.3" />
			<path d="M8 2.2v1.4M8 12.4v1.4M2.2 8h1.4M12.4 8h1.4M3.9 3.9l1 1M11.1 11.1l1 1M12.1 3.9l-1 1M4.9 11.1l-1 1" />
		</svg>
	{:else if fileVisual.icon === "db"}
		<svg viewBox="0 0 16 16" fill="none" stroke={fileVisual.color} stroke-width="1.4">
			<ellipse cx="8" cy="4.2" rx="4.8" ry="1.9" />
			<path d="M3.2 4.2v7.6c0 1.05 2.15 1.9 4.8 1.9s4.8-.85 4.8-1.9V4.2" />
			<path d="M3.2 8c0 1.05 2.15 1.9 4.8 1.9s4.8-.85 4.8-1.9" />
		</svg>
	{:else if fileVisual.icon === "image"}
		<svg viewBox="0 0 16 16" fill="none" stroke={fileVisual.color} stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
			<rect x="2" y="2.6" width="12" height="10.8" rx="1.8" />
			<circle cx="5.6" cy="6" r="1.1" fill={fileVisual.color} stroke="none" />
			<path d="m3 12 3.2-3.2 2.2 2.2 2-2 2.6 3" />
		</svg>
	{:else if fileVisual.icon === "pdf"}
		<svg viewBox="0 0 16 16" fill="none" stroke={fileVisual.color} stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
			<path d="M3.5 2h6l3 3v9h-9V2Z" />
			<path d="M9.5 2v3h3M5.5 9.2h5M5.5 11.5h3.5" />
		</svg>
	{:else if fileVisual.icon === "audio"}
		<svg viewBox="0 0 16 16" fill="none" stroke={fileVisual.color} stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
			<path d="M6.5 11.8V4.2l6-1.2v7.6" />
			<circle cx="4.8" cy="11.8" r="1.7" />
			<circle cx="10.8" cy="10.6" r="1.7" />
		</svg>
	{:else if fileVisual.icon === "video"}
		<svg viewBox="0 0 16 16" fill="none" stroke={fileVisual.color} stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
			<rect x="2" y="3" width="12" height="10" rx="1.8" />
			<path d="M6.6 5.8 10.6 8l-4 2.2V5.8Z" fill={fileVisual.color} />
		</svg>
	{:else if fileVisual.icon === "table"}
		<svg viewBox="0 0 16 16" fill="none" stroke={fileVisual.color} stroke-width="1.3">
			<rect x="2" y="2.6" width="12" height="10.8" rx="1.5" />
			<path d="M2 6.2h12M2 9.8h12M6.5 6.2v7.2" />
		</svg>
	{:else if fileVisual.icon === "git"}
		<svg viewBox="0 0 16 16" fill="none" stroke={fileVisual.color} stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
			<circle cx="5" cy="4.2" r="1.4" />
			<circle cx="5" cy="11.8" r="1.4" />
			<circle cx="11.2" cy="6.8" r="1.4" />
			<path d="M5 5.6v4.8M5 9.2c0-1.4 1.2-2.4 4.8-2.4" />
		</svg>
	{:else if fileVisual.icon === "docker"}
		<svg viewBox="0 0 16 16" fill="none" stroke={fileVisual.color} stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">
			<path d="M2 9h12c-.4 2.6-2.2 4.2-5.6 4.2C4.6 13.2 2.4 11.4 2 9Z" />
			<path d="M4.5 6.5h2v2.5h-2zM7 6.5h2v2.5H7zM9.5 6.5h2v2.5h-2zM7 4h2v2.5H7z" />
		</svg>
	{:else if fileVisual.icon === "pkg"}
		<svg viewBox="0 0 16 16" fill="none" stroke={fileVisual.color} stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
			<path d="M8 2 13.2 4.8v6.4L8 14 2.8 11.2V4.8L8 2Z" />
			<path d="M2.8 4.8 8 7.6l5.2-2.8M8 7.6V14" />
		</svg>
	{:else if fileVisual.icon === "license"}
		<svg viewBox="0 0 16 16" fill="none" stroke={fileVisual.color} stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
			<circle cx="8" cy="6.2" r="3.4" />
			<path d="m6 9.2-.8 4.6L8 12.4l2.8 1.4-.8-4.6" />
		</svg>
	{:else}
		<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
			<path d="M3.5 2h6l3 3v9h-9V2Z" />
			<path d="M9.5 2v3h3" />
		</svg>
	{/if}
</span>

<style>
	.fi {
		width: 16px;
		height: 16px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex: none;
	}
	.fi svg {
		width: 15px;
		height: 15px;
		display: block;
	}
</style>
