import { SUMMARY_PREFIX, SUMMARY_REQUEST_TEMPLATE, SUMMARY_SYSTEM } from "./compaction.ts";
import { withBytes, type SystemPromptEntry } from "./context.ts";
import { HINT_OPEN, PEER_MESSAGE_TEMPLATE, READ_NOTE } from "./peers.ts";
import { DESCRIBE_SYSTEM, GROUP_NAME_SYSTEM } from "./system-model.ts";

/** What decides which provider-specific wording applies to a session's model. */
export interface PromptModel {
	provider: string;
	api: string;
}

/**
 * Every piece of text the system adds for a model besides the session's own prompt, tools and AGENTS.md, in the order a
 * reader would ask about it. Wording that lives inside the pi SDK is copied here from its source (see the `when` of each
 * entry); nothing is invented: an entry exists only where the code that sends it was read.
 */
export function systemPromptEntries(model: PromptModel | null, opts: { hasExtensions: boolean; extensionHooks: string[]; anthropicOAuth?: boolean }): SystemPromptEntry[] {
	const anthropic = model?.api === "anthropic-messages";
	const codex = model?.api === "openai-codex-responses";
	return [
		{
			id: "sdk-claude-code",
			delivery: "request" as const,
			kind: "sdk" as const,
			title: "Claude Code identity",
			when: "pi SDK, Anthropic Messages API: put first in the system prompt, only when the login is an Anthropic subscription token (OAuth, `sk-ant-oat…`); the session prompt follows it as a second block",
			text: "You are Claude Code, Anthropic's official CLI for Claude.",
			active: anthropic && opts.anthropicOAuth !== false,
		},
		{
			id: "sdk-codex-default",
			delivery: "request" as const,
			kind: "sdk" as const,
			title: "Codex fallback instructions",
			when: "pi SDK, OpenAI Codex Responses API: used as `instructions` only when the session prompt is empty",
			text: "You are a helpful assistant.",
			active: codex,
		},
		{
			id: "sdk-tool-changes",
			delivery: "event" as const,
			kind: "sdk" as const,
			title: "Tool changes",
			when: "pi SDK agent loop: when the tools of a session differ from the previous request, a system message records which tools were added or removed (names only, no wording)",
			text: "(system message with `toolsAdded` / `toolsRemoved` lists)",
			active: true,
		},
		{
			id: "runtime-peer-message",
			delivery: "event" as const,
			kind: "runtime" as const,
			title: "Message from another session",
			when: "A session used `peer_send`: this is how the receiving session sees it, as a user message",
			text: PEER_MESSAGE_TEMPLATE,
			active: true,
		},
		{
			id: "runtime-mention-hint",
			delivery: "event" as const,
			kind: "runtime" as const,
			title: "@mention hint",
			when: "The user wrote `@name` or a group handle in a message: a short index of those sessions is added to that message (never their transcripts)",
			text: `${HINT_OPEN}The user mentioned other sessions (agents) on this server:\n- @name (purpose) · working|idle · branch … · /path · last: "…"\n${READ_NOTE}</pipaya-hint>`,
			active: true,
		},
		{
			id: "runtime-compaction-summary",
			delivery: "event" as const,
			kind: "runtime" as const,
			title: "Compaction summary",
			when: "After a compaction (automatic or /compact): the summary replaces the earlier messages and goes first in the conversation as a user message",
			text: `${SUMMARY_PREFIX}\${summary}`,
			active: true,
		},
		{
			id: "extension-hooks",
			delivery: "event" as const,
			kind: "extension" as const,
			title: "Server extensions",
			when: "Extensions can replace or extend the system prompt (`before_agent_start`), rewrite the messages before each model call (`context`) and add parts to a user message. None of it is stored with the session",
			text: opts.extensionHooks.length ? `Active hooks: ${opts.extensionHooks.join(", ")}` : "No loaded extension uses these hooks.",
			active: opts.hasExtensions && opts.extensionHooks.length > 0,
		},
		{
			id: "helper-compaction",
			delivery: "separate" as const,
			kind: "helper" as const,
			title: "Compaction (summarizer)",
			when: "A separate model call when the conversation is compacted; its system prompt, then the request below",
			text: `${SUMMARY_SYSTEM}\n\n--- request ---\n${SUMMARY_REQUEST_TEMPLATE}`,
			active: true,
		},
		{
			id: "helper-describe",
			delivery: "separate" as const,
			kind: "helper" as const,
			title: "Session title and purpose",
			when: "A separate call to the system model after a session's first message (only when a system model is set)",
			text: `${DESCRIBE_SYSTEM}\n\n--- request ---\nWorking directory: \${cwd}\n\nFirst user message:\n\${text}\n\nLatest user message:\n\${text}\n\nReply with the JSON object now.`,
			active: true,
		},
		{
			id: "helper-group-name",
			delivery: "separate" as const,
			kind: "helper" as const,
			title: "Group name",
			when: "A separate call to the system model when a split group needs a name (only when a system model is set)",
			text: `${GROUP_NAME_SYSTEM}\n\n--- request ---\nSessions in the group:\n1. folder: …; title: …; role: …\n\nReply with the group name now.`,
			active: true,
		},
	].map(withBytes);
}
