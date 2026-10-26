/**
 * Image models are listed by the server, and run only when a server extension runs them. This is the official one the
 * app points to when none is installed (any extension that runs image models will do).
 */
export const IMAGE_RUNNER_EXTENSION = "image-generation";

/** The model cannot answer on this server now: an image model without an extension that runs it. */
export const needsRunner = (m: { runnable?: boolean } | undefined | null): boolean => m?.runnable === false;
