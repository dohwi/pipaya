import { expect, test } from "bun:test";
import { makeQuote, parsePeer, splitQuote } from "../src/lib/quote";

test("parsePeer reads sender and body", () => {
	expect(parsePeer("[from @지우, another session on this server; answer with peer_send to @지우 only if a reply is needed]\n안녕")).toEqual({ from: "지우", body: "안녕" });
	expect(parsePeer("hello")).toBeNull();
});
test("quote round trip", () => {
	const q = makeQuote("a\nb");
	expect(q).toBe("> a\n> b\n\n");
	expect(splitQuote(`${q}answer`)).toEqual({ quote: "a\nb", rest: "answer" });
	expect(splitQuote("plain")).toEqual({ quote: "", rest: "plain" });
});
