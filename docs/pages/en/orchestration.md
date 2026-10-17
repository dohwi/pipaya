This feature lets you keep several chats (sessions) open, and have one session hand work to another or read its progress. You mention them in the input box with `@name`.

## Concepts

| Term | Description |
|---|---|
| Session | One chat. Each has its own independent model, working folder and history |
| Name (`@name`) | A call name assigned to each session automatically |
| Purpose (`purpose`) | One line on what this session is for. Written by the system model → [[models]] |
| Pane | A session visible on screen. Split view shows several panes at once → [[panes]] |
| Collaboration tools | `peer_send` (send), `peer_read` (read) |

Sessions **do not share each other's conversations automatically.** Only what is written in the message you send reaches the other side.

## Session names

When a new session is created, the first name in the order below that no active session is using is assigned.

```text
철수, 미나, 제임스, 영희, 민준, 소피아, 지우, 에밀리, 하준, 루카, 서연, 토마스
```

The names are fixed Korean names and are not translated; type them as shown in the app.

- If all 12 are in use, it continues as `철수2`, `철수3`…
- Names are based on **active sessions** and are case-insensitive.
- A closed session drops out of the `@` list and its name can be used again.
- `@name` is shown in the sidebar and the pane title bar; the title is set automatically from the first message or changed with `/rename`. The menu shows the **pane title** next to the name, so you can tell what each session is doing.

## Usage

### Handing off work

```text
Tell @미나 to write the login API tests
```

1. Type `@` in the input box and pick a session from the list.
2. Send your request.
3. The agent in the current chat hands the task to Mina with `peer_send`.
4. Mina works **independently** in her own session.

### Checking results

```text
Check how far @미나 got and summarize it
```

The agent reads Mina's recent history with `peer_read` and summarizes it.

### Several sessions at once

```text
@철수 takes the server side and @미나 takes the client side. The interface follows docs/api.md
```

You can write several names in one message, and a repeated name is recognized only once.

## Internal behavior

::: steps
### A hidden hint is appended

If a message contains `@name`, the server appends a **hidden hint** for the agent. It says "the user mentioned these sessions; hand work over with `peer_send` and check with `peer_read`. Do not guess what they did." It is not shown on screen.

### Delivery

The agent calls `peer_send(to, message)`. The receiving session gets a message with the header below.

```text
[from @sender, another session on this server; answer with peer_send to @sender only if a reply is needed]
```

### How the receiver handles it

If the receiving session is **idle**, it starts as a new request. If it is **working**, it enters the queue as a follow-up request (`follow_up`) and is handled after the current turn ends.

### The sender does not wait

The sender carries on right away. If you need the result, check later with `peer_read` or ask the receiver to reply.
:::

## Tool specification

| Tool | Arguments | Limits |
|---|---|---|
| `peer_send` | `to` (name, `@` optional), `message` | Name 1–60 characters, message 1–8,000 characters. **At most 10 times per run** |
| `peer_read` | `from`, `count` (optional) | `count` 1–40, default 10. Only the first 1,500 characters of each message are returned |

- Both tools are **included in every session by default** and run without an approval request.
- `peer_read` shows only text and tool call names (in the form `[tool bash]`). Tool output bodies, images and hidden hints are not included.
- If the other side is still working, a "still working" note is put at the start of the result. If there is no history, `has no messages yet` is returned.
- For an unknown name, an error is returned together with **the list of sessions you can call right now**. Case is ignored.
- You cannot send to yourself, and closed sessions cannot be found.

## Preventing endless ping-pong

Two sessions that keep replying to each other might never end, so a session can make **at most 10 `peer_send` calls in one run**. From the 11th, the agent gets an error (`409`) telling it to "stop and report to the user".

Recommended habits:

- Say "tell me when you are done" explicitly only when a reply is really needed. The receiving session is also told in its header to "reply only when necessary".
- Using a **hub structure**, where one session coordinates everything and the rest report only to the hub, keeps the flow simple.

## Permissions and safety

- The collaboration tools themselves need no approval, but **the receiving session acts under its own approval policy**. If the receiving session tries to write a file or run a command, the approval request appears in that session.
- If the receiving session's working folder is different, it works relative to that folder. If two or more sessions edit the same folder at once, **they may overwrite each other's changes**, so divide roles by folder or file.
- Handing work to a session with the `auto` policy runs it without confirmation. Use it only in an isolated environment → [[security]].

## Difference from sub-agents

| | **Sub-agent** (`delegate`) | **Session collaboration** (`@`, `peer_send`) |
|---|---|---|
| The other side | A temporary helper | An independent chat (session) |
| Context | Sees only the request text | Has its own history and working folder |
| Result | One report comes straight back | Asynchronous. Check later with `peer_read` |
| Tools | Only the configured tools (read-only by default) | All of that session's tools and approval policy |
| Model | Can be set per helper | The model the session uses |
| Use for | Short, read-heavy work like search and research | Long-running parallel work, division of roles |

## Examples

**Dividing roles**

```text
@철수 does the backend and @미나 the frontend. Have Chulsoo write the API spec in docs/api.md, then have Mina read it and implement
```

**A reviewer session**

```text
@제임스 is a review-only session. When my changes are done, send him the diff for review and summarize his remarks
```

**Progress check**

```text
Read how far @철수 and @미나 each got and put it in a table
```

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| No sessions in the `@` menu | There is no other active session with a name. Open a new chat |
| "session @name …" cannot be found | It is a closed session or the name is misspelled. Pick from the list shown in the error |
| The 10-call limit error | The ping-pong safeguard. Ask for a summary report and continue with a new instruction |
| The other side does not respond | If it is working, it waits its turn in the queue. Check its status with `peer_read` |
| The other side seems stuck | An approval request may be pending in that session. The sidebar shows the waiting-for-approval state |
| They overwrite each other's files | They edit the same folder at once. Divide roles by folder or file |
