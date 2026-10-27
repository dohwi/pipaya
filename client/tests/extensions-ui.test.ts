import { describe, expect, test } from "bun:test";
import {
	UI_LIMITS, UIValidationError, fieldsIn, findNode, parsePanelSpec, parseView, validateUIEvent,
	type UIEvent, type UINode,
} from "../src/lib/extensions/ui";

const bytes = (input: unknown) => new TextEncoder().encode(JSON.stringify(input)).byteLength;

function every(): UINode {
	return {
		type: "stack", id: "root", direction: "horizontal", gap: "large",
		children: [
			{ type: "grid", id: "grid", columns: 3, children: [{ type: "divider", id: "rule" }] },
			{
				type: "card", id: "card", title: "Card", description: "Described",
				children: [
					{ type: "text", id: "heading", text: "Hello", tone: "info", size: "heading" },
					{ type: "badge", id: "badge", text: "New", tone: "success" },
					{ type: "code", id: "code", text: "const a = 1;", language: "ts" },
					{ type: "alert", id: "alert", text: "Careful", title: "Warn", tone: "warning" },
					{ type: "progress", id: "progress", label: "Done", value: 5, max: 10 },
					{ type: "stat", id: "stat", label: "Users", value: "12", hint: "last week" },
					{
						type: "table", id: "table", caption: "Cap",
						columns: [{ id: "name", label: "Name" }, { id: "age", label: "Age" }],
						rows: [{ id: "r1", cells: ["Ann", "3"] }, { id: "r2", cells: ["", "4"] }],
					},
					{
						type: "list", id: "list", emptyText: "none",
						items: [{ id: "i1", title: "One", description: "d", badge: "b" }, { id: "i2", title: "Two" }],
					},
					{ type: "button", id: "go", label: "Go", variant: "danger", disabled: false },
				],
			},
			{
				type: "tabs", id: "tabs",
				items: [
					{
						id: "tab-a", label: "A",
						children: [{
							type: "form", id: "form", submitLabel: "Send", disabled: false,
							children: [
								{ type: "input", id: "email", label: "Email", inputType: "email", required: true, value: "a@b.co", placeholder: "x", minLength: 3, maxLength: 50 },
								{ type: "textarea", id: "notes", label: "Notes", rows: 4, minLength: 0, maxLength: 100, value: "hi" },
								{ type: "select", id: "color", label: "Color", value: "red", required: true, options: [{ value: "red", label: "Red" }, { value: "blue", label: "Blue" }] },
								{ type: "checkbox", id: "agree", label: "Agree", checked: false, required: true },
							],
						}],
					},
					{ id: "tab-b", label: "B", children: [{ type: "text", id: "other", text: "x" }] },
				],
			},
		],
	};
}

function formView(...children: unknown[]): UINode {
	return { type: "form", id: "f", submitLabel: "Go", children } as UINode;
}

function rejects(input: unknown, message?: string) {
	if (message) expect(() => parseView(input)).toThrow(message);
	else expect(() => parseView(input)).toThrow();
}

function eventRejects(view: UINode, event: unknown, message?: string) {
	if (message) expect(() => validateUIEvent(view, event)).toThrow(message);
	else expect(() => validateUIEvent(view, event)).toThrow();
}

const text = (id: string, extra: object = {}) => ({ type: "text", id, text: "t", ...extra });
const nest = (levels: number): unknown => {
	let node: unknown = text("leaf");
	for (let i = 0; i < levels - 1; i++) node = { type: "stack", id: `s${i}`, children: [node] };
	return node;
};

