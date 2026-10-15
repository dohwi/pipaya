#!/usr/bin/env bash
# pipaya installer (Linux, macOS).
#
#   curl -fsSL https://raw.githubusercontent.com/pipaya/main/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/pipaya/main/install.sh | bash -s -- client
#
# Commands: server (default) | client | update | status | uninstall | help
set -euo pipefail

REPO_URL="${PIPAYA_REPO:-https://github.com/dohwi/pipaya.git}"
RELEASE_URL="${PIPAYA_RELEASE_URL:-https://github.com/dohwi/pipaya/releases/download/latest}"
BUN_VERSION="${PIPAYA_BUN_VERSION:-1.3.14}"
APP_DIR="${PIPAYA_APP_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/pipaya}"
DATA_DIR="${PIPAYA_DATA_DIR:-$HOME/.pipaya}"
CONF_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/pipaya"
ENV_FILE="$CONF_DIR/server.env"
UNIT_NAME="pipaya"
PLIST_LABEL="app.pipaya.server"
PLIST="$HOME/Library/LaunchAgents/$PLIST_LABEL.plist"
UNIT="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$UNIT_NAME.service"

REF="main"
HOST=""
PORT="8787"
APPROVAL="ask"
SERVICE=1
ASSUME_YES=0

say() { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

usage() {
	cat <<'EOF'
pipaya installer

Usage: install.sh [command] [options]

Commands
  server       Install the server and start it as a user service (default)
  client       Download the desktop client for this OS and verify its checksum
  update       Fetch the latest server code and restart the service
  status       Show whether the server is running
  uninstall    Remove the service and the installed code (data is kept)

Server options
  --host ADDR      Listen address. Default: the Tailscale IPv4 address if there is one, else 127.0.0.1.
                   Use 0.0.0.0 only behind a firewall or a private network.
  --port N         Listen port (default 8787)
  --approval MODE  Tool approval policy: ask (default), readonly, auto
  --ref REF        Git branch or tag to install (default main)
  --dir PATH       Install location (default ~/.local/share/pipaya)
  --no-service     Install only; do not register or start a service
  -y, --yes        Do not ask before installing Bun

Environment: PIPAYA_DATA_DIR (default ~/.pipaya), PIPAYA_BUN_VERSION, PIPAYA_REPO
EOF
}

# ---------- helpers ----------

os() {
	case "$(uname -s)" in
		Linux) echo linux ;;
		Darwin) echo macos ;;
		*) echo other ;;
	esac
}

tailscale_ip() {
	have tailscale || return 0
	tailscale ip -4 2>/dev/null | head -n 1 || true
}

valid_host() { [[ "$1" =~ ^[A-Za-z0-9.:_-]+$ ]]; }

ensure_git() { have git || die "git is required (install it with your package manager and run this again)"; }

ensure_bun() {
	if have bun; then return; fi
	if [ -x "$HOME/.bun/bin/bun" ]; then export PATH="$HOME/.bun/bin:$PATH"; return; fi
	have curl || die "curl is required to install Bun"
	if [ "$ASSUME_YES" != 1 ]; then
		[ -r /dev/tty ] || die "Bun is not installed. Install Bun $BUN_VERSION (https://bun.sh) or re-run with --yes"
		printf 'Bun is not installed. Install Bun %s from https://bun.sh into ~/.bun? [y/N] ' "$BUN_VERSION" >/dev/tty
		local answer=""
		read -r answer </dev/tty || true
		case "$answer" in y | Y | yes | YES) ;; *) die "Bun is required" ;; esac
	fi
	install_bun
	export PATH="$HOME/.bun/bin:$PATH"
	have bun || die "Bun installation failed"
}

