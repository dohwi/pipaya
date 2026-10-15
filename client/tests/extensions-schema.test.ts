import { describe, expect, test } from "bun:test";
import {
	MAX_PACKAGE_BYTES, PERMISSIONS, SDK_VERSION, THEME_TOKENS, parsePackage,
	type ExtensionPackage,
} from "../src/lib/extensions/schema";

function fixture(): ExtensionPackage {
	return {
		manifest: {
			id: "example.tools", name: "Example tools", version: "1.2.3-beta.1",
			sdkVersion: 1, description: "Portable extension", permissions: ["commands", "composer"],
		},
		theme: { dark: { "--bg": "#123", "--accent": "#12345678", "--radius": "8px", "--content-w": "800px" } },
		commands: [{ name: "summarize", description: "Prefill a summary request", template: "Summarize this conversation." }],
		code: "export default {};",
	};
}

function codePackage(): ExtensionPackage {
	return { manifest: { ...fixture().manifest, permissions: [] }, code: "export default {};" };
}

const bytes = (input: unknown) => new TextEncoder().encode(JSON.stringify(input)).byteLength;

function rejects(input: unknown, message?: string) {
	if (message) expect(() => parsePackage(input)).toThrow(message);
	else expect(() => parsePackage(input)).toThrow();
}

