import type { Static, TSchema } from "typebox";
import Value from "typebox/value";

export class HttpError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}

export const badRequest = (message: string) => new HttpError(400, "invalid_request", message);
export const notFound = (what: string) => new HttpError(404, "not_found", `${what} not found`);
export const conflict = (message: string) => new HttpError(409, "conflict", message);

/** Validate untrusted input against a TypeBox schema or throw a 400. */
export function parse<T extends TSchema>(schema: T, data: unknown): Static<T> {
	if (Value.Check(schema, data)) return data as Static<T>;
	const problems = [...Value.Errors(schema, data)]
		.slice(0, 5)
		.map((e) => `${e.instancePath || "/"} ${e.message}`);
	throw badRequest(problems.join("; ") || "invalid request");
}

