The limits defined in the code, gathered in one place. For how things behave, see each page. The values were copied directly from constants in the source.

## Messages and attachments → [[composer]]

| Item | Value |
|---|---|
| Message characters | 1,000,000 |
| Images | 8 per message |
| Image conversion | Scaled so the long side is 1568px. PNGs under 600KB are kept; others become JPEG (0.85) |
| Number of files | 8 per message |
| One file | 50MB |
| Files total | 100MB per message |
| Message request size | 192MB |
| Other request size | 2MB |
| WebSocket frame | 25MB |
| Upload storage location | `.pipaya/uploads/` in the working folder |
| Upload file name | Allowed characters are letters, digits and `. _ -`; the rest become `_`; last 120 characters |

## File mentions and previews → [[composer]]

| Item | Value |
|---|---|
| `#` suggestion results | 50 by default (up to 100) |
| `#` index range | 20,000 entries, 5-second cache, symlinks not followed |
| Folder picker | 500 at a time |
| Text preview | First 400,000 characters |
| Table (CSV, TSV) preview | First 1,000 rows |
| File size for previews | 50MB |

## Sessions and runs → [[sessions]], [[tools]]

| Item | Value |
|---|---|
| Session title | 200 characters (auto-generated: up to 60) |
| Purpose (`purpose`) | 200 characters (auto-generated: up to 120) |
| `systemPrompt` | 100,000 characters |
| Session list `limit` | 1–200, default 50 |
| Bulk delete | 500 at a time |
| Automatic deletion period | 1–3,650 days, default 30 days |
| Model calls in one run | 200 (`PIPAYA_MAX_RUN_TURNS`) |
| Repeated identical tool call | 6 in a row |
| Forced-stop wait | 8 seconds |
| Memory unload | 30 minutes unused |
| Event retention | 7 days |
| Message lookup `limit` | 1–5,000, default 1,000 |
| Event history `limit` | 1–1,000, default 200 |

## Tools → [[tools]]

| Item | Value |
|---|---|
| Tool output | 50KB (tail kept) |
| `read` lines | 2,000 lines |
| `grep` results | 200 lines, 30 seconds |
| `bash` timeout | 120 seconds by default, 1–1,800 seconds |
| Pipe drain after process exit | 2 seconds |
| `ask_user` question | 1–2,000 characters |
| `ask_user` options | 2–8, each 1–200 characters |
| `ask_user` multiple questions | 2–8 |
| Answer to a question | Up to 10,000 characters |
| Approval reason | 2,000 characters |
| Approval auto-deny | 10 minutes (`PIPAYA_APPROVAL_TIMEOUT_MS`, unlimited at 0) |

## Session collaboration → [[orchestration]]

| Item | Value |
|---|---|
| `peer_send` count | 10 per run |
| `peer_send` message | 8,000 characters |
| Session name length | 60 characters |
| `peer_read` count | 1–40 (default 10) |
| `peer_read` length per message | 1,500 characters |
| Name pool | 12 (then `철수2`…) |

## Split screen and terminals → [[panes]]

| Item | Value |
|---|---|
| Group members | 2–8 |
| Group name | 1–100 characters |
| Split ratio | 0.1–0.9 |
| Split nesting depth | 8 |
| Terminal count | 16 per server |
| Terminal scrollback | 512KB |
| Terminal name | 1–100 characters |
| Terminal size | 2–1,000 columns, 1–500 rows |
| Slow terminal connection | Cut off when 4MB behind |

## Context → [[context]]

| Item | Value |
|---|---|
| `AGENTS.md` | 64KiB per file, 256KiB total (a file over the limit is excluded entirely) |
| Auto-compaction threshold | `max(window × 0.5, window − 16,384)` |
| Kept verbatim at compaction | About the last 20,000 tokens |
| Tool output in the compaction summary | 2,000 characters per message |
| `/compact` instructions | 2,000 characters |

## Skills, templates and sub-agents → [[skills]], [[templates]], [[subagents]]

| Item | Value |
|---|---|
| Skill name | Lowercase letters, digits, single hyphens, 64 characters |
| Skill description | 1,024 characters (truncated beyond) |
| Skill count | 200 |
| Skill search depth | 4 levels |
| `/skill:` full text | 40,000 characters |
| Template files | 128KB, 200 |
| Template expansion result | 60,000 characters |
| Number of sub-agents | 10 |
| Helper name | Starts with a lowercase letter, 40 characters |
| Helper description | 1–200 characters |
| Helper extra instructions | 2,000 characters |
| Delegation request (`task`) | 4,000 characters |
| Helper tools | 1–6 |
| Max steps | 2–30 (default 12) |
| Report | About 300 words, cut at 6,000 characters |
| Output per call | 2,048 tokens |
| Helper file | 32KB |

## Models → [[models]]

| Item | Value |
|---|---|
| Models per connection | 100 |
| Provider ID | Starts with a lowercase letter, 64 characters |
| Context window | 128 to 10,000,000 |
| Max output | 1 up to the context window |
| Connection test | 32 output tokens, 30 seconds |
| Roles | 20, name 40 characters |
| `/llm/complete` output | 1,024 by default, up to 8,192 tokens |
| `/llm/complete` input / system | 200,000 characters / 20,000 characters |
| Sign-in | Expires after 10 minutes |
| System model output | 400 tokens |
| Reasoning strength | minimal, low, medium (default), high, xhigh, max |

## Notifications and devices → [[notifications]]

| Item | Value |
|---|---|
| Connection code | 2 minutes, single use, 5 at a time |
| Wrong codes | 10 per minute per caller, 100 per minute overall |
| Device label | 60 characters |
| Notification devices | Up to 100 |
| Device heartbeat | Disconnected if none within 45 seconds |
| Mobile "looking" | Honored for 25 seconds |
| Mobile push delay | 5 seconds (1 second if no device can display it) |
| Duplicate prevention | 24 hours |
| Escalation | Don't send / 1, 2, 3 (default), 5, 10, 15, 30, 60 minutes |
| Extension notifications | 5 per 10 seconds per source, title 183 characters, body 300 characters |
| Notification rules | 5 per owner |
| `visibleSessionIds` | 20 |

## Extensions, settings and sync → [[server-extensions]], [[client-extensions]], [[settings]]

| Item | Value |
|---|---|
| Server extension error log | Last 100 |
| Server extension unload wait | 2 seconds |
| Client extension package | 256KB |
| Extension code | 128KB |
| Extension setting fields | 20 |
| Extension settings JSON | 16,000 characters (server storage) / 16KB (screen) |
| Extension's own storage | 32KB per extension |
| Extension SDK requests | 5-second limit, 100 at a time |
| `composer-filter` | 2 seconds |
| `session` permission | 5 per 10 seconds |
| Extension shortcuts | 10 per extension |
| navbar / slots | 3 / 2 per extension |
| Extension commands | 20, template 16,000 characters |
| Language packs | 20 on the server, 3,000 messages per pack (key 1,000 characters, value 2,000 characters), 5 per extension package |
| Favorite models | 100,000 characters |
| Settings backup file | 4MiB |
| Skill overrides | 500 per project or session |