describe("portable extension package schema", () => {
	test("exports the SDK, byte cap, and immutable permission/token whitelists", () => {
		expect(SDK_VERSION).toBe(1);
		expect(MAX_PACKAGE_BYTES).toBe(256 * 1024);
		expect(PERMISSIONS).toEqual(["commands", "composer", "status", "context", "storage", "notifications", "events", "ui", "navbar", "http", "configuration", "http-write", "configuration-background", "system-notifications", "locales"]);
		expect(Object.isFrozen(PERMISSIONS)).toBe(true);
		expect(Object.isFrozen(THEME_TOKENS)).toBe(true);
		expect(new Set(THEME_TOKENS).size).toBe(23);
	});

	test("accepts and reconstructs a complete portable package without transforming strings", () => {
		const input = fixture();
		input.commands![0]!.template = "  Use {{selection}}\nwith Unicode: 안녕  ";
		const output = parsePackage(input);
		expect(output).toEqual(input);
		expect(output).not.toBe(input);
		expect(output.manifest).not.toBe(input.manifest);
		expect(output.manifest.permissions).not.toBe(input.manifest.permissions);
		expect(output.theme).not.toBe(input.theme);
		expect(output.theme!.dark).not.toBe(input.theme!.dark);
		expect(output.commands).not.toBe(input.commands);
		expect(output.commands![0]).not.toBe(input.commands![0]);
		input.theme!.dark!["--bg"] = "url(evil)";
		input.commands![0]!.template = "mutated";
		input.manifest.permissions.push("storage");
		expect(output.theme!.dark!["--bg"]).toBe("#123");
		expect(output.commands![0]!.template).toContain("{{selection}}");
		expect(output.manifest.permissions).toEqual(["commands", "composer"]);
	});

	test("accepts theme-only, command-only, and code-only packages and omits absent fields", () => {
		const themeOnly = { manifest: codePackage().manifest, theme: { light: { "--text": "#abc" } } };
		expect(parsePackage(themeOnly)).toEqual(themeOnly);
		const commandOnly = { manifest: fixture().manifest, commands: fixture().commands };
		expect(parsePackage(commandOnly)).toEqual(commandOnly);
		expect(parsePackage(codePackage())).toEqual(codePackage());
		expect(Object.hasOwn(parsePackage(codePackage()), "theme")).toBe(false);
		// The contract requires a theme object, not a nonempty palette.
		expect(parsePackage({ manifest: codePackage().manifest, theme: {} }).theme).toEqual({});
	});

	test("requires at least one contribution", () => {
		for (const extras of [{}, { commands: [] }, { code: "" }, { code: " \n\t" }, { commands: [], code: "" }]) {
			rejects({ manifest: codePackage().manifest, ...extras }, "must contain");
		}
	});

	test("requires both template-prefill permissions when commands are present", () => {
		for (const permissions of [[], ["commands"], ["composer"], ["storage", "events"]]) {
			rejects({ ...fixture(), manifest: { ...fixture().manifest, permissions } }, "commands require both");
		}
		expect(parsePackage({ ...codePackage(), commands: [] }).commands).toEqual([]);
	});

	test("accepts all unique permissions and rejects unknown or duplicate entries", () => {
		const input = codePackage();
		input.manifest.permissions = [...PERMISSIONS];
		expect(parsePackage(input).manifest.permissions).toEqual(PERMISSIONS);
		for (const permissions of [["commands", "commands"], ["filesystem"], ["quota"], ["Commands"], ["__proto__"], [1], [null], [...PERMISSIONS, "storage"]]) {
			rejects({ ...codePackage(), manifest: { ...codePackage().manifest, permissions } }, "manifest.permissions");
		}
	});

	test("rejects unsupported SDK versions and wrong SDK types", () => {
		for (const sdkVersion of [0, 2, -1, 1.1, "1", null, undefined, true]) {
			rejects({ ...codePackage(), manifest: { ...codePackage().manifest, sdkVersion } }, "manifest.sdkVersion");
		}
	});

	test("accepts safe simple or namespaced IDs and rejects unsafe or overlong IDs", () => {
		for (const id of ["sync", "tools", "a.b", "example-tools.commands", "a.b0.c1", `a.${"b".repeat(78)}`]) {
			expect(parsePackage({ ...codePackage(), manifest: { ...codePackage().manifest, id } }).manifest.id).toBe(id);
		}
		for (const id of ["constructor", "prototype", "Example.tools", "1example.tools", ".example", "a..b", "a.-b", "a.b-", "a_b.c", "../evil", "a/b.c", "__proto__", "a.b\n", `a.${"b".repeat(79)}`]) {
			rejects({ ...codePackage(), manifest: { ...codePackage().manifest, id } }, "manifest.id");
		}
	});

	test("enforces simple strict SemVer without build metadata or leading numeric zeroes", () => {
		for (const version of ["0.0.0", "10.20.30", "1.0.0-alpha", "1.2.3-rc.1", "1.0.0-0", "1.0.0-01a", "1.0.0-alpha-beta"]) {
			expect(parsePackage({ ...codePackage(), manifest: { ...codePackage().manifest, version } }).manifest.version).toBe(version);
		}
		for (const version of ["1", "1.2", "v1.2.3", "01.2.3", "1.02.3", "1.2.03", "1.2.3-01", "1.2.3-", "1.2.3-a..b", "1.2.3+build", "1.2.3\n", `1.2.3-${"a".repeat(75)}`]) {
			rejects({ ...codePackage(), manifest: { ...codePackage().manifest, version } }, "manifest.version");
		}
	});

	test("bounds names and descriptions and requires meaningful display names", () => {
		const input = fixture();
		input.manifest.name = "n".repeat(80);
		input.manifest.description = "d".repeat(2000);
		input.commands![0]!.description = "d".repeat(500);
		expect(parsePackage(input)).toEqual(input);
		for (const [field, value] of [["name", "n".repeat(81)], ["name", ""], ["name", " \n"], ["description", "d".repeat(2001)]]) {
			rejects({ ...codePackage(), manifest: { ...codePackage().manifest, [field!]: value } });
		}
		for (const description of ["", " ", "d".repeat(501)]) {
			rejects({ ...fixture(), commands: [{ ...fixture().commands![0], description }] });
		}
		expect(parsePackage({ ...codePackage(), manifest: { ...codePackage().manifest, description: "" } }).manifest.description).toBe("");
	});

	test("bounds command count, names, and templates and rejects duplicates", () => {
		const input = fixture();
		input.commands = Array.from({ length: 20 }, (_, i) => ({ name: `command-${i}`, description: "Prefill", template: "t".repeat(16000) }));
		// Check the command-count boundary independently of the package-byte cap.
		for (const command of input.commands) command.template = "Prefill";
		expect(parsePackage(input).commands).toHaveLength(20);
		rejects({ ...input, commands: [...input.commands, { name: "extra", description: "Prefill", template: "Text" }] }, "at most 20");
		rejects({ ...fixture(), commands: [...fixture().commands!, ...fixture().commands!] }, "duplicate command");
		for (const name of ["Upper", "1name", "a_b", "a.b", "a/b", "a".repeat(41), "name\n", ""]) {
			rejects({ ...fixture(), commands: [{ ...fixture().commands![0], name }] }, ".name");
		}
		for (const template of ["", " \n", "t".repeat(16001)]) {
			rejects({ ...fixture(), commands: [{ ...fixture().commands![0], template }] }, ".template");
		}
		expect(parsePackage({ ...fixture(), commands: [{ name: "a".repeat(40), description: "Prefill", template: "t".repeat(16000) }] }).commands![0]!.template).toHaveLength(16000);
	});

	test("accepts every whitelisted color token and all four hex forms", () => {
		const dark = Object.fromEntries(THEME_TOKENS.map((token) => [token, token === "--content-w" ? "480px" : token.startsWith("--radius") ? "0px" : "#AbC"]));
		for (const color of ["#abc", "#AbCd", "#123456", "#12aBcD78"]) {
			dark["--bg"] = color;
			expect(parsePackage({ manifest: codePackage().manifest, theme: { dark, light: { "--bg": color } } }).theme!.dark).toEqual(dark);
		}
	});

	test("rejects malicious CSS, named colors, functions, fonts, and malformed hex", () => {
		for (const value of ["url(https://evil.test)", "var(--secret)", "rgb(0,0,0)", "hsl(0 0% 0%)", "expression(1)", "red", "transparent", "inherit", "Arial", "#12", "#12345", "#1234567", "#ggg", "#abc;", "#abc\n", " #abc", "#abc !important", "#abc;--x:1"]) {
			rejects({ manifest: codePackage().manifest, theme: { dark: { "--bg": value } } }, "theme.dark.--bg");
		}
		for (const token of ["--font", "--font-family", "--background-image", "--unknown", "color", "__proto__"]) {
			rejects({ manifest: codePackage().manifest, theme: { light: { [token]: "#abc" } } }, "unknown field");
		}
	});

	test("restricts dimensions to bounded integer px", () => {
		for (const token of ["--radius", "--radius-panel", "--radius-sm", "--content-w"]) {
			const allowed = token === "--content-w" ? ["480px", "1200px"] : ["0px", "32px"];
			for (const value of allowed) {
				expect(parsePackage({ manifest: codePackage().manifest, theme: { dark: { [token]: value } } }).theme!.dark![token]).toBe(value);
			}
			const invalid = token === "--content-w" ? ["479px", "1201px"] : ["-1px", "33px"];
			for (const value of [...invalid, "1.5px", "01px", "+1px", "8PX", "8", "8rem", "8%", "calc(1px)", "var(--x)", "8px\n", "#abc"]) {
				rejects({ manifest: codePackage().manifest, theme: { dark: { [token]: value } } }, "integer px");
			}
		}
	});

	test("limits code to 128 KiB in UTF-8 rather than just character count", () => {
		expect(parsePackage({ ...codePackage(), code: "x".repeat(128 * 1024) }).code).toHaveLength(128 * 1024);
		rejects({ ...codePackage(), code: "x".repeat(128 * 1024 + 1) }, "code");
		rejects({ ...codePackage(), code: "界".repeat(45000) }, "UTF-8 bytes");
	});

	test("enforces the inclusive total JSON UTF-8 byte limit", () => {
		const input = fixture();
		input.code = "x".repeat(120000);
		input.commands = Array.from({ length: 9 }, (_, i) => ({ name: `command-${i}`, description: "Prefill", template: i === 8 ? "" : "t".repeat(16000) }));
		const remaining = MAX_PACKAGE_BYTES - bytes(input);
		expect(remaining).toBeGreaterThan(0);
		expect(remaining).toBeLessThanOrEqual(16000);
		input.commands[8]!.template = "t".repeat(remaining);
		expect(bytes(input)).toBe(MAX_PACKAGE_BYTES);
		expect(parsePackage(input)).toEqual(input);
		input.commands[8]!.template += "t";
		rejects(input, "package: must be at most");
		const multibyte = { ...fixture(), code: "", commands: Array.from({ length: 9 }, (_, i) => ({ name: `unicode-${i}`, description: "Prefill", template: "界".repeat(10000) })) };
		expect(JSON.stringify(multibyte).length).toBeLessThan(MAX_PACKAGE_BYTES);
		expect(bytes(multibyte)).toBeGreaterThan(MAX_PACKAGE_BYTES);
		rejects(multibyte, "package: must be at most");
		// JSON escaping contributes to bytes as well as the raw string contents.
		const escaped = { ...fixture(), code: "", commands: Array.from({ length: 3 }, (_, i) => ({ name: `escape-${i}`, description: "Prefill", template: "\u0000".repeat(16000) })) };
		rejects(escaped, "package: must be at most");
	});

	test("rejects unknown fields at every object level, including model pins", () => {
		for (const input of [
			{ ...fixture(), model: "pinned-model" },
			{ ...fixture(), manifest: { ...fixture().manifest, model: "pinned-model" } },
			{ ...fixture(), manifest: { ...fixture().manifest, sdkVerison: 1 } },
			{ ...fixture(), theme: { drak: { "--bg": "#abc" } } },
			{ ...fixture(), theme: { dark: { "--bg-typo": "#abc" } } },
			{ ...fixture(), commands: [{ ...fixture().commands![0], execute: "evil" }] },
		]) rejects(input, "unknown field");
	});

	test("rejects prototype keys without polluting output objects", () => {
		for (const key of ["__proto__", "constructor", "prototype"]) {
			const payload = JSON.parse(`{"${key}":{"polluted":true}}`);
			for (const input of [
				{ ...fixture(), ...payload },
				{ ...fixture(), manifest: { ...fixture().manifest, ...payload } },
				{ ...fixture(), theme: { ...payload } },
				{ ...fixture(), theme: { dark: payload } },
				{ ...fixture(), commands: [{ ...fixture().commands![0], ...payload }] },
			]) rejects(input, "unknown field");
		}
		expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
	});

	test("rejects wrong types and missing required fields without coercion", () => {
		for (const input of [null, undefined, true, 1, "{}", [], new Date(), new Map(), Object.create({ manifest: fixture().manifest }), {}]) rejects(input);
		for (const manifest of [null, [], "manifest", 1]) rejects({ ...fixture(), manifest });
		for (const field of ["id", "name", "version", "sdkVersion", "permissions"]) {
			const manifest: Record<string, unknown> = { ...fixture().manifest };
			delete manifest[field];
			rejects({ ...fixture(), manifest });
		}
		for (const field of ["id", "name", "version", "description"]) {
			for (const value of [null, undefined, 42, true, {}, []]) rejects({ ...fixture(), manifest: { ...fixture().manifest, [field]: value } });
		}
		for (const value of [null, undefined, "commands", {}, true]) {
			rejects({ ...fixture(), commands: value });
			rejects({ ...fixture(), manifest: { ...fixture().manifest, permissions: value } });
		}
		for (const value of [null, undefined, [], "theme", 42]) {
			rejects({ ...fixture(), theme: value });
			rejects({ ...fixture(), theme: { dark: value } });
		}
		for (const value of [null, undefined, {}, [], 42, true]) rejects({ ...fixture(), code: value });
		for (const value of [null, undefined, {}, [], 42, true]) rejects({ ...fixture(), theme: { light: { "--bg": value } } });
		for (const command of [null, [], "command", {}]) rejects({ ...fixture(), commands: [command] });
		for (const field of ["name", "description", "template"]) {
			for (const value of [null, undefined, 42, true, {}, []]) rejects({ ...fixture(), commands: [{ ...fixture().commands![0], [field]: value }] });
		}
	});

	test("accepts null-prototype data but emits ordinary, sanitized objects", () => {
		const input = Object.assign(Object.create(null), codePackage());
		input.manifest = Object.assign(Object.create(null), input.manifest);
		input.theme = Object.assign(Object.create(null), { dark: Object.assign(Object.create(null), { "--bg": "#abc" }) });
		const output = parsePackage(input);
		for (const value of [output, output.manifest, output.theme, output.theme!.dark]) {
			expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
		}
		expect(Object.keys(output)).toEqual(["manifest", "theme", "code"]);
	});

	test("rejects accessors, symbols, hidden fields, serialization hooks, and non-JSON arrays", () => {
		let reads = 0;
		const accessor = { ...fixture() };
		Object.defineProperty(accessor, "code", { enumerable: true, get() { reads++; return "evil"; } });
		rejects(accessor, "data field");
		expect(reads).toBe(0);
		rejects({ ...fixture(), [Symbol("hidden")]: "evil" }, "unknown field");
		rejects(Object.defineProperty(fixture(), "code", { value: "evil", enumerable: false }), "data field");
		rejects({ ...fixture(), toJSON() { throw new Error("must not run"); } }, "unknown field");
		const hidden = Object.assign(["commands", "composer"], { toJSON() { throw new Error("must not run"); } });
		rejects({ ...fixture(), manifest: { ...fixture().manifest, permissions: hidden } }, "dense JSON array");
		const sparse = new Array(2);
		rejects({ ...fixture(), commands: sparse }, "dense JSON array");
		const accessorArray = ["commands", "composer"];
		Object.defineProperty(accessorArray, "0", { enumerable: true, get() { reads++; return "commands"; } });
		rejects({ ...fixture(), manifest: { ...fixture().manifest, permissions: accessorArray } }, "array data entry");
		expect(reads).toBe(0);
	});
});