# Download Bun from its GitHub release and check it against the SHA256SUMS published with that release,
# instead of piping an install script from the network into a shell.
install_bun() {
	have unzip || die "unzip is required to install Bun"
	local os arch asset base tmp
	case "$(uname -s)" in Linux) os=linux ;; Darwin) os=darwin ;; *) die "unsupported OS for the Bun download" ;; esac
	case "$(uname -m)" in x86_64 | amd64) arch=x64 ;; aarch64 | arm64) arch=aarch64 ;; *) die "unsupported CPU for the Bun download: $(uname -m)" ;; esac
	# Bun's default x64 build needs AVX2; the baseline build runs on older CPUs.
	if [ "$os-$arch" = linux-x64 ] && ! grep -qw avx2 /proc/cpuinfo 2>/dev/null; then arch=x64-baseline; fi
	asset="bun-$os-$arch.zip"
	base="https://github.com/oven-sh/bun/releases/download/bun-v$BUN_VERSION"
	tmp="$(mktemp -d)"
	curl -fSL --proto '=https' --tlsv1.2 -o "$tmp/SHASUMS256.txt" "$base/SHASUMS256.txt" || { rm -rf "$tmp"; die "could not download the Bun checksums"; }
	curl -fSL --proto '=https' --tlsv1.2 -o "$tmp/$asset" "$base/$asset" || { rm -rf "$tmp"; die "could not download $asset"; }
	cp "$tmp/SHASUMS256.txt" "$tmp/SHA256SUMS.txt"
	( verify_download "$tmp" "$asset" ) || { rm -rf "$tmp"; exit 1; }
	unzip -q -o "$tmp/$asset" -d "$tmp"
	mkdir -p "$HOME/.bun/bin"
	install -m 755 "$tmp/bun-$os-$arch/bun" "$HOME/.bun/bin/bun"
	rm -rf "$tmp"
}

fetch_code() {
	if [ -d "$APP_DIR/.git" ]; then
		git -C "$APP_DIR" fetch --quiet --depth 1 origin "$REF"
		git -C "$APP_DIR" reset --quiet --hard FETCH_HEAD
	else
		[ ! -e "$APP_DIR" ] || [ -z "$(ls -A "$APP_DIR" 2>/dev/null)" ] || die "$APP_DIR exists and is not a pipaya checkout (use --dir)"
		mkdir -p "$(dirname "$APP_DIR")"
		git clone --quiet --depth 1 --branch "$REF" "$REPO_URL" "$APP_DIR"
	fi
	(cd "$APP_DIR/server" && bun install --frozen-lockfile --production --silent)
}

write_env() {
	mkdir -p "$CONF_DIR"
	chmod 700 "$CONF_DIR"
	umask 077
	{
		echo "PIPAYA_HOST=$HOST"
		echo "PIPAYA_PORT=$PORT"
		echo "PIPAYA_APPROVAL=$APPROVAL"
		echo "PIPAYA_DATA_DIR=$DATA_DIR"
		# Commands run by the agent need the tools of the installing user (git, node, ...).
		echo "PATH=$(dirname "$(command -v bun)"):$PATH"
	} >"$ENV_FILE"
	chmod 600 "$ENV_FILE"
}

load_env() {
	[ -f "$ENV_FILE" ] || return 0
	HOST="$(sed -n 's/^PIPAYA_HOST=//p' "$ENV_FILE" | head -n 1)"
	PORT="$(sed -n 's/^PIPAYA_PORT=//p' "$ENV_FILE" | head -n 1)"
}

xml_escape() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

install_systemd() {
	have systemctl || return 1
	systemctl --user show-environment >/dev/null 2>&1 || return 1
	mkdir -p "$(dirname "$UNIT")"
	cat >"$UNIT" <<EOF
[Unit]
Description=pipaya server
After=network-online.target
Wants=network-online.target
# Never stop retrying, however often it fails.
StartLimitIntervalSec=0

[Service]
WorkingDirectory=$APP_DIR/server
EnvironmentFile=$ENV_FILE
ExecStart=$(command -v bun) src/index.ts
# Restart after crashes, kills and clean exits alike; only an explicit systemctl stop keeps it down.
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
EOF
	systemctl --user daemon-reload
	systemctl --user enable "$UNIT_NAME.service" >/dev/null 2>&1
	systemctl --user restart "$UNIT_NAME.service"
	# Without lingering, a user service stops at logout and does not start at boot.
	if have loginctl && [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" != yes ]; then
		loginctl enable-linger "$USER" >/dev/null 2>&1 || true
		if [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" != yes ]; then
			warn "the server will stop at logout and will not start at boot. To fix that, run: sudo loginctl enable-linger $USER"
		fi
	fi
}

install_launchd() {
	mkdir -p "$(dirname "$PLIST")" "$HOME/Library/Logs"
	local path
	path="$(dirname "$(command -v bun)"):$PATH"
	cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>$PLIST_LABEL</string>
	<key>ProgramArguments</key><array><string>$(command -v bun | xml_escape)</string><string>src/index.ts</string></array>
	<key>WorkingDirectory</key><string>$(printf '%s' "$APP_DIR/server" | xml_escape)</string>
	<key>EnvironmentVariables</key><dict>
		<key>PIPAYA_HOST</key><string>$(printf '%s' "$HOST" | xml_escape)</string>
		<key>PIPAYA_PORT</key><string>$PORT</string>
		<key>PIPAYA_APPROVAL</key><string>$APPROVAL</string>
		<key>PIPAYA_DATA_DIR</key><string>$(printf '%s' "$DATA_DIR" | xml_escape)</string>
		<key>PATH</key><string>$(printf '%s' "$path" | xml_escape)</string>
	</dict>
	<key>RunAtLoad</key><true/>
	<key>KeepAlive</key><true/>
	<key>ThrottleInterval</key><integer>3</integer>
	<key>StandardOutPath</key><string>$HOME/Library/Logs/pipaya.log</string>
	<key>StandardErrorPath</key><string>$HOME/Library/Logs/pipaya.log</string>
</dict>
</plist>
EOF
	chmod 600 "$PLIST"
	launchctl bootout "gui/$(id -u)/$PLIST_LABEL" >/dev/null 2>&1 || true
	launchctl bootstrap "gui/$(id -u)" "$PLIST"
}

start_service() {
	case "$(os)" in
		linux) install_systemd || return 1 ;;
		macos) install_launchd ;;
		*) return 1 ;;
	esac
}

