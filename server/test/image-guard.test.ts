import { describe, expect, test } from "bun:test";
import * as photon from "@silvia-odwyer/photon-node";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { sniffImage } from "../src/image-file.ts";
import { fitImagesInContext } from "../src/image-guard.ts";

const png = (w: number, h: number) => Buffer.from(new photon.PhotonImage(new Uint8Array(w * h * 4).fill(200), w, h).get_bytes());
const msg = (role: string, data: Buffer): AgentMessage => ({ role, content: [{ type: "text", text: "x" }, { type: "image", data: data.toString("base64"), mimeType: "image/png" }], timestamp: 0 }) as unknown as AgentMessage;
const imageOf = (m: AgentMessage) => (m as unknown as { content: { type: string; data: string }[] }).content[1]!;

describe("fitImagesInContext", () => {
	test("shrinks a 3200x1800 picture in an old tool result", async () => {
		const out = await fitImagesInContext([msg("toolResult", png(3200, 1800))]);
		const info = sniffImage(Buffer.from(imageOf(out[0]!).data, "base64"))!;
		expect(Math.max(info.width!, info.height!)).toBeLessThanOrEqual(2000);
	});

	test("small pictures and the same array pass through untouched", async () => {
		const input = [msg("user", png(100, 100))];
		expect(await fitImagesInContext(input)).toBe(input);
	});

	test("a model limit above 2000 is capped", async () => {
		const out = await fitImagesInContext([msg("user", png(2800, 600))], { maxWidth: 4000, maxHeight: 4000 });
		expect(sniffImage(Buffer.from(imageOf(out[0]!).data, "base64"))!.width).toBeLessThanOrEqual(2000);
	});

	test("an undecodable picture is replaced by a text note", async () => {
		const out = await fitImagesInContext([msg("user", Buffer.from("not a picture"))]);
		expect((out[0] as unknown as { content: { type: string }[] }).content[1]!.type).toBe("text");
	});

	test("the input messages are not mutated", async () => {
		const input = [msg("toolResult", png(3200, 1800))];
		const before = imageOf(input[0]!).data;
		await fitImagesInContext(input);
		expect(imageOf(input[0]!).data).toBe(before);
	});
});
