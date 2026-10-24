import { fileRejection, fileToDraft, isInlineImage, MAX_FILE_BYTES, MAX_FILES, MAX_FILES_TOTAL, MAX_IMAGES, type FileDraft } from "./files";
import { fileToAttachment, type Attachment } from "./images";
import { t } from "./i18n";

/** What the composer needs from the outside: a place to report problems, and to type the `#imageN` token. */
export interface AttachmentHost {
	/** Whether the model in use can look at pictures (else they travel as plain files) */
	vision(): boolean;
	error(message: string): void;
	/** An image was added: put its `#imageN` token in the text */
	imageAdded(n: number): void;
}

export const rejectionText = (reason: "count" | "size" | "total", name: string): string =>
	reason === "count"
		? t("파일은 최대 {n}개까지 첨부할 수 있습니다", { n: MAX_FILES })
		: reason === "size"
			? t("{name}: 파일은 {n}MB까지 첨부할 수 있습니다", { name, n: MAX_FILE_BYTES / 1024 / 1024 })
			: t("한 메시지에 첨부할 수 있는 파일은 모두 합쳐 {n}MB까지입니다", { n: MAX_FILES_TOTAL / 1024 / 1024 });

/** Blob URLs of the thumbnails are held until the draft is gone. */
export function releaseFiles(list: readonly FileDraft[]): void {
	for (const f of list) if (f.preview) URL.revokeObjectURL(f.preview);
}

/**
 * What is attached to the message being written: pictures the model can see (inline, downscaled) and everything else
 * (sent as files). Adding checks the limits and reports through the host; a `.svelte.ts` module so a template reading
 * `images` / `files` updates.
 */
export class Attachments {
	images = $state<Attachment[]>([]);
	/** Non-image files (and images a text-only model cannot see): sent as-is, saved in the working directory */
	files = $state<FileDraft[]>([]);

	constructor(private host: AttachmentHost) {}

	get any(): boolean {
		return this.images.length > 0 || this.files.length > 0;
	}

	/** Pictures the model can see go in as images (downscaled); everything else is attached as a file. */
	async add(picked: Iterable<File>): Promise<void> {
		const fail = (name: string, fallback: string) => this.host.error(t("{name}을(를) 읽지 못했습니다", { name: name || fallback }));
		for (const f of picked) {
			if (isInlineImage(f, this.host.vision())) {
				if (this.images.length >= MAX_IMAGES) {
					this.host.error(t("이미지는 최대 8장까지 첨부할 수 있습니다"));
					continue;
				}
				try {
					this.images.push(await fileToAttachment(f));
					this.host.imageAdded(this.images.length);
				} catch {
					fail(f.name, t("이미지"));
				}
				continue;
			}
			const rejected = fileRejection(f, this.files);
			if (rejected) {
				this.host.error(rejectionText(rejected.reason, f.name));
				if (rejected.stop) break;
				continue;
			}
			try {
				this.files.push(await fileToDraft(f));
			} catch {
				fail(f.name, t("파일"));
			}
		}
	}

	/** Remove an image; returns its 1-based number so the caller can drop the `#imageN` token. */
	removeImage(id: string): number | null {
		const i = this.images.findIndex((x) => x.id === id);
		if (i < 0) return null;
		this.images = this.images.filter((x) => x.id !== id);
		return i + 1;
	}

	removeFile(id: string): void {
		const f = this.files.find((x) => x.id === id);
		if (f) releaseFiles([f]);
		this.files = this.files.filter((x) => x.id !== id);
	}

	/** Forget everything (after a send), freeing the thumbnails. */
	clear(): void {
		this.images = [];
		releaseFiles(this.files);
		this.files = [];
	}

	/** Swap in a stored draft's attachments without freeing them (they belong to that draft). */
	load(images: Attachment[], files: FileDraft[]): void {
		this.images = images;
		this.files = files;
	}
}