restart_service() {
	case "$(os)" in
		linux) systemctl --user restart "$UNIT_NAME.service" ;;
		macos) launchctl kickstart -k "gui/$(id -u)/$PLIST_LABEL" ;;
	esac
}

probe_host() {
	case "$HOST" in 0.0.0.0 | "" ) echo 127.0.0.1 ;; ::) echo "[::1]" ;; *:*) echo "[$HOST]" ;; *) echo "$HOST" ;; esac
}

wait_healthy() {
	have curl || return 0
	for _ in $(seq 1 30); do
		if curl -fsS -o /dev/null "http://$(probe_host):$PORT/health" 2>/dev/null; then return 0; fi
		sleep 0.5
	done
	return 1
}

print_summary() {
	say ""
	say "pipaya server is running."
	say "  URL:    http://$([ "$HOST" = 0.0.0.0 ] && echo "<this-machine-ip>" || echo "$HOST"):$PORT"
	say "  Token:  cat $DATA_DIR/token"
	say "  Code:   $APP_DIR"
	if [ "$HOST" = 0.0.0.0 ]; then
		warn "the server listens on every network interface. Put it behind a firewall, Tailscale or HTTPS; the token grants full control."
	elif [ "$HOST" = 127.0.0.1 ]; then
		say ""
		say "The server only accepts connections from this machine. To reach it from a phone or another computer,"
		say "install Tailscale (https://tailscale.com) and re-run with --host \"\$(tailscale ip -4)\"."
	fi
	say ""
	say "Open the client, enter the URL and token, then add a model connection under Settings > Models."
	say "Desktop/Android clients: https://github.com/dohwi/pipaya/releases/tag/latest"
}

# ---------- commands ----------

cmd_server() {
	[ "$(os)" != other ] || die "unsupported OS (Linux and macOS only; on Windows use install.ps1 for the client and run the server in WSL)"
	if ! [[ "$PORT" =~ ^[0-9]+$ ]] || [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then die "invalid --port"; fi
	case "$APPROVAL" in ask | readonly | auto) ;; *) die "--approval must be ask, readonly or auto" ;; esac
	[[ "$REF" =~ ^[A-Za-z0-9._/-]+$ ]] || die "invalid --ref"
	if [ -z "$HOST" ]; then HOST="$(tailscale_ip)"; HOST="${HOST:-127.0.0.1}"; fi
	valid_host "$HOST" || die "invalid --host"
	[ "$APPROVAL" != auto ] || warn "approval 'auto' lets the model run any command as $USER without asking."

	ensure_git
	ensure_bun
	say "Installing to $APP_DIR ..."
	fetch_code
	write_env

	if [ "$SERVICE" = 0 ]; then
		say ""
		say "Installed without a service. Start it with:"
		say "  cd $APP_DIR/server && set -a && . $ENV_FILE && set +a && bun src/index.ts"
		return
	fi
	if ! start_service; then
		warn "could not register a user service on this system."
		say "Start the server manually:"
		say "  cd $APP_DIR/server && set -a && . $ENV_FILE && set +a && bun src/index.ts"
		return
	fi
	wait_healthy || die "the server did not become healthy; see: $( [ "$(os)" = macos ] && echo "$HOME/Library/Logs/pipaya.log" || echo "journalctl --user -u $UNIT_NAME" )"
	print_summary
}

cmd_update() {
	[ -d "$APP_DIR/.git" ] || die "not installed in $APP_DIR (run: install.sh server)"
	ensure_git
	ensure_bun
	load_env
	fetch_code
	restart_service
	wait_healthy || die "the server did not become healthy after the update"
	say "Updated to $(git -C "$APP_DIR" rev-parse --short HEAD)."
}

