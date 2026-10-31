/**
 * One server process holds every session, so a stray rejection or exception (an extension, a background task, a
 * dropped socket) must not take all of them down: Bun exits on the first one by default. Log it and keep running.
 */
export interface GuardLog { error(obj: object, msg: string): void }

export function installCrashGuard(log: GuardLog, target: Pick<NodeJS.Process, "on"> = process): void {
	const describe = (e: unknown) => (e instanceof Error ? { message: e.message, stack: e.stack } : { message: String(e) });
	target.on("unhandledRejection", (reason) => log.error({ err: describe(reason) }, "unhandled promise rejection (server kept running)"));
	target.on("uncaughtException", (error) => log.error({ err: describe(error) }, "uncaught exception (server kept running)"));
}
