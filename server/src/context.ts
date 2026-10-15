import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { skillsPrompt, type SkillRef } from "./skills.ts";
import type { SessionRecord, StoredMessage } from "./store.ts";

export interface Instruction {
	path: string;
	scope: "global" | "ancestor" | "cwd";
	content: string;
	bytes: number;
}

export interface ContextSnapshot {
	cwd: string;
	capturedAt: number;
	systemPrompt: string;
	effectiveSystemPrompt: string;
	instructions: Instruction[];
	warnings: { path: string; message: string }[];
	tools: string[];
	/** Skills advertised at capture time (informational: the live set follows the current settings each turn). */
	skills?: SkillRef[];
}

export interface ReadFileTrace {
	path: string;
	reads: number;
	lastReadAt: number;
	ranges: { from: number; to: number }[];
}

export interface SessionContext extends Omit<ContextSnapshot, "capturedAt" | "skills"> {
	skills: Omit<SkillRef, "baseDir">[];
	/** Sub-agents advertised to the model this turn. */
	agents: AdvertisedAgent[];
	/** The exact `<available_skills>` block appended to the system prompt ("" when none). */
	skillsPrompt: string;
	/** The exact `# Sub-agents` block appended to the system prompt ("" when none). */
	agentsPrompt: string;
	state: "preview" | "applied";
	capturedAt: number | null;
	/** Historical successful read results, not a guarantee of retained model context. */
	readFiles: ReadFileTrace[];
}

export const INSTRUCTION_MAX_FILE_BYTES = 64 * 1024;
export const INSTRUCTION_MAX_TOTAL_BYTES = 256 * 1024;

/** Only global (`<home>/.agents/AGENTS.md`) and root-to-cwd AGENTS.md files; never recursively search children. */
export function discoverInstructions(cwd: string, opts: { home?: string; maxFileBytes?: number; maxTotalBytes?: number } = {}) {
	const maxFile = opts.maxFileBytes ?? INSTRUCTION_MAX_FILE_BYTES;
	const maxTotal = opts.maxTotalBytes ?? INSTRUCTION_MAX_TOTAL_BYTES;
	const dirs: string[] = [];
	for (let dir = resolve(cwd); ; dir = dirname(dir)) {
		dirs.unshift(dir);
		if (dirname(dir) === dir) break;
	}
	const candidates: { path: string; scope: Instruction["scope"] }[] = [
		{ path: join(opts.home ?? homedir(), ".agents", "AGENTS.md"), scope: "global" },
		...dirs.map((dir, i) => ({ path: join(dir, "AGENTS.md"), scope: i === dirs.length - 1 ? "cwd" as const : "ancestor" as const })),
	];
	const instructions: Instruction[] = [];
	const warnings: ContextSnapshot["warnings"] = [];
	const seen = new Set<string>();
	let total = 0;
	for (const candidate of candidates) {
		let fd: number | undefined;
		try {
			// Check before opening (including symlink targets); NONBLOCK and fstat also
			// protect against a file being replaced with a FIFO/device during discovery.
			if (!statSync(candidate.path).isFile()) {
				warnings.push({ path: candidate.path, message: "Skipped: instruction path is not a regular file" });
				continue;
			}
			const path = realpathSync(candidate.path);
			if (seen.has(path)) continue;
			seen.add(path);
			fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
			const info = fstatSync(fd);
			if (!info.isFile()) {
				warnings.push({ path, message: "Skipped: instruction path is not a regular file" });
				continue;
			}
			const remaining = maxTotal - total;
			const cap = Math.min(maxFile, remaining);
			const tooLarge = () => warnings.push({ path, message: info.size > maxFile
				? `Skipped: instruction exceeds per-file limit (${maxFile} bytes)`
				: `Skipped: instruction exceeds total limit (${maxTotal} bytes)` });
			if (info.size > cap) { tooLarge(); continue; }
			// Read at most cap+1 bytes even if the file grows after stat.
			const buffer = Buffer.alloc(cap + 1);
			let bytes = 0;
			while (bytes < buffer.length) {
				const n = readSync(fd, buffer, bytes, buffer.length - bytes, null);
				if (!n) break;
				bytes += n;
			}
			if (bytes > cap) {
				warnings.push({ path, message: `Skipped: instruction grew beyond ${cap === maxFile ? "per-file" : "remaining total"} limit (${cap} bytes)` });
				continue;
			}
			const content = buffer.subarray(0, bytes).toString("utf8");
			if (!content.trim()) continue;
			instructions.push({ path, scope: candidate.scope, content, bytes });
			total += bytes;
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
				warnings.push({ path: candidate.path, message: `Unable to load instruction: ${e instanceof Error ? e.message : String(e)}` });
			}
		} finally {
			if (fd !== undefined) closeSync(fd);
		}
	}
	return { instructions, warnings };
}

