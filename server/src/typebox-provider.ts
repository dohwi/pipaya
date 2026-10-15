import type { FastifySchemaCompiler, FastifySerializerCompiler, FastifyTypeProvider } from "fastify";
import type { Static, TSchema } from "typebox";
import Value from "typebox/value";
import { HttpError } from "./errors.ts";

/** Infers `req.body` / `req.query` / `req.params` types from TypeBox route schemas. */
export interface TypeBoxProvider extends FastifyTypeProvider {
	validator: this["schema"] extends TSchema ? Static<this["schema"]> : unknown;
}

const describe = (httpPart: string, schema: TSchema, data: unknown): string =>
	[...Value.Errors(schema, data)]
		.slice(0, 5)
		.map((e) => `${httpPart}${e.instancePath} ${e.message}`)
		.join("; ") || `invalid ${httpPart}`;

/**
 * Validates requests with TypeBox. Query/params arrive as strings, so they are coerced first.
 * A missing JSON body is treated as `{}` so routes with all-optional bodies accept empty POSTs.
 */
export const validatorCompiler: FastifySchemaCompiler<TSchema> =
	({ schema, httpPart }) =>
	(data) => {
		let input: unknown = data === undefined && httpPart === "body" ? {} : data;
		if (httpPart === "querystring" || httpPart === "params") input = Value.Convert(schema, input);
		if (Value.Check(schema, input)) return { value: input };
		return { error: new HttpError(400, "invalid_request", describe(httpPart ?? "request", schema, input)) };
	};

/**
 * Response schemas enforce API contracts in strict mode (tests).
 * Production uses plain JSON serialization, without per-response validation overhead.
 */
export const makeSerializerCompiler =
	(strict: boolean): FastifySerializerCompiler<TSchema> =>
	({ schema, method, url, httpStatus }) =>
	(data) => {
		if (strict && !Value.Check(schema, data)) {
			throw new Error(`response schema violation: ${method} ${url} -> ${httpStatus}: ${describe("response", schema, data)}`);
		}
		return JSON.stringify(data);
	};