cmd_status() {
	load_env
	HOST="${HOST:-127.0.0.1}"; PORT="${PORT:-8787}"
	if have curl && curl -fsS "http://$(probe_host):$PORT/health" 2>/dev/null; then echo; else say "not running on $HOST:$PORT"; return 1; fi
}

cmd_uninstall() {
	case "$(os)" in
		linux)
			if have systemctl; then
				systemctl --user disable --now "$UNIT_NAME.service" >/dev/null 2>&1 || true
				rm -f "$UNIT"
				systemctl --user daemon-reload >/dev/null 2>&1 || true
			fi ;;
		macos)
			launchctl bootout "gui/$(id -u)/$PLIST_LABEL" >/dev/null 2>&1 || true
			rm -f "$PLIST" ;;
	esac
	rm -rf "$CONF_DIR"
	if [ -d "$APP_DIR/.git" ]; then rm -rf "$APP_DIR"; fi
	say "Removed the service and $APP_DIR."
	say "Your data (sessions, API keys, token) is still in $DATA_DIR. Delete it yourself if you no longer need it."
}

verify_download() {
	local dir="$1" name="$2" expected actual
	expected="$(awk -v n="$name" '$2 == n || $2 == "*" n { print $1 }' "$dir/SHA256SUMS.txt" | head -n 1)"
	[ -n "$expected" ] || { rm -f "$dir/$name"; die "no checksum for $name in SHA256SUMS.txt"; }
	if have sha256sum; then actual="$(sha256sum "$dir/$name" | awk '{print $1}')"; else actual="$(shasum -a 256 "$dir/$name" | awk '{print $1}')"; fi
	if [ "$expected" != "$actual" ]; then
		rm -f "$dir/$name"
		die "checksum mismatch for $name (expected $expected, got $actual); the file was deleted"
	fi
}

cmd_client() {
	have curl || die "curl is required"
	case "$(os)" in
		macos)
			local dest="${PIPAYA_DOWNLOAD_DIR:-$HOME/Downloads}" name="pipaya-macos-arm64.dmg"
			[ "$(uname -m)" = arm64 ] || die "the macOS build is for Apple Silicon only"
			mkdir -p "$dest"
			curl -fSL --proto '=https' --tlsv1.2 -o "$dest/SHA256SUMS.txt" "$RELEASE_URL/SHA256SUMS.txt"
			curl -fSL --proto '=https' --tlsv1.2 -o "$dest/$name" "$RELEASE_URL/$name"
			verify_download "$dest" "$name"
			say "Downloaded and verified: $dest/$name"
			say "Open it and drag pipaya to Applications. The app is ad-hoc signed and not notarized:"
			say "if macOS blocks the first launch, use System Settings > Privacy & Security > Open Anyway."
			if have open; then open "$dest/$name"; fi ;;
		linux)
			say "There is no prebuilt Linux client. Build the desktop app from source (see client/README.md),"
			say "or run the web client: cd client && bun install && bun run dev."
			say "Android: $RELEASE_URL/pipaya-android-arm64.apk (verify with SHA256SUMS.txt)" ;;
		*) die "unsupported OS; on Windows run install.ps1" ;;
	esac
}

# ---------- argument parsing ----------

COMMAND="server"
if [ $# -gt 0 ] && [[ "$1" != -* ]]; then COMMAND="$1"; shift; fi
while [ $# -gt 0 ]; do
	case "$1" in
		--host) [ $# -ge 2 ] || die "--host needs a value"; HOST="$2"; shift 2 ;;
		--port) [ $# -ge 2 ] || die "--port needs a value"; PORT="$2"; shift 2 ;;
		--approval) [ $# -ge 2 ] || die "--approval needs a value"; APPROVAL="$2"; shift 2 ;;
		--ref) [ $# -ge 2 ] || die "--ref needs a value"; REF="$2"; shift 2 ;;
		--dir) [ $# -ge 2 ] || die "--dir needs a value"; APP_DIR="$2"; shift 2 ;;
		--no-service) SERVICE=0; shift ;;
		-y | --yes) ASSUME_YES=1; shift ;;
		-h | --help) usage; exit 0 ;;
		*) die "unknown option: $1 (see --help)" ;;
	esac
done

case "$COMMAND" in
	server) cmd_server ;;
	client) cmd_client ;;
	update) cmd_update ;;
	status) cmd_status ;;
	uninstall) cmd_uninstall ;;
	help) usage ;;
	*) die "unknown command: $COMMAND (see --help)" ;;
esac
