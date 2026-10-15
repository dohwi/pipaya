import { describe, expect, test } from "bun:test";
import { remoteImageHost } from "../src/lib/remote-image";
import { blocksOf, streamSplit } from "../src/lib/markdown-split";

describe("remoteImageHost", () => {
	test("offers only http(s) images, reporting the host that would be contacted", () => {
		expect(remoteImageHost("https://evil.example/x.png?d=secret")).toBe("evil.example");
		expect(remoteImageHost("http://10.0.0.1:8080/a.png")).toBe("10.0.0.1:8080");
	});
	test("everything else is not loadable", () => {
		for (const href of ["javascript:alert(1)", "data:image/svg+xml;base64,AAAA", "file:///etc/passwd", "//evil.example/x.png", "x.png", ""]) {
			expect(remoteImageHost(href), href).toBeNull();
		}
	});
});

describe("streaming split", () => {
	test("cuts before the block being written, never inside one", () => {
		const s = "para one\n\n- a\n- b\n\n```js\nco";
		expect(s.slice(streamSplit(s))).toBe("```js\nco");
		expect(blocksOf(s.slice(0, streamSplit(s)))).toEqual(["para one", "- a\n- b"]);
	});
	test("does not split what cannot be rendered in pieces", () => {
		expect(streamSplit("only one block")).toBe(0);
		expect(streamSplit("")).toBe(0);
		// a reference definition below changes how a link above renders
		expect(streamSplit("text [r]\n\n[r]: http://x\n\nmore")).toBe(0);
	});
});
