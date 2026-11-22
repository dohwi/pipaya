import { resolve } from "node:path";
import pkg from "../package.json" with { type: "json" };

export { MIN_CLIENT_PROTOCOL, PROTOCOL_HEADER, PROTOCOL_QUERY, PROTOCOL_VERSION } from "./shared/protocol.ts";

export const SERVER_VERSION: string = pkg.version;

/** The checkout this server runs from (server/src -> repo root). */
export const REPO_ROOT = resolve(import.meta.dir, "../..");
