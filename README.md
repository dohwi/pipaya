<div align="center">
  <img src="client/src-tauri/icons/128x128@2x.png" alt="pipaya" width="140" />
  <h1>pipaya</h1>
  <p>A self-hosted harness for LLM coding agents: a Bun + Fastify API server and a Svelte 5 + Tauri 2 chat client.</p>

  <p><b>English</b> · <a href="README.ko.md">한국어</a></p>

  <p>
    <a href="https://bun.sh" target="_blank" rel="noreferrer"><img src="https://img.shields.io/badge/Bun-1.3-000000?style=flat-square&logo=bun&logoColor=white" alt="Bun" /></a>
    <a href="https://fastify.dev" target="_blank" rel="noreferrer"><img src="https://img.shields.io/badge/Fastify-5-000000?style=flat-square&logo=fastify&logoColor=white" alt="Fastify" /></a>
    <a href="https://svelte.dev" target="_blank" rel="noreferrer"><img src="https://img.shields.io/badge/Svelte-5-FF3E00?style=flat-square&logo=svelte&logoColor=white" alt="Svelte" /></a>
    <a href="https://tauri.app" target="_blank" rel="noreferrer"><img src="https://img.shields.io/badge/Tauri-2-24C8DB?style=flat-square&logo=tauri&logoColor=white" alt="Tauri" /></a>
    <a href="https://www.typescriptlang.org" target="_blank" rel="noreferrer"><img src="https://img.shields.io/badge/TypeScript-5.x-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript" /></a>
    <a href="https://www.sqlite.org" target="_blank" rel="noreferrer"><img src="https://img.shields.io/badge/SQLite-3-003B57?style=flat-square&logo=sqlite&logoColor=white" alt="SQLite" /></a>
    <a href="#server-in-docker-sandbox"><img src="https://img.shields.io/badge/Docker-Sandbox-2496ED?style=flat-square&logo=docker&logoColor=white" alt="Docker Sandbox" /></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/License-AGPL_3.0-5C5C5C?style=flat-square" alt="AGPL-3.0" /></a>
  </p>

  <p>
    <a href="#quick-install"><b>Install</b></a> ·
    <a href="#server-in-docker-sandbox"><b>Docker Sandbox</b></a> ·
    <a href="#client"><b>Download</b></a> ·
    <a href="server/README.md">Server docs</a> ·
    <a href="client/README.md">Client docs</a>
  </p>
</div>

---

## Preview

<p align="center">
  <img src=".github/assets/preview-desktop.png" alt="Two chats side by side in a split-pane session group, with tool calls and token usage" width="100%" />
  <br />
  <sub>Session groups: run several agents side by side, each with its own tools, model and approval policy.</sub>
</p>

| Light theme | Settings |
| :---: | :---: |
| <img src=".github/assets/preview-light.png" alt="Light theme with a split-pane session group" width="100%" /> | <img src=".github/assets/preview-settings.png" alt="Settings dialog with language, theme, tool approval and notification sound" width="100%" /> |

<p align="center">
  <img src=".github/assets/preview-mobile.png" alt="Mobile layout of a chat with tool calls" width="280" />
  <br />
  <sub>The same client on mobile.</sub>
</p>

## Overview

`pipaya` is a monorepo with an API-only **server** (`server/`) that runs LLM coding agents, and a desktop, mobile and web **client** (`client/`) that drives it.
The server manages sessions, tool execution, approval policy and model connections. Commands go over REST; progress is delivered over SSE and WebSocket.

You bring the models: there are no built-in providers, and API keys never leave your server.

## Features

### Agent and safety

