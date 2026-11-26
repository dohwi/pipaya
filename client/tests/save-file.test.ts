import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { dataUrlToBlob, saveFile, sourceBlob } from "../src/lib/save-file";

test("dataUrlToBlob decodes base64 and percent-encoded payloads", async () => {
	const b = dataUrlToBlob("data:text/plain;base64,aGk=");
	expect(b.type.startsWith("text/plain")).toBe(true);
	expect(await b.text()).toBe("hi");
	expect(await dataUrlToBlob("data:,a%20b").text()).toBe("a b");
	expect(dataUrlToBlob("data:;base64,AA==").type).toBe("application/octet-stream");
	expect(() => dataUrlToBlob("data:nope")).toThrow();
});

test("sourceBlob passes a Blob through and decodes data: URLs without fetch", async () => {
	const blob = new Blob(["x"]);
	expect(await sourceBlob(blob)).toBe(blob);
	expect(await (await sourceBlob("data:text/plain,yo")).text()).toBe("yo");
});

test("sourceBlob fetches http(s) URLs with no-referrer/omit credentials and surfaces HTTP/network failures", async () => {
	const g = globalThis as Record<string, unknown>;
	const orig = g.fetch;
	let lastInit: RequestInit | undefined;
	g.fetch = async (_url: string, init?: RequestInit) => {
		lastInit = init;
		return new Response("net");
	};
	try {
		expect(await (await sourceBlob("https://x/y")).text()).toBe("net");
		expect(lastInit).toEqual({ referrerPolicy: "no-referrer", credentials: "omit" });
		g.fetch = async (_url: string, init?: RequestInit) => {
			lastInit = init;
			return new Response("local");
		};
		expect(await (await sourceBlob("blob:http://localhost/1")).text()).toBe("local");
		expect(lastInit).toBeUndefined();
		g.fetch = async () => new Response("nope", { status: 404 });
		await expect(sourceBlob("https://x/missing")).rejects.toThrow("HTTP 404");
		g.fetch = async () => Promise.reject(new Error("cors"));
		await expect(sourceBlob("https://x/y")).rejects.toThrow("cors");
	} finally {
		g.fetch = orig;
	}
});

let win: Window;
const g = globalThis as Record<string, unknown>;
const saved: Record<string, unknown> = {};
beforeEach(() => {
	win = new Window();
	for (const k of ["document"]) saved[k] = g[k];
	g.document = win.document;
});
afterEach(() => {
	for (const k of Object.keys(saved)) g[k] = saved[k];
	win.close();
});

test("web saveFile clicks an anchor with the file name and resolves true", async () => {
	const urls: string[] = [];
	const origCreate = URL.createObjectURL;
	URL.createObjectURL = () => (urls.push("u"), "blob:fake");
	let clicked: { download: string; href: string } | null = null;
	const origCreateEl = win.document.createElement.bind(win.document);
	(win.document as unknown as { createElement: (t: string) => unknown }).createElement = (tag: string) => {
		const el = origCreateEl(tag) as unknown as HTMLAnchorElement;
		if (tag === "a") el.click = () => void (clicked = { download: el.download, href: el.href });
		return el;
	};
	try {
		expect(await saveFile(new Blob(["x"]), "a.txt")).toBe(true);
		expect(clicked as unknown).toEqual({ download: "a.txt", href: "blob:fake" });
		expect(win.document.querySelector("a")).toBeNull();
		await expect(saveFile("data:bad", "b")).rejects.toThrow();
	} finally {
		URL.createObjectURL = origCreate;
	}
});