describe("parseView", () => {
	test("accepts every component and returns an equal but fresh tree", () => {
		const input = every();
		const output = parseView(input);
		expect(output).toEqual(input);
		expect(output).not.toBe(input);
		const card = (output as any).children[1];
		expect(card).not.toBe((input as any).children[1]);
		(input as any).children[1].children[0].text = "mutated";
		expect(card.children[0].text).toBe("Hello");
	});

	test("accepts each node type with only required fields", () => {
		const nodes = [
			{ type: "stack", id: "a", children: [] }, { type: "grid", id: "a", children: [] },
			{ type: "card", id: "a", children: [] }, { type: "tabs", id: "a", items: [{ id: "t", label: "T", children: [] }] },
			{ type: "form", id: "a", submitLabel: "Go", children: [] }, text("a"),
			{ type: "badge", id: "a", text: "b" }, { type: "divider", id: "a" }, { type: "code", id: "a", text: "x" },
			{ type: "alert", id: "a", text: "x" }, { type: "progress", id: "a", label: "p", value: 0 },
			{ type: "stat", id: "a", label: "l", value: "v" },
			{ type: "table", id: "a", columns: [{ id: "c", label: "C" }], rows: [] },
			{ type: "list", id: "a", items: [] }, { type: "button", id: "a", label: "b" },
			{ type: "input", id: "a", label: "l" }, { type: "textarea", id: "a", label: "l" },
			{ type: "select", id: "a", label: "l", options: [{ value: "x", label: "X" }] },
			{ type: "checkbox", id: "a", label: "l" },
		];
		for (const node of nodes) expect(parseView(node)).toEqual(node as UINode);
	});

	test("accepts null-prototype data and omits absent optional fields", () => {
		const input = Object.assign(Object.create(null), { type: "divider", id: "x" });
		const output = parseView(input);
		expect(output).toEqual({ type: "divider", id: "x" });
		expect(Object.hasOwn(output, "tone")).toBe(false);
	});

	test("rejects non-objects, unknown types and unknown fields with deterministic paths", () => {
		for (const bad of [null, undefined, 1, "x", [], () => 0]) rejects(bad, "view: expected a plain object");
		rejects({ id: "a" }, "view.type: expected one of");
		rejects({ type: "iframe", id: "a" }, "view.type: expected one of");
		rejects({ type: "toString", id: "a" }, "view.type: expected one of");
		rejects({ type: "__proto__", id: "a" }, "view.type: expected one of");
		rejects({ type: "divider", id: "a", className: "x" }, "view: unknown field className for divider");
		rejects({ type: "divider", id: "a", style: "color:red" }, "unknown field style");
		rejects({ type: "text", id: "a", text: "t", html: "<b>" }, "unknown field html");
		rejects({ type: "button", id: "a", label: "b", href: "javascript:alert(1)" }, "unknown field href");
		rejects({ type: "button", id: "a", label: "b", onClick: "x" }, "unknown field onClick");
		rejects({ type: "textarea", id: "a", label: "l", inputType: "text" }, "unknown field inputType");
		rejects({ type: "input", id: "a", label: "l", rows: 3 }, "unknown field rows");
		rejects({ type: "checkbox", id: "a", label: "l", value: true }, "unknown field value");
		rejects({ type: "stack", id: "a", children: [text("b", { extra: 1 })] }, "view.children[0]: unknown field extra");
		rejects({ type: "table", id: "a", columns: [{ id: "c", label: "C", width: 1 }], rows: [] }, "unknown field width");
		rejects({ type: "list", id: "a", items: [{ id: "i", title: "T", href: "x" }] }, "unknown field href");
		rejects({ type: "select", id: "a", label: "l", options: [{ value: "v", label: "V", disabled: true }] }, "unknown field disabled");
		rejects({ type: "tabs", id: "a", items: [{ id: "t", label: "T", children: [], active: true }] }, "unknown field active");
	});

	test("rejects prototype pollution vectors, symbols, accessors, class instances and hidden fields", () => {
		rejects(JSON.parse('{"type":"divider","id":"a","__proto__":{"x":1}}'), "unknown field __proto__");
		rejects(JSON.parse('{"type":"divider","id":"a","constructor":{}}'), "unknown field constructor");
		rejects({ type: "divider", id: "a", [Symbol("s")]: 1 }, "unknown field Symbol(s)");
		const getter = { type: "divider" } as any;
		Object.defineProperty(getter, "id", { enumerable: true, get: () => "a" });
		rejects(getter, "view.id: expected an enumerable data field");
		const hidden = { type: "divider", id: "a" } as any;
		Object.defineProperty(hidden, "secret", { enumerable: false, value: 1 });
		rejects(hidden, "view.secret: expected an enumerable data field");
		class Node { type = "divider"; id = "a"; }
		rejects(new Node(), "expected a plain object");
		rejects(Object.create({ type: "divider", id: "a" }), "expected a plain object");
		rejects(Object.setPrototypeOf({ type: "divider", id: "a" }, Array.prototype), "expected a plain object");
		const proxy = new Proxy({ type: "divider", id: "a" }, {});
		expect(parseView(proxy)).toEqual({ type: "divider", id: "a" });
		expect((Object.prototype as any).polluted).toBeUndefined();
		let calls = 0;
		const toJSON = { type: "divider", id: "a" } as any;
		Object.defineProperty(toJSON, "toJSON", { enumerable: false, value: () => { calls++; return {}; } });
		rejects(toJSON, "view.toJSON: expected an enumerable data field");
		expect(calls).toBe(0);
	});

	test("rejects malicious or sparse arrays", () => {
		const children: any[] = [text("b")];
		(children as any).extra = 1;
		rejects({ type: "stack", id: "a", children }, "dense JSON array");
		rejects({ type: "stack", id: "a", children: new Array(2) }, "dense JSON array");
		const accessor: any[] = [];
		Object.defineProperty(accessor, "0", { enumerable: true, get: () => text("b") });
		rejects({ type: "stack", id: "a", children: accessor }, "expected an array data entry");
		class Sub extends Array {}
		rejects({ type: "stack", id: "a", children: Sub.from([text("b")]) }, "expected an array");
		rejects({ type: "stack", id: "a", children: { length: 0 } }, "expected an array");
		rejects({ type: "stack", id: "a", children: "x" }, "expected an array");
		rejects({ type: "stack", id: "a" }, "view.children: is required");
	});

	test("rejects circular structures without hanging", () => {
		const loop: any = { type: "stack", id: "loop", children: [] };
		loop.children.push(loop);
		rejects(loop, "cycle detected");
		const a: any = { type: "stack", id: "a", children: [] };
		const b: any = { type: "stack", id: "b", children: [a] };
		a.children.push(b);
		rejects(a, "cycle detected");
		// The same object reused as a sibling is not a cycle but is a duplicate ID.
		const shared = text("shared");
		rejects({ type: "stack", id: "a", children: [shared, shared] }, "duplicate ID shared");
	});

	test("enforces ID syntax exactly", () => {
		for (const id of ["", "A", "1a", "-a", "a_b", "a b", "a.b", "a".repeat(41), "a\n", "\na", "é", "a\u0000"]) {
			rejects({ type: "divider", id }, "view.id");
		}
		for (const id of ["a", "a1", "a-b-", "a".repeat(40)]) expect(parseView({ type: "divider", id })).toEqual({ type: "divider", id });
		rejects({ type: "divider" }, "view.id: is required");
		rejects({ type: "divider", id: 1 }, "view.id: expected a string");
		rejects({ type: "tabs", id: "t", items: [{ id: "BAD", label: "x", children: [] }] }, "items[0].id");
		rejects({ type: "table", id: "t", columns: [{ id: "c\n", label: "C" }], rows: [] }, "columns[0].id");
		rejects({ type: "table", id: "t", columns: [{ id: "c", label: "C" }], rows: [{ id: "r\n", cells: [""] }] }, "rows[0].id");
		rejects({ type: "list", id: "t", items: [{ id: "A", title: "x" }] }, "items[0].id");
	});

	test("enforces ID uniqueness across the tree including tab item IDs", () => {
		rejects({ type: "stack", id: "a", children: [text("a")] }, "duplicate ID a");
		rejects({ type: "stack", id: "a", children: [text("b"), { type: "card", id: "c", children: [text("b")] }] }, "duplicate ID b");
		rejects({ type: "tabs", id: "a", items: [{ id: "t", label: "T", children: [] }, { id: "t", label: "U", children: [] }] }, "duplicate ID t");
		rejects({ type: "tabs", id: "a", items: [{ id: "a", label: "T", children: [] }] }, "duplicate ID a");
		rejects({ type: "tabs", id: "a", items: [{ id: "t", label: "T", children: [text("t")] }] }, "duplicate ID t");
		rejects({ type: "stack", id: "a", children: [text("t"), { type: "tabs", id: "x", items: [{ id: "t", label: "T", children: [] }] }] }, "duplicate ID t");
	});

	test("row, column and list item IDs are unique only locally", () => {
		const view = {
			type: "stack", id: "root", children: [
				{ type: "table", id: "table", columns: [{ id: "x", label: "X" }], rows: [{ id: "x", cells: ["1"] }] },
				{ type: "list", id: "list", items: [{ id: "x", title: "X" }] },
				{ type: "table", id: "other", columns: [{ id: "x", label: "X" }], rows: [{ id: "x", cells: ["2"] }] },
			],
		};
		expect(parseView(view)).toEqual(view as UINode);
		rejects({ type: "table", id: "t", columns: [{ id: "c", label: "C" }], rows: [{ id: "r", cells: [""] }, { id: "r", cells: [""] }] }, "rows[1].id: duplicate ID r");
		rejects({ type: "table", id: "t", columns: [{ id: "c", label: "C" }, { id: "c", label: "D" }], rows: [] }, "columns[1].id: duplicate ID c");
		rejects({ type: "list", id: "t", items: [{ id: "r", title: "A" }, { id: "r", title: "B" }] }, "items[1].id: duplicate ID r");
	});

	test("enforces depth, node count and fan-out limits", () => {
		expect(parseView(nest(UI_LIMITS.depth))).toBeDefined();
		rejects(nest(UI_LIMITS.depth + 1), "at most 8 levels");
		// Tab and card nesting count toward depth too.
		let deep: unknown = text("leaf");
		for (let i = 0; i < 4; i++) deep = { type: "card", id: `c${i}`, children: [{ type: "tabs", id: `t${i}`, items: [{ id: `i${i}`, label: "I", children: [deep] }] }] };
		rejects(deep, "at most 8 levels");

		const flat = (count: number, per = 50) => {
			const groups: unknown[] = [];
			let made = 0;
			let g = 0;
			while (made < count) {
				const size = Math.min(per, count - made - 1);
				groups.push({ type: "stack", id: `g${g}`, children: Array.from({ length: size }, (_, i) => text(`n${g}-${i}`)) });
				made += size + 1;
				g++;
			}
			return { type: "stack", id: "root", children: groups };
		};
		// root + groups + leaves: 1 + 4 groups (50 each incl.) = 200 nodes exactly
		const at = flat(UI_LIMITS.nodes - 1, 50);
		let n = 0;
		const count = (node: any): number => 1 + (node.children ?? []).reduce((s: number, c: any) => s + count(c), 0);
		n = count(at);
		expect(n).toBe(200);
		expect(parseView(at)).toBeDefined();
		const over = structuredClone(at) as any;
		over.children[3].children.push(text("one-more"));
		rejects(over, "at most 200 nodes");

		rejects({ type: "stack", id: "a", children: Array.from({ length: 51 }, (_, i) => text(`n${i}`)) }, "at most 50 entries");
		expect(parseView({ type: "stack", id: "a", children: Array.from({ length: 50 }, (_, i) => text(`n${i}`)) })).toBeDefined();
	});

	test("enforces the serialized UTF-8 byte cap", () => {
		const big = (chars: number, ch: string) => ({
			type: "stack", id: "root",
			children: Array.from({ length: 5 }, (_, i) => ({ type: "code", id: `c${i}`, text: ch.repeat(chars) })),
		});
		expect(bytes(parseView(big(10000, "a")))).toBeLessThan(UI_LIMITS.viewBytes);
		// 5 x 16000 ASCII = 80000 bytes > 60KB although every field is within its own cap.
		rejects(big(16000, "a"), "at most 61440 UTF-8 bytes");
		// Multi-byte text: character count is small but UTF-8 size is not.
		rejects(big(8000, "한"), "UTF-8 bytes");
	});

	test("enforces string caps and well-formed Unicode", () => {
		const ok = (node: object) => expect(() => parseView(node)).not.toThrow();
		ok({ type: "badge", id: "a", text: "x".repeat(120) });
		rejects({ type: "badge", id: "a", text: "x".repeat(121) }, "at most 120 characters");
		rejects({ type: "badge", id: "a", text: "   " }, "must not be empty");
		rejects({ type: "button", id: "a", label: "" }, "must not be empty");
		rejects({ type: "button", id: "a", label: "x".repeat(121) }, "view.label");
		ok({ type: "card", id: "a", title: "x".repeat(80), description: "y".repeat(500), children: [] });
		rejects({ type: "card", id: "a", title: "x".repeat(81), children: [] }, "view.title");
		rejects({ type: "card", id: "a", description: "y".repeat(501), children: [] }, "view.description");
		rejects({ type: "alert", id: "a", text: "x", title: "x".repeat(81) }, "view.title");
		ok({ type: "text", id: "a", text: "x".repeat(8000) });
		rejects({ type: "text", id: "a", text: "x".repeat(8001) }, "at most 8000");
		rejects({ type: "alert", id: "a", text: "x".repeat(8001) }, "at most 8000");
		ok({ type: "code", id: "a", text: "x".repeat(16000) });
		rejects({ type: "code", id: "a", text: "x".repeat(16001) }, "at most 16000");
		rejects({ type: "code", id: "a", text: "x", language: "x".repeat(121) }, "view.language");
		rejects({ type: "text", id: "a", text: "bad \ud800" }, "well-formed Unicode");
		rejects({ type: "text", id: "a", text: 5 }, "expected a string");
		rejects({ type: "stat", id: "a", label: "l", value: "v".repeat(121) }, "view.value");
		ok({ type: "text", id: "a", text: "line1\nline2 <b>literal</b>" });
	});

	test("rejects invalid enums and booleans", () => {
		rejects({ type: "text", id: "a", text: "t", tone: "red" }, "view.tone");
		rejects({ type: "text", id: "a", text: "t", size: "huge" }, "view.size");
		rejects({ type: "stack", id: "a", children: [], direction: "diagonal" }, "view.direction");
		rejects({ type: "stack", id: "a", children: [], gap: "xl" }, "view.gap");
		rejects({ type: "grid", id: "a", children: [], columns: 4 }, "view.columns");
		rejects({ type: "grid", id: "a", children: [], columns: "2" }, "view.columns");
		rejects({ type: "button", id: "a", label: "b", variant: "link" }, "view.variant");
		rejects({ type: "button", id: "a", label: "b", disabled: "yes" }, "expected a boolean");
		rejects({ type: "input", id: "a", label: "l", inputType: "password" }, "view.inputType");
		rejects({ type: "form", id: "a", children: [] }, "view.submitLabel: is required");
		rejects({ type: "form", id: "a", children: [], submitLabel: "Go", disabled: 1 }, "expected a boolean");
	});

	test("validates progress numbers", () => {
		const p = (extra: object) => ({ type: "progress", id: "a", label: "p", ...extra });
		expect(parseView(p({ value: 100 }))).toEqual(p({ value: 100 }) as UINode);
		expect(parseView(p({ value: 1e9, max: 1e9 }))).toBeDefined();
		expect(Object.is((parseView(p({ value: -0 })) as any).value, 0)).toBe(true);
		rejects(p({ value: 101 }), "between 0 and 100");
		rejects(p({ value: -1 }), "between 0 and 100");
		rejects(p({ value: 6, max: 5 }), "between 0 and 5");
		rejects(p({ value: 0, max: 0 }), "view.max: must be positive");
		rejects(p({ value: 0, max: -1 }), "view.max");
		rejects(p({ value: 0, max: 1e9 + 1 }), "view.max");
		for (const bad of [NaN, Infinity, -Infinity]) {
			rejects(p({ value: bad }), "finite number");
			rejects(p({ value: 1, max: bad }), "finite number");
		}
		rejects(p({ value: "5" }), "finite number");
		rejects(p({}), "view.value: is required");
		rejects({ type: "progress", id: "a", value: 1 }, "view.label: is required");
	});

	test("validates tabs, tables and lists limits", () => {
		const tab = (i: number) => ({ id: `t${i}`, label: "T", children: [] });
		expect(parseView({ type: "tabs", id: "a", items: Array.from({ length: 8 }, (_, i) => tab(i)) })).toBeDefined();
		rejects({ type: "tabs", id: "a", items: Array.from({ length: 9 }, (_, i) => tab(i)) }, "at most 8 entries");
		rejects({ type: "tabs", id: "a", items: [] }, "at least 1 entry");

		const cols = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `c${i}`, label: "C" }));
		expect(parseView({ type: "table", id: "a", columns: cols(8), rows: [] })).toBeDefined();
		rejects({ type: "table", id: "a", columns: cols(9), rows: [] }, "at most 8 entries");
		rejects({ type: "table", id: "a", columns: [], rows: [] }, "at least 1 entry");
		const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `r${i}`, cells: ["x"] }));
		expect(parseView({ type: "table", id: "a", columns: cols(1), rows: rows(100) })).toBeDefined();
		rejects({ type: "table", id: "a", columns: cols(1), rows: rows(101) }, "at most 100 entries");
		rejects({ type: "table", id: "a", columns: cols(2), rows: [{ id: "r", cells: ["x"] }] }, "expected exactly 2 cells");
		rejects({ type: "table", id: "a", columns: cols(1), rows: [{ id: "r", cells: ["x", "y"] }] }, "at most 1 entries");
		rejects({ type: "table", id: "a", columns: cols(1), rows: [{ id: "r", cells: [5] }] }, "expected a string");
		expect(parseView({ type: "table", id: "a", columns: cols(1), rows: [{ id: "r", cells: ["x".repeat(2000)] }] })).toBeDefined();
		rejects({ type: "table", id: "a", columns: cols(1), rows: [{ id: "r", cells: ["x".repeat(2001)] }] }, "at most 2000");

		const items = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `i${i}`, title: "T" }));
		expect(parseView({ type: "list", id: "a", items: items(100) })).toBeDefined();
		rejects({ type: "list", id: "a", items: items(101) }, "at most 100 entries");
		rejects({ type: "list", id: "a", items: [{ id: "i", title: "x".repeat(81) }] }, "title");
		rejects({ type: "list", id: "a", items: [{ id: "i", title: "x", badge: "x".repeat(121) }] }, "badge");
	});

	test("validates input, textarea and select definitions", () => {
		const input = (extra: object) => ({ type: "input", id: "a", label: "l", ...extra });
		expect(parseView(input({ minLength: 0, maxLength: 16000, value: "x".repeat(16000) }))).toBeDefined();
		rejects(input({ value: "x".repeat(16001) }), "at most 16000");
		rejects(input({ minLength: 1.5 }), "expected an integer");
		rejects(input({ minLength: -1 }), "expected an integer between 0 and 16000");
		rejects(input({ maxLength: 16001 }), "expected an integer between 0 and 16000");
		rejects(input({ maxLength: NaN }), "expected an integer");
		rejects(input({ maxLength: Infinity }), "expected an integer");
		rejects(input({ maxLength: "5" }), "expected an integer");
		rejects(input({ minLength: 5, maxLength: 4 }), "minLength: must be less than or equal to maxLength");
		expect(parseView(input({ minLength: 4, maxLength: 4 }))).toBeDefined();
		rejects(input({ value: "abcd", maxLength: 3 }), "value: must be at most maxLength");
		rejects(input({ error: "x".repeat(501) }), "view.error");
		rejects(input({ placeholder: "x".repeat(121) }), "view.placeholder");

		const area = (extra: object) => ({ type: "textarea", id: "a", label: "l", ...extra });
		for (const rows of [2, 12]) expect(parseView(area({ rows }))).toBeDefined();
		for (const rows of [1, 13, 2.5, NaN, "3"]) rejects(area({ rows }), "view.rows");
		rejects(area({ minLength: 3, maxLength: 2 }), "maxLength");

		const select = (extra: object = {}) => ({ type: "select", id: "a", label: "l", options: [{ value: "x", label: "X" }, { value: "", label: "None" }], ...extra });
		expect(parseView(select({ value: "x" }))).toBeDefined();
		expect(parseView(select({ value: "" }))).toBeDefined();
		rejects(select({ value: "nope" }), "view.value: must be empty or one of the option values");
		rejects(select({ options: [{ value: "x", label: "X" }, { value: "x", label: "Y" }] }), "duplicate option value");
		rejects(select({ options: [] }), "at least 1 entry");
		rejects(select({ options: Array.from({ length: 51 }, (_, i) => ({ value: `v${i}`, label: "L" })) }), "at most 50 entries");
		expect(parseView(select({ options: Array.from({ length: 50 }, (_, i) => ({ value: `v${i}`, label: "L" })) }))).toBeDefined();
		expect(parseView(select({ options: [{ value: "v".repeat(200), label: "L" }] }))).toBeDefined();
		rejects(select({ options: [{ value: "v".repeat(201), label: "L" }] }), "at most 200");
		rejects(select({ options: [{ value: "v", label: "" }] }), "label");
		rejects({ type: "select", id: "a", label: "l" }, "options: is required");
	});

	test("rejects nested forms directly and through containers", () => {
		const inner = { type: "form", id: "inner", submitLabel: "Go", children: [] };
		rejects({ type: "form", id: "outer", submitLabel: "Go", children: [inner] }, "forms must not be nested");
		rejects({ type: "form", id: "outer", submitLabel: "Go", children: [{ type: "card", id: "c", children: [inner] }] }, "forms must not be nested");
		rejects({
			type: "form", id: "outer", submitLabel: "Go",
			children: [{ type: "tabs", id: "t", items: [{ id: "i", label: "I", children: [{ type: "stack", id: "s", children: [inner] }] }] }],
		}, "forms must not be nested");
		// Sibling forms are fine.
		expect(parseView({ type: "stack", id: "r", children: [inner, { ...inner, id: "second" }] })).toBeDefined();
	});
});

