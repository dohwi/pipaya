/**
 * Render the icon PNG masters and web favicons from the logo SVGs (logo/build_mark.py writes them).
 *   src-tauri/app-icon.png           1024 opaque tile master (cream background, colour tree)
 *   src-tauri/app-icon-glyph.png     the same artwork on transparent
 *   src-tauri/app-icon-adaptive.png  Android adaptive foreground (crown inside the safe zone, trunk to the bottom edge)
 *   src-tauri/app-icon-mark.png      the whole tree as a single-colour silhouette (notification icon)
 *   public/favicon.svg, favicon-{16,32,64}.png, favicon.ico   single-colour mark, as before
 * Then run `python3 scripts/make-icons.py` for the per-OS icon sets.
 * Run from client/:  bun scripts/render-icons.ts
 */
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Resvg } from "@resvg/resvg-js";

const LOGO = resolve(import.meta.dir, "../../logo/svg");
const TAURI = resolve(import.meta.dir, "../src-tauri");
const PUBLIC = resolve(import.meta.dir, "../public");

function render(svg: string, width: number): Buffer {
	return Buffer.from(new Resvg(readFileSync(resolve(LOGO, svg), "utf8"), { fitTo: { mode: "width", value: width } }).render().asPng());
}

/** ICO container with PNG payloads (supported since Windows Vista and by every browser). */
function ico(pngs: { size: number; data: Buffer }[]): Buffer {
	const head = Buffer.alloc(6 + 16 * pngs.length);
	head.writeUInt16LE(0, 0);
	head.writeUInt16LE(1, 2);
	head.writeUInt16LE(pngs.length, 4);
	let offset = head.length;
	pngs.forEach(({ size, data }, i) => {
		const e = 6 + 16 * i;
		head.writeUInt8(size >= 256 ? 0 : size, e);
		head.writeUInt8(size >= 256 ? 0 : size, e + 1);
		head.writeUInt16LE(1, e + 4); // colour planes
		head.writeUInt16LE(32, e + 6); // bits per pixel
		head.writeUInt32LE(data.length, e + 8);
		head.writeUInt32LE(offset, e + 12);
		offset += data.length;
	});
	return Buffer.concat([head, ...pngs.map((p) => p.data)]);
}

writeFileSync(resolve(TAURI, "app-icon.png"), render("app-icon.svg", 1024));
writeFileSync(resolve(TAURI, "app-icon-glyph.png"), render("app-icon-glyph.svg", 1024));
writeFileSync(resolve(TAURI, "app-icon-adaptive.png"), render("app-icon-adaptive.svg", 1024));
writeFileSync(resolve(TAURI, "app-icon-mark.png"), render("app-icon-mark.svg", 1024));
copyFileSync(resolve(LOGO, "app-icon.svg"), resolve(TAURI, "app-icon.svg"));

copyFileSync(resolve(LOGO, "favicon.svg"), resolve(PUBLIC, "favicon.svg"));
const fav = Object.fromEntries([16, 32, 64].map((s) => [s, render("favicon.svg", s)]));
for (const s of [16, 32, 64]) writeFileSync(resolve(PUBLIC, `favicon-${s}.png`), fav[s]);
writeFileSync(resolve(PUBLIC, "favicon.ico"), ico([16, 32].map((size) => ({ size, data: fav[size] }))));
console.log("icon masters and favicons rendered");