- **Custom-only model connections**: register OpenAI Chat Completions, OpenAI Responses or Anthropic Messages compatible endpoints yourself. API keys are stored only in the server's SQLite database.
- **Tool approval policy**: each session uses `auto`, `ask` or `readonly`. Under `ask`, mutating tools (`write`, `edit`, `bash`) wait for you and are denied automatically on timeout.
- **Working-directory isolation**: file tools cannot open anything outside the session's working directory, symlinks included, and `bash` does not inherit the server's `HARNESS_*` environment variables.
- **Skills and AGENTS.md**: global and project skills are discovered and advertised in the system prompt; instructions are frozen into the session on its first run.
- **Docker sandbox**: run the server in a hardened container so the agent's commands never touch your host ([details](#server-in-docker-sandbox)).

### Experience

- **English and Korean UI**: both ship with the client and follow the device language. Other languages are added with a language-pack extension and shared across devices through the server (`GET/PUT /locales`).
- **Client extensions**: extension code runs in a Worker inside an opaque-origin iframe (network blocked by CSP) and talks to the host only through a permission-checked MessagePort.
- **Auto-update**: Windows and macOS apps update themselves after verifying a signature; Android tells you when a new build is out. Check in Settings → General.
- **Notifications**: desktop and web OS notifications, suppressed while a window is in focus; optional Android push through Firebase Cloud Messaging.
- **Live event stream**: SSE and WebSocket with a global, increasing cursor. `Last-Event-ID` replays missed events without gaps.
- **Session groups**: split-pane layouts and multiple server connections.

<details>
<summary>How session groups work</summary>

- Groups are created by dragging a chat onto another chat in the sidebar, not set up in advance. A group dissolves when one chat is left (the server enforces a minimum of two).
- Shortcuts split the selected pane: `Ctrl+\` (right) and `Ctrl+Shift+\` (below) create a new chat and group it at once. Assign keys for left and up splits in Settings → Shortcuts. The new chat starts in the same working directory and model as the pane you split.
- When dropping on screen there is no center zone; the pane splits toward the nearest edge.

</details>

## Quick Install

Pick how you want to run the server:

| Setup | Best for | Isolation |
|---|---|---|
| [**Host install**](#server-linux-macos) | Daily use on your own machine or server | None: tools run as your user |
| [**Docker (Sandbox)**](#server-in-docker-sandbox) | Keeping the agent's commands away from your host | Container, unprivileged, read-only root |
| [**From source**](#getting-started-development) | Development | None |

Every option ends with a server URL and a token. Then set up a [client](#client).

### Server (Linux, macOS)

```bash
curl -fsSL https://raw.githubusercontent.com/pipaya/main/install.sh | bash
```

The installer needs `git` and `curl`. It installs Bun (after asking), fetches the server into `~/.local/share/pipaya`, and starts it as a **user service** (systemd or launchd). The service **restarts automatically** after a crash or kill and starts at boot (on Linux the installer enables `loginctl enable-linger` for this when it can). Nothing runs as root.

- **Address**: your **Tailscale address** if Tailscale is installed, otherwise `127.0.0.1` only. Use `--host 0.0.0.0` only behind a firewall.
- **Token**: created in `~/.pipaya/token` (mode `0600`).
- **Approval policy**: `ask` by default.

```bash
curl -fsSL https://raw.githubusercontent.com/pipaya/main/install.sh | bash -s -- --port 9000 --approval ask
bash ~/.local/share/pipaya/install.sh update      # pull the latest code and restart
bash ~/.local/share/pipaya/install.sh status
bash ~/.local/share/pipaya/install.sh uninstall   # keeps ~/.pipaya
```

Run `install.sh --help` for all options. To review the script before running it, download it first: `curl -fsSLO https://raw.githubusercontent.com/pipaya/main/install.sh`.

### Server in Docker (Sandbox)

If you do not want the agent's `bash`, `write` and `edit` tools to touch your host, run the server in a container. It needs only Docker with Compose.

```bash
git clone https://github.com/dohwi/pipaya.git && cd pipaya
docker compose up -d --build
docker compose exec harness cat /data/token      # the auth token
```

The server is then at `http://127.0.0.1:8787`.