describe("parsePanelSpec", () => {
	const spec = () => ({ id: "my-panel", title: "Panel", description: "Desc", placement: "composer", view: every() });

	test("accepts a complete and a minimal panel and returns fresh data", () => {
		const input = spec();
		const output = parsePanelSpec(input);
		expect(output).toEqual(input as any);
		expect(output.view).not.toBe(input.view);
		const minimal = { id: "p", title: "T", view: { type: "divider", id: "d" } };
		expect(parsePanelSpec(minimal)).toEqual(minimal as any);
		expect(Object.hasOwn(parsePanelSpec(minimal), "placement")).toBe(false);
		expect(parsePanelSpec({ ...minimal, placement: "panel" }).placement).toBe("panel");
	});

	test("rejects bad metadata, unknown fields and invalid views", () => {
		const base = { id: "p", title: "T", view: { type: "divider", id: "d" } };
		const bad = (input: unknown, message: string) => expect(() => parsePanelSpec(input)).toThrow(message);
		bad(null, "panel: expected a plain object");
		bad({ ...base, id: "P" }, "panel.id");
		bad({ ...base, id: "p\n" }, "panel.id");
		bad({ ...base, title: "" }, "panel.title");
		bad({ ...base, title: "x".repeat(81) }, "panel.title");
		bad({ ...base, description: "x".repeat(501) }, "panel.description");
		bad({ ...base, placement: "header" }, "panel.placement");
		bad({ ...base, placement: "composer", size: { width: 300 } }, "panel.size");
		bad({ ...base, placement: "side", position: "center" }, "panel.position");
		bad({ ...base, placement: "floating", size: { width: 100 } }, "panel.size.width");
		bad({ ...base, placement: "floating", position: { x: 1 } }, "panel.position.y");
		bad({ ...base, placement: "floating", position: "middle" }, "panel.position");
		expect(parsePanelSpec({ ...base, placement: "floating", size: { width: 300, height: 200 }, position: "top-left" })).toMatchObject({ placement: "floating", size: { width: 300, height: 200 }, position: "top-left" });
		expect(parsePanelSpec({ ...base, placement: "sidebar" }).placement).toBe("sidebar");
		bad({ ...base, icon: "x" }, "unknown field icon");
		bad({ ...base, script: "x" }, "unknown field script");
		bad({ id: "p", title: "T" }, "panel.view: is required");
		bad({ ...base, view: { type: "div", id: "d" } }, "view.type");
		bad(JSON.parse('{"id":"p","title":"T","view":{"type":"divider","id":"d"},"__proto__":{}}'), "unknown field __proto__");
	});
});

