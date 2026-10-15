import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

// Tauri sets TAURI_DEV_HOST when running on a physical mobile device.
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
	plugins: [svelte()],
	clearScreen: false,
	envPrefix: ["VITE_", "TAURI_ENV_*"],
	server: {
		host: host || "0.0.0.0", // reachable over Tailscale
		port: 1420,
		strictPort: true,
		allowedHosts: true,
		hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
		watch: { ignored: ["**/src-tauri/**"] },
	},
	build: {
		target: "es2022",
		sourcemap: !!process.env.TAURI_ENV_DEBUG,
		minify: !process.env.TAURI_ENV_DEBUG,
	},
});
