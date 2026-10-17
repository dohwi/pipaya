The agent does real work through tools. This page covers the behavior of the 10 tools, the approval policy, path rules and safeguards.

## Tool list

| Tool | Function | Modifies | Included by default |
|---|---|---|---|
| `read` | Read a text file | No | Yes |
| `write` | Write a file (overwrite) | **Yes** | Yes |
| `edit` | Replace part of a file | **Yes** | Yes |
| `ls` | List a folder | No | Yes |
| `grep` | Search contents | No | Yes |
| `bash` | Run a shell command | **Yes** | Yes |
| `ask_user` | Ask the user a question mid-run | No | Yes (can be turned off in settings) |
| `delegate` | Hand research to a sub-agent | Depends on the helper's tools | Yes |
| `peer_send` | Send a message to another session | No | **Always** |
| `peer_read` | Read another session's recent history | No | **Always** |

`peer_send` and `peer_read` are included in every session regardless of its tool list, and run without approval. The tool list and defaults can be seen with `GET /tools`. Extensions can add tools or change the default list → [[server-extensions]].

## Output limits

| Item | Value |
|---|---|
| Tool output cap | **50KB**. If exceeded, **the tail is kept** and `[output truncated, showing last 51200 bytes]` is put in front |
| `read` lines | Up to **2,000 lines**. If there are more, a `[N more lines; continue with offset=…]` note |
| `grep` results | Up to **200 lines**. If there are more, `[N more matches]` |
| `grep` time | 30 seconds |

## Each tool

### read

| Argument | Description |
|---|---|
| `path` | File path. Relative to the working folder, or absolute |
| `offset` | Start line (from 1). Default 1 |
| `limit` | Number of lines. Default and maximum 2,000 |

It reads the file as UTF-8 text. We found no separate handling for images or binaries. A folder of an enabled skill can be read even if it is outside the working directory.

### write

Takes `path` and `content` and creates the file. **It creates missing parent folders and overwrites an existing file.**

### edit

`path`, `oldText`, `newText`. `oldText` must appear in the file **exactly once**. If it does not, the error is `oldText was not found in the file`; if it appears more than once, `oldText matches more than once; include more surrounding context`. Each call changes one place.

### ls

`path` (default `.`). Folders get a `/` after the name and the list is sorted. If empty, `(empty)`. We found no limit on the number of entries.

### grep

`pattern`, `path` (optional), `glob` (optional). If `rg` (ripgrep) is installed it uses `rg -n --no-heading --max-columns 300`; otherwise the system `grep -rnIE`.

### bash

| Argument | Description |
|---|---|
| `command` | The command to run |
| `timeout` | Limit in seconds. 1–1800, default **120** |

- It runs with `bash -c` in the working directory. On Linux and macOS it creates a new process group with `setsid`, and input is empty (no `stdin`).
- On timeout or abort, it sends `SIGKILL` to the whole process group and waits up to 2 seconds for the output pipes to drain.
- **It is not a sandbox.** It runs with the permissions of the user running the server.
- The child process receives **only allow-listed environment variables** (`PATH` `HOME` `USER` `SHELL` `TERM` `LANG` `TZ` `TMPDIR`, proxy variables, `SSL_CERT_*`, `BUN_INSTALL` `CARGO_HOME` `GOPATH` `JAVA_HOME` and the like, and the prefixes `LC_` `XDG_` `MISE_`). No `PIPAYA_*` is passed on; to pass more, set `PIPAYA_BASH_ENV=NAME1,NAME2` on the server. This is a safeguard against leaking cloud credentials or the FCM service account path.

### ask_user

The agent asks the user mid-run and waits for the answer.

| Argument | Description |
|---|---|
| `question` | The question. 1–2,000 characters |
| `options` | Choices. 2–8, each 1–200 characters |
| `recommended` | The recommended choice. One of `options` |
| `allowFreeText` | Allow typed answers. Default `true` |
| `questions` | Several questions at once. 2–8 (shown as tabs, and answers can be revised before sending) |

**There is no time limit.** It waits until you answer or abort. If you turn off **Allow questions** under Settings → General, the agent does not ask and proceeds on assumptions (stored on the server and applied to all chats). See pending questions with `GET /questions` and answer with `POST /sessions/:id/questions/:toolCallId`.

### delegate

`task` (1–4,000 characters), `agent` (optional; if omitted, the first enabled helper). Helper setup and limits are in [[subagents]].

### peer_send / peer_read

Collaboration tools between sessions. → [[orchestration]]

## Approval policy

`write`, `edit`, `bash`, and `delegate` when it calls a helper with write access are subject to approval.