describe("findNode and fieldsIn", () => {
	test("findNode locates nodes at any depth, including inside tabs, and ignores tab item and row IDs", () => {
		const view = parseView(every());
		expect(findNode(view, "root")).toBe(view);
		expect(findNode(view, "email")?.type).toBe("input");
		expect(findNode(view, "other")?.type).toBe("text");
		expect(findNode(view, "go")?.type).toBe("button");
		expect(findNode(view, "tab-a")).toBeUndefined();
		expect(findNode(view, "r1")).toBeUndefined();
		expect(findNode(view, "missing")).toBeUndefined();
		expect(findNode(view, "")).toBeUndefined();
		expect(findNode(view, "constructor")).toBeUndefined();
	});

	test("findNode and fieldsIn are safe on cyclic hand-built trees", () => {
		const loop: any = { type: "stack", id: "loop", children: [] };
		loop.children.push(loop, { type: "input", id: "f", label: "F" });
		expect(findNode(loop, "f")?.type).toBe("input");
		expect(findNode(loop, "zzz")).toBeUndefined();
		expect(fieldsIn(loop).map((f) => f.id)).toEqual(["f"]);
		expect(fieldsIn({ type: "stack", id: "bad" } as any)).toEqual([]);
	});

	test("fieldsIn returns fields recursively in document order, including a field itself", () => {
		const view = parseView(every());
		expect(fieldsIn(view).map((f) => f.id)).toEqual(["email", "notes", "color", "agree"]);
		expect(fieldsIn(findNode(view, "form")!).map((f) => f.type)).toEqual(["input", "textarea", "select", "checkbox"]);
		expect(fieldsIn(findNode(view, "email")!).map((f) => f.id)).toEqual(["email"]);
		expect(fieldsIn(findNode(view, "go")!)).toEqual([]);
		expect(fieldsIn(findNode(view, "table")!)).toEqual([]);
	});
});

