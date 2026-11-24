/**
 * The line icons of `components/ui/Icon.svelte`, kept in lib so that code building markup by hand
 * (`lib/video-view.ts` draws the video's own buttons) uses the same shapes instead of copying them.
 */
export type IconName =
	| "menu" | "plus" | "send" | "stop" | "mic" | "mic-rec" | "chat" | "trash" | "edit" | "copy" | "check" | "x" | "chevron-down"
	| "chevron-right" | "chevron-left" | "settings" | "sun" | "moon" | "monitor" | "image" | "terminal" | "file" | "attach" | "search"
	| "folder" | "pencil" | "brain" | "fork" | "reply" | "retry" | "shield" | "alert" | "wifi-off" | "key" | "arrow-down" | "arrow-up"
	| "undo" | "download" | "bolt" | "list" | "more" | "sidebar" | "star" | "cache" | "gauge" | "clock" | "columns" | "unlink" | "clip" | "skill" | "prompt" | "keyboard" | "server" | "widgets" | "phone" | "expand" | "shrink" | "group" | "group-open" | "sparkles" | "arrow-left" | "arrow-right" | "plug" | "pin" | "bot" | "bell" | "bell-off" | "repo" | "globe" | "target" | "info" | "alert-circle";

export const ICON_PATHS: Record<IconName, string> = {
	menu: "M4 7h16M4 12h16M4 17h16",
	bell: "M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0",
	"bell-off": "M8.7 3A6 6 0 0 1 18 8c0 2.2.3 4 .7 5.4M17 17H3s3-2 3-9c0-.6.1-1.2.3-1.7M10.3 21a1.94 1.94 0 0 0 3.4 0M3 3l18 18",
	pin: "M9 3h6l-1 6 3 3v2H7v-2l3-3zM12 14v7",
	plus: "M12 5v14M5 12h14",
	send: "M12 19V5M5 12l7-7 7 7",
	// a microphone: the capsule, its stand and the base
	mic: "M12 3a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6",
	// recording: the microphone with a filled dot, so it never reads as the agent's square stop button
	"mic-rec": "M12 3a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6M19.5 4.5h.01",
	stop: "M7 7h10v10H7z",
	// drawn 0.75 higher than its first sketch: the bubble with its tail spans 4.77-19.25, centred on 12 like every other glyph
	chat: "M21 11.25a8 8 0 0 1-11.6 7.1L4 19.25l1-4.6A8 8 0 1 1 21 11.25z",
	trash: "M4 6.5h16M10 10.5v6M14 10.5v6M6 6.5l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 6.5v-3h6v3",
	edit: "M4.5 19.5h4L19.5 8.5l-4-4L4.5 15.5v4zM14.5 5.5l4 4",
	pencil: "M4.5 19.5h4L19.5 8.5l-4-4L4.5 15.5v4zM14.5 5.5l4 4",
	// two sheets with the same soft corners as the other line icons; the back one shows only its two visible sides
	copy: "M10 8.5h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2zM5 14.5a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v1",
	check: "M5 12.5l4.5 4.5L19 7.5",
	x: "M6 6l12 12M18 6L6 18",
	"chevron-down": "M6 9l6 6 6-6",
	"chevron-right": "M9 6l6 6-6 6",
	"chevron-left": "M15 6l-6 6 6 6",
	settings: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
	sun: "M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4",
	moon: "M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z",
	monitor: "M3 4.5h18v11H3zM8 19.5h8M12 15.5v4",
	phone: "M7 2h10a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zM11 19h2",
	image: "M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M9 9.5a.5.5 0 1 0 0-1 .5.5 0 0 0 0 1z",
	terminal: "M4 5h16v14H4zM7 10l3 2.5L7 15M12 15h5",
	file: "M6 3h7l5 5v13H6zM13 3v5h5",
	attach: "M21.4 11.1l-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5",
	search: "M10.5 17.5a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20.5 20.5l-5-5",
	folder: "M3 5.5h6l2 2h10v11H3z",
	// a project (a git repository): a box, so it reads apart from the folders listed in it
	// the web: a globe with its equator and one meridian
	// a goal: two rings and the centre point
	target: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 12h.01",
	globe: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3a14 14 0 0 1 3.6 9 14 14 0 0 1-3.6 9 14 14 0 0 1-3.6-9A14 14 0 0 1 12 3z",
	repo: "M12 3l8.5 4v10L12 21l-8.5-4V7zM3.5 7l8.5 4 8.5-4M12 11v10",
	brain: "M9 4a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 2 5 3 3 0 0 0 6 1V5a2 2 0 0 0-3-1zM15 4a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-2 5 3 3 0 0 1-6 1",
	// a branch: three 5px nodes (the old 6px ones read heavy beside copy and reply), the side branch joining the trunk's lower node
	fork: "M6 8v8M6 3a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM6 16a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM18 3a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM18 8a8 8 0 0 1-8 8H8.5",
	undo: "M4 12a8 8 0 1 0 2.3-5.7M4 4v5h5",
	reply: "M9 14.5L4 9.5l5-5M4 9.5h10a6 6 0 0 1 6 6v4",
	retry: "M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5",
	shield: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z",
	alert: "M12 3l10 18H2zM12 10v5M12 18h.01",
	"alert-circle": "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 8v5M12 16h.01",
	info: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v5M12 8h.01",
	"wifi-off": "M2 8.8a15 15 0 0 1 4-2.4M22 8.8a15 15 0 0 0-8.4-3.7M5 12.9a10 10 0 0 1 3.2-1.9M19 12.9a10 10 0 0 0-3-2M8.5 16.4a5 5 0 0 1 7 0M12 20h.01M2 2l20 20",
	key: "M11 12a3.5 3.5 0 1 0-7 0 3.5 3.5 0 0 0 7 0zM11 12h10M18 12v3.5M14.5 12v2.5",
	"arrow-down": "M12 5v14M5 12l7 7 7-7",
	"arrow-up": "M12 19V5M5 12l7-7 7 7",
	"arrow-left": "M19 12H5M12 5l-7 7 7 7",
	"arrow-right": "M5 12h14M12 5l7 7-7 7",
	bolt: "M13 2L4 14h7l-1 8 9-12h-7z",
	sparkles: "M9.5 4.5l1.6 4.4L15.5 10.5l-4.4 1.6L9.5 16.5l-1.6-4.4L3.5 10.5l4.4-1.6zM17.5 3.5l.8 2.2L20.5 6.5l-2.2.8L17.5 9.5l-.8-2.2L14.5 6.5l2.2-.8zM17.5 14.5l.8 2.2L20.5 17.5l-2.2.8L17.5 20.5l-.8-2.2L14.5 17.5l2.2-.8z",
	list: "M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01",
	more: "M5 12h.01M12 12h.01M19 12h.01",
	sidebar: "M4 5h16v14H4zM9.5 5v14",
	download: "M12 4v11M7.5 10.5L12 15l4.5-4.5M5 19.5h14",
	cache: "M12 2.5l9 5-9 5-9-5zM3 12l9 5 9-5M3 16.5l9 5 9-5",
	clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2",
	gauge: "M4.5 18a8.5 8.5 0 1 1 15 0M12 14l4-5M12 14h.01",
	columns: "M4 5h16v14H4zM12 5v14",
	group: "M4.5 4h4a1.5 1.5 0 0 1 1.5 1.5v3A1.5 1.5 0 0 1 8.5 10h-4A1.5 1.5 0 0 1 3 8.5v-3A1.5 1.5 0 0 1 4.5 4zM15.5 4h4A1.5 1.5 0 0 1 21 5.5v3a1.5 1.5 0 0 1-1.5 1.5h-4A1.5 1.5 0 0 1 14 8.5v-3A1.5 1.5 0 0 1 15.5 4zM4.5 14h15a1.5 1.5 0 0 1 1.5 1.5v3a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5v-3A1.5 1.5 0 0 1 4.5 14z",
	"group-open": "M4.5 3h4A1.5 1.5 0 0 1 10 4.5v4A1.5 1.5 0 0 1 8.5 10h-4A1.5 1.5 0 0 1 3 8.5v-4A1.5 1.5 0 0 1 4.5 3zM15.5 3h4A1.5 1.5 0 0 1 21 4.5v4a1.5 1.5 0 0 1-1.5 1.5h-4A1.5 1.5 0 0 1 14 8.5v-4A1.5 1.5 0 0 1 15.5 3zM4.5 14h4A1.5 1.5 0 0 1 10 15.5v4A1.5 1.5 0 0 1 8.5 21h-4A1.5 1.5 0 0 1 3 19.5v-4A1.5 1.5 0 0 1 4.5 14zM15.5 14h4a1.5 1.5 0 0 1 1.5 1.5v4a1.5 1.5 0 0 1-1.5 1.5h-4a1.5 1.5 0 0 1-1.5-1.5v-4a1.5 1.5 0 0 1 1.5-1.5z",
	expand: "M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5",
	shrink: "M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5",
	clip: "M20.5 11.5l-8.2 8.2a5 5 0 0 1-7.1-7.1l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8",
	unlink: "M9 7H7a4 4 0 0 0 0 8h2M15 7h2a4 4 0 0 1 0 8h-2M4 4l16 16",
	// 0.75 lower than first drawn: antenna tip to base spans 4.25-19.75, centred on 12 like every other glyph
	bot: "M5 9.75h14v10H5zM12 9.75V5.75M12 4.25h.01M9 14.25h.01M15 14.25h.01M2.5 13.75v3M21.5 13.75v3",
	plug: "M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4",
	skill: "M12 6.5c-1.6-1.4-3.7-2-7-2v13c3.3 0 5.4.6 7 2 1.6-1.4 3.7-2 7-2v-13c-3.3 0-5.4.6-7 2zM12 6.5v13",
	prompt: "M5 7.5l5 4-5 4M12 16.5h7",
	keyboard: "M3 6h18v12H3zM7 10h.01M11 10h.01M15 10h.01M7 14h10",
	server: "M4 4h16v6H4zM4 14h16v6H4zM8 7h.01M8 17h.01",
	widgets: "M4 4h6.5v6.5H4zM13.5 4H20v6.5h-6.5zM4 13.5h6.5V20H4zM16.75 13.5v6.5M13.5 16.75H20",
	star: "M12 3.9l2.6 5.4 5.9.8-4.3 4.1 1 5.9L12 17.3l-5.2 2.8 1-5.9L3.5 10.1l5.9-.8z",
};