| Policy | Behavior |
|---|---|
| `ask` (default) | Asks the user only for modifying actions that reach **outside** the project |
| `auto` | Runs without asking |
| `readonly` | Blocks modifying actions. The model is told `"<tool>" is disabled: this session is read-only` |

There is a server default policy (`PIPAYA_APPROVAL`, **Tool approval** under Settings → General); new sessions follow it, and each session can change it. The app lets you choose only `ask` and `auto`; `readonly` can be set only through the API.

### What counts as "outside the project"

The rules for deciding whether `ask` needs confirmation.

| Tool | When confirmation is needed |
|---|---|
| `write`, `edit` | When the target path is **outside** the working directory (symlinks are judged by their real location) |
| `bash` | When any word in the command points outside the working directory |
| `delegate` | A helper with write tools cannot be judged in advance, so **always** confirmed |
| Modifying tools made by extensions | The server cannot judge them, so **always** confirmed |

The `bash` judgment **reads the string**, so it is conservative and has limits.

- Counted as outside: absolute paths that resolve outside the working folder, `~`, `$HOME`, paths containing `..`, and `$VAR/…` that cannot be resolved
- Ignored: URLs, standard devices like `/dev/null`, and absolute-path words that do not actually exist (patterns such as `sed`'s `/foo/d`)
- **Not caught**: command substitution (`$(…)`), variables that hold only a path, and what a script or another program does by itself

> [!WARNING]
> `ask` does not ask about changes **inside** the working folder. A `bash` command inside the project can be dangerous too, so on an important server run it in Docker or a VM.

### Approval flow

![The approval card. (1) shows **Confirmation needed** (2) shows the whole command to be run (3) **Deny** lets you write a reason and (4) pressing **Approve** runs it](/assets/img/ui/en/approval.png)

1. Just before the tool call, an `approval_requested` event is sent and the approval card appears.
2. The user chooses **Approve** or **Deny** (a reason can be entered).
3. The decision is announced as `approval_resolved` (`source`: `user` / `timeout` / `abort`).
4. With no response, after `PIPAYA_APPROVAL_TIMEOUT_MS` (default 10 minutes; 0 for unlimited) it is denied as `Approval timed out`.

![After approval, the marker changes to **Done** and the agent picks up the result and answers](/assets/img/ui/en/approved.png)

See pending approvals with `GET /approvals?sessionId=` and decide by sending `{approved, reason?}` to `POST /sessions/:id/approvals/:toolCallId`. In the app, use the buttons on the approval card, or the *Approve/Deny tool run* shortcuts (no default). There is also a shortcut to switch the approval mode → [[shortcuts]].

## Path rules

> [!WARNING]
> **The current code does not restrict the file tools' paths to the working directory.** `read`, `write`, `edit`, `ls` and `grep` can work outside the working folder with absolute paths or `../`. The check `safePath` used to perform was intentionally removed in commit `cb26464` ("drop path restriction"), and it now returns the path as is. **Modifications** that go outside are controlled only by approval under the `ask` policy, and **reading is not blocked under any policy.**

| Tool | Path handling |
|---|---|
| `read` `ls` `grep` | No restriction. Not subject to approval |
| `write` `edit` | No restriction. Approval needed under `ask` if outside the project |
| `bash` | No restriction. Under `ask`, judged by the string rules above |

The server setting `PIPAYA_RESTRICT_WORKSPACE=1` only restricts **the session's `cwd`, the folder picker and the default folder** to the workspace; it does not block the paths the agent tools read.

If you need isolation, use the Docker setup in [[security]]. Inside a container, the filesystem the agent can see is itself limited.

## Safeguards

| Safeguard | Value | Description |
|---|---|---|
| Max model calls | 200 per run | Change with `PIPAYA_MAX_RUN_TURNS`. If exceeded, it stops with a note to "send a message to continue" |
| Repeated-call detection | 6 identical calls in a row | Stops when tool calls with the same name and arguments (per turn) repeat 6 times |
| Forced stop | 8 seconds after the abort request | If it does not stop, the run is cut off and ends as `aborted` |
| Approval timeout | 10 minutes | Default |
| `peer_send` | 10 per run | Prevents endless ping-pong between sessions |
| bash timeout | 120 seconds by default, up to 1800 | |

## Tool calls and events

Tool execution is announced by the events `tool_execution_start` → `tool_execution_update` (intermediate output, not stored) → `tool_execution_end`, and the state is shown on the app's tool card: preparing, approval needed, answer needed, running, done, failed, denied, not run. If there is an exit code, it is shown too. → [[events]]