describe("validateUIEvent", () => {
	const view = () => parseView(every());
	const submitValues = (): Record<string, string | boolean> => ({ email: "a@b.co", notes: "hello", color: "blue", agree: true });

	test("accepts and sanitizes action events", () => {
		const input = { type: "action", id: "go" };
		const out = validateUIEvent(view(), input);
		expect(out).toEqual({ type: "action", id: "go" });
		expect(out).not.toBe(input);
	});

	test("accepts change events for every field kind", () => {
		const v = view();
		expect(validateUIEvent(v, { type: "change", id: "email", value: "x" })).toEqual({ type: "change", id: "email", value: "x" });
		expect(validateUIEvent(v, { type: "change", id: "notes", value: "n" })).toEqual({ type: "change", id: "notes", value: "n" });
		expect(validateUIEvent(v, { type: "change", id: "color", value: "red" })).toEqual({ type: "change", id: "color", value: "red" });
		expect(validateUIEvent(v, { type: "change", id: "color", value: "" })).toEqual({ type: "change", id: "color", value: "" });
		expect(validateUIEvent(v, { type: "change", id: "agree", value: false })).toEqual({ type: "change", id: "agree", value: false });
	});

	test("change does not enforce required, minLength, email or number while typing", () => {
		const v = view();
		expect(validateUIEvent(v, { type: "change", id: "email", value: "" }).type).toBe("change");
		expect(validateUIEvent(v, { type: "change", id: "email", value: "a" }).type).toBe("change"); // minLength 3, not email
		expect(validateUIEvent(v, { type: "change", id: "agree", value: false }).type).toBe("change"); // required checkbox
		const num = parseView({ type: "input", id: "n", label: "N", inputType: "number" });
		expect(validateUIEvent(num, { type: "change", id: "n", value: "1e" })).toEqual({ type: "change", id: "n", value: "1e" });
	});

	test("change still enforces value type, maximum length and select allowlist", () => {
		const v = view();
		eventRejects(v, { type: "change", id: "email", value: true }, "event.value: expected a string");
		eventRejects(v, { type: "change", id: "email", value: 5 }, "expected a string");
		eventRejects(v, { type: "change", id: "email", value: "x".repeat(51) }, "at most 50 characters");
		eventRejects(v, { type: "change", id: "notes", value: "x".repeat(101) }, "at most 100 characters");
		eventRejects(v, { type: "change", id: "agree", value: "true" }, "expected a boolean");
		eventRejects(v, { type: "change", id: "agree", value: 1 }, "expected a boolean");
		eventRejects(v, { type: "change", id: "color", value: "green" }, "must be empty or one of the option values");
		eventRejects(v, { type: "change", id: "color", value: "constructor" }, "one of the option values");
		eventRejects(v, { type: "change", id: "color", value: "__proto__" }, "one of the option values");
		eventRejects(v, { type: "change", id: "color", value: "red\n" }, "one of the option values");
		eventRejects(v, { type: "change", id: "color", value: true }, "expected a string");
		eventRejects(v, { type: "change", id: "email" }, "event.value: is required");
		const free = parseView({ type: "textarea", id: "t", label: "T" });
		eventRejects(free, { type: "change", id: "t", value: "x".repeat(16001) }, "at most 16000");
		eventRejects(free, { type: "change", id: "t", value: "bad \udc00" }, "well-formed Unicode");
	});

	test("accepts a valid submit and returns fresh values in field order", () => {
		const values = submitValues();
		const reordered = { agree: values.agree, color: values.color, notes: values.notes, email: values.email };
		const out = validateUIEvent(view(), { type: "submit", id: "form", values: reordered }) as Extract<UIEvent, { type: "submit" }>;
		expect(out).toEqual({ type: "submit", id: "form", values: submitValues() });
		expect(Object.keys(out.values)).toEqual(["email", "notes", "color", "agree"]);
		expect(out.values).not.toBe(reordered);
		expect(Object.getPrototypeOf(out.values)).toBe(Object.prototype);
	});

	test("submit enforces required fields", () => {
		const v = view();
		const attempt = (patch: Record<string, unknown>, message: string) =>
			eventRejects(v, { type: "submit", id: "form", values: { ...submitValues(), ...patch } }, message);
		attempt({ email: "" }, "event.values.email: is required");
		attempt({ agree: false }, "event.values.agree: is required");
		attempt({ color: "" }, "event.values.color: is required");
		// optional textarea may be empty
		expect(validateUIEvent(v, { type: "submit", id: "form", values: { ...submitValues(), notes: "" } }).type).toBe("submit");
	});

	test("submit enforces length, email, number and type constraints", () => {
		const v = view();
		const attempt = (patch: Record<string, unknown>, message: string) =>
			eventRejects(v, { type: "submit", id: "form", values: { ...submitValues(), ...patch } }, message);
		attempt({ email: "not-an-email" }, "expected an email address");
		attempt({ email: "a@b" + "x".repeat(60) + ".co" }, "at most 50 characters");
		attempt({ email: "a b@c.co" }, "expected an email address");
		attempt({ email: "a@b.co\n" }, "expected an email address");
		attempt({ notes: "x".repeat(101) }, "at most 100 characters");
		attempt({ color: "green" }, "one of the option values");
		attempt({ agree: "yes" }, "expected a boolean");
		attempt({ email: 5 }, "expected a string");
		attempt({ notes: null }, "expected a string");
		attempt({ notes: { toString: () => "x" } }, "expected a string");

		const min = parseView(formView({ type: "input", id: "name", label: "N", minLength: 3 }));
		eventRejects(min, { type: "submit", id: "f", values: { name: "ab" } }, "at least 3 characters");
		expect(validateUIEvent(min, { type: "submit", id: "f", values: { name: "abc" } }).type).toBe("submit");

		const num = parseView(formView({ type: "input", id: "n", label: "N", inputType: "number" }));
		for (const good of ["0", "-1.5", "1e3", ".5", "7."]) expect(validateUIEvent(num, { type: "submit", id: "f", values: { n: good } }).type).toBe("submit");
		for (const bad of ["abc", "NaN", "Infinity", "-Infinity", "1e999", "0x10", " 1", "1 ", "1,5", "--1", "1\n"]) {
			eventRejects(num, { type: "submit", id: "f", values: { n: bad } }, "expected a finite number");
		}
		// optional empty numeric/email field is allowed
		expect(validateUIEvent(num, { type: "submit", id: "f", values: { n: "" } }).type).toBe("submit");
	});

	test("ignores the author-supplied error property when validating submit", () => {
		const v = parseView(formView({ type: "input", id: "name", label: "N", error: "Server says no" }, { type: "checkbox", id: "ok", label: "O", error: "bad" }));
		expect(validateUIEvent(v, { type: "submit", id: "f", values: { name: "x", ok: false } }).type).toBe("submit");
	});

	test("submit requires exactly the form's own enabled fields", () => {
		const v = view();
		const values = submitValues();
		const missing = { ...values } as any;
		delete missing.notes;
		eventRejects(v, { type: "submit", id: "form", values: missing }, "event.values.notes: is required");
		eventRejects(v, { type: "submit", id: "form", values: { ...values, extra: "x" } }, "event.values.extra: unknown or disabled field");
		eventRejects(v, { type: "submit", id: "form", values: { ...values, other: "x" } }, "unknown or disabled field");
		eventRejects(v, { type: "submit", id: "form", values: { ...values, go: "x" } }, "unknown or disabled field");
		eventRejects(v, { type: "submit", id: "form", values: { ...values, constructor: "x" } }, "unknown or disabled field");
		eventRejects(v, { type: "submit", id: "form", values: { ...values, toString: "x" } }, "unknown");
		eventRejects(v, { type: "submit", id: "form", values: JSON.parse('{"__proto__":{"email":"a@b.co"}}') }, "unknown or disabled field");
		eventRejects(v, { type: "submit", id: "form", values: [] }, "expected a plain object");
		eventRejects(v, { type: "submit", id: "form", values: null }, "expected a plain object");
		eventRejects(v, { type: "submit", id: "form" }, "event.values: is required");
		eventRejects(v, { type: "submit", id: "form", values: Object.create(values) }, "expected a plain object");
	});

	test("submit omits disabled fields and rejects values supplied for them", () => {
		const v = parseView(formView(
			{ type: "input", id: "a", label: "A", required: true },
			{ type: "input", id: "b", label: "B", required: true, disabled: true },
			{ type: "checkbox", id: "c", label: "C", disabled: true },
			{ type: "card", id: "card", children: [{ type: "input", id: "d", label: "D" }] },
		));
		expect(validateUIEvent(v, { type: "submit", id: "f", values: { a: "1", d: "" } })).toEqual({ type: "submit", id: "f", values: { a: "1", d: "" } });
		eventRejects(v, { type: "submit", id: "f", values: { a: "1", b: "x", d: "" } }, "event.values.b: unknown or disabled field");
		eventRejects(v, { type: "submit", id: "f", values: { a: "1", c: true, d: "" } }, "unknown or disabled field");
	});

	test("submit of a form with no fields yields empty values", () => {
		const v = parseView(formView({ type: "text", id: "t", text: "hi" }));
		const out = validateUIEvent(v, { type: "submit", id: "f", values: {} }) as Extract<UIEvent, { type: "submit" }>;
		expect(out.values).toEqual({});
		eventRejects(v, { type: "submit", id: "f", values: { x: "1" } }, "event.values.x: unknown or disabled field");
	});

	test("submit only covers fields in its own form, not fields in sibling forms or the page", () => {
		const v = parseView({
			type: "stack", id: "root", children: [
				{ type: "input", id: "loose", label: "Loose" },
				{ type: "form", id: "f1", submitLabel: "1", children: [{ type: "input", id: "a", label: "A" }] },
				{ type: "form", id: "f2", submitLabel: "2", children: [{ type: "input", id: "b", label: "B" }] },
			],
		});
		expect(validateUIEvent(v, { type: "submit", id: "f1", values: { a: "x" } }).type).toBe("submit");
		eventRejects(v, { type: "submit", id: "f1", values: { b: "x" } }, "event.values.b: unknown or disabled field");
		eventRejects(v, { type: "submit", id: "f1", values: { a: "x", loose: "y" } }, "unknown or disabled field");
		eventRejects(v, { type: "submit", id: "f1", values: { a: "x", b: "y" } }, "unknown or disabled field");
	});

	test("rejects forged event shapes and types", () => {
		const v = view();
		for (const bad of [null, undefined, "action", 1, [], () => 0]) eventRejects(v, bad, "event: expected a plain object");
		eventRejects(v, {}, "event.type: expected one of");
		eventRejects(v, { id: "go" }, "event.type");
		eventRejects(v, { type: "click", id: "go" }, "event.type: expected one of");
		eventRejects(v, { type: "toString", id: "go" }, "event.type");
		eventRejects(v, { type: "__proto__", id: "go" }, "event.type");
		eventRejects(v, { type: "action" }, "event.id: is required");
		eventRejects(v, { type: "action", id: 5 }, "event.id: expected a string");
		eventRejects(v, { type: "action", id: "go", value: "x" }, "unknown field value");
		eventRejects(v, { type: "action", id: "go", extra: 1 }, "unknown field extra");
		eventRejects(v, { type: "change", id: "email", value: "x", values: {} }, "unknown field values");
		eventRejects(v, { type: "submit", id: "form", values: submitValues(), value: "x" }, "unknown field value");
		eventRejects(v, JSON.parse('{"type":"action","id":"go","__proto__":{"x":1}}'), "unknown field __proto__");
		eventRejects(v, { type: "action", id: "go", [Symbol("x")]: 1 }, "unknown field Symbol(x)");
		const getter: any = { type: "action" };
		Object.defineProperty(getter, "id", { enumerable: true, get: () => "go" });
		eventRejects(v, getter, "event.id: expected an enumerable data field");
		class Evt { type = "action"; id = "go"; }
		eventRejects(v, new Evt(), "expected a plain object");
	});

	test("rejects wrong target kinds", () => {
		const v = view();
		eventRejects(v, { type: "action", id: "email" }, "action requires a button target, got input");
		eventRejects(v, { type: "action", id: "form" }, "action requires a button target, got form");
		eventRejects(v, { type: "action", id: "root" }, "action requires a button target");
		eventRejects(v, { type: "change", id: "go", value: "x" }, "change requires a field target, got button");
		eventRejects(v, { type: "change", id: "form", value: "x" }, "change requires a field target, got form");
		eventRejects(v, { type: "change", id: "heading", value: "x" }, "change requires a field target");
		eventRejects(v, { type: "submit", id: "go", values: {} }, "submit requires a form target, got button");
		eventRejects(v, { type: "submit", id: "email", values: {} }, "submit requires a form target, got input");
	});

	test("rejects unknown, malformed and prototype-key targets", () => {
		const v = view();
		eventRejects(v, { type: "action", id: "nope" }, "event.id: unknown target nope");
		eventRejects(v, { type: "action", id: "tab-a" }, "unknown target tab-a");
		eventRejects(v, { type: "action", id: "r1" }, "unknown target r1");
		for (const id of ["", "GO", "go\n", "\ngo", "go ", "constructor ", "__proto__", "a".repeat(41)]) {
			eventRejects(v, { type: "action", id }, "event.id");
		}
		eventRejects(v, { type: "action", id: "constructor" }, "unknown target constructor");
		eventRejects(v, { type: "action", id: "toString" }, "event.id");
		eventRejects(v, { type: "action", id: "to-string" }, "unknown target");
	});

	test("rejects disabled targets", () => {
		const v = parseView({
			type: "stack", id: "root", children: [
				{ type: "button", id: "off", label: "Off", disabled: true },
				{ type: "button", id: "on", label: "On", disabled: false },
				{ type: "input", id: "inp", label: "I", disabled: true },
				{ type: "textarea", id: "ta", label: "T", disabled: true },
				{ type: "select", id: "sel", label: "S", disabled: true, options: [{ value: "a", label: "A" }] },
				{ type: "checkbox", id: "chk", label: "C", disabled: true },
			],
		});
		expect(validateUIEvent(v, { type: "action", id: "on" }).type).toBe("action");
		eventRejects(v, { type: "action", id: "off" }, "target off is disabled");
		eventRejects(v, { type: "change", id: "inp", value: "x" }, "target inp is disabled");
		eventRejects(v, { type: "change", id: "ta", value: "x" }, "target ta is disabled");
		eventRejects(v, { type: "change", id: "sel", value: "a" }, "target sel is disabled");
		eventRejects(v, { type: "change", id: "chk", value: true }, "target chk is disabled");
		const form = parseView({ type: "form", id: "f", submitLabel: "Go", disabled: true, children: [] });
		eventRejects(form, { type: "submit", id: "f", values: {} }, "target f is disabled");
	});

	test("a disabled form blocks events for itself and every descendant, including via card and tabs", () => {
		const v = parseView({
			type: "stack", id: "root", children: [
				{
					type: "form", id: "locked", submitLabel: "Go", disabled: true, children: [
						{ type: "button", id: "inner-btn", label: "B" },
						{ type: "card", id: "inner-card", children: [{ type: "input", id: "deep", label: "D" }] },
						{ type: "tabs", id: "inner-tabs", items: [{ id: "ti", label: "T", children: [{ type: "checkbox", id: "tabbed", label: "C" }] }] },
					],
				},
				{ type: "form", id: "open", submitLabel: "Go", children: [{ type: "input", id: "free", label: "F" }] },
			],
		});
		eventRejects(v, { type: "submit", id: "locked", values: { deep: "x", tabbed: true } }, "target locked is disabled");
		eventRejects(v, { type: "action", id: "inner-btn" }, "inside a disabled form");
		eventRejects(v, { type: "change", id: "deep", value: "x" }, "inside a disabled form");
		eventRejects(v, { type: "change", id: "tabbed", value: true }, "inside a disabled form");
		expect(validateUIEvent(v, { type: "change", id: "free", value: "x" }).type).toBe("change");
		expect(validateUIEvent(v, { type: "submit", id: "open", values: { free: "x" } }).type).toBe("submit");
	});

	test("never trusts the supplied view object: tampered views are re-validated", () => {
		const good = view();
		const tampered = structuredClone(good) as any;
		tampered.children[2].items[0].children[0].children.push({ type: "form", id: "evil", submitLabel: "x", children: [] });
		eventRejects(tampered, { type: "action", id: "go" }, "forms must not be nested");
		const dup = structuredClone(good) as any;
		dup.children.push({ type: "text", id: "go", text: "dup" });
		eventRejects(dup, { type: "action", id: "go" }, "duplicate ID go");
		eventRejects({ type: "button", id: "b", label: "b", onClick: "x" } as any, { type: "action", id: "b" }, "unknown field onClick");
		const loop: any = { type: "stack", id: "loop", children: [] };
		loop.children.push(loop);
		eventRejects(loop, { type: "action", id: "loop" }, "cycle detected");
	});

	test("does not mutate the view or the event and returns fresh objects", () => {
		const v = view();
		const snapshot = JSON.stringify(v);
		const values = submitValues();
		const event = { type: "submit", id: "form", values };
		const eventSnapshot = JSON.stringify(event);
		const out = validateUIEvent(v, event);
		expect(JSON.stringify(v)).toBe(snapshot);
		expect(JSON.stringify(event)).toBe(eventSnapshot);
		expect(out).not.toBe(event);
		expect((out as any).values).not.toBe(values);
		const change = { type: "change", id: "email", value: "a@b.co" };
		expect(validateUIEvent(v, change)).not.toBe(change);
	});

	test("form fields keep working under form tabs and cards at maximum nesting", () => {
		const v = parseView({
			type: "form", id: "f", submitLabel: "Go", children: [
				{ type: "tabs", id: "t", items: [
					{ id: "one", label: "1", children: [{ type: "card", id: "c1", children: [{ type: "input", id: "a", label: "A", required: true }] }] },
					{ id: "two", label: "2", children: [{ type: "checkbox", id: "b", label: "B" }] },
				] },
			],
		});
		expect(validateUIEvent(v, { type: "submit", id: "f", values: { a: "x", b: false } }).type).toBe("submit");
		eventRejects(v, { type: "submit", id: "f", values: { a: "", b: false } }, "event.values.a: is required");
	});
});

