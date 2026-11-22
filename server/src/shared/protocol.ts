/**
 * Wire-compatibility constants shared between the server and clients (browser, desktop, Android, iOS).
 * Zero runtime dependencies so the client build/tests can import this without installing server packages.
 *
 * `PROTOCOL_VERSION` is raised only when REST/WebSocket/SSE shapes change in a way an older peer cannot cope with.
 * Adding a field or a route does not raise it.
 */
export const PROTOCOL_VERSION = 1;
export const MIN_CLIENT_PROTOCOL = 1;

/** Request header (REST) and query parameter (EventSource/WebSocket, which cannot set headers) carrying the client's protocol. */
export const PROTOCOL_HEADER = "x-pipaya-protocol";
export const PROTOCOL_QUERY = "protocol";
