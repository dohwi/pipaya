Installation has two parts: a **client** (the app) and the **server** (required). Install the client app first, then the server it connects to.

## Requirements

| Item | Notes |
|---|---|
| Server OS | Linux or macOS (for the install script) |
| Tools | `git` and `curl`. The script asks before installing Bun (pinned version, checksum verified) |
| Network | [Tailscale](https://tailscale.com) is recommended for access from other devices |

## Install a client

| Platform | How | File |
|---|---|---|
| Windows x64 | In PowerShell: `irm https://raw.githubusercontent.com/dohwi/pipaya/main/install.ps1 \| iex` | `pipaya-windows-x64-setup.exe` |
| macOS Apple Silicon | `install.sh client` downloads it, then drag it to Applications | `pipaya-macos-arm64.dmg` |
| Android arm64 | Install the APK from the release | `pipaya-android-arm64.apk` |
| iOS | CI builds an unsigned IPA. You need to sign it yourself | `pipaya-ios-arm64-unsigned.ipa` |
| Linux / web | No prebuilt app. Use the web client | |

Releases: `https://github.com/dohwi/pipaya/releases/tag/latest`. Every file's checksum is in `SHA256SUMS.txt`, and the scripts verify it after downloading.

> [!NOTE]
> The Windows installer has no Authenticode signature, so SmartScreen may warn you. The macOS app is ad-hoc signed and not notarized. If the first launch is blocked, open **System Settings → Privacy & Security → Open Anyway**.

### Web client (including Linux)

```bash
cd client
bun install
bun run dev -- --host 0.0.0.0     # default port 1420
```

For static files, run `bun run build` to produce `client/dist/`. When you open the client from a different address than the server, add that address to the server's `PIPAYA_CORS_ORIGINS`. Loopback, Tailscale (`100.64.0.0/10`, `*.ts.net`), private networks (RFC1918) and Tauri origins are allowed by default.

### Build the desktop app yourself

```bash
cd client
bun run tauri dev       # on Linux you need webkit2gtk-4.1 and other build dependencies
```

## Install the server

### Option A. Install script (recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/dohwi/pipaya/main/install.sh | bash
```

The script:

1. Checks for Bun and installs it if needed, verifying the checksum
2. Fetches the code into `~/.local/share/pipaya`
3. Registers and starts a user service (Linux: systemd `--user`, macOS: launchd). It restarts after a crash or a clean exit
4. Prints the address and where the token is

| Option | Default | Description |
|---|---|---|
| `--host ADDR` | Tailscale IPv4, else `127.0.0.1` | Listen address. Use `0.0.0.0` only behind a firewall or private network |
| `--port N` | `8787` | Port |
| `--approval MODE` | `ask` | `ask` / `readonly` / `auto` |
| `--ref REF` | `main` | Branch or tag to install |
| `--dir PATH` | `~/.local/share/pipaya` | Install location |
| `--no-service` | | Install only, no service |
| `-y`, `--yes` | | Do not ask before installing Bun |

```bash
# Listen on the Tailscale address
curl -fsSL https://raw.githubusercontent.com/dohwi/pipaya/main/install.sh | bash -s -- --host "$(tailscale ip -4)"
```

| Management command | Description |
|---|---|
| `install.sh status` | Show whether the server is running (calls `/health`) |
| `install.sh update` | Fetch the latest code and restart the service |
| `install.sh client` | Download the client for this OS and verify its checksum |
| `install.sh uninstall` | Remove the service and code. **Data is kept** |

The service is named `pipaya` on Linux (a systemd user unit) and `app.pipaya.server` on macOS (launchd). The settings file is `~/.config/pipaya/server.env`.

Read the token after installing:

```bash
cat ~/.pipaya/token
```

### Option B. Run manually

```bash
git clone https://github.com/dohwi/pipaya.git
cd pipaya/server
bun install
bun run start        # bun run dev while developing
```

The repository's `mise.toml` pins Bun 1.3 and stable Rust. Running it directly listens on `0.0.0.0:8787` by default, so use it only on a private network.

### Option C. Docker (isolated)

The agent's `bash` and file work runs **inside the container**, not on your host.

```bash
docker compose up -d --build
docker compose exec pipaya cat /data/token     # show the token
```

| Variable | Default | Description |
|---|---|---|
| `PIPAYA_BIND` | `127.0.0.1` | Address to publish. Use your Tailscale IP for other devices |
| `PIPAYA_PORT` | `8787` | Host port |
| `PIPAYA_WORKSPACE_DIR` | Docker volume | Host folder to give the agent. Files in it can be changed or deleted |
| `PIPAYA_APPROVAL` | `ask` | Approval policy |
| `PIPAYA_TOKEN` | Generated | Leave empty to create `/data/token` |
| `PIPAYA_CORS_ORIGINS` | None | Extra allowed origins |
| `PIPAYA_MEM_LIMIT` / `PIPAYA_CPUS` | `2g` / `2` | Resource limits |

Put variables in a `.env` file next to `compose.yaml`. The container runs as a non-root user (`10001`) with a read-only root filesystem, `cap_drop: ALL`, `no-new-privileges` and `pids_limit: 512`. Only `/tmp` (512 MB) and the home folder (256 MB) are writable tmpfs.

To use Ollama on the host, uncomment `extra_hosts` in `compose.yaml` and register the connection URL as `http://host.docker.internal:11434/v1`.

## Verify

```bash
curl http://<server address>:8787/health
```

A JSON response with `ok`, `version` and `protocol` means the server is up (without a token, the load figures are left out). Continue with [[quick-start]].
