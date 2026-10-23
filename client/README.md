# pipaya client

**English** · [한국어](README.ko.md) · [Project README](../README.md)

Svelte 5 + Vite + Tauri 2 chat client for the pipaya server (REST + SSE).

```bash
cd client && bun install
bun run dev          # http://0.0.0.0:1420 (open via the Tailscale IP)
bun run check        # svelte-check
bun run build        # static bundle in dist/
bun run tauri dev    # desktop; needs webkit2gtk-4.1 + build deps on Linux
bun run tauri android init   # mobile, once the Android SDK/NDK is set up
```

On first launch enter the server URL and the token from `~/.pipaya/token`.

## Native builds and downloads

Downloads for every platform and the checksum-verifying installers are listed under [Client](../README.md#client) in the project README.
Client changes pushed to `main` automatically build all four platforms and replace the assets in the single `latest` release after all checks succeed. Installed Windows and macOS apps update themselves; Android notifies you of a new build (details).

See build, signing, and release instructions for toolchains, GitHub Secrets, local build commands, and server connectivity.

## Language

The UI ships in **English and Korean** and follows the device language (Settings → General → Language lets you pick one or follow the system). Korean is the source language: `t("설정")` uses the Korean text as the lookup key, and `src/lib/locales/en.ts` maps it to English. A missing translation falls back to the Korean text, so nothing is ever blank.

- Check coverage: `node scripts/extract-i18n.cjs` lists strings used in code but missing from `en.ts`, and entries that are no longer used (it exits with 1 when something is missing).
- More languages are added with a language-pack extension; packs are shared across devices through the server.

## Model connections (custom only)

The server ships no providers or models, so the model list is **empty at first**.
Open Settings → Models → "Add connection" and enter a connection name, endpoint (Base URL) and at least one model ID by hand; pick the API format (OpenAI Chat Completions, OpenAI Responses or Anthropic Messages).
There are no presets or default endpoint lists. If the endpoint needs a key, add it afterwards in the same screen; it is stored on the server, not on this device.
Chat is unavailable until one usable connection exists. Connections are saved per server.

## Context compaction (pi compact)

- Compaction runs only through `/compact [instructions]`, which appears in the `/` autocomplete. The footer has no run button.
- Every built-in command uses a single English `/name`. Korean and duplicate aliases are not supported.
- `/sidebar`, `/model`, `/thinking` and `/help` are not built-in commands; use the existing UI for the sidebar and for model and reasoning settings.
- Older turns are summarized while recent turns and the original transcript are kept. The summary model call costs tokens and may omit details.
- Sending messages and changing the model are blocked while compaction runs; the stop button requests cancellation. The server's automatic compaction progress is shown too.
- The current context and the cumulative billed tokens are shown separately. An old server's estimate is marked `~`, and usage not yet measured right after compaction shows `—`.
- **Needs backend support:** the server currently uses the low-level `pi-agent-core`, so this client work alone does not reduce real tokens. The backend request and REST/SSE contract must be implemented. Unsupported servers show a notice.

Verify with `bun run test` (REST contract and real Svelte rune state module tests), `bun run check` and `bun run build`.

## Motion

Follows the Material profile. Values live in one place, the `:root` tokens in `src/app.css`, and the Svelte transitions in `src/lib/motion.ts` read the same tokens so CSS and JS motion cannot drift apart.

- **Time and easing**: entrances use `--motion-normal` (360ms) with `--ease` (decelerate); exits use `--motion-fast` (180ms) with `--ease-exit` (accelerate). Exits travel and shrink less than entrances.
- **Dialog**: starts 18px up at scale .94 and settles in the center; the exit is 8px at .96. On phone widths (640px and below) it is a bottom sheet. Settings continues from where it was pulled down.
- **Large floating surfaces** (Palette, model picker, slash menu, toasts): movement and fade only, no scale.
- **Native `<dialog>`** (Skills, session context, extension screens): `::backdrop` is not a child, so `dialog[data-closing]` lets CSS draw the exit. `holdClosing` and `closeAnimated` delay closing until the exit ends.
- **Buttons**: pressing shrinks `.btn` to .94 and `.iconbtn` to .88 in place; `lib/ripple.ts` attaches a Material ripple to both by delegation.
- **Selection indicator**: one marker slides to the next item like Tabs (`lib/sliding-indicator.ts`). The sidebar list and collapsed rail, the tab underline of Settings and server settings, the theme cards, the Skills scope toggle, the reasoning level (the marker follows the level color), group chips and extension screen tabs all use the same action. It slides only when switching to another item; a first placement or layout change follows instantly. The marker still moves during a theme switch. Content below a tab slides in slightly from the direction the tab moved, and tab and radio groups move with ←/→/Home/End (`lib/roving.ts`).
- **Theme switch**: all transitions are off during `.theme-switching`, so colors change together in one frame. When adding a transition, use the `--motion-*` and `--ease*` tokens instead of hard-coded values.
- **Accessibility**: with `prefers-reduced-motion`, `ms()` returns 0, ripples are hidden, and the global rule disables the remaining animations.

## Layout

- `src/lib/store.svelte.ts`: connection, sessions, SSE sync and reconnect, commands
- `src/lib/chat.svelte.ts`: folds REST history and SSE events into one transcript
- `src/lib/api.ts`: typed REST client and EventSource subscription
- `src/lib/i18n.ts`, `src/lib/locales/`: UI language, English dictionary, language packs
- `src/components/`: Sidebar, Header, MessageList, Message, ToolCard (approvals), Composer, ModelPicker, Settings
