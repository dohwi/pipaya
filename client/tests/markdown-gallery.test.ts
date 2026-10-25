import { describe, expect, test } from "bun:test";
import { groupPictures } from "../src/lib/gallery";

const pic = (n: number) => `<span class="wd-img" data-wd-src="out/${n}.png" data-alt="">out/${n}.png</span>`;

describe("groupPictures", () => {
	test("leaves a lone picture alone", () => {
		const html = `<p>${pic(1)}</p>`;
		expect(groupPictures(html)).toBe(html);
	});

	test("groups pictures separated by line breaks", () => {
		const out = groupPictures(`<p>${pic(1)}<br>${pic(2)}<br>${pic(3)}</p>`);
		expect(out).toContain('class="gallery" data-count="3"');
		expect(out.match(/wd-img/g)?.length).toBe(3);
	});

	test("groups pictures in consecutive paragraphs", () => {
		const out = groupPictures(`<p>${pic(1)}</p>\n<p>${pic(2)}</p>\n`);
		expect(out).toContain('data-count="2"');
		expect(out).not.toContain("<p>");
	});

	test("keeps text around the pictures and does not group across text", () => {
		const html = `<p>before</p><p>${pic(1)}</p><p>between</p><p>${pic(2)}</p>`;
		expect(groupPictures(html)).toBe(html);
	});

	test("a paragraph with text and pictures is not a gallery", () => {
		const html = `<p>see ${pic(1)} and ${pic(2)}</p>`;
		expect(groupPictures(html)).toBe(html);
	});
});
