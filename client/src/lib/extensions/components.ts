/**
 * Trusted extension components (`ui-components`): Svelte 5 sources from a package, compiled here with the app's own
 * compiler and linked to the app's own Svelte runtime, so they mount like any built-in component.
 *
 * This is NOT a sandbox. A component runs in the application realm with the app's full access; the consent dialog says
 * so and the host only starts such a package after the user enabled it on this device. Loaded lazily (the compiler is
 * large) by the adapter in App.svelte.
 */
import { compile } from "svelte/compiler";
import { parse } from "acorn";
import type { Component } from "svelte";
import * as svelte from "svelte";
// @ts-expect-error the runtime has no public typings; components compiled by the app link to it
import * as internal from "svelte/internal/client";
import * as transition from "svelte/transition";
import * as animate from "svelte/animate";
import * as easing from "svelte/easing";
import * as motion from "svelte/motion";
import * as store from "svelte/store";
import * as reactivity from "svelte/reactivity";
import * as events from "svelte/events";
import * as attachments from "svelte/attachments";
import type { ExtensionPackage } from "./schema";

/** What a component may import. `pipaya` is the app's kit (see kit.ts); `./Name.svelte` is another component of the same package. */
const SVELTE: Record<string, unknown> = {
	svelte, "svelte/internal/client": internal, "svelte/transition": transition, "svelte/animate": animate, "svelte/easing": easing,
	"svelte/motion": motion, "svelte/store": store, "svelte/reactivity": reactivity, "svelte/events": events, "svelte/attachments": attachments,
};
export const IMPORTABLE = Object.freeze([...Object.keys(SVELTE).filter(k => k !== "svelte/internal/client"), "pipaya", "./<Name>.svelte"]);

interface Node { type: string; start: number; end: number; [key: string]: any }

/** Compile one component and turn its ES module into a function body: imports become lookups, exports assignments. */
export function compileComponent(owner: string, name: string, source: string): string {
	const out = compile(source, {
		filename: `${owner}/${name}.svelte`, generate: "client", runes: true, css: "injected", dev: false, discloseVersion: false,
		// Hash per extension and component, so two packages with the same markup never share a class.
		cssHash: ({ css, hash }) => `x-${hash(`${owner}/${name}\n${css}`)}`,
	});
	const code = out.js.code;
	const program = parse(code, { ecmaVersion: "latest", sourceType: "module" }) as unknown as { body: Node[] };
	const edits: { start: number; end: number; text: string }[] = [];
	const tail: string[] = [];
	for (const node of program.body) {
		if (node.type === "ImportDeclaration") {
			const from: string = node.source.value;
			// Pure side-effect imports of the runtime need nothing; flags would change the whole app (runes is forced on).
			if (!node.specifiers.length && from.startsWith("svelte/internal/")) { edits.push({ start: node.start, end: node.end, text: "" }); continue; }
			const binds = node.specifiers.map((s: Node) => s.type === "ImportNamespaceSpecifier" ? `${s.local.name} = __m`
				: s.type === "ImportDefaultSpecifier" ? `${s.local.name} = __m.default`
				: `${s.local.name} = __m[${JSON.stringify(s.imported.type === "Literal" ? s.imported.value : s.imported.name)}]`);
			const load = `__import(${JSON.stringify(from)})`;
			edits.push({ start: node.start, end: node.end, text: binds.length ? `const ${binds.map((b: string) => b.replace("__m", load)).join(", ")};` : `${load};` });
		} else if (node.type === "ExportDefaultDeclaration") {
			const decl = node.declaration;
			if ((decl.type === "FunctionDeclaration" || decl.type === "ClassDeclaration") && decl.id) {
				edits.push({ start: node.start, end: decl.start, text: "" }); tail.push(`__exports.default = ${decl.id.name};`);
			} else edits.push({ start: node.start, end: decl.start, text: "__exports.default = " });
		} else if (node.type === "ExportNamedDeclaration") {
			if (node.source) throw new Error(`${name}: export … from is not supported`);
			if (node.declaration) {
				edits.push({ start: node.start, end: node.declaration.start, text: "" });
				const d = node.declaration;
				const names: string[] = d.type === "VariableDeclaration" ? d.declarations.map((v: Node) => { if (v.id.type !== "Identifier") throw new Error(`${name}: destructured exports are not supported`); return v.id.name; }) : [d.id.name];
				for (const n of names) tail.push(`__exports[${JSON.stringify(n)}] = ${n};`);
			} else {
				edits.push({ start: node.start, end: node.end, text: "" });
				for (const s of node.specifiers) tail.push(`__exports[${JSON.stringify(s.exported.name ?? s.exported.value)}] = ${s.local.name};`);
			}
		} else if (node.type === "ExportAllDeclaration") throw new Error(`${name}: export * is not supported`);
	}
	let body = code;
	for (const edit of edits.sort((a, b) => b.start - a.start)) body = body.slice(0, edit.start) + edit.text + body.slice(edit.end);
	return `"use strict";\n${body}\n${tail.join("\n")}`;
}

/**
 * Compile and link every component of a package. Components import each other as `./Name.svelte`; modules are
 * evaluated on first import, so the order in the package does not matter. Throws with the component's name on error.
 */
export function loadComponents(pkg: ExtensionPackage, kit: Record<string, unknown>): Record<string, Component<any>> {
	const owner = pkg.manifest.id;
	const sources = pkg.components ?? {};
	const bodies = new Map<string, string>();
	for (const [name, source] of Object.entries(sources)) {
		try { bodies.set(name, compileComponent(owner, name, source)); }
		catch (e) { throw new Error(`${name}.svelte: ${e instanceof Error ? e.message : String(e)}`.slice(0, 500)); }
	}
	const modules = new Map<string, Record<string, unknown>>();
	const evaluate = (name: string): Record<string, unknown> => {
		const done = modules.get(name);
		if (done) return done;
		const exports: Record<string, unknown> = {};
		modules.set(name, exports);
		try { new Function("__import", "__exports", bodies.get(name)!)(require, exports); }
		catch (e) { modules.delete(name); throw new Error(`${name}.svelte: ${e instanceof Error ? e.message : String(e)}`.slice(0, 500)); }
		return exports;
	};
	const require = (from: string): unknown => {
		if (from === "pipaya") return kit;
		if (Object.hasOwn(SVELTE, from)) return SVELTE[from];
		const sibling = /^\.\/([A-Z][A-Za-z0-9]*)\.svelte$/.exec(from)?.[1];
		if (sibling && bodies.has(sibling)) return evaluate(sibling);
		throw new Error(`cannot import "${from}" (allowed: ${IMPORTABLE.join(", ")})`);
	};
	const result: Record<string, Component<any>> = {};
	for (const name of bodies.keys()) {
		const value = evaluate(name).default;
		if (typeof value !== "function") throw new Error(`${name}.svelte: no component was exported`);
		result[name] = value as Component<any>;
	}
	return result;
}