| Topic | Details |
|---|---|
| **What the agent can reach** | Only the container. Its working folder is the `workspace` volume, so it cannot see your home directory or other projects. |
| **Work on a host project** | Set `HARNESS_WORKSPACE_DIR=/path/to/project` in a `.env` file next to `compose.yaml`. That folder is writable by the agent. |
| **Hardening** | Unprivileged user (uid 10001), read-only root filesystem, all Linux capabilities dropped, `no-new-privileges`, and limits of 2 GB memory, 2 CPUs and 512 processes (`HARNESS_MEM_LIMIT`, `HARNESS_CPUS`). |
| **Network** | Published on `127.0.0.1` only. To reach it from a phone, set `HARNESS_BIND` to your Tailscale address, never a public one. |
| **Data** | Sessions, API keys and the token live in the `data` volume. Back it up; `docker compose down -v` deletes it. |
| **Included tools** | `git`, `ripgrep` and `bash`. Add what your projects need (node, python, ...) to [server/Dockerfile](server/Dockerfile). |
| **Local model servers** | The container cannot see `localhost` on the host. Uncomment `extra_hosts` in `compose.yaml` and register `http://host.docker.internal:11434/v1` as the connection URL. |

> [!WARNING]
> The sandbox limits the damage a bad command can do; it is not a complete security boundary. The container can still reach the network, including your LAN, and it has full control over the mounted workspace. Do not mount `/var/run/docker.sock` or sensitive folders into it.

### Client

