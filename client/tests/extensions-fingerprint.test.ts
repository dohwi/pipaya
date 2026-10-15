import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { sha256, canonical, configurationFingerprint } from "../src/lib/extensions/fingerprint";
test("sync SHA-256 matches native vectors, multiblock and Unicode", () => {
  for (const text of ["", "abc", "설정", "x".repeat(100000)]) expect(sha256(text)).toBe(createHash("sha256").update(text).digest("hex"));
  expect(canonical({ b: 1, a: 2 })).toBe(canonical({ a: 2, b: 1 }));
  expect(configurationFingerprint({ servers: [{baseUrl:"b"},{baseUrl:"a"}], extensions: [] })).toBe(configurationFingerprint({ servers: [{baseUrl:"a"},{baseUrl:"b"}], extensions: [] }));
});
