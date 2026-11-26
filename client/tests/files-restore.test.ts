import { describe, expect, spyOn, test } from "bun:test";
import { uploadFileToDraft } from "../src/lib/files";
import type { UploadFile } from "../src/lib/types";

describe("uploadFileToDraft", () => {
	test("mints a fresh blob preview URL for raster images and never reuses a stale preview", () => {
		let seq = 0;
		const create = spyOn(URL, "createObjectURL").mockImplementation(() => `blob:fresh-${++seq}`);
		try {
			const returnedWithStalePreview = {
				name: "shot.png",
				size: 4,
				mimeType: "image/png",
				data: btoa("fake"),
				preview: "blob:revoked-old",
			} as UploadFile & { preview: string };

			const draft = uploadFileToDraft(returnedWithStalePreview);
			expect(draft.id).toBeTruthy();
			expect(draft.name).toBe("shot.png");
			expect(draft.size).toBe(4);
			expect(draft.mimeType).toBe("image/png");
			expect(draft.data).toBe(returnedWithStalePreview.data);
			expect(draft.preview).toBe("blob:fresh-1");
			expect(create).toHaveBeenCalledTimes(1);

			// Explicit id is preserved when provided (e.g. fromStored).
			const withId = uploadFileToDraft(returnedWithStalePreview, "fixed-id");
			expect(withId.id).toBe("fixed-id");
			expect(withId.preview).toBe("blob:fresh-2");
		} finally {
			create.mockRestore();
		}
	});

	test("omits preview for SVG, non-image files, empty data, and invalid base64 without throwing", () => {
		const create = spyOn(URL, "createObjectURL").mockImplementation(() => "blob:unexpected");
		try {
			const svg = uploadFileToDraft({ name: "icon.svg", size: 10, mimeType: "image/svg+xml", data: btoa("<svg/>") });
			expect(svg.preview).toBeUndefined();

			const pdf = uploadFileToDraft({ name: "doc.pdf", size: 10, mimeType: "application/pdf", data: btoa("%PDF") });
			expect(pdf.preview).toBeUndefined();

			const empty = uploadFileToDraft({ name: "empty.png", size: 0, mimeType: "image/png", data: "" });
			expect(empty.preview).toBeUndefined();

			const broken = uploadFileToDraft({ name: "bad.png", size: 3, mimeType: "image/png", data: "!!!not-base64!!!" });
			expect(broken.preview).toBeUndefined();

			expect(create).not.toHaveBeenCalled();
		} finally {
			create.mockRestore();
		}
	});
});
