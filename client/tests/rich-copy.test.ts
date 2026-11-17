import { describe, expect, test } from "bun:test";
import { htmlImages, messageHtml, pastedMessage, shiftImageTokens } from "../src/lib/rich-copy";

const png = { type: "image" as const, data: "iVBORw0KGgo=", mimeType: "image/png" };
const jpg = { type: "image" as const, data: "/9j/4AAQ", mimeType: "image/jpeg" };

describe("rich copy", () => {
	test("a copied message reads back as itself, pictures in order", () => {
		const text = 'look at #image1 & "#image2"\n<b>not html</b>';
		const html = messageHtml(text, [png, jpg]);
		expect(html).toContain("&lt;b&gt;");
		expect(pastedMessage(html)).toEqual({ text, images: [png, jpg] });
	});

	test("the browser's wrapping around the copied HTML does not matter", () => {
		const html = `<html><body><!--StartFragment-->${messageHtml("hi #image1", [png])}<!--EndFragment--></body></html>`;
		expect(pastedMessage(html)?.text).toBe("hi #image1");
	});

	test("other HTML is not a pipaya message, but its inline pictures are found (links are not)", () => {
		const html = `<p>x</p><img alt=a src="data:image/PNG;base64,iVBO\nRw=="><img src="https://e.com/a.png">`;
		expect(pastedMessage(html)).toBeNull();
		expect(htmlImages(html)).toEqual([{ type: "image", mimeType: "image/png", data: "iVBORw==" }]);
	});

	test("#imageN moves after the pictures already attached, only for its own pictures", () => {
		expect(shiftImageTokens("a #image1 b #image2 c #image5", 2, 2)).toBe("a #image3 b #image4 c #image5");
		expect(shiftImageTokens("#image1", 0, 1)).toBe("#image1");
	});
});
