import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { badRequest } from "./errors.ts";

/** A model's `icon` that points at an uploaded image instead of one of the built-in marks. */
export const ICON_PREFIX = "img:";
export const MAX_ICON_BYTES = 256 * 1024;
/** An uploaded image nobody uses is kept this long (the form uploads before the connection is saved), then dropped. */
const UNUSED_KEEP_MS = 60 * 60_000;

/** The image type by its first bytes; only formats a browser shows safely as <img> (no SVG: it can carry script). */
function sniff(b: Buffer): string | null {
	if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
	if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
	if (b.length > 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return "image/webp";
	return null;
}

/** Images owners upload as model icons. Stored in the database, addressed by a hash of their bytes, so the same picture is stored once. */
export class ModelIcons {
	constructor(private db: Database) {}

	add(data: Buffer): string {
		if (!data.length) throw badRequest("icon image is empty");
		if (data.length > MAX_ICON_BYTES) throw badRequest(`icon image is larger than ${MAX_ICON_BYTES / 1024} KB`);
		const mime = sniff(data);
		if (!mime) throw badRequest("icon must be a PNG, JPEG or WebP image");
		const id = createHash("sha256").update(data).digest("hex").slice(0, 16);
		this.db.query("INSERT OR IGNORE INTO model_icons (id, mime, data, created_at) VALUES ($id, $mime, $data, $at)").run({ id, mime, data, at: Date.now() });
		return ICON_PREFIX + id;
	}

	get(id: string): { mime: string; data: Buffer } | undefined {
		const row = this.db.query("SELECT mime, data FROM model_icons WHERE id = $id").get({ id }) as { mime: string; data: Uint8Array } | null;
		return row ? { mime: row.mime, data: Buffer.from(row.data) } : undefined;
	}

	has(icon: string): boolean {
		return icon.startsWith(ICON_PREFIX) && Boolean(this.db.query("SELECT 1 FROM model_icons WHERE id = $id").get({ id: icon.slice(ICON_PREFIX.length) }));
	}

	list(): string[] {
		return (this.db.query("SELECT id FROM model_icons ORDER BY created_at DESC, id").all() as { id: string }[]).map((r) => ICON_PREFIX + r.id);
	}

	/** Drop images no model uses any more (recent uploads stay, a form may still be open). */
	prune(inUse: Iterable<string>): void {
		const keep = new Set([...inUse].filter((i) => i.startsWith(ICON_PREFIX)).map((i) => i.slice(ICON_PREFIX.length)));
		const rows = this.db.query("SELECT id FROM model_icons WHERE created_at < $before").all({ before: Date.now() - UNUSED_KEEP_MS }) as { id: string }[];
		for (const r of rows) if (!keep.has(r.id)) this.db.query("DELETE FROM model_icons WHERE id = $id").run({ id: r.id });
	}
}
