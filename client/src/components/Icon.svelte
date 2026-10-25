<script lang="ts" module>
	export type IconName =
		| "menu" | "plus" | "send" | "stop" | "chat" | "trash" | "edit" | "copy" | "check" | "x" | "chevron-down"
		| "chevron-right" | "chevron-left" | "settings" | "sun" | "moon" | "monitor" | "image" | "terminal" | "file" | "attach" | "search"
		| "folder" | "pencil" | "brain" | "fork" | "reply" | "retry" | "shield" | "alert" | "wifi-off" | "key" | "arrow-down"
		| "undo" | "download" | "bolt" | "list" | "more" | "sidebar" | "star" | "coin" | "cache" | "gauge" | "clock" | "columns" | "unlink" | "skill" | "prompt" | "keyboard" | "server" | "widgets" | "phone" | "expand" | "shrink" | "group" | "group-open";
</script>

<script lang="ts">
	type Name = IconName;

	let { name }: { name: Name } = $props();

	const paths: Record<Name, string> = {
		menu: "M4 7h16M4 12h16M4 17h16",
		plus: "M12 5v14M5 12h14",
		send: "M12 19V5M5 12l7-7 7 7",
		stop: "M7 7h10v10H7z",
		chat: "M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z",
		trash: "M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3",
		edit: "M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4",
		pencil: "M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4",
		copy: "M9 9h10v11H9zM5 15V4h10",
		check: "M5 12.5l4.5 4.5L19 7.5",
		x: "M6 6l12 12M18 6L6 18",
		"chevron-down": "M6 9l6 6 6-6",
		"chevron-right": "M9 6l6 6-6 6",
		"chevron-left": "M15 6l-6 6 6 6",
		settings: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
		sun: "M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4",
		moon: "M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z",
		monitor: "M3 5h18v11H3zM8 20h8M12 16v4",
		phone: "M7 2h10a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zM11 19h2",
		image: "M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M9 9.5a.5.5 0 1 0 0-1 .5.5 0 0 0 0 1z",
		terminal: "M4 5h16v14H4zM7 10l3 2.5L7 15M12 15h5",
		file: "M7 3h7l5 5v13H7zM14 3v5h5",
		attach: "M21.4 11.1l-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5",
		search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-5-5",
		folder: "M3 6h6l2 2h10v11H3z",
		brain: "M9 4a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 2 5 3 3 0 0 0 6 1V5a2 2 0 0 0-3-1zM15 4a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-2 5 3 3 0 0 1-6 1",
		fork: "M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a9 9 0 0 1-9 9",
		undo: "M4 12a8 8 0 1 0 2.3-5.7M4 4v5h5",
		reply: "M9 14L4 9l5-5M4 9h10a6 6 0 0 1 6 6v4",
		retry: "M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5",
		shield: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z",
		alert: "M12 3l10 18H2zM12 10v5M12 18h.01",
		"wifi-off": "M2 8.8a15 15 0 0 1 4-2.4M22 8.8a15 15 0 0 0-8.4-3.7M5 12.9a10 10 0 0 1 3.2-1.9M19 12.9a10 10 0 0 0-3-2M8.5 16.4a5 5 0 0 1 7 0M12 20h.01M2 2l20 20",
		key: "M11 12a3.5 3.5 0 1 0-7 0 3.5 3.5 0 0 0 7 0zM11 12h10M18 12v3.5M14.5 12v2.5",
		"arrow-down": "M12 5v14M5 12l7 7 7-7",
		bolt: "M13 2L4 14h7l-1 8 9-12h-7z",
		list: "M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01",
		more: "M5 12h.01M12 12h.01M19 12h.01",
		sidebar: "M4 5h16v14H4zM9.5 5v14",
		coin: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM14.6 9.6c-.5-1-1.5-1.6-2.6-1.6-1.4 0-2.5.8-2.5 2s1 1.7 2.5 2 2.5.8 2.5 2-1.1 2-2.5 2c-1.1 0-2.1-.6-2.6-1.6M12 6.5V8M12 16v1.5",
		download: "M12 4v11M7.5 10.5L12 15l4.5-4.5M5 19.5h14",
		cache: "M12 3l9 5-9 5-9-5zM3 12.5l9 5 9-5M3 17l9 5 9-5",
		clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2",
		gauge: "M4.5 18a8.5 8.5 0 1 1 15 0M12 14l4-5M12 14h.01",
		columns: "M4 5h16v14H4zM12 5v14",
		group: "M4.5 4h4a1.5 1.5 0 0 1 1.5 1.5v3A1.5 1.5 0 0 1 8.5 10h-4A1.5 1.5 0 0 1 3 8.5v-3A1.5 1.5 0 0 1 4.5 4zM15.5 4h4A1.5 1.5 0 0 1 21 5.5v3a1.5 1.5 0 0 1-1.5 1.5h-4A1.5 1.5 0 0 1 14 8.5v-3A1.5 1.5 0 0 1 15.5 4zM4.5 14h15a1.5 1.5 0 0 1 1.5 1.5v3a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5v-3A1.5 1.5 0 0 1 4.5 14z",
		"group-open": "M4.5 3h4A1.5 1.5 0 0 1 10 4.5v4A1.5 1.5 0 0 1 8.5 10h-4A1.5 1.5 0 0 1 3 8.5v-4A1.5 1.5 0 0 1 4.5 3zM15.5 3h4A1.5 1.5 0 0 1 21 4.5v4a1.5 1.5 0 0 1-1.5 1.5h-4A1.5 1.5 0 0 1 14 8.5v-4A1.5 1.5 0 0 1 15.5 3zM4.5 14h4A1.5 1.5 0 0 1 10 15.5v4A1.5 1.5 0 0 1 8.5 21h-4A1.5 1.5 0 0 1 3 19.5v-4A1.5 1.5 0 0 1 4.5 14zM15.5 14h4a1.5 1.5 0 0 1 1.5 1.5v4a1.5 1.5 0 0 1-1.5 1.5h-4a1.5 1.5 0 0 1-1.5-1.5v-4a1.5 1.5 0 0 1 1.5-1.5z",
		expand: "M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5",
		shrink: "M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5",
		unlink: "M9 7H7a4 4 0 0 0 0 8h2M15 7h2a4 4 0 0 1 0 8h-2M4 4l16 16",
		skill: "M12 7c-1.6-1.4-3.7-2-7-2v13c3.3 0 5.4.6 7 2 1.6-1.4 3.7-2 7-2V5c-3.3 0-5.4.6-7 2zM12 7v13",
		prompt: "M5 8l5 4-5 4M12 17h7",
		keyboard: "M3 6h18v12H3zM7 10h.01M11 10h.01M15 10h.01M7 14h10",
		server: "M4 4h16v6H4zM4 14h16v6H4zM8 7h.01M8 17h.01",
		widgets: "M4 4h6.5v6.5H4zM13.5 4H20v6.5h-6.5zM4 13.5h6.5V20H4zM16.75 13.5v6.5M13.5 16.75H20",
		star: "M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.9L12 16.9l-5.2 2.8 1-5.9L3.5 9.7l5.9-.8z",
	};
</script>

<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d={paths[name]} /></svg>

<style>
	/* Line-icon defaults at zero specificity (:where), so any rule in the parent (a size, a fill, a thinner stroke) wins
	   without !important. New code needs nothing; existing per-component svg rules keep working unchanged. */
	:where(.ic) {
		width: 1em;
		height: 1em;
		flex: none;
		stroke: currentColor;
		fill: none;
		stroke-width: 1.9;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
</style>
