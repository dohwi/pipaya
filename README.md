<div align="center">
  <img src=".github/assets/banner.svg" alt="pipaya" width="100%" />

  <p><b>English</b> · <a href="README.ko.md">한국어</a></p>

  <p>
    <a href="https://bun.sh" target="_blank" rel="noreferrer"><img src="https://img.shields.io/badge/Bun-1.3-000000?style=flat-square&logo=bun&logoColor=white" alt="Bun" /></a>
    <a href="https://fastify.dev" target="_blank" rel="noreferrer"><img src="https://img.shields.io/badge/Fastify-5-000000?style=flat-square&logo=fastify&logoColor=white" alt="Fastify" /></a>
    <a href="https://svelte.dev" target="_blank" rel="noreferrer"><img src="https://img.shields.io/badge/Svelte-5-FF3E00?style=flat-square&logo=svelte&logoColor=white" alt="Svelte" /></a>
    <a href="https://tauri.app" target="_blank" rel="noreferrer"><img src="https://img.shields.io/badge/Tauri-2-24C8DB?style=flat-square&logo=tauri&logoColor=white" alt="Tauri" /></a>
    <a href="https://www.typescriptlang.org" target="_blank" rel="noreferrer"><img src="https://img.shields.io/badge/TypeScript-5.x-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript" /></a>
    <a href="https://www.sqlite.org" target="_blank" rel="noreferrer"><img src="https://img.shields.io/badge/SQLite-3-003B57?style=flat-square&logo=sqlite&logoColor=white" alt="SQLite" /></a>
    <img src="https://img.shields.io/badge/Docker-Sandbox-2496ED?style=flat-square&logo=docker&logoColor=white" alt="Docker Sandbox" />
    <a href="LICENSE"><img src="https://img.shields.io/badge/License-AGPL_3.0-5C5C5C?style=flat-square" alt="AGPL-3.0" /></a>
    <a href="https://discord.gg/rn3uEghsjh" target="_blank" rel="noreferrer"><img src="https://img.shields.io/badge/Discord-Join-5865F2?style=flat-square&logo=discord&logoColor=white" alt="Discord" /></a>
  </p>
</div>

pipaya is an **AI agent chat tool that runs on your own server**. The server calls models and runs tools; the app connects to it from any device. Sessions, settings and API keys stay in your server's SQLite database. No cloud account needed.

## Features

- **Agent with 10 built-in tools**: read, write, edit, ls, grep, bash, ask_user, delegate, peer_send, peer_read
- **Approval policies**: `ask` (default), `auto`, `readonly`. You decide what may change things
- **Any model**: built-in providers, local servers (Ollama, LM Studio, llama.cpp, vLLM) or your own endpoint
- **Many devices, one conversation**: Windows, macOS, Android, iOS and web, with notifications and mobile push
- **Teamwork and split view**: hand work to other sessions with `@name`; up to 8 conversations on one screen
- **Extensible**: AGENTS.md, skills, templates, sub-agents, server and client extensions

## Quick install

Install the client. On Windows and macOS the app **bundles its own server** (shown as "This PC", loopback only), so there is nothing else to set up.

| Client | How |
|---|---|
| Windows x64 | `irm https://raw.githubusercontent.com/dohwi/pipaya/main/install.ps1 \| iex` |
| macOS (Apple Silicon) | `curl -fsSL https://raw.githubusercontent.com/dohwi/pipaya/main/install.sh \| bash -s -- client` |
| Android, iOS | Files on the [latest release](https://github.com/dohwi/pipaya/releases/tag/latest) (iOS IPA is unsigned). Needs a headless server below |
| Linux, web | `cd client && bun install && bun run dev -- --host 0.0.0.0`. Needs a headless server below |

Open the app and connect a model under **Settings → Model connections**.

## Headless server

Run the server on its own to use it from a phone, the web or several devices. Linux or macOS; requires `git` and `curl`, and the script asks before installing Bun.

```bash
curl -fsSL https://raw.githubusercontent.com/dohwi/pipaya/main/install.sh | bash
```

It registers a user service on port `8787` and prints where the access token is (`~/.pipaya/token`). The default listen address is your Tailscale IP if there is one, else `127.0.0.1`. In the app, add `http://<server address>:8787` and the token.

Other commands: `install.sh update | status | uninstall`. To run it in a container instead, see below.

## Server in Docker (Sandbox)

Runs the server in a hardened container, so the agent's `bash` and file tools stay inside it.

```bash
docker compose up -d --build
docker compose exec pipaya cat /data/token    # the auth token
```

Set `PIPAYA_WORKSPACE_DIR` (a host folder the agent may work on), `PIPAYA_BIND`, `PIPAYA_PORT` and `PIPAYA_APPROVAL` in a `.env` file. See [`compose.yaml`](compose.yaml).

## Security

- The token grants **administrator** access. Reach the server over Tailscale or HTTPS, never the open internet.
- API keys are stored **unencrypted** in the server database.
- The file tools can read outside the working folder and `bash` is **not a sandbox**. Keep the policy at `ask` and use Docker or a VM.

Report vulnerabilities privately: [SECURITY.md](SECURITY.md).

## Development

```bash
cd server && bun install && bun run dev          # API server
cd client && bun install && bun run dev          # web client (port 1420)
```

Before committing:

```bash
cd server && bun run typecheck && bun run lint && bun run test
cd client && bun run check && bun run test && bun run build
```

Prerequisites are pinned in [`mise.toml`](mise.toml) (Bun 1.3, Rust stable). The server is documented in [`server/README.md`](server/README.md) and the logo in [`logo/README.md`](logo/README.md). Commits follow [Conventional Commits](https://www.conventionalcommits.org).

## License

[AGPL-3.0](LICENSE)