Every platform is in the [latest release](https://github.com/dohwi/pipaya/releases/tag/latest). The Windows and macOS scripts verify the download against `SHA256SUMS.txt` and abort on a mismatch.

| Platform | Install |
|---|---|
| Windows x64 | `irm https://raw.githubusercontent.com/pipaya/main/install.ps1 \| iex` |
| macOS (Apple Silicon) | `curl -fsSL https://raw.githubusercontent.com/pipaya/main/install.sh \| bash -s -- client` |
| Android ARM64 | Signed APK from the release |
| iOS ARM64 | Unsigned IPA from the release; it cannot be installed as is and needs Apple signing and provisioning |

> [!NOTE]
> The Windows installer is not code-signed and the macOS DMG is ad-hoc signed but not notarized, so the OS may warn on first launch.
>
> - **macOS first launch**: If macOS blocks the app ("cannot be opened because it is from an unidentified developer" or "cannot check it for malicious software"), go to **System Settings → Privacy & Security**, scroll down to the Security section, and click **Open Anyway**. Alternatively, right-click (or Control-click) the app in `/Applications` and select **Open**, then click **Open** in the confirmation dialog.
> - **macOS Terminal bypass**: `xattr -cr /Applications/pipaya.app` removes the Gatekeeper quarantine flag directly.

**Connect**: open the client, enter the server URL and token, then add a model connection under Settings → Models.

<details>
<summary>How releases are built</summary>

When client files change on `main`, GitHub Actions builds all four platforms and, after every check passes, replaces the files of the single fixed `latest` release. The server is not included, and installed Windows and macOS apps update themselves from it (see [in-app updates](client/docs/releases.md#in-app-updates)).

Build environment, Android signing and release operations: [client/docs/releases.md](client/docs/releases.md).

</details>

## Tech Stack

| Domain | Technology / Specification |
|---|---|
| Server Runtime | Bun 1.3 / TypeScript 5.x |
| HTTP & Realtime | Fastify 5, `@fastify/websocket`, SSE |
| Agent Core | `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai` |
| Validation | TypeBox |
| Storage | SQLite (`bun:sqlite`, WAL) |
| Client | Svelte 5, Vite 8, marked + DOMPurify |
| Desktop / Mobile | Tauri 2 (Rust, edition 2021) |
| Containerization | Docker / Docker Compose |

## Getting Started (Development)

Prepare the runtimes with [mise](https://mise.jdx.dev):

```bash
mise trust
mise install
```

Start the server (`http://0.0.0.0:8787`) and the client (`http://0.0.0.0:1420`) in two terminals:

```bash
# Terminal 1: server
cd server && bun install && bun run dev

# Terminal 2: client
cd client && bun install && bun run dev
```

On first start the server generates an auth token at `~/.pipaya/token` (or set `HARNESS_TOKEN`); connect the client as described in [Client](#client).
Run the desktop app with `bun run tauri dev` (Linux needs webkit2gtk-4.1).

Run the tests:

```bash
cd server && bun run typecheck && bun test
cd client && bun run check && bun test tests
```

## Configuration

The server is configured through `server/.env` (see [server/.env.example](server/.env.example)) or environment variables.

| Variable | Default | Purpose |
|---|---|---|
| `HARNESS_HOST` / `HARNESS_PORT` | `0.0.0.0` / `8787` | Listen address |
| `HARNESS_TOKEN` | generated | Bearer auth token (at least 24 characters) |
| `HARNESS_RESTRICT_WORKSPACE` | `0` | `1` keeps sessions, the folder picker and the default working directory inside `HARNESS_WORKSPACE`. Off by default: any existing folder on the server may be used |
| `HARNESS_BASH_ENV` | _(empty)_ | Extra env var names (comma separated) the agent's `bash` may inherit. By default only a safe allow-list (`PATH`, `HOME`, `LANG`, ...) is passed; cloud credentials and `HARNESS_*` are withheld |
| `HARNESS_DATA_DIR` | `~/.pipaya` | Database, token, default workspace |
| `HARNESS_APPROVAL` | `ask` | `auto`, `ask` or `readonly` |
| `HARNESS_CORS_ORIGINS` | _(empty)_ | Extra allowed browser origins (exact match; `*` allows all) |

The full list is in [server/README.md](server/README.md#runtime-configuration).

## Security

> [!WARNING]
> The token grants administrator access. The development default binds to `0.0.0.0`, so expose the server only on a private network such as Tailscale or behind HTTPS, and never share the token with an untrusted client. The installer binds to loopback or Tailscale instead.

- **No sandbox by default**: the `auto` approval policy and the `bash` tool run arbitrary commands with the server user's permissions. For isolation, use the [Docker sandbox](#server-in-docker-sandbox) or a dedicated user.
- **Model URLs**: connection URLs are requested by the server itself, including LAN addresses. Register only endpoints you trust.
- **Secrets at rest**: API keys are stored **unencrypted** in `harness.db`. The data directory is created with mode `0700` and the database and token with `0600`.
- **Browser access**: limited by CORS to the Tauri app, loopback, Tailscale and private LAN origins unless you add more with `HARNESS_CORS_ORIGINS`.
- **Reporting**: report vulnerabilities privately; see [SECURITY.md](SECURITY.md).

## Project Structure

```
pipaya/
├── install.sh             # Server and macOS client installer (Linux, macOS)
├── install.ps1            # Windows client installer
├── compose.yaml           # Docker sandbox for the server
├── server/                # API server (Bun + Fastify + SQLite)
│   ├── Dockerfile         # Sandbox image
│   ├── src/               # Routes, sessions, tools, approvals, skills, locales, notifications
│   └── test/              # bun test
├── client/                # Svelte 5 + Tauri 2 client
│   ├── src/               # Components, stores, API client, extension runtime, locales
│   ├── src-tauri/         # Tauri shell (Rust)
│   ├── docs/              # Extension, skill and context docs (Korean)
│   └── tests/             # bun test
└── mise.toml              # Runtime versions (bun, rust)
```

Detailed docs: [server/README.md](server/README.md) (API and configuration) and [client/README.md](client/README.md), [client/docs/](client/docs) (client and extensions, written in Korean).

## License

[GNU Affero General Public License v3.0](LICENSE) (AGPL-3.0). You may use, modify and distribute this software, including for commercial purposes, as long as you comply with the AGPL. If you modify it and run it as a network service, you must offer the corresponding source code of your modified version to its users. Derivative works must be released under the same license. This is an OSI-approved open-source license. For a separate commercial license that does not carry these obligations, contact the author through [GitHub](https://github.com/dohwi).