describe("UIValidationError", () => {
	const form = (field: Record<string, unknown>) => ({ type: "form", id: "f", submitLabel: "Go", children: [{ type: "input", id: "name", label: "Name", ...field }] }) as UINode;
	const problemOf = (view: UINode, value: string) => {
		try {
			validateUIEvent(view, { type: "submit", id: "f", values: { name: value } });
		} catch (e) {
			expect(e).toBeInstanceOf(UIValidationError);
			return (e as UIValidationError).problem;
		}
		return "accepted";
	};

	test("names the mistake a person made, with the limit, instead of making callers parse English", () => {
		expect(problemOf(parseView(form({ required: true })), "")).toEqual({ code: "required" });
		expect(problemOf(parseView(form({ maxLength: 5 })), "abcdef")).toEqual({ code: "too_long", max: 5 });
		expect(problemOf(parseView(form({ minLength: 3 })), "ab")).toEqual({ code: "too_short", min: 3 });
		expect(problemOf(parseView(form({ inputType: "email" })), "nope")).toEqual({ code: "email" });
		expect(problemOf(parseView(form({ inputType: "number" })), "abc")).toEqual({ code: "number" });
	});

	test("keeps the English path: message text for logs", () => {
		expect(() => validateUIEvent(parseView(form({ maxLength: 2 })), { type: "submit", id: "f", values: { name: "abc" } })).toThrow("must be at most 2 characters");
	});

	test("a structural mistake has no friendly problem", () => {
		try {
			validateUIEvent(parseView(form({})), { type: "submit", id: "f", values: { name: 5 } });
		} catch (e) {
			expect((e as UIValidationError).problem).toBeUndefined();
			return;
		}
		throw new Error("expected a rejection");
	});
});