/** Skills are loaded through `read`, so they are pointless (and not advertised) without that tool. */
export const advertisedSkills = (tools: string[], skills: SkillRef[]): SkillRef[] => (tools.includes("read") ? skills : []);

export interface AdvertisedAgent {
	name: string;
	description: string;
}

/** Helpers are only reachable through `delegate`, so they are not advertised without that tool. */
export const advertisedAgents = (tools: string[], agents: AdvertisedAgent[]): AdvertisedAgent[] => (tools.includes("delegate") ? agents : []);

/** Short list of the enabled sub-agents (name + description); the `delegate` tool description carries the call details. */
export function agentsPrompt(agents: AdvertisedAgent[]): string {
	const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
	return [
		"# Sub-agents",
		"",
		"Helpers you can hand work to with the `delegate` tool (pass `agent` = name). Their reports are leads: verify cited lines before changing code.",
		...agents.map((a) => `- ${a.name}: ${oneLine(a.description)}`),
	].join("\n");
}

/** The model's system prompt: base + frozen AGENTS.md + the skills and sub-agents that are currently enabled. */
export function buildSystemPrompt(base: string, instructions: Instruction[], skills: SkillRef[], agents: AdvertisedAgent[] = []): string {
	const parts = [base];
	if (instructions.length) parts.push(`# Project instructions\n\n${instructions.map((i) => `## ${i.path}\n\n${i.content}`).join("\n\n")}`);
	if (skills.length) parts.push(skillsPrompt(skills));
	if (agents.length) parts.push(agentsPrompt(agents));
	return parts.join("\n\n");
}

export function previewContext(record: SessionRecord, skills: SkillRef[] = [], home?: string, agents: AdvertisedAgent[] = []): Omit<ContextSnapshot, "capturedAt"> {
	const { instructions, warnings } = discoverInstructions(record.cwd, { home });
	const advertised = advertisedSkills(record.tools, skills);
	return {
		cwd: record.cwd,
		systemPrompt: record.systemPrompt,
		effectiveSystemPrompt: buildSystemPrompt(record.systemPrompt, instructions, advertised, advertisedAgents(record.tools, agents)),
		instructions,
		warnings,
		tools: [...record.tools],
		skills: advertised,
	};
}

/** Persisted read toolResults only: neither tool calls nor bash output prove a read. */
export function aggregateReadFiles(cwd: string, messages: StoredMessage[]): ReadFileTrace[] {
	const files = new Map<string, ReadFileTrace>();
	for (const stored of messages) {
		const m = stored.message;
		if (m.role !== "toolResult" || m.toolName !== "read" || m.isError) continue;
		if (!m.details || typeof m.details !== "object" || Array.isArray(m.details)) continue;
		const details = m.details as Record<string, unknown>;
		if (typeof details.path !== "string" || !details.path.trim()) continue;
		const path = resolve(cwd, details.path);
		const timestamp = Number.isFinite(m.timestamp) ? m.timestamp : stored.createdAt;
		const trace = files.get(path) ?? { path, reads: 0, lastReadAt: timestamp, ranges: [] };
		trace.reads++;
		trace.lastReadAt = Math.max(trace.lastReadAt, timestamp);
		if (typeof details.from === "number" && typeof details.to === "number" &&
			Number.isInteger(details.from) && Number.isInteger(details.to) && details.from >= 1 && details.to >= details.from) {
			trace.ranges.push({ from: details.from, to: details.to });
		}
		files.set(path, trace);
	}
	for (const trace of files.values()) {
		const merged: ReadFileTrace["ranges"] = [];
		for (const range of trace.ranges.sort((a, b) => a.from - b.from || a.to - b.to)) {
			const last = merged.at(-1);
			if (last && range.from <= last.to + 1) last.to = Math.max(last.to, range.to);
			else merged.push({ ...range });
		}
		trace.ranges = merged;
	}
	return [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
}
